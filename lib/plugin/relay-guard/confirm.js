const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Owner confirmations for a delegate's high-risk calls (relay trust v2 PR2,
// GST-2090). Shared by AlphaClaw's relay guard and Wintermute's own guard,
// which both load this file from the plugin directory, so "may this call run"
// has one answer and one record: relay/bridge.db's relay_confirmations.
//
// A guard asks checkConfirmation for one call (sender, action, target,
// binding generation). The first ask writes a "requested" row and the call is
// refused; AlphaClaw's bridge sends the owner one message with a one-time
// link (lib/server/relay/confirmations.js). Approve makes the row "confirmed"
// for 15 minutes and tells the sender, which sends the request again with the
// confirmation_ref; the next matching call is admitted once and the row is
// spent in the same transaction, so two guards, two lanes or a retry after a
// gateway restart can never spend it twice. Anything missing, unreadable or
// mismatched refuses the call.
//
// Kinds:
//   low     the grant is enough (files, shell, memory and the brain)
//   medium  a send to a named person: the carried approval, as before
//   high    config, env, secrets, guard or access changes: a confirmation
// The kind is derived here from the call, never taken from the caller.
// Canonical action and target name key names and paths only, never values.
const kConfirmTtlMs = 15 * 60 * 1000;
const kConfirmationRefPattern = /^rc_[a-f0-9]{16}$/;
const kOpenStates = Object.freeze(["requested", "pending"]);

const kProtectedNames = /^(openclaw\.json|alphaclaw\.json|exec-approvals\.json|\.env(\..+)?|secrets\.json|internal\.secret|auth-profiles\.json)$/i;
const kProtectedSegments = Object.freeze(["relay-guard", "wm-guards"]);
const kPatchFilePattern = /^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm;
const kMutatingAdmin = /\balphaclaw\s+admin\s+(POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s"'|;&]*)/i;
const kOpenclawChange = /\bopenclaw\s+(config\s+(?:set|unset|apply)|secrets\s+[a-z-]+|plugins\s+(?:install|uninstall|enable|disable|update)|gateway\s+(?:install|uninstall))\b(?:\s+([A-Za-z0-9_.:@\/\[\]-]{1,120}))?/i;

const normalizePath = (value) => String(value || "").trim().replace(/\\/g, "/");

// What the delegate chose (a path, a route, a key) reaches the owner's notice
// and its page, so it is cut to letters, digits and . _ / @ + , - before it is
// stored: no transport can build a link, mention or markup from what is left,
// and no redaction pattern can reach past it. Anything else becomes "?".
const kUnsafeChars = /[^A-Za-z0-9._\/@+,-]/g;
const safe = (value, max) => String(value || "").replace(kUnsafeChars, "?").slice(0, max);
const commandHash = (command) => crypto.createHash("sha256").update(String(command)).digest("hex").slice(0, 16);

const isProtectedPath = (value, rootDir = "") => {
  const file = normalizePath(value);
  if (!file) return false;
  const segments = file.split("/").filter(Boolean);
  if (kProtectedNames.test(segments[segments.length - 1] || "")) return true;
  if (segments.some((segment) => kProtectedSegments.includes(segment.toLowerCase()))) return true;
  const relayDir = rootDir ? normalizePath(path.join(rootDir, "relay")) + "/" : "";
  return Boolean(relayDir) && path.posix.isAbsolute(file) && path.posix.normalize(file).startsWith(relayDir);
};

const pathsOf = (toolName, params = {}) => {
  const found = [params.path, params.file_path, params.filePath].filter((entry) => typeof entry === "string" && entry.trim());
  if (toolName === "apply_patch") {
    const patch = [params.input, params.patch].find((entry) => typeof entry === "string") || "";
    for (const match of patch.matchAll(kPatchFilePattern)) found.push((match[1] || match[2]).trim());
  }
  return found;
};

// { kind, action, target }. action and target are short, canonical and never
// carry a value: a path, an admin route or a CLI subcommand.
const classifyRisk = ({ toolName, params = {}, rootDir = "" } = {}) => {
  const name = String(toolName || "").trim().toLowerCase();
  if (name === "message") return { kind: "medium", action: null, target: null };
  if (name === "write" || name === "edit" || name === "apply_patch") {
    const file = pathsOf(name, params || {}).find((entry) => isProtectedPath(entry, rootDir));
    if (file) return { kind: "high", action: name + " " + safe(path.posix.basename(normalizePath(file)), 80), target: safe(normalizePath(file), 300) };
    return { kind: "low", action: null, target: null };
  }
  if (name === "exec") {
    const command = typeof params?.command === "string" ? params.command : Array.isArray(params?.command) ? params.command.join(" ") : "";
    // An approved command is that exact command: the target carries a hash
    // of all of it (body, flags and value included, none of them shown), so
    // a flag before the key or another value is another confirmation.
    const admin = kMutatingAdmin.exec(command);
    if (admin) {
      const action = "alphaclaw admin " + admin[1].toUpperCase() + " " + safe(admin[2].split("?")[0], 160);
      return { kind: "high", action, target: action + " #" + commandHash(command) };
    }
    const openclaw = kOpenclawChange.exec(command);
    if (openclaw) {
      const words = openclaw[1].trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase();
      const subject = openclaw[2] && !openclaw[2].startsWith("-") ? " " + safe(openclaw[2], 120) : "";
      const action = "openclaw " + words + subject;
      return { kind: "high", action, target: action + " #" + commandHash(command) };
    }
  }
  return { kind: "low", action: null, target: null };
};

const openBridge = ({ rootDir, fsModule = fs }) => {
  const dbPath = path.join(rootDir, "relay", "bridge.db");
  if (!fsModule.existsSync(dbPath)) return null;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 2000;");
  return db;
};

const newRef = () => "rc_" + crypto.randomBytes(8).toString("hex");

// { admitted, state, ref }. state: "admitted" | "requested" | "pending" |
// "denied" | "unavailable". Never throws for a refusal; a database error
// throws and the guard turns it into a deny.
const checkConfirmation = ({ rootDir, sender, messageId, lane = null, generation = null, confirmationRef = null, kind, action, target, now = Date.now(), fsModule = fs }) => {
  if (kind !== "high") return { admitted: true, state: "not_needed", ref: null };
  if (!sender || !messageId || !action || !target) return { admitted: false, state: "unavailable", ref: null };
  const db = openBridge({ rootDir, fsModule });
  if (!db) return { admitted: false, state: "unavailable", ref: null };
  try {
    const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'relay_confirmations'").get();
    if (!hasTable) return { admitted: false, state: "unavailable", ref: null };
    const generationValue = Number.isInteger(generation) ? generation : null;
    const ref = typeof confirmationRef === "string" && kConfirmationRefPattern.test(confirmationRef) ? confirmationRef : null;
    db.exec("BEGIN IMMEDIATE");
    try {
      const same = "sender = ? AND action = ? AND target = ? AND generation IS ?";
      const confirmed = db
        .prepare("SELECT id FROM relay_confirmations WHERE " + same + " AND state = 'confirmed' AND expires_at > ? AND (message_id = ? OR id = ?) ORDER BY created_at LIMIT 1")
        .get(String(sender), action, target, generationValue, now, String(messageId), ref);
      if (confirmed) {
        db.prepare("UPDATE relay_confirmations SET state = 'spent', spent_at = ?, spent_message_id = ? WHERE id = ? AND state = 'confirmed'").run(now, String(messageId), confirmed.id);
        db.exec("COMMIT");
        return { admitted: true, state: "admitted", ref: confirmed.id };
      }
      const open = db
        .prepare("SELECT id, state FROM relay_confirmations WHERE " + same + " AND state IN ('requested', 'pending') AND expires_at > ? ORDER BY created_at DESC LIMIT 1")
        .get(String(sender), action, target, generationValue, now);
      if (open) {
        db.exec("COMMIT");
        return { admitted: false, state: "pending", ref: open.id };
      }
      const denied = db
        .prepare("SELECT id FROM relay_confirmations WHERE " + same + " AND state = 'denied' AND (message_id = ? OR id = ?) LIMIT 1")
        .get(String(sender), action, target, generationValue, String(messageId), ref);
      if (denied) {
        db.exec("COMMIT");
        return { admitted: false, state: "denied", ref: denied.id };
      }
      const id = newRef();
      db.prepare(
        "INSERT INTO relay_confirmations (id, message_id, sender, lane, generation, kind, action, target, state, created_at, expires_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'requested', ?, ?)",
      ).run(id, String(messageId), String(sender), lane || null, generationValue, kind, action, target, now, now + kConfirmTtlMs);
      db.exec("COMMIT");
      return { admitted: false, state: "requested", ref: id };
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      throw error;
    }
  } finally {
    db.close();
  }
};

module.exports = { classifyRisk, checkConfirmation, isProtectedPath, kConfirmTtlMs, kConfirmationRefPattern, kOpenStates };

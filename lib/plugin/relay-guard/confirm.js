const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");
const { fileURLToPath } = require("url");

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

const kProtectedNames = /^(openclaw\.json|alphaclaw\.json|exec-approvals\.json|\.env(\..+)?|secrets\.json|internal\.secret|provenance-key\.json|auth-profiles\.json)$/i;
const kProtectedSegments = Object.freeze(["relay-guard", "wm-guards"]);
const kRelayFiles = /^((bridge|remote|relaycast|archive)\.db(-wal|-shm|-journal)?|secrets\.json|internal\.secret|provenance-key\.json)$/i;
const kPatchFilePattern = /^\s*\*\*\* (?:Add|Update|Delete) File: (.+)$|^\s*\*\*\* Move to: (.+)$/gm;
const kMutatingAdmin = /\balphaclaw\s+admin\s+(POST|PUT|PATCH|DELETE)\s+(\/api\/[^\s|;&]*)/i;
const kOpenclawChanges = Object.freeze({
  config: ["set", "unset", "apply"],
  secrets: null,
  plugins: ["install", "uninstall", "enable", "disable", "update"],
  gateway: ["install", "uninstall"],
});
// A protected file named anywhere in a shell command (or in input written to
// a running process): the names above, the guards' directories, and the
// relay's databases, by name when sqlite3 opens them or under a relay/ path.
const kShellProtected = /(?:^|[^\w.-])(openclaw\.json|alphaclaw\.json|exec-approvals\.json|secrets\.json|internal\.secret|provenance-key\.json|auth-profiles\.json|\.env(?:\.[\w.-]+)?)(?![\w.-])|(?:^|\/)(relay-guard|wm-guards)\/|relay\/((?:bridge|remote|relaycast|archive)\.db)/;
const kSqliteRelayDb = /\bsqlite3?\b[^|;&]*\b((?:bridge|remote|relaycast|archive)\.db)\b/;
// A command that only reads: every segment starts with one of these and
// nothing redirects, substitutes or runs a nested command.
const kReadOnlyCommands = new Set(["cat", "head", "tail", "grep", "egrep", "fgrep", "wc", "ls", "stat", "file", "jq", "diff", "cmp", "sha256sum", "md5sum", "cd", "test", "true", "pwd"]);
// The single-line match the guard used before the token scan above: a
// change it caught is always held, whatever the scan makes of the command.
const kOpenclawChangeLoose = /\bopenclaw\s+(config\s+(?:set|unset|apply)|secrets\s+[a-z-]+|plugins\s+(?:install|uninstall|enable|disable|update)|gateway\s+(?:install|uninstall))\b(?:\s+([A-Za-z0-9_.:@\/\[\]-]{1,120}))?/i;
// The automations tool's actions (OpenClaw 2026.11.2 CRON_ACTIONS): a
// delegate reads with the first set; the second changes or starts a job and
// is held for the owner (PR4, GST-2090).
const kAutomationReadActions = Object.freeze(["status", "list", "get", "runs", "next_check"]);
const kAutomationWriteActions = Object.freeze(["add", "update", "remove", "run", "wake"]);
const kMaxOpenPerSender = 5;

// What the delegate chose (a path, a route, a key) reaches the owner's notice
// and its page, so it is cut to letters, digits and . _ / @ + , - before it is
// stored: no transport can build a link, mention or markup from what is left,
// and no redaction pattern can reach past it. Anything else becomes "?".
const kUnsafeChars = /[^A-Za-z0-9._\/@+,-]/g;
const safe = (value, max) => String(value || "").replace(kUnsafeChars, "?").slice(0, max);
const commandHash = (command) => crypto.createHash("sha256").update(String(command)).digest("hex").slice(0, 16);

const matchesProtected = (file, relayDirs) => {
  const segments = file.split("/").filter(Boolean);
  if (kProtectedNames.test(segments[segments.length - 1] || "")) return true;
  if (segments.some((segment) => kProtectedSegments.includes(segment.toLowerCase()))) return true;
  if (segments.length > 1 && segments[segments.length - 2].toLowerCase() === "relay" && kRelayFiles.test(segments[segments.length - 1])) return true;
  return path.posix.isAbsolute(file) && relayDirs.some((dir) => file.startsWith(dir));
};

// The path as OpenClaw's write and edit tools read it (path-utils expandPath
// in 2026.11.2): one leading @ marks a file reference and is dropped (@@x is
// the literal ./@x), and a file: URL is decoded, %2D and %2E included.
// Trailing spaces are kept, as OpenClaw keeps them.
const openclawPathOf = (value) => {
  const referenced = value.startsWith("@") ? value.slice(1) : value;
  const normalized = referenced.startsWith("@") ? "./" + referenced : referenced;
  if (!normalized.startsWith("file://")) return normalized;
  try {
    return fileURLToPath(normalized);
  } catch {
    return normalized;
  }
};

// Every spelling a tool may act on: as written (a literal @ name can exist),
// as OpenClaw reads it, and both trimmed.
const spellingsOf = (value) => {
  const raw = String(value || "").replace(/\\/g, "/");
  const spellings = new Set();
  for (const spelling of [raw, raw.trim()]) {
    spellings.add(spelling);
    spellings.add(openclawPathOf(spelling).replace(/\\/g, "/"));
  }
  return [...spellings].filter((spelling) => spelling.trim());
};

// Where an absolute path lands, walked the way the kernel walks it: one
// component at a time, a symlink replaced by its target before the next
// component (a link whose target does not exist yet included, since a write
// through it creates the target), and .. taken from the real directory
// reached so far, never folded first. Missing components are kept as written.
const kMaxLinkHops = 40;
const landingOf = (file, fsModule) => {
  const queue = file.split("/");
  let current = "/";
  for (let hops = 0; queue.length; ) {
    const part = queue.shift();
    if (!part || part === ".") continue;
    if (part === "..") {
      current = path.posix.dirname(current);
      continue;
    }
    const next = path.posix.join(current, part);
    let link = null;
    try {
      if (fsModule.lstatSync(next).isSymbolicLink()) link = String(fsModule.readlinkSync(next)).replace(/\\/g, "/");
    } catch {}
    if (link === null || hops >= kMaxLinkHops) {
      current = next;
      continue;
    }
    hops += 1;
    if (link.startsWith("/")) current = "/";
    queue.unshift(...link.split("/"));
  }
  return current;
};

const existsAt = (file, fsModule) => {
  try {
    fsModule.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

// Where a write tool's path can land: an absolute or ~ path as it is, a
// relative one against each directory the tool may resolve it from (the
// agent's workspace, the gateway's cwd). Nothing is folded here.
const candidatesOf = (file, bases) => {
  if (file === "~" || file.startsWith("~/")) return [os.homedir().replace(/\\/g, "/") + file.slice(1)];
  if (path.posix.isAbsolute(file)) return [file];
  return bases.map((base) => path.resolve(base).replace(/\\/g, "/") + "/" + file);
};

// The protected file a write would touch, or null. Each spelling is judged
// as written, with . and .. folded, and where it lands from every base. The
// hold is bound to the file the write lands on: a protected file reached
// through a link or that exists wins over a bare name match, and a link with
// a protected name that points elsewhere names its real target.
const protectedTargetOf = (value, rootDir = "", { bases = [], fsModule = fs } = {}) => {
  const relayDir = rootDir ? path.resolve(rootDir, "relay").replace(/\\/g, "/") : "";
  const relayDirs = relayDir ? [...new Set([relayDir, landingOf(relayDir, fsModule)])].map((dir) => dir + "/") : [];
  let named = null;
  let landed = null;
  let followed = null;
  for (const spelling of spellingsOf(value)) {
    const folded = path.posix.normalize(spelling);
    if (!named && (matchesProtected(spelling, relayDirs) || matchesProtected(folded, relayDirs))) named = folded;
    for (const candidate of candidatesOf(spelling, bases)) {
      const real = landingOf(candidate, fsModule);
      const viaLink = real !== path.posix.normalize(candidate);
      const exists = existsAt(candidate, fsModule);
      if (matchesProtected(real, relayDirs)) {
        if (viaLink || exists) return real;
        landed = landed || real;
      }
      if (!followed && viaLink && exists) followed = real;
    }
  }
  return named || landed ? followed || named || landed : null;
};

const isProtectedPath = (value, rootDir = "", options) => Boolean(protectedTargetOf(value, rootDir, options));

// The directories a relative write path can be resolved from: OpenClaw
// resolves it against the agent's workspace (rootDir/.openclaw/workspace,
// which the default agent uses whatever its id; workspace-<agent>; or the
// workspace and cwd openclaw.json sets for the agent in agents.list or
// agents.entries, or for every agent), and the gateway's own cwd is checked
// too. Every candidate is kept, so a path that lands on a protected file
// from any of them is held.
const kAgentIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const userPathOf = (value) => {
  const dir = String(value || "").trim();
  if (!dir) return "";
  if (dir === "~" || dir.startsWith("~/")) return path.join(os.homedir(), dir.slice(1));
  return path.resolve(dir);
};
const configuredBasesOf = (openclawDir, id, fsModule) => {
  let config;
  try {
    config = JSON.parse(fsModule.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"));
  } catch {
    return [];
  }
  const agents = config?.agents || {};
  const roster = agents.entries && typeof agents.entries === "object" && !Array.isArray(agents.entries)
    ? Object.entries(agents.entries).map(([key, value]) => ({ ...(value && typeof value === "object" ? value : {}), id: key }))
    : Array.isArray(agents.list) ? agents.list : [];
  const entry = roster.find((agent) => String(agent?.id || "").trim().toLowerCase() === (id || "main").toLowerCase());
  const defaults = agents.defaults || {};
  const shared = userPathOf(typeof defaults.workspace === "string" ? defaults.workspace : "");
  return [
    typeof entry?.workspace === "string" ? userPathOf(entry.workspace) : "",
    typeof entry?.cwd === "string" ? userPathOf(entry.cwd) : "",
    typeof defaults.cwd === "string" ? userPathOf(defaults.cwd) : "",
    shared,
    shared && id ? path.join(shared, id) : "",
  ].filter(Boolean);
};
const writeBasesOf = ({ rootDir = "", agentId = "", fsModule = fs } = {}) => {
  const bases = [];
  const id = String(agentId || "").trim();
  const knownId = kAgentIdPattern.test(id) ? id : "";
  if (rootDir) {
    const openclawDir = path.join(rootDir, ".openclaw");
    bases.push(path.join(openclawDir, "workspace"));
    if (knownId && knownId.toLowerCase() !== "main") bases.push(path.join(openclawDir, "workspace-" + knownId));
    bases.push(...configuredBasesOf(openclawDir, knownId, fsModule));
  }
  try {
    bases.push(process.cwd());
  } catch {}
  return [...new Set(bases)];
};

const pathsOf = (toolName, params = {}) => {
  const found = [params.path, params.file_path, params.filePath].filter((entry) => typeof entry === "string" && entry.trim());
  if (toolName === "apply_patch") {
    const patch = [params.input, params.patch].find((entry) => typeof entry === "string") || "";
    for (const match of patch.matchAll(kPatchFilePattern)) found.push((match[1] || match[2]).trim());
  }
  return found;
};

const segmentsOf = (command) =>
  command
    .split(/&&|\|\||[;|&\n]/)
    .map((segment) => segment.trim())
    .filter(Boolean);

const isReadOnly = (command) => {
  const cleaned = command.replace(/\d?>\s*\/dev\/null|2>&1/g, " ");
  if (/[<>`]|\$\(/.test(cleaned)) return false;
  return segmentsOf(cleaned).every((segment) => {
    const [first] = segment.split(/\s+/);
    const name = first.replace(/^.*\//, "");
    return kReadOnlyCommands.has(name);
  });
};

// "openclaw [global flags] config set <key>" and the like, in any segment.
const openclawChangeOf = (command) => {
  for (const segment of segmentsOf(command.replace(/["'\\]/g, "").replace(/[`(){}]|\$\(/g, " "))) {
    const tokens = segment.split(/\s+/);
    const at = tokens.findIndex((token) => /(^|\/)openclaw$/i.test(token));
    if (at < 0) continue;
    let i = at + 1;
    while (i < tokens.length && !Object.hasOwn(kOpenclawChanges, tokens[i].toLowerCase())) i += 1;
    if (i >= tokens.length) continue;
    const group = tokens[i].toLowerCase();
    const verb = (tokens[i + 1] || "").toLowerCase();
    const verbs = kOpenclawChanges[group];
    if (!/^[a-z][a-z-]*$/.test(verb) || (verbs && !verbs.includes(verb))) continue;
    const subject = tokens[i + 2] && !tokens[i + 2].startsWith("-") ? tokens[i + 2] : "";
    return "openclaw " + group + " " + verb + (subject ? " " + safe(subject, 120) : "");
  }
  const loose = kOpenclawChangeLoose.exec(command);
  if (!loose) return null;
  const subject = loose[2] && !loose[2].startsWith("-") ? " " + safe(loose[2], 120) : "";
  return "openclaw " + loose[1].trim().split(/\s+/).slice(0, 2).join(" ").toLowerCase() + subject;
};

// What a shell command, or input written to a running process, would
// change. An approved command is that exact command: the target carries a
// hash of all of it (body, flags and value included, none of them shown).
const classifyCommand = (command) => {
  const admin = kMutatingAdmin.exec(command.replace(/["']/g, " "));
  const openclaw = admin ? null : openclawChangeOf(command);
  const touched = admin || openclaw ? null : kShellProtected.exec(command) || kSqliteRelayDb.exec(command);
  const action = admin
    ? "alphaclaw admin " + admin[1].toUpperCase() + " " + safe(admin[2].split("?")[0], 160)
    : openclaw || (touched && !isReadOnly(command) ? "run a command on " + safe(touched.slice(1).find(Boolean), 80) : null);
  if (!action) return { kind: "low", action: null, target: null };
  return { kind: "high", action, target: action + " #" + commandHash(command) };
};

// { kind, action, target }. action and target are short, canonical and never
// carry a value: a path, an admin route or a CLI subcommand.
const classifyRisk = ({ toolName, params = {}, rootDir = "", agentId = "", fsModule = fs } = {}) => {
  const name = String(toolName || "").trim().toLowerCase();
  if (name === "message") return { kind: "medium", action: null, target: null };
  if (name === "write" || name === "edit" || name === "apply_patch") {
    const bases = writeBasesOf({ rootDir, agentId, fsModule });
    const files = [...new Set(pathsOf(name, params || {}).map((entry) => protectedTargetOf(entry, rootDir, { bases, fsModule })).filter(Boolean))].sort();
    if (!files.length) return { kind: "low", action: null, target: null };
    const names = files.map((file) => safe(path.posix.basename(file), 80)).join(",");
    const list = files.join(",");
    return {
      kind: "high",
      action: name + " " + (names.length > 160 ? names.slice(0, 140) + " +" + files.length + " files" : names),
      target: list.length > 300 ? safe(list, 280) + " #" + commandHash(files.join("\0")) : safe(list, 300),
    };
  }
  if (name === "exec") {
    return classifyCommand(typeof params?.command === "string" ? params.command : Array.isArray(params?.command) ? params.command.join(" ") : "");
  }
  if (name === "automations") {
    const action = String(params?.action || "").trim().toLowerCase();
    if (!kAutomationWriteActions.includes(action)) return { kind: "low", action: null, target: null };
    const job = params?.jobId ?? params?.id ?? params?.job?.name ?? params?.name ?? "";
    const label = "automations " + action + (job ? " " + safe(job, 80) : "");
    return { kind: "high", action: label, target: label + " #" + commandHash(JSON.stringify(params || {})) };
  }
  if (name === "process") {
    const input = [params?.data, params?.text, params?.literal, ...(Array.isArray(params?.keys) ? params.keys : [])].filter((entry) => typeof entry === "string").join(" ");
    return input ? classifyCommand(input) : { kind: "low", action: null, target: null };
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
// "denied" | "too_many" (5 already open) | "unavailable". Never throws for a
// refusal; a database error
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
      const opened = db.prepare("SELECT COUNT(*) AS n FROM relay_confirmations WHERE sender = ? AND state IN ('requested', 'pending') AND expires_at > ?").get(String(sender), now).n;
      if (opened >= kMaxOpenPerSender) {
        db.exec("COMMIT");
        return { admitted: false, state: "too_many", ref: null };
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

module.exports = { classifyRisk, checkConfirmation, isProtectedPath, protectedTargetOf, kConfirmTtlMs, kConfirmationRefPattern, kOpenStates, kMaxOpenPerSender, kAutomationReadActions, kAutomationWriteActions };

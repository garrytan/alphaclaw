const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// Owner provenance, the guard's half (GST-2090 PR4). OpenClaw tells plugins
// which channel message started a turn (message_received: chat, topic,
// message id, sender, text) and, on each tool call, who asked for the turn
// (ctx.requester, with senderIsOwner). When the box agent calls the relay's
// relay_send or relay_reply in a turn the owner started on Telegram, the
// guard writes a claim for that one message into bridge.db and sets
// provenance_ref on the call; AlphaClaw signs it when the message leaves
// (lib/server/relay/outbound.js). On every other call to those tools the
// guard removes provenance_ref, so an agent cannot set one itself.
const kRelaySendTools = Object.freeze(["relay__relay_send", "relay__relay_reply"]);
const kOwnerChannels = Object.freeze(["telegram"]);
const kTurnTtlMs = 30 * 60 * 1000;
const kMaxTurns = 200;
const kMaxQuoteChars = 2000;

const isRelaySendTool = (toolName) => kRelaySendTools.includes(String(toolName || "").toLowerCase());

const text = (value, max = 200) => (value === undefined || value === null || value === "" ? null : String(value).slice(0, max));

// The latest owner-channel message per session, kept in memory only.
const createOwnerTurns = ({ now = () => Date.now() } = {}) => {
  const turns = new Map();
  const record = (event = {}, ctx = {}) => {
    const channel = String(ctx?.channelId || "").toLowerCase();
    if (!kOwnerChannels.includes(channel)) return;
    const sessionKey = text(event?.sessionKey || ctx?.sessionKey, 300);
    const messageId = text(event?.messageId, 120);
    const senderId = text(event?.senderId, 120);
    if (!sessionKey || !messageId || !senderId) return;
    if (turns.size >= kMaxTurns && !turns.has(sessionKey)) turns.delete(turns.keys().next().value);
    const content = String(event?.content ?? "");
    turns.delete(sessionKey);
    turns.set(sessionKey, {
      channel,
      accountId: text(ctx?.accountId, 120),
      conversationId: text(ctx?.conversationId, 200),
      threadId: text(event?.threadId, 120),
      messageId,
      senderId,
      textSha256: crypto.createHash("sha256").update(content, "utf8").digest("hex"),
      quote: content.slice(0, kMaxQuoteChars),
      receivedAt: Number.isFinite(event?.timestamp) ? event.timestamp : now(),
      at: now(),
    });
  };
  // The turn behind a tool call, when the owner asked for it on the same
  // channel, from the same sender, recently.
  const ownerTurnFor = (ctx = {}) => {
    const requester = ctx?.requester || {};
    if (requester.senderIsOwner !== true) return null;
    const turn = turns.get(String(ctx?.sessionKey || ""));
    if (!turn || now() - turn.at > kTurnTtlMs) return null;
    if (String(requester.channel || ctx?.channelId || "").toLowerCase() !== turn.channel) return null;
    if (requester.senderId !== undefined && requester.senderId !== null && String(requester.senderId) !== turn.senderId) return null;
    return turn;
  };
  return { record, ownerTurnFor, size: () => turns.size };
};

// Writes the claim AlphaClaw signs and returns its ref, or null when the
// relay has no bridge.db or no claims table yet.
const writeClaim = ({ rootDir, sessionKey, turn, now = Date.now(), fsModule = fs }) => {
  const dbPath = path.join(rootDir, "relay", "bridge.db");
  if (!fsModule.existsSync(dbPath)) return null;
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA busy_timeout = 2000;");
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'relay_provenance'").get()) return null;
    const ref = "pv_" + crypto.randomBytes(12).toString("hex");
    db.prepare(
      "INSERT INTO relay_provenance (ref, session_key, channel, account_id, conversation_id, thread_id, message_id, sender_id, text_sha256, quote, received_at, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(ref, String(sessionKey), turn.channel, turn.accountId, turn.conversationId, turn.threadId, turn.messageId, turn.senderId, turn.textSha256, turn.quote, turn.receivedAt, now);
    return ref;
  } finally {
    db.close();
  }
};

// The params a relay send goes out with, or null to leave the call as it is:
// the guard's own provenance_ref on an owner turn, and never the caller's.
// OpenClaw merges a hook's params over the call's (2026.11.2,
// mergeParamsWithApprovalOverrides), so a caller's value is blanked, not
// left out.
const withProvenance = ({ params, ref = null }) => {
  const base = params && typeof params === "object" ? params : {};
  if (ref) return { ...base, provenance_ref: ref };
  return Object.hasOwn(base, "provenance_ref") ? { ...base, provenance_ref: "" } : null;
};

module.exports = { kRelaySendTools, kOwnerChannels, kTurnTtlMs, isRelaySendTool, createOwnerTurns, writeClaim, withProvenance };

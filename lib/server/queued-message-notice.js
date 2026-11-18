// Queued-message notice (GST-3049). While an agent run holds a chat's session,
// a new message in that chat waits. OpenClaw normally steers it into the
// running turn, but it falls back to its follow-up queue when it cannot
// (2026.11.4: the running turn has no channel source, such as a subagent's
// completion announce, and the session still carries restart-recovery
// tombstones; the line then says reason=unknown-source-with-terminal-history).
// Nothing tells the sender, so a long announce run reads as a dead agent: 11
// minutes in a Telegram topic.
//
// This reads OpenClaw's own fallback line from the gateway output
// ("[diagnostic] steering rejected; applying follow-up policy ...
// disposition=followup-queued sessionId=<id>" on the plain console styles,
// the same fields as a JSON object in the json style). The line names neither
// the chat nor the sender, so:
// - the sender comes from AlphaClaw's group-guard plugin, which logs
//   "owner inbound chat=<hash of the session key>" for each Telegram turn an
//   owner sends, before OpenClaw queues it. A queued line is an owner's only
//   when an unused owner mark for that session arrived just before it.
// - the chat and the run ahead come from one sessions.list (key,
//   deliveryContext, hasActiveRun, activeRunIds, startedAt).
// When the run ahead started at least 60 s earlier, it posts one short line in
// that Telegram chat or topic through the Bot API: at most once per run per
// chat, never the message's content. It never changes config, sessions or the
// queue.
const { ownerInboundKey, kOwnerInboundLine } = require("../plugin/group-guard");
const { normalizeAccountId } = require("./utils/channels");

const kNoticeText = "Got it — I'm finishing another task in this chat, your message is next.";
const kTopicNoticeText = "Got it — I'm finishing another task in this topic, your message is next.";
const kMinRunAgeMs = 60_000;
const kOwnerMarkWindowMs = 30_000;
const kMaxOwnerMarks = 200;
const kNotifiedTtlMs = 6 * 60 * 60 * 1000;
const kMaxNotified = 500;
const kMaxOutputCarry = 4096;
const kListLimit = 200;
const kGeneralTopicId = "1";

const kAnsi = /\u001b\[[0-9;]*m/g;
const kQueuedMessage = "steering rejected; applying follow-up policy";
const kQueuedDispositions = new Set(["followup-queued", "followup-policy"]);
const kOwnerMark = new RegExp("\\[group-guard\\] " + kOwnerInboundLine + "([0-9a-f]{16})\\b");
const kField = (name) => new RegExp("(?:\\b" + name + "=|\"" + name + "\":)(\"(?:[^\"\\\\]|\\\\.)*\"|[^\\s,}]+)");
const kDispositionField = kField("disposition");
const kSessionIdField = kField("sessionId");
const kChannelField = kField("channel");
const kReasonField = kField("reason");
const kRunIdField = kField("runId");

const readField = (line, pattern) => {
  const raw = pattern.exec(line)?.[1];
  if (!raw) return "";
  if (!raw.startsWith('"')) return raw;
  try {
    return String(JSON.parse(raw));
  } catch {
    return "";
  }
};

// "telegram:-100123:topic:45", "-100123:topic:45", "telegram:group:-100123",
// "123" (a DM). The thread id from deliveryContext wins over a suffix.
const parseTelegramChat = (to, threadId) => {
  const raw = String(to ?? "").trim().replace(/^(?:telegram|tg):/i, "").replace(/^group:/i, "");
  const match = /^(-?\d{1,20})(?::topic:(\d{1,12}))?$/.exec(raw);
  if (!match) return null;
  const thread = threadId != null && /^\d{1,12}$/.test(String(threadId)) ? String(threadId) : match[2] || "";
  return { chatId: match[1], threadId: thread };
};

// The chat a session answers in: its deliveryContext, else its last route,
// else what the session key names (agent:<id>:telegram:group:<chat>:topic:<n>
// or agent:<id>:telegram:direct:<user>).
const resolveTelegramTarget = (row) => {
  const delivery = row?.deliveryContext || {};
  const accountId = delivery.accountId || row?.lastAccountId || "";
  if ((delivery.channel || "telegram") === "telegram" && delivery.to) {
    const chat = parseTelegramChat(delivery.to, delivery.threadId);
    if (chat) return { ...chat, accountId };
  }
  if (row?.lastChannel === "telegram" && row?.lastTo) {
    const chat = parseTelegramChat(row.lastTo, row.lastThreadId);
    if (chat) return { ...chat, accountId };
  }
  const key = String(row?.key || "");
  const group = /:telegram:group:(-\d{1,20})(?::topic:(\d{1,12}))?(?::|$)/.exec(key);
  if (group) return { chatId: group[1], threadId: group[2] || "", accountId };
  const direct = /:telegram:direct:(\d{1,20})(?::|$)/.exec(key);
  if (direct) return { chatId: direct[1], threadId: "", accountId };
  return null;
};

const createQueuedMessageNotice = ({
  listSessions = async () => null,
  sendTelegram = async () => {},
  readOwnerIds = () => [],
  insertEvent = null,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms).unref?.(),
  minRunAgeMs = kMinRunAgeMs,
  logger = console,
} = {}) => {
  const ownerMarks = [];
  const notified = new Map();
  const scheduled = new Set();
  let outputCarry = "";
  let pending = Promise.resolve();

  const log = (message) => logger.log?.("[alphaclaw] queued-notice: " + message);

  const recordEvent = (status, details) => {
    try {
      insertEvent?.({ eventType: "queued_message_notice", source: "queued_notice", status, details });
    } catch {}
  };

  const pruneNotified = (atMs) => {
    for (const [key, at] of notified) {
      if (atMs - at > kNotifiedTtlMs || notified.size > kMaxNotified) notified.delete(key);
    }
  };

  // Each owner turn leaves one mark and each queued line spends at most one
  // logged no later than the line and at most 30 s before it (OpenClaw marks
  // and queues a turn within moments), so a stranger's message queued after
  // an owner's in the same chat finds none, and an owner mark left by a
  // message OpenClaw steered instead of queueing soon expires.
  const usable = (entry, queuedAtMs) => !entry.used && entry.atMs <= queuedAtMs && queuedAtMs - entry.atMs <= kOwnerMarkWindowMs;

  const hasOwnerMark = (queuedAtMs) => {
    while (ownerMarks.length && queuedAtMs - ownerMarks[0].atMs > kOwnerMarkWindowMs) ownerMarks.shift();
    return ownerMarks.some((entry) => usable(entry, queuedAtMs));
  };

  const takeOwnerMark = (sessionKey, queuedAtMs) => {
    if (!hasOwnerMark(queuedAtMs)) return false;
    const hash = ownerInboundKey(sessionKey);
    const mark = ownerMarks.find((entry) => entry.hash === hash && usable(entry, queuedAtMs));
    if (!mark) return false;
    mark.used = true;
    return true;
  };

  const findRow = async (sessionId) => {
    const body = await listSessions({ activeOnly: true, limit: kListLimit, rowMode: "compact" });
    const rows = Array.isArray(body?.sessions) ? body.sessions : [];
    return rows.find((row) => row?.sessionId === sessionId) || null;
  };

  const runKeyOf = (row) => {
    const runIds = Array.isArray(row?.activeRunIds) ? row.activeRunIds.filter((id) => typeof id === "string" && id) : [];
    if (runIds.length) return runIds.slice().sort().join(",");
    return Number.isFinite(row?.startedAt) ? "started:" + row.startedAt : "";
  };

  // A follow-up waits behind a run that is still going. Post when that run is
  // at least minRunAgeMs old; a younger run is looked at again once it would
  // be, and only that same run earns the notice. A run that started after the
  // message was queued, or that is the queued message's own run, is the
  // owner's message already running, never the run ahead of it.
  const consider = async ({ sessionId, channel, reason, runId, queuedAtMs }, { recheck = null } = {}) => {
    if (!recheck && !hasOwnerMark(queuedAtMs)) return "not_owner";
    const row = await findRow(sessionId);
    if (!row || row.hasActiveRun !== true || typeof row.key !== "string") return "not_active";
    if (!recheck && !takeOwnerMark(row.key, queuedAtMs)) return "not_owner";
    if (runId && Array.isArray(row.activeRunIds) && row.activeRunIds.includes(runId)) return "own_run";
    const runKey = runKeyOf(row);
    if (recheck && runKey !== recheck.runKey) return "run_changed";
    // The chat is fixed when the message is queued: a DM session shared by
    // several senders (dmScope main) moves its route to whoever wrote last.
    const target = recheck ? recheck.target : resolveTelegramTarget(row);
    if (!target) return "no_target";
    const kind = target.chatId.startsWith("-") ? (target.threadId ? "topic" : "group") : "dm";
    if (kind === "dm") {
      let owners = [];
      try {
        owners = readOwnerIds() || [];
      } catch {}
      if (!owners.includes(target.chatId)) return "not_owner_dm";
    }
    const atMs = now();
    if (Number.isFinite(row.startedAt) && row.startedAt > queuedAtMs) return "run_changed";
    const startedAt = Number.isFinite(row.startedAt) ? row.startedAt : null;
    const ageMs = startedAt === null ? atMs - queuedAtMs : atMs - startedAt;
    if (ageMs < minRunAgeMs) {
      if (recheck) return "young";
      const scheduleKey = sessionId + "|" + runKey;
      if (scheduled.has(scheduleKey)) return "scheduled";
      scheduled.add(scheduleKey);
      setTimer(() => {
        scheduled.delete(scheduleKey);
        pending = pending.then(() => consider({ sessionId, channel, reason, runId, queuedAtMs }, { recheck: { runKey, target } })).catch(() => {});
      }, minRunAgeMs - ageMs);
      return "scheduled";
    }
    const accountId = normalizeAccountId(target.accountId);
    const dedupeKey = target.chatId + ":" + target.threadId + ":" + accountId + "|" + (runKey || sessionId);
    if (notified.has(dedupeKey)) return "already_notified";
    notified.set(dedupeKey, atMs);
    pruneNotified(atMs);
    const threadId = target.threadId && target.threadId !== kGeneralTopicId ? target.threadId : "";
    const text = kind === "topic" ? kTopicNoticeText : kNoticeText;
    const runAgeS = Math.round(ageMs / 1000);
    try {
      await sendTelegram({ accountId, chatId: target.chatId, threadId, text });
    } catch (error) {
      log("send failed chat=" + kind + ": " + String(error?.message || error).slice(0, 200));
      recordEvent("failed", { channel, chat: kind, runAgeS, reason });
      return "send_failed";
    }
    log("sent chat=" + kind + " runAgeS=" + runAgeS + (reason ? " reason=" + reason : ""));
    recordEvent("sent", { channel, chat: kind, runAgeS, reason });
    return "sent";
  };

  const observeLine = (rawLine) => {
    if (rawLine.includes(kOwnerInboundLine)) {
      const hash = kOwnerMark.exec(rawLine.replace(kAnsi, ""))?.[1];
      if (!hash) return;
      ownerMarks.push({ hash, atMs: now(), used: false });
      if (ownerMarks.length > kMaxOwnerMarks) ownerMarks.shift();
      return;
    }
    if (!rawLine.includes(kQueuedMessage)) return;
    const line = rawLine.replace(kAnsi, "");
    if (!kQueuedDispositions.has(readField(line, kDispositionField))) return;
    const channel = readField(line, kChannelField).toLowerCase();
    const sessionId = readField(line, kSessionIdField);
    if (channel !== "telegram" || !sessionId) return;
    const reason = readField(line, kReasonField).replace(/[^a-z0-9_-]/gi, "").slice(0, 80);
    const runId = readField(line, kRunIdField);
    const queuedAtMs = now();
    pending = pending.then(() => consider({ sessionId, channel, reason, runId, queuedAtMs })).catch((error) => {
      logger.warn?.("[alphaclaw] queued-notice: check failed: " + String(error?.message || error).slice(0, 200));
    });
  };

  const observeGatewayOutput = (text) => {
    const lines = (outputCarry + String(text ?? "")).split("\n");
    outputCarry = lines.pop().slice(-kMaxOutputCarry);
    for (const line of lines) observeLine(line);
  };

  return { observeGatewayOutput, settled: () => pending };
};

module.exports = {
  createQueuedMessageNotice,
  parseTelegramChat,
  resolveTelegramTarget,
  kNoticeText,
  kTopicNoticeText,
};

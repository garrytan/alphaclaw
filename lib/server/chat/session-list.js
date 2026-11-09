// The session list for #/chat (ALPH-68): read from the gateway's own
// sessions.list over the bridge's shared socket instead of a CLI spawn, and
// classified once (kind, label, read-only) from the row's delivery context,
// with the key as the fallback (d6).
const {
  classifySessionKey,
  isReadOnlySessionKind,
  parseRelaySessionKey,
  parseTelegramSessionKey,
} = require("../utils/session-keys");

const kSessionListTtlMs = 15_000;
const kSessionListTimeoutMs = 10_000;
const kPolicyReadMs = 3_000;
const kSessionListLimit = 500;
// A box can hold thousands of sessions (Garry's had 623+ with 54 cron and 181
// dashboard rows); the list pages through sessions.list up to this many.
const kSessionListMaxPages = 10;

// Never ask for transcript-derived fields: rows are shown to the agent actor
// through /api/agent/sessions (d5), so no message text may ride in them.
const kSessionsListParams = {
  configuredAgentsOnly: true,
  excludeSubagents: true,
  excludeSystem: true,
  limit: kSessionListLimit,
};

const clean = (value) => String(value || "").trim();

// "Owner (@bb_owner) id:7000210001" → "Owner (@bb_owner)"
const stripChannelIds = (label) =>
  clean(label)
    .replace(/\s+id:-?\d+(?:\s+topic:\S+)?$/i, "")
    .trim();

const lastDigits = (value, count = 4) => {
  const digits = String(value || "").replace(/\D/g, "");
  return digits ? digits.slice(-count) : "";
};

const readChannel = (row = {}) =>
  clean(row?.deliveryContext?.channel || row?.origin?.provider || row?.origin?.surface || row?.channel).toLowerCase();

const kReadOnlyMessages = {
  relay: "Relay conversations answer the other agent automatically. Read them here; replies go back over Agent Relay.",
  telegram: "This conversation lives in Telegram. Reply from Telegram.",
};

/**
 * Classify one session row. Works on gateway sessions.list rows, CLI rows and
 * bare { key } rows (key fallback).
 * Returns { kind, readOnly, label, isMain, peer?, readOnlyMessage? }.
 */
// dmScope is the box's configured session.dmScope (OpenClaw's default is
// "main"). Only under "main" does a channel deliver DMs into an agent's own
// main key; under any other scope a Telegram delivery context on that row
// (a forum-topic turn run under the bare main key, 2026.10.9) does not make
// the operator's Main read-only.
const classifySessionRow = (row = {}, { topicName = "", groupName = "", dmScope = "main" } = {}) => {
  const key = clean(row?.key || row?.sessionKey);
  const relay = parseRelaySessionKey(key);
  if (relay) {
    return {
      kind: "relay",
      readOnly: true,
      label: `@${relay.peer} · relay` + (relay.lane ? ` · ${relay.lane}` : ""),
      isMain: false,
      peer: relay.peer,
      readOnlyMessage: kReadOnlyMessages.relay,
    };
  }
  const keyKind = classifySessionKey(key);
  const channel = readChannel(row);
  const telegramKey = parseTelegramSessionKey(key);
  const isMainKey = key === "main" || /^agent:[^:]+:main$/.test(key);
  const telegramDelivered = channel === "telegram" && (!isMainKey || dmScope === "main");
  if (telegramDelivered || keyKind.startsWith("telegram-")) {
    const chatType = clean(row?.chatType || row?.origin?.chatType).toLowerCase();
    const isGroup = telegramKey ? telegramKey.scope === "group" : chatType === "group" || chatType === "channel";
    const threadId = clean(row?.origin?.threadId ?? telegramKey?.threadId);
    const title = stripChannelIds(row?.subject || groupName || (isGroup ? row?.displayName : ""));
    let kind = "telegram-dm";
    let label = "";
    if (isGroup && threadId) {
      kind = "telegram-topic";
      const groupLabel = title || `Telegram group …${lastDigits(telegramKey?.groupId)}`;
      label = `${groupLabel} · ${clean(topicName) || `topic ${threadId}`}`;
    } else if (isGroup) {
      kind = "telegram-group";
      label = title || `Telegram group …${lastDigits(telegramKey?.groupId)}`;
    } else {
      label =
        stripChannelIds(row?.displayName || row?.origin?.label) ||
        (telegramKey?.peerId ? `Telegram ${telegramKey.peerId}` : "Telegram chat");
    }
    return {
      kind,
      readOnly: true,
      label: isMainKey ? "Main · Telegram" : label,
      isMain: isMainKey,
      readOnlyMessage: kReadOnlyMessages.telegram,
    };
  }
  const isMain = row?.isMain === true || isMainKey;
  const kind = row?.classification === "cron" ? "cron" : keyKind;
  const label = isMain
    ? "Main"
    : clean(row?.label) || clean(row?.autoLabel) || stripChannelIds(row?.displayName) || clean(row?.subject);
  return { kind, readOnly: isReadOnlySessionKind(kind), label, isMain };
};

const createSessionListCache = ({
  requestGateway,
  ttlMs = kSessionListTtlMs,
  policyReadMs = kPolicyReadMs,
  now = () => Date.now(),
}) => {
  let cached = null;
  let inFlight = null;
  let generation = 0;

  const list = async () => {
    if (cached && now() - cached.atMs < ttlMs) return cached.rows;
    if (!inFlight) {
      const startedGeneration = generation;
      const readAllPages = async () => {
        const rows = [];
        let offset = 0;
        for (let page = 0; page < kSessionListMaxPages; page += 1) {
          const payload = await requestGateway(
            "sessions.list",
            offset > 0 ? { ...kSessionsListParams, offset } : kSessionsListParams,
            kSessionListTimeoutMs,
          );
          const pageRows = Array.isArray(payload?.sessions) ? payload.sessions : [];
          rows.push(...pageRows);
          const nextOffset = Number(payload?.nextOffset);
          if (payload?.hasMore !== true || pageRows.length === 0 || !(nextOffset > offset)) break;
          offset = nextOffset;
        }
        return rows;
      };
      const read = readAllPages()
        .then((rows) => {
          if (startedGeneration === generation) cached = { atMs: now(), rows };
          return rows;
        })
        .finally(() => {
          if (inFlight === read) inFlight = null;
        });
      inFlight = read;
    }
    return inFlight;
  };

  const get = (sessionKey) => {
    const key = clean(sessionKey);
    return cached?.rows.find((row) => clean(row?.key) === key) || null;
  };

  // A send's policy must not fall back to the bare key just because the
  // cache is cold (every sessions.changed empties it): a Telegram-delivered
  // main session is read-only only by its row. So a cold cache is read, and
  // the answer comes from the rows that read returned, which an invalidation
  // during the read cannot take away. Only a read that fails or takes longer
  // than policyReadMs falls back to the key, rather than holding the send.
  const resolve = async (sessionKey) => {
    if (cached) return get(sessionKey);
    let timer = null;
    const deadline = new Promise((resolveDeadline) => {
      timer = setTimeout(() => resolveDeadline(null), policyReadMs);
      if (typeof timer?.unref === "function") timer.unref();
    });
    try {
      const rows = await Promise.race([list(), deadline]);
      const key = clean(sessionKey);
      return (rows || []).find((row) => clean(row?.key) === key) || null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  const invalidate = () => {
    generation += 1;
    cached = null;
    inFlight = null;
  };

  return { list, get, resolve, invalidate };
};

// Read-only policy for a send (d6): the cached list row when known, else the
// key.
const resolveSessionPolicy = (row, sessionKey, { dmScope = "main" } = {}) => {
  const classified = classifySessionRow(row || { key: sessionKey }, { dmScope });
  return classified.readOnly
    ? { readOnly: true, kind: classified.kind, message: classified.readOnlyMessage || "" }
    : { readOnly: false, kind: classified.kind };
};

const readDmScope = (config) => clean(config?.session?.dmScope) || "main";

module.exports = {
  readDmScope,
  classifySessionRow,
  createSessionListCache,
  resolveSessionPolicy,
  kSessionsListParams,
};

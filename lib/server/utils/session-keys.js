// Canonical parser for openclaw telegram session keys. openclaw emits keys
// like `agent:main:telegram:group:-123:topic:42` and suffixed variants such
// as `agent:main:telegram:group:-123:topic:42:heartbeat`, so every segment
// match must tolerate a trailing `:suffix` — anchor with `(?::|$)`, never `$`.
// The client mirror lives in lib/public/js/lib/session-keys.js (ESM, served
// to the browser); tests/server/session-keys.test.js locks the two in parity.

const kAgentPattern = /^agent:([^:]+):/;
const kGroupPattern = /:telegram:group:([^:]+?)(?::topic:([^:]+?))?(?::|$)/;
const kDirectPattern = /:telegram:direct(?::([^:]+?))?(?::|$)/;

const kReservedGroupSegments = new Set(["topic"]);

// Returns null for non-telegram keys, otherwise:
// { agentId, channel: "telegram", scope: "group"|"direct",
//   groupId, threadId|null, peerId|null }
const parseTelegramSessionKey = (sessionKey) => {
  const raw = String(sessionKey || "").trim();
  if (!raw || !raw.includes(":telegram:")) return null;

  const agentId = String(raw.match(kAgentPattern)?.[1] || "").trim();

  const groupMatch = raw.match(kGroupPattern);
  if (groupMatch) {
    const groupId = String(groupMatch[1] || "").trim();
    if (!groupId || kReservedGroupSegments.has(groupId)) return null;
    const threadId = String(groupMatch[2] || "").trim();
    return {
      agentId,
      channel: "telegram",
      scope: "group",
      groupId,
      threadId: threadId || null,
      peerId: null,
    };
  }

  const directMatch = raw.match(kDirectPattern);
  if (directMatch) {
    return {
      agentId,
      channel: "telegram",
      scope: "direct",
      groupId: "",
      threadId: null,
      peerId: String(directMatch[1] || "").trim() || null,
    };
  }

  return null;
};

const isTelegramTopicSessionKey = (sessionKey) => {
  const parsed = parseTelegramSessionKey(sessionKey);
  return !!(parsed && parsed.scope === "group" && parsed.threadId);
};

module.exports = {
  parseTelegramSessionKey,
  isTelegramTopicSessionKey,
};

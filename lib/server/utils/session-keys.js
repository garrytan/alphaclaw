// Canonical parser for openclaw session keys. openclaw emits keys like
// `agent:main:telegram:group:-123:topic:42` and suffixed variants such
// as `agent:main:telegram:group:-123:topic:42:heartbeat`, so every segment
// match must tolerate a trailing `:suffix` — anchor with `(?::|$)`, never `$`.
// The client mirror lives in lib/public/js/lib/session-keys.js (ESM, served
// to the browser); tests/server/session-keys.test.js locks the two in parity.
//
// Delivery-route grammar (mirrors openclaw's own parseSessionDeliveryRoute,
// positional): after `agent:<agentId>:<channel>` —
//   segment 4 = `direct|dm`            → unscoped DM  (…:telegram:direct:1050[:suffix])
//   segment 5 = `direct|dm`            → segment 4 is the accountId
//                                        (…:telegram:default:direct:1050[:suffix])
//   segment 4 = `group`                → group, optional `:topic:<id>` then suffix
//   segment 4 = `channel`              → platform channel
// Account scoping exists only for direct/dm, never groups — so
// `…telegram:direct:1050:heartbeat` is a suffixed unscoped DM, never
// account-scoped.

const kAgentPattern = /^agent:([^:]+):/;
const kGroupPattern = /:telegram:group:([^:]+?)(?::topic:([^:]+?))?(?::|$)/;
// Optional account segment between `telegram` and `direct` (openclaw's
// per-account-channel-peer dmScope). Backtracking keeps plain
// `:telegram:direct:…` matching with no account captured.
const kDirectPattern = /:telegram:(?:([^:]+?):)?direct(?::([^:]+?))?(?::|$)/;

const kReservedGroupSegments = new Set(["topic"]);

// First post-agent segments that are session kinds, not channels — a
// delivery route never starts with one of these.
const kNonChannelKinds = new Set([
  "main",
  "doctor",
  "cron",
  "hook",
  "subagent",
  "slash",
  "spawn",
  "direct",
  "dm",
  "group",
  "channel",
  "topic",
  "thread",
]);

const kDirectScopeSegments = new Set(["direct", "dm"]);

// Channels whose replyTo formats are verified against the pinned openclaw
// (see docs: telegram targets accept bare chat ids / `chatId:topicId`;
// discord/slack DMs REQUIRE `user:<id>`, channels `channel:<id>`; whatsapp
// uses raw JIDs). Unknown/plugin channels still parse (labels, icons) but
// never claim a deliverable reply target.
const kTypedReplyChannels = new Set(["telegram", "discord", "slack", "whatsapp"]);

// Returns null when the key carries no delivery route, otherwise:
// { agentId, channel, scope: "direct"|"group"|"channel",
//   accountId|null, peerId|null, groupId, threadId|null }
const parseSessionDeliveryRoute = (sessionKey) => {
  const raw = String(sessionKey || "").trim();
  if (!raw) return null;
  const agentMatch = raw.match(/^agent:([^:]+):(.+)$/);
  if (!agentMatch) return null;
  const agentId = String(agentMatch[1] || "").trim();
  const segments = agentMatch[2].split(":");
  const channel = String(segments[0] || "").trim().toLowerCase();
  if (!channel || kNonChannelKinds.has(channel)) return null;

  const scopeSegment = String(segments[1] || "").trim();
  const base = { agentId, channel, accountId: null, peerId: null, groupId: "", threadId: null };

  if (kDirectScopeSegments.has(scopeSegment)) {
    const peerId = String(segments[2] || "").trim();
    if (!peerId) return null;
    return { ...base, scope: "direct", peerId };
  }
  if (scopeSegment === "group") {
    const groupId = String(segments[2] || "").trim();
    if (!groupId || kReservedGroupSegments.has(groupId)) return null;
    const threadId =
      String(segments[3] || "").trim() === "topic" ? String(segments[4] || "").trim() : "";
    return { ...base, scope: "group", groupId, threadId: threadId || null };
  }
  if (scopeSegment === "channel") {
    const peerId = String(segments[2] || "").trim();
    if (!peerId) return null;
    return { ...base, scope: "channel", peerId };
  }
  // Account-scoped direct: segment 5 is direct/dm, segment 4 the accountId.
  if (scopeSegment && kDirectScopeSegments.has(String(segments[2] || "").trim())) {
    const peerId = String(segments[3] || "").trim();
    if (!peerId) return null;
    return { ...base, scope: "direct", accountId: scopeSegment, peerId };
  }
  return null;
};

// Maps a session key to the gateway delivery params. Empty strings mean
// "no deliverable reply target" — the caller must NOT set deliver:true.
const getReplyTargetFromSessionKey = (sessionKey) => {
  const empty = { replyChannel: "", replyTo: "", replyAccountId: "" };
  const route = parseSessionDeliveryRoute(sessionKey);
  if (!route || !kTypedReplyChannels.has(route.channel)) return empty;

  const replyAccountId = route.accountId || "";
  if (route.channel === "telegram" || route.channel === "whatsapp") {
    if (route.scope === "direct" || route.scope === "channel") {
      return route.peerId
        ? { replyChannel: route.channel, replyTo: route.peerId, replyAccountId }
        : empty;
    }
    // Telegram topic targets are `groupId:topicId` (parseTelegramTarget
    // accepts both this and the `groupId:topic:topicId` long form).
    const replyTo = route.threadId ? `${route.groupId}:${route.threadId}` : route.groupId;
    return replyTo ? { replyChannel: route.channel, replyTo, replyAccountId } : empty;
  }
  // discord/slack: bare ids resolve as CHANNEL ids upstream, so DMs must be
  // explicit `user:<id>` targets.
  if (route.scope === "direct") {
    return { replyChannel: route.channel, replyTo: `user:${route.peerId}`, replyAccountId };
  }
  const channelId = route.scope === "group" ? route.groupId : route.peerId;
  return channelId
    ? { replyChannel: route.channel, replyTo: `channel:${channelId}`, replyAccountId }
    : empty;
};

// Returns null for non-telegram keys, otherwise:
// { agentId, channel: "telegram", scope: "group"|"direct",
//   groupId, threadId|null, peerId|null, accountId|null }
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
      accountId: null,
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
      peerId: String(directMatch[2] || "").trim() || null,
      accountId: String(directMatch[1] || "").trim() || null,
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
  parseSessionDeliveryRoute,
  getReplyTargetFromSessionKey,
};

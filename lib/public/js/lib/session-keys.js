export const getNormalizedSessionKey = (sessionKey = "") =>
  String(sessionKey || "").trim();

export const getSessionRowKey = (sessionRow = null) =>
  getNormalizedSessionKey(sessionRow?.key || sessionRow?.sessionKey || "");

export const getAgentIdFromSessionKey = (sessionKey = "") => {
  const normalizedSessionKey = getNormalizedSessionKey(sessionKey);
  const agentMatch = normalizedSessionKey.match(/^agent:([^:]+):/);
  return String(agentMatch?.[1] || "").trim();
};

export const isDestinationSessionKey = (sessionKey = "") => {
  const normalizedSessionKey = getNormalizedSessionKey(sessionKey).toLowerCase();
  return (
    normalizedSessionKey.includes(":direct:") ||
    normalizedSessionKey.includes(":group:")
  );
};

export const kDestinationSessionFilter = (sessionRow) =>
  !!(
    String(sessionRow?.replyChannel || "").trim() &&
    String(sessionRow?.replyTo || "").trim()
  ) || isDestinationSessionKey(getSessionRowKey(sessionRow));

const kSessionPriority = {
  destination: 0,
  other: 1,
};

export const getSessionPriority = (sessionRow = null) =>
  isDestinationSessionKey(getSessionRowKey(sessionRow))
    ? kSessionPriority.destination
    : kSessionPriority.other;

export const sortSessionsByPriority = (sessions = []) =>
  [...(Array.isArray(sessions) ? sessions : [])].sort((leftRow, rightRow) => {
    const priorityDiff = getSessionPriority(leftRow) - getSessionPriority(rightRow);
    if (priorityDiff !== 0) return priorityDiff;
    const updatedAtDiff =
      Number(rightRow?.updatedAt || 0) - Number(leftRow?.updatedAt || 0);
    if (updatedAtDiff !== 0) return updatedAtDiff;
    return getSessionRowKey(leftRow).localeCompare(getSessionRowKey(rightRow));
  });

export const getDestinationFromSession = (sessionRow = null) => {
  const channel = String(sessionRow?.replyChannel || "").trim();
  const to = String(sessionRow?.replyTo || "").trim();
  if (!channel || !to) return null;
  const agentId = getAgentIdFromSessionKey(getSessionRowKey(sessionRow));
  return {
    channel,
    to,
    ...(agentId ? { agentId } : {}),
  };
};

// Mirror of lib/server/utils/session-keys.js — the browser cannot import the
// CJS server module, so the logic is duplicated here and locked in parity by
// tests/server/session-keys.test.js. Suffix-tolerant: openclaw emits keys
// like `…:topic:42:heartbeat`, so segments end at `(?::|$)`, never `$`.
// Delivery-route grammar is positional (mirrors openclaw): after
// `agent:<id>:<channel>`, segment 4 = direct|dm ⇒ unscoped DM; segment 5 =
// direct|dm ⇒ segment 4 is the accountId. Account scoping exists only for
// direct/dm.
const kTelegramAgentPattern = /^agent:([^:]+):/;
const kTelegramGroupPattern = /:telegram:group:([^:]+?)(?::topic:([^:]+?))?(?::|$)/;
const kTelegramDirectPattern = /:telegram:(?:([^:]+?):)?direct(?::([^:]+?))?(?::|$)/;
const kReservedGroupSegments = new Set(["topic"]);
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
const kTypedReplyChannels = new Set(["telegram", "discord", "slack", "whatsapp"]);

export const parseSessionDeliveryRoute = (sessionKey = "") => {
  const raw = getNormalizedSessionKey(sessionKey);
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
  if (scopeSegment && kDirectScopeSegments.has(String(segments[2] || "").trim())) {
    const peerId = String(segments[3] || "").trim();
    if (!peerId) return null;
    return { ...base, scope: "direct", accountId: scopeSegment, peerId };
  }
  return null;
};

export const getReplyTargetFromSessionKey = (sessionKey = "") => {
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
    const replyTo = route.threadId ? `${route.groupId}:${route.threadId}` : route.groupId;
    return replyTo ? { replyChannel: route.channel, replyTo, replyAccountId } : empty;
  }
  if (route.scope === "direct") {
    return { replyChannel: route.channel, replyTo: `user:${route.peerId}`, replyAccountId };
  }
  const channelId = route.scope === "group" ? route.groupId : route.peerId;
  return channelId
    ? { replyChannel: route.channel, replyTo: `channel:${channelId}`, replyAccountId }
    : empty;
};

export const parseTelegramSessionKey = (sessionKey = "") => {
  const raw = getNormalizedSessionKey(sessionKey);
  if (!raw || !raw.includes(":telegram:")) return null;

  const agentId = String(raw.match(kTelegramAgentPattern)?.[1] || "").trim();

  const groupMatch = raw.match(kTelegramGroupPattern);
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

  const directMatch = raw.match(kTelegramDirectPattern);
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

/** Matches server `parseChannelFromSessionKey` for icon routing when `channel` is absent (cached rows). */
export const parseChannelFromSessionKey = (sessionKey = "") => {
  const k = String(sessionKey || "");
  if (k.includes(":telegram:")) return "telegram";
  if (k.includes(":discord:")) return "discord";
  if (k.includes(":slack:")) return "slack";
  if (k.includes(":whatsapp:")) return "whatsapp";
  return "";
};

const getTopicIdsFromSessionKey = (sessionKey = "") => {
  const parsed = parseTelegramSessionKey(sessionKey);
  if (parsed?.scope === "group" && parsed.threadId) {
    return { groupId: parsed.groupId, topicId: parsed.threadId };
  }
  return { groupId: "", topicId: "" };
};

export const getSessionKind = (sessionKey = "") => {
  const normalizedSessionKey = getNormalizedSessionKey(sessionKey);
  if (!normalizedSessionKey) return "other";
  if (normalizedSessionKey === "main" || normalizedSessionKey.endsWith(":main")) {
    return "main";
  }
  if (/:telegram:group:([^:]+):topic:([^:]+)(?::|$)/.test(normalizedSessionKey)) {
    return "topic";
  }
  if (normalizedSessionKey.includes(":slash:")) return "slash";
  if (normalizedSessionKey.includes(":subagent:")) return "subagent";
  // Suffix/account tolerant: `…:direct:1050:heartbeat` and
  // `…:telegram:default:direct:1050` are both DMs.
  if (parseSessionDeliveryRoute(normalizedSessionKey)?.scope === "direct") {
    return "direct";
  }
  if (/:direct:([^:]+)(?::|$)/.test(normalizedSessionKey)) return "direct";
  return "other";
};

const getDirectPeerIdFromSessionKey = (sessionKey = "") => {
  const route = parseSessionDeliveryRoute(sessionKey);
  if (route?.scope === "direct" && route.peerId) return route.peerId;
  const directMatch = getNormalizedSessionKey(sessionKey).match(/:direct:([^:]+?)(?::|$)/);
  return String(directMatch?.[1] || "").trim();
};

export const getSessionDisplayLabel = (sessionRow = null) => {
  const key = getSessionRowKey(sessionRow);
  const kind = getSessionKind(key);
  if (kind === "main") return "Main Thread";

  const doctorMatch = key.match(/(?:^|:)doctor:(\d+)$/);
  if (doctorMatch) return `Doctor Run #${doctorMatch[1]}`;
  if (/(?:^|:)doctor(?::|$)/.test(key)) return "Doctor Run";

  if (kind === "topic") {
    const { groupId, topicId } = getTopicIdsFromSessionKey(key);
    const topicName = String(sessionRow?.topicName || "").trim();
    const groupName = String(sessionRow?.groupName || "").trim();
    const topicLabel = topicName || (topicId ? `Topic ${topicId}` : "Topic");
    const groupLabel = groupName || groupId;
    return groupLabel ? `${topicLabel} - ${groupLabel}` : topicLabel;
  }

  if (kind === "direct") {
    const directTarget = getDirectPeerIdFromSessionKey(key);
    if (parseChannelFromSessionKey(key) === "telegram") {
      // Peer-qualified: two DMs from different peers/agents must not render
      // as identical "Direct message" rows in a delivery picker.
      return directTarget ? `Direct message · ${directTarget}` : "Direct message";
    }
    return directTarget ? `Direct ${directTarget}` : "Direct";
  }

  return key || "Session";
};

/** Channel id for platform icons; prefers API `channel`, else parses from key / replyChannel. */
export const getSessionChannelForIcon = (sessionRow = null) => {
  const fromRow = String(sessionRow?.channel || "").trim();
  if (fromRow) return fromRow;
  const fromReply = String(sessionRow?.replyChannel || "").trim();
  if (fromReply) return fromReply;
  return parseChannelFromSessionKey(getSessionRowKey(sessionRow));
};

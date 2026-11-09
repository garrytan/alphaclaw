const { describeAccount, isBlockedGroupRecord, isValidTelegramGroupId, isValidTelegramUserId, parseTelegramUserId, pickOwned } = require("./telegram-groups");
const { TelegramGroupsError } = require("./telegram-groups-errors");
const { describeGroupGuard } = require("./telegram-group-guard-entry");

// "Test this group" (GST-1975 d9): what Wintermute would do with a message
// from each known sender, plus anyone else. The group and tool layers come
// from OpenClaw's own plugin-SDK resolvers (resolveChannelGroupPolicy,
// resolveChannelGroupRequireMention, resolveChannelGroupToolsPolicy, which
// calls resolveToolsBySender); the Telegram ingress rule (enabled, the
// group's policy and its allowFrom override) follows the pinned Telegram
// channel's group-access check and is held to the gateway by the live tier
// (tests/live/telegram-groups.e2e.test.js); AlphaClaw's group guard is read
// from its own block list and owners (group-rules.json, exactly what the
// plugin reads), and counts only when openclaw.json loads the plugin. Other plugins on the box (for example a guard of
// your own) can still refuse a turn, and are listed as not modelled.
const kAnyoneElseId = "0";
const kKnownPlugins = new Set(["telegram", "group-guard", "relay-guard", "usage-tracker"]);

let sdkPromise = null;
const loadSdk = () => (sdkPromise ||= import("openclaw/plugin-sdk/channel-policy"));

const listIds = (values) => (Array.isArray(values) ? values : []).map(parseTelegramUserId).filter(Boolean);
const allowListMatches = (list, senderId) => list.some((entry) => String(entry).trim() === "*") || listIds(list).includes(senderId);

const describeTools = (policy) => {
  if (!policy || (!policy.deny?.length && !policy.allow?.length)) return { actions: "all", policy: policy || null };
  if (policy.deny?.includes("*")) return { actions: "none", policy };
  return { actions: "limited", policy };
};

const collectSenders = ({ owners, state, groupId, entry, accountConfig, extraIds }) => {
  const senders = new Map();
  const add = (id, role, label) => {
    if (!isValidTelegramUserId(id)) return;
    const known = senders.get(id);
    if (known) {
      if (!known.roles.includes(role)) known.roles.push(role);
      if (!known.label && label) known.label = label;
      return;
    }
    senders.set(id, { id, roles: [role], label: label || null });
  };
  for (const id of owners) add(id, "owner", null);
  for (const person of state.groups[groupId]?.trusted || []) add(person.id, "trusted_" + person.scope, person.label);
  for (const id of listIds(entry?.allowFrom)) add(id, "group_allow_from", null);
  for (const key of Object.keys(entry?.toolsBySender || {})) {
    const id = /^id:(\d{1,20})$/.exec(key)?.[1];
    if (id) add(id, "tools_by_sender", null);
  }
  for (const id of listIds(accountConfig?.groupAllowFrom)) add(id, "account_group_allow_from", null);
  for (const person of state.blockedSenders) add(String(person.id), "blocked", person.label);
  for (const id of extraIds) add(id, "asked", null);
  return [...senders.values()];
};

const runGroupTest = async ({ cfg, state, accountId = "default", groupId, senderIds = [] }) => {
  if (!isValidTelegramGroupId(groupId)) throw new TelegramGroupsError("invalid_group_id");
  if (!Array.isArray(senderIds) || senderIds.length > 50 || senderIds.some((id) => !isValidTelegramUserId(String(id)))) {
    throw new TelegramGroupsError("invalid_input", "senderIds must be at most 50 numeric Telegram user ids");
  }
  const { target, accountConfig, owners, accountPolicy, groupsMap } = describeAccount({ cfg, state, accountId });
  if (!target) throw new TelegramGroupsError("telegram_not_configured");
  const sdk = await loadSdk();
  const entry = groupsMap[groupId] || null;
  const blockedGroup = isBlockedGroupRecord(state.groups[groupId]);
  const blockedSenders = new Set(state.blockedSenders.map((person) => String(person.id)));
  const guardOwners = listIds(state.owners);
  const groupGuard = describeGroupGuard(cfg);
  const accountGroupAllowFrom = Array.isArray(accountConfig.groupAllowFrom) ? accountConfig.groupAllowFrom : [];
  const groupAccess = sdk.resolveChannelGroupPolicy({ cfg, channel: "telegram", accountId, groupId, hasGroupAllowFrom: accountGroupAllowFrom.length > 0 });
  const requireMention = sdk.resolveChannelGroupRequireMention({ cfg, channel: "telegram", accountId, groupId });
  const effectivePolicy = entry?.groupPolicy ?? accountPolicy ?? "allowlist";
  const hasOverride = Array.isArray(entry?.allowFrom);
  const effectiveAllow = hasOverride ? entry.allowFrom : accountGroupAllowFrom;
  const notModelled = Object.entries(cfg?.plugins?.entries || {})
    .filter(([id, value]) => value?.enabled !== false && !kKnownPlugins.has(id))
    .map(([id]) => id)
    .concat(groupGuard.reason === "foreign" ? ["group-guard"] : [])
    .sort();

  const answer = (senderId) => {
    const layers = [];
    const silent = (layer, reason, source) => {
      layers.push({ layer, source, allowed: false, reason });
      return { reply: "never", actions: "none", reason, layers };
    };
    if (!groupAccess.allowed) return silent("openclaw.group", "group-chat-not-allowed", "resolveChannelGroupPolicy");
    layers.push({ layer: "openclaw.group", source: "resolveChannelGroupPolicy", allowed: true });
    if (entry?.enabled === false) return silent("telegram.ingress", "group-disabled", "telegram group access");
    if (effectivePolicy === "disabled") return silent("telegram.ingress", "group-policy-disabled", "telegram group access");
    if (hasOverride && (!effectiveAllow.length || !allowListMatches(effectiveAllow, senderId))) return silent("telegram.ingress", "group-override-unauthorized", "telegram group access");
    if (effectivePolicy === "allowlist" && !(Boolean(groupAccess.groupConfig) && !effectiveAllow.length) && !allowListMatches(effectiveAllow, senderId)) {
      return silent("telegram.ingress", effectiveAllow.length || groupAccess.groupConfig ? "group-policy-allowlist-unauthorized" : "group-policy-allowlist-empty", "telegram group access");
    }
    layers.push({ layer: "telegram.ingress", source: "telegram group access", allowed: true, groupPolicy: effectivePolicy });
    const isOwner = guardOwners.includes(senderId);
    const guardReason = isOwner ? null : blockedSenders.has(senderId) ? "blocked_sender" : blockedGroup ? "blocked_group" : null;
    if (guardReason && groupGuard.enforced) return silent("alphaclaw.group-guard", guardReason, "group-rules.json");
    layers.push(guardReason ? { layer: "alphaclaw.group-guard", source: "group-rules.json", allowed: true, enforced: false, reason: "guard_not_enforced", wouldDrop: guardReason } : { layer: "alphaclaw.group-guard", source: "group-rules.json", allowed: true });
    const tools = describeTools(sdk.resolveChannelGroupToolsPolicy({ cfg, channel: "telegram", accountId, groupId, senderId, messageProvider: "telegram" }));
    layers.push({ layer: "openclaw.tools", source: "resolveChannelGroupToolsPolicy", allowed: true, actions: tools.actions, policy: tools.policy });
    if (notModelled.length) layers.push({ layer: "box.plugins", source: "not modelled", plugins: notModelled });
    return { reply: requireMention ? "when_mentioned" : "always", actions: tools.actions, reason: null, layers };
  };

  const senders = collectSenders({ owners, state, groupId, entry, accountConfig, extraIds: senderIds.map(String) });
  return {
    groupId,
    rules: entry ? pickOwned(entry) : null,
    requireMention,
    notModelled,
    groupGuard,
    senders: [
      ...senders.map((sender) => ({ ...sender, ...answer(sender.id) })),
      { id: null, roles: ["anyone_else"], label: "Anyone else", ...answer(kAnyoneElseId) },
    ],
  };
};

module.exports = { runGroupTest };

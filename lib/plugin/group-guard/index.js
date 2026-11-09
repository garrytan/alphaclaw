const fs = require("fs");
const os = require("os");
const path = require("path");

// AlphaClaw's group guard (GST-1975 PR 1): an OpenClaw plugin whose
// before_dispatch hook drops Telegram turns from people and groups the owner
// blocked on the Groups page. OpenClaw has no sender block list, and an
// Approved group is open to every member, so this is the layer that keeps a
// blocked person silent there. A dropped turn answers {handled: true} with no
// text, so OpenClaw sends nothing and runs no agent. The owners are never
// dropped, whatever the file says. The block list is
// <rootDir>/telegram/group-rules.json, written by AlphaClaw and re-read when
// its mtime changes; a missing or unreadable file blocks nobody.
const kPluginId = "group-guard";
const kMarker = "[group-guard]";
const kMaxLoggedDrops = 2000;

const parseUserId = (value) => {
  const match = /^(?:(?:telegram|tg):)?(\d{1,20})$/i.exec(String(value ?? "").trim());
  return match ? match[1] : "";
};

const aliases = (groupId) => {
  if (!/^-\d{5,20}$/.test(groupId)) return [groupId];
  if (groupId.startsWith("-100") && groupId.length > 4) return [groupId, "-" + groupId.slice(4)];
  return [groupId, "-100" + groupId.slice(1)];
};

// Telegram conversation ids and session keys carry the chat id; a group
// chat id is negative.
const parseGroupId = (...values) => {
  for (const value of values) {
    const match = /(?:^|[^\d])(-\d{5,20})(?!\d)/.exec(String(value ?? ""));
    if (match) return match[1];
  }
  return "";
};

const createRulesReader = ({ rootDir, fsModule = fs }) => {
  const file = path.join(rootDir, "telegram", "group-rules.json");
  let cache = { key: "", rules: { senders: new Set(), groups: new Set(), owners: new Set() } };
  return () => {
    let stat;
    try {
      stat = fsModule.statSync(file);
    } catch {
      cache = { key: "", rules: { senders: new Set(), groups: new Set(), owners: new Set() } };
      return cache.rules;
    }
    const key = stat.mtimeMs + ":" + stat.size;
    if (key === cache.key) return cache.rules;
    const parsed = JSON.parse(fsModule.readFileSync(file, "utf8"));
    const senders = new Set((Array.isArray(parsed?.blockedSenders) ? parsed.blockedSenders : []).map((entry) => parseUserId(entry?.id)).filter(Boolean));
    const groups = new Set();
    for (const [groupId, record] of Object.entries(parsed?.groups && typeof parsed.groups === "object" ? parsed.groups : {})) {
      if (record?.mode === "blocked" || record?.pendingBlockAt) for (const alias of aliases(groupId)) groups.add(alias);
    }
    const owners = new Set((Array.isArray(parsed?.owners) ? parsed.owners : []).map(parseUserId).filter(Boolean));
    cache = { key, rules: { senders, groups, owners } };
    return cache.rules;
  };
};

const createGroupGuardPlugin = () => ({
  id: kPluginId,
  name: "AlphaClaw Group Guard",
  description: "Drops Telegram turns from people and groups blocked in AlphaClaw's Telegram group rules, with no reply",
  register: (api) => {
    const logger = api?.logger;
    const pluginConfig = api?.pluginConfig && typeof api.pluginConfig === "object" ? api.pluginConfig : {};
    const rootDir = String(pluginConfig.rootDir || process.env.ALPHACLAW_ROOT_DIR || path.join(os.homedir(), ".alphaclaw"));
    const configOwners = new Set((Array.isArray(pluginConfig.ownerIds) ? pluginConfig.ownerIds : []).map(parseUserId).filter(Boolean));
    const readRules = createRulesReader({ rootDir });
    const logged = new Set();
    const logDrop = (reason, who) => {
      const key = reason + "|" + who;
      if (logged.has(key)) return;
      if (logged.size >= kMaxLoggedDrops) logged.clear();
      logged.add(key);
      logger?.info?.(kMarker + " dropped a turn reason=" + reason + " " + who);
    };
    let warnedUnreadable = false;
    api.on("before_dispatch", (event, ctx) => {
      const channel = String(event?.channel || ctx?.channelId || "").toLowerCase();
      if (channel !== "telegram") return undefined;
      let rules;
      try {
        rules = readRules();
      } catch (error) {
        if (!warnedUnreadable) logger?.warn?.(kMarker + " cannot read the block list; blocking nobody: " + String(error?.message || error).slice(0, 200));
        warnedUnreadable = true;
        return undefined;
      }
      warnedUnreadable = false;
      const senderId = parseUserId(event?.senderId ?? ctx?.senderId);
      if (senderId && (configOwners.has(senderId) || rules.owners.has(senderId))) return undefined;
      if (senderId && rules.senders.has(senderId)) {
        logDrop("blocked_sender", "sender=" + senderId);
        return { handled: true };
      }
      const groupId = parseGroupId(ctx?.conversationId, event?.sessionKey, ctx?.sessionKey);
      if (groupId && rules.groups.has(groupId)) {
        logDrop("blocked_group", "group=" + groupId);
        return { handled: true };
      }
      return undefined;
    });
    logger?.info?.(kMarker + " active: drops Telegram turns from blocked people and groups");
  },
});

const plugin = createGroupGuardPlugin();
module.exports = plugin;
module.exports.default = plugin;
module.exports.createGroupGuardPlugin = createGroupGuardPlugin;
module.exports.kGroupGuardPluginId = kPluginId;
module.exports.parseGroupId = parseGroupId;

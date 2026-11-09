const fs = require("fs");
const os = require("os");
const path = require("path");

// AlphaClaw's group guard (GST-1975 PR 1): an OpenClaw plugin whose
// before_dispatch hook drops Telegram turns from people and groups the owner
// blocked on the Groups page. OpenClaw has no sender block list, and an
// Approved group is open to every member, so this is the layer that keeps a
// blocked person silent there. A dropped turn answers {handled: true} with no
// text, so OpenClaw sends nothing and runs no agent. The owners listed in the
// file (AlphaClaw rewrites them from openclaw.json on every write and at
// startup) are never dropped. The block list is
// <rootDir>/telegram/group-rules.json, written by AlphaClaw and re-read when
// its mtime changes. A missing file blocks nobody. A file that cannot be read
// as a JSON object keeps the last rules read from it. With none (a gateway
// that started over a damaged or unreadable file) the guard falls back to
// group-rules.last-good.json, the copy AlphaClaw writes beside it on every
// save, and enforces the blocks in that copy. It drops only turns it can
// prove were blocked: with no readable copy either it blocks nobody, so a
// damaged file never silences the owner's DMs or an approved group. The
// owners in OpenClaw's own config (commands.ownerAllowFrom, else every
// Telegram account's allowFrom) are never dropped by the copy's blocks. A
// rule matches only the exact chat id.
const kPluginId = "group-guard";
const kMarker = "[group-guard]";
const kMaxLoggedDrops = 2000;

const parseUserId = (value) => {
  const match = /^(?:(?:telegram|tg):)?(\d{1,20})$/i.exec(String(value ?? "").trim());
  return match ? match[1] : "";
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

const emptyRules = () => ({ senders: new Set(), groups: new Set(), owners: new Set() });

// The owners in OpenClaw's own config, read the way AlphaClaw reads them.
const configOwners = (cfg) => {
  const ids = (values) => (Array.isArray(values) ? values : []).map(parseUserId).filter(Boolean);
  const fromCommands = ids(cfg?.commands?.ownerAllowFrom);
  if (fromCommands.length) return new Set(fromCommands);
  const telegram = cfg?.channels?.telegram;
  const accounts = telegram?.accounts && typeof telegram.accounts === "object" ? Object.values(telegram.accounts) : [];
  return new Set([telegram?.allowFrom, ...accounts.map((account) => account?.allowFrom)].flatMap(ids));
};
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// Returns { rules } ({ rules: <none>, missing: true } for a missing file) or,
// for a file that is not a readable JSON object,
// { rules: <last good rules, or null when none were read>, error }.
const createRulesReader = ({ file, fsModule = fs }) => {
  let cache = { key: "", rules: null };
  return () => {
    let stat;
    try {
      stat = fsModule.statSync(file);
    } catch (error) {
      if (error?.code !== "ENOENT") return { rules: cache.rules, error };
      cache = { key: "", rules: emptyRules() };
      return { rules: cache.rules, missing: true };
    }
    const key = stat.mtimeMs + ":" + stat.size;
    if (key === cache.key && cache.rules) return { rules: cache.rules };
    let parsed;
    try {
      parsed = JSON.parse(fsModule.readFileSync(file, "utf8"));
      if (!isPlainObject(parsed)) throw new Error("not a JSON object");
      if (parsed.groups !== undefined && !isPlainObject(parsed.groups)) throw new Error("groups is not an object");
      if (parsed.blockedSenders !== undefined && !Array.isArray(parsed.blockedSenders)) throw new Error("blockedSenders is not a list");
    } catch (error) {
      return { rules: cache.rules, error };
    }
    const senders = new Set((parsed.blockedSenders || []).map((entry) => parseUserId(entry?.id)).filter(Boolean));
    const groups = new Set();
    for (const [groupId, record] of Object.entries(parsed.groups || {})) {
      if (record?.mode === "blocked" || record?.pendingBlockAt) groups.add(groupId);
    }
    const owners = new Set((Array.isArray(parsed.owners) ? parsed.owners : []).map(parseUserId).filter(Boolean));
    cache = { key, rules: { senders, groups, owners } };
    return { rules: cache.rules };
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
    const readRules = createRulesReader({ file: path.join(rootDir, "telegram", "group-rules.json") });
    const readLastGood = createRulesReader({ file: path.join(rootDir, "telegram", "group-rules.last-good.json") });
    const logged = new Set();
    const logDrop = (reason, who) => {
      const key = reason + "|" + who;
      if (logged.has(key)) return;
      if (logged.size >= kMaxLoggedDrops) logged.clear();
      logged.add(key);
      logger?.info?.(kMarker + " dropped a turn reason=" + reason + " " + who);
    };
    const currentConfig = () => {
      try {
        return api?.runtime?.config?.current?.() || api?.config || {};
      } catch {
        return api?.config || {};
      }
    };
    let warnedUnreadable = "";
    api.on("before_dispatch", (event, ctx) => {
      const channel = String(event?.channel || ctx?.channelId || "").toLowerCase();
      if (channel !== "telegram") return undefined;
      const read = readRules();
      let { rules } = read;
      let fallback = "";
      if (!rules) {
        const lastGood = readLastGood();
        const saved = lastGood.missing ? null : lastGood.rules;
        rules = saved || emptyRules();
        fallback = saved ? "last_good" : "none";
      }
      const warning = read.error ? fallback || "cached" : "";
      if (warning && warning !== warnedUnreadable) {
        const detail = String(read.error?.message || read.error).slice(0, 200);
        const effect = {
          cached: "keeping the last rules read: ",
          last_good: "no rules were read yet, so the blocks in the last copy AlphaClaw saved are enforced until it is fixed: ",
          none: "no rules were read yet and no saved copy reads, so no block is enforced until it is fixed: ",
        }[warning];
        logger?.warn?.(kMarker + " cannot read the block list; " + effect + detail);
      }
      warnedUnreadable = warning;
      const senderId = parseUserId(event?.senderId ?? ctx?.senderId);
      if (senderId && rules.owners.has(senderId)) return undefined;
      if (fallback && senderId && configOwners(currentConfig()).has(senderId)) return undefined;
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

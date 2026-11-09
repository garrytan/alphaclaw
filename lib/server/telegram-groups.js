const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { readOpenclawConfigForWrite, updateOpenclawConfig } = require("./openclaw-config");
const { writeFileAtomic } = require("./utils/safe-file");
const { normalizeAccountId } = require("./utils/channels");
const { resolveTelegramAccountConfig } = require("./telegram-workspace");
const { TelegramGroupsError, toTelegramGroupsError } = require("./telegram-groups-errors");

// Telegram group rules (GST-1975 PR 1). This module owns five keys on each
// channels.telegram[.accounts.<id>].groups.<groupId> entry: enabled,
// groupPolicy, allowFrom, tools and toolsBySender. A mode change clears all
// five and writes the mode's shape; every other key (requireMention, topics,
// systemPrompt...) is the operator's and is kept. OpenClaw enforces the shape
// at ingress and at tool policy, before any plugin runs:
//   approved  enabled, groupPolicy "open", owners and trusted people by
//             typed id, "*" denied every tool (members talk, only the owner
//             and people trusted with actions act)
//   trusted   enabled, groupPolicy "allowlist", allowFrom = owners + trusted
//             people (a per-group allowFrom replaces groupAllowFrom, so the
//             owners are always written into it), same toolsBySender
//   silent    enabled:false, entry kept (an empty groups map under an
//             allowlist admits any group an allowed sender posts in)
//   blocked   silent, plus the group-guard plugin drops its turns and the
//             bot leaves it (state first, then config, then leaveChat)
// Entries the page did not write read as "custom" until converted, so a
// click never rewrites rules nobody has looked at.
const kModes = Object.freeze(["approved", "trusted", "silent", "blocked"]);
const kOwnedKeys = Object.freeze(["enabled", "groupPolicy", "allowFrom", "tools", "toolsBySender"]);
const kTopicOverrideKeys = Object.freeze(["enabled", "groupPolicy", "allowFrom"]);
const kScopes = Object.freeze(["actions", "conversation"]);
const kGroupIdPattern = /^-\d{5,20}$/;
const kUserIdPattern = /^\d{1,20}$/;
const kMaxTrusted = 200;
const kMaxBlockedSenders = 2000;
const kMaxLabelChars = 120;
const kMaxBackups = 100;
const kLeaveAttempts = 3;
const kStateVersion = 1;

const isValidTelegramGroupId = (value) => typeof value === "string" && kGroupIdPattern.test(value);
const isValidTelegramUserId = (value) => typeof value === "string" && kUserIdPattern.test(value);

const resolveStatePaths = (rootDir) => {
  const dir = path.join(rootDir, "telegram");
  return { dir, statePath: path.join(dir, "group-rules.json"), backupsDir: path.join(dir, "group-rules-backups") };
};

const stableStringify = (value) => {
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  if (value && typeof value === "object") {
    return "{" + Object.keys(value).sort().filter((key) => value[key] !== undefined).map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
  }
  return JSON.stringify(value ?? null);
};
const shortHash = (value) => crypto.createHash("sha256").update(stableStringify(value)).digest("hex").slice(0, 16);

const cleanLabel = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, kMaxLabelChars);

// "telegram:123", "tg:123" and 123 all name Telegram user 123; usernames and
// "*" are not ids and are never treated as an owner.
const parseTelegramUserId = (entry) => {
  const match = /^(?:(?:telegram|tg):)?(\d{1,20})$/i.exec(String(entry ?? "").trim());
  return match ? match[1] : "";
};

// Group id aliases: a basic group that becomes a supergroup moves from -<n>
// to -100<n>. Only the block list matches both forms (it only silences).
const groupIdAliases = (groupId) => {
  const id = String(groupId || "");
  if (!kGroupIdPattern.test(id)) return [id];
  if (id.startsWith("-100") && id.length > 4) return [id, "-" + id.slice(4)];
  return [id, "-100" + id.slice(1)];
};

const emptyState = () => ({ version: kStateVersion, owners: [], groups: {}, blockedSenders: [], seen: {} });

const readState = ({ fsModule = fs, rootDir }) => {
  const { statePath } = resolveStatePaths(rootDir);
  let parsed;
  try {
    parsed = JSON.parse(fsModule.readFileSync(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return emptyState();
    throw new TelegramGroupsError("internal_error", "Cannot read " + statePath + ": " + error.message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return emptyState();
  return {
    version: kStateVersion,
    owners: Array.isArray(parsed.owners) ? parsed.owners.map(String) : [],
    groups: parsed.groups && typeof parsed.groups === "object" && !Array.isArray(parsed.groups) ? parsed.groups : {},
    blockedSenders: Array.isArray(parsed.blockedSenders) ? parsed.blockedSenders.filter((entry) => isValidTelegramUserId(String(entry?.id ?? ""))) : [],
    seen: parsed.seen && typeof parsed.seen === "object" && !Array.isArray(parsed.seen) ? parsed.seen : {},
  };
};

const writeState = ({ fsModule = fs, rootDir, state }) => {
  const { dir, statePath } = resolveStatePaths(rootDir);
  fsModule.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(statePath, JSON.stringify(state, null, 2) + "\n", { fsModule });
};

// The owners: OpenClaw's own command-owner list, else the bot's DM
// allowlist. These ids are written into every group shape with every tool.
const resolveOwnerIds = ({ cfg, accountConfig }) => {
  const fromCommands = (Array.isArray(cfg?.commands?.ownerAllowFrom) ? cfg.commands.ownerAllowFrom : []).map(parseTelegramUserId).filter(Boolean);
  const source = fromCommands.length ? fromCommands : (Array.isArray(accountConfig?.allowFrom) ? accountConfig.allowFrom : []).map(parseTelegramUserId).filter(Boolean);
  return [...new Set(source)];
};

const resolveTarget = (cfg, accountId) => {
  const telegramConfig = cfg?.channels?.telegram;
  if (!telegramConfig || typeof telegramConfig !== "object") return null;
  const resolved = resolveTelegramAccountConfig({ telegramConfig, accountId });
  return { telegramConfig, ...resolved };
};

// The account's effective group policy, read the way OpenClaw reads it.
const resolveAccountGroupPolicy = ({ cfg, telegramConfig, accountConfig, hasAccounts }) =>
  accountConfig?.groupPolicy ?? (hasAccounts ? telegramConfig?.groupPolicy : undefined) ?? cfg?.channels?.defaults?.groupPolicy;

const pickOwned = (entry) => {
  const owned = {};
  for (const key of kOwnedKeys) if (entry && entry[key] !== undefined) owned[key] = entry[key];
  return owned;
};

const listTopicOverrides = (entry) => {
  const topics = entry?.topics && typeof entry.topics === "object" ? entry.topics : {};
  const overrides = [];
  for (const [threadId, topic] of Object.entries(topics)) {
    const keys = kTopicOverrideKeys.filter((key) => topic && topic[key] !== undefined);
    if (keys.length) overrides.push({ threadId, keys, ...Object.fromEntries(keys.map((key) => [key, topic[key]])) });
  }
  return overrides;
};

const normalizeTrusted = (raw, owners) => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new TelegramGroupsError("invalid_input", "trusted must be an array of {id, scope, label}");
  if (raw.length > kMaxTrusted) throw new TelegramGroupsError("invalid_input", "trusted holds at most " + kMaxTrusted + " people");
  const byId = new Map();
  for (const item of raw) {
    const id = String(item?.id ?? "").trim();
    if (!isValidTelegramUserId(id)) throw new TelegramGroupsError("invalid_input", "trusted[].id must be a numeric Telegram user id");
    const scope = item?.scope === undefined ? "conversation" : item.scope;
    if (!kScopes.includes(scope)) throw new TelegramGroupsError("invalid_input", "trusted[].scope must be actions or conversation");
    if (owners.includes(id)) continue;
    byId.set(id, { id, scope, ...(item?.label ? { label: cleanLabel(item.label) } : {}) });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
};

// The five owned keys for a mode. Owners always get every tool and always
// sit in a per-group allowFrom; the wildcard is deny-all, so a member who is
// neither owner nor trusted with actions gets conversation and no tool.
const buildOwnedKeys = ({ mode, owners, trusted }) => {
  if (mode === "silent" || mode === "blocked") return { enabled: false };
  const toolsBySender = {};
  for (const id of owners) toolsBySender["id:" + id] = {};
  for (const person of trusted) toolsBySender["id:" + person.id] = person.scope === "actions" ? {} : { deny: ["*"] };
  toolsBySender["*"] = { deny: ["*"] };
  if (mode === "approved") return { enabled: true, groupPolicy: "open", toolsBySender };
  return { enabled: true, groupPolicy: "allowlist", allowFrom: [...owners, ...trusted.map((person) => person.id)], toolsBySender };
};

const derivedMode = ({ entry, record }) => {
  if (!entry) return record?.mode === "blocked" ? "blocked" : "waiting";
  if (record && kModes.includes(record.mode) && record.hash === shortHash(pickOwned(entry))) return record.mode;
  return "custom";
};

const groupRevision = ({ entry, accountPolicy, record }) =>
  shortHash({ entry: entry ? pickOwned(entry) : null, topics: listTopicOverrides(entry), accountPolicy: accountPolicy ?? null, mode: record?.mode ?? null, trusted: record?.trusted ?? [] });

// The two shapes that would admit groups nobody chose: an allowlist account
// with no group entries admits any group an allowed sender posts in
// (OpenClaw's senderFilterBypass), and any other account policy admits
// groups that are not listed. Checked on every write, against the groups the
// write would leave behind.
const assertSafeGroups = ({ groups, accountPolicy }) => {
  if (accountPolicy !== "allowlist") throw new TelegramGroupsError("account_policy", "The account's groupPolicy is " + JSON.stringify(accountPolicy ?? null));
  const ids = Object.keys(groups && typeof groups === "object" ? groups : {}).filter((id) => id !== "*");
  if (!ids.length) throw new TelegramGroupsError("empty_groups");
};

const resolveVisibleReplies = (cfg) => cfg?.messages?.groupChat?.visibleReplies ?? cfg?.messages?.visibleReplies ?? "automatic";

// A group is dropped by the group guard once its block is saved, and from
// the moment a block starts saving (pendingBlockAt), so a block whose config
// write fails still holds.
const isBlockedGroupRecord = (record) => record?.mode === "blocked" || Boolean(record?.pendingBlockAt);

// Builds the projection the plugin, the test button and the GET share.
const describeAccount = ({ cfg, state, accountId = "default" }) => {
  const target = resolveTarget(cfg, accountId);
  const accountConfig = target?.accountConfig || {};
  const owners = resolveOwnerIds({ cfg, accountConfig });
  const accountPolicy = target ? resolveAccountGroupPolicy({ cfg, ...target }) : undefined;
  const groupsMap = accountConfig.groups && typeof accountConfig.groups === "object" ? accountConfig.groups : {};
  return { target, accountConfig, owners, accountPolicy, groupsMap };
};

const createTelegramGroups = ({
  fsModule = fs,
  openclawDir,
  rootDir,
  telegramApi = null,
  validatePatch = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log = (line) => console.log(line),
} = {}) => {
  const readCfg = () => readOpenclawConfigForWrite({ fsModule, openclawDir });
  const loadState = () => readState({ fsModule, rootDir });
  const saveState = (state) => writeState({ fsModule, rootDir, state });

  const list = ({ accountId = "default" } = {}) => {
    const cfg = readCfg();
    const state = loadState();
    const { target, owners, accountPolicy, groupsMap } = describeAccount({ cfg, state, accountId });
    const ids = new Set([...Object.keys(groupsMap).filter((id) => id !== "*"), ...Object.keys(state.groups), ...Object.keys(state.seen)]);
    const groups = [...ids].filter(isValidTelegramGroupId).sort().map((groupId) => {
      const entry = groupsMap[groupId];
      const record = state.groups[groupId];
      const seen = state.seen[groupId] || null;
      const mode = derivedMode({ entry, record });
      return {
        groupId,
        title: record?.title || seen?.title || null,
        mode,
        readOnly: mode === "custom",
        inConfig: Boolean(entry),
        rules: entry ? pickOwned(entry) : null,
        requireMention: typeof entry?.requireMention === "boolean" ? entry.requireMention : null,
        trusted: mode === "approved" || mode === "trusted" ? record?.trusted || [] : [],
        topicOverrides: listTopicOverrides(entry),
        revision: groupRevision({ entry, accountPolicy, record }),
        updatedAt: record?.updatedAt || null,
        seen,
        lastLeftAt: record?.lastLeftAt || null,
        leaveError: record?.leaveError || null,
        pendingBlockAt: record?.pendingBlockAt || null,
      };
    });
    return {
      configured: Boolean(target),
      accountId: normalizeAccountId(accountId),
      owners,
      accountPolicy: accountPolicy ?? null,
      visibleReplies: resolveVisibleReplies(cfg),
      blockedSenders: state.blockedSenders,
      groups,
    };
  };

  // Plans a mode change without writing: the before/after of the group's
  // owned keys, every refusal check, and the patch OpenClaw validates.
  const plan = ({ cfg, state, accountId, groupId, body }) => {
    if (!isValidTelegramGroupId(groupId)) throw new TelegramGroupsError("invalid_group_id", "Group id " + JSON.stringify(String(groupId).slice(0, 40)) + " is not a Telegram group id");
    const mode = body?.mode;
    if (!kModes.includes(mode)) throw new TelegramGroupsError("invalid_input", "mode must be one of " + kModes.join(", "));
    const { target, owners, accountPolicy, groupsMap } = describeAccount({ cfg, state, accountId });
    if (!target) throw new TelegramGroupsError("telegram_not_configured");
    if (!owners.length) throw new TelegramGroupsError("owner_required", "No owner Telegram id is configured (commands.ownerAllowFrom or the bot's DM allowFrom)");
    if (accountPolicy !== "allowlist") throw new TelegramGroupsError("account_policy", "The account's groupPolicy is " + JSON.stringify(accountPolicy ?? null));
    const trusted = mode === "approved" || mode === "trusted" ? normalizeTrusted(body?.trusted, owners) : [];
    const entry = groupsMap[groupId];
    const record = state.groups[groupId];
    const currentMode = derivedMode({ entry, record });
    if (currentMode === "custom" && body?.convert !== true) {
      throw new TelegramGroupsError("custom_config", "Group " + groupId + " has rules the Groups page did not write", { extra: { current: pickOwned(entry) } });
    }
    const overrides = listTopicOverrides(entry);
    const loosening = mode === "approved" || mode === "trusted";
    if (loosening && overrides.length && body?.normalizeTopics !== true) {
      throw new TelegramGroupsError("topic_override", "Topics " + overrides.map((item) => item.threadId).join(", ") + " override the group's rules", { extra: { topicOverrides: overrides } });
    }
    if (mode === "approved" && resolveVisibleReplies(cfg) === "message_tool" && cfg?.tools?.message?.crossContext?.allowWithinProvider !== false) {
      throw new TelegramGroupsError("message_tool_replies");
    }
    const owned = buildOwnedKeys({ mode, owners, trusted });
    const nextEntry = { ...(entry || {}) };
    for (const key of kOwnedKeys) delete nextEntry[key];
    Object.assign(nextEntry, owned);
    if (loosening && overrides.length && nextEntry.topics) {
      const topics = {};
      for (const [threadId, topic] of Object.entries(nextEntry.topics)) {
        const kept = { ...topic };
        for (const key of kTopicOverrideKeys) delete kept[key];
        topics[threadId] = kept;
      }
      nextEntry.topics = topics;
    }
    if (nextEntry.enabled !== false) {
      for (const owner of owners) {
        if (nextEntry.toolsBySender?.["id:" + owner] === undefined || (nextEntry.groupPolicy === "allowlist" && !nextEntry.allowFrom?.includes(owner))) {
          throw new TelegramGroupsError("owner_required", "The new rules would leave owner " + owner + " out");
        }
      }
    }
    assertSafeGroups({ groups: { ...groupsMap, [groupId]: nextEntry }, accountPolicy });
    const unchanged = Boolean(entry) && stableStringify(entry) === stableStringify(nextEntry) && record?.mode === mode && stableStringify(record?.trusted || []) === stableStringify(trusted);
    const groupsPath = target.hasAccounts
      ? "channels.telegram.accounts[" + JSON.stringify(target.normalizedAccountId) + "].groups[" + JSON.stringify(groupId) + "]"
      : "channels.telegram.groups[" + JSON.stringify(groupId) + "]";
    const patch = target.hasAccounts
      ? { channels: { telegram: { accounts: { [target.normalizedAccountId]: { groups: { [groupId]: nextEntry } } } } } }
      : { channels: { telegram: { groups: { [groupId]: nextEntry } } } };
    return {
      mode,
      currentMode,
      owners,
      trusted,
      entry: entry || null,
      nextEntry,
      unchanged,
      revision: groupRevision({ entry, accountPolicy, record }),
      validation: { patch, replacePaths: [groupsPath] },
      preview: { before: entry ? pickOwned(entry) : null, after: pickOwned(nextEntry), topicsNormalized: loosening && overrides.length > 0 },
    };
  };

  const backup = ({ groupId, accountId, entry, record }) => {
    const { backupsDir } = resolveStatePaths(rootDir);
    fsModule.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, "-");
    const file = path.join(backupsDir, stamp + "_" + groupId + ".json");
    writeFileAtomic(file, JSON.stringify({ at: new Date(now()).toISOString(), accountId, groupId, entry: entry ?? null, record: record ?? null }, null, 2) + "\n", { fsModule });
    const names = fsModule.readdirSync(backupsDir).filter((name) => name.endsWith(".json")).sort();
    for (const name of names.slice(0, Math.max(0, names.length - kMaxBackups))) {
      try {
        fsModule.unlinkSync(path.join(backupsDir, name));
      } catch {}
    }
    return file;
  };

  const leaveGroup = async (groupId) => {
    if (!telegramApi?.leaveChat) return { ok: false, error: "No Telegram API to leave with" };
    let lastError = "";
    for (let attempt = 1; attempt <= kLeaveAttempts; attempt += 1) {
      try {
        await telegramApi.leaveChat(groupId);
        return { ok: true };
      } catch (error) {
        const message = String(error?.message || error);
        if (/not a member|chat not found|kicked|bot is not a participant|PEER_ID_INVALID/i.test(message)) return { ok: true, alreadyGone: true };
        lastError = message.slice(0, 200);
        if (attempt < kLeaveAttempts) await sleep(500 * attempt);
      }
    }
    return { ok: false, error: lastError };
  };

  const patchRecord = (groupId, patch) => {
    const state = loadState();
    state.groups[groupId] = { ...(state.groups[groupId] || {}), ...patch };
    saveState(state);
    return state.groups[groupId];
  };

  const setPolicy = async ({ accountId = "default", groupId, body = {}, ifMatch = "", dryRun = false } = {}) => {
    const cfg = readCfg();
    const state = loadState();
    const planned = plan({ cfg, state, accountId, groupId, body });
    const wanted = String(ifMatch || "").replace(/^W\//, "").replace(/"/g, "").trim();
    if (!dryRun && !planned.unchanged) {
      if (!wanted) throw new TelegramGroupsError("revision_required", "", { extra: { revision: planned.revision } });
      if (wanted !== planned.revision) throw new TelegramGroupsError("revision_mismatch", "Revision " + wanted + " is not the current " + planned.revision, { extra: { revision: planned.revision } });
    }
    if (typeof validatePatch !== "function") throw new TelegramGroupsError("validator_unavailable", "No OpenClaw config check is wired");
    const verdict = await validatePatch(planned.validation);
    if (!verdict?.ok) throw new TelegramGroupsError("config_invalid", (verdict?.errors || []).join("; ").slice(0, 800) || "OpenClaw rejected the change");
    if (dryRun) return { changed: false, dryRun: true, mode: planned.mode, preview: planned.preview, revision: planned.revision, owners: planned.owners };

    const title = body?.title ? cleanLabel(body.title) : state.groups[groupId]?.title;
    const blocking = planned.mode === "blocked";
    let backupPath = null;
    let changed = false;
    if (!planned.unchanged) {
      backupPath = backup({ groupId, accountId, entry: planned.entry, record: state.groups[groupId] });
      // Blocking is a tightening: the plugin starts dropping the group the
      // moment the state says so, before the config write lands.
      if (blocking) patchRecord(groupId, { pendingBlockAt: new Date(now()).toISOString() });
      let written;
      try {
        written = updateOpenclawConfig({
          fsModule,
          openclawDir,
          mutate: (fresh) => {
            const again = plan({ cfg: fresh, state: loadState(), accountId, groupId, body });
            if (again.revision !== planned.revision) throw new TelegramGroupsError("revision_mismatch", "The group changed while saving", { extra: { revision: again.revision } });
            const target = resolveTarget(fresh, accountId);
            const container = target.hasAccounts ? fresh.channels.telegram.accounts[target.normalizedAccountId] : fresh.channels.telegram;
            container.groups = { ...(container.groups || {}), [groupId]: again.nextEntry };
            assertSafeGroups({ groups: container.groups, accountPolicy: resolveAccountGroupPolicy({ cfg: fresh, ...target, accountConfig: container }) });
            return { nextEntry: again.nextEntry };
          },
        });
      } catch (error) {
        // A block whose config write failed still drops the group (the state
        // already says blocked): report it as partial so a retry finishes it.
        if (!blocking) throw error;
        const problem = toTelegramGroupsError(error);
        throw new TelegramGroupsError(problem.code, problem.message, { sideEffects: "partial", extra: problem.extra });
      }
      changed = true;
      patchRecord(groupId, {
        mode: planned.mode,
        trusted: planned.trusted,
        hash: shortHash(pickOwned(written.nextEntry)),
        updatedAt: new Date(now()).toISOString(),
        ...(title ? { title } : {}),
        pendingBlockAt: undefined,
        ...(blocking ? { blockedAt: state.groups[groupId]?.blockedAt || new Date(now()).toISOString() } : { blockedAt: undefined, leaveError: undefined }),
      });
      syncOwners();
      log("[alphaclaw] telegram groups: group=" + groupId + " mode=" + planned.mode + " from=" + planned.currentMode + " trusted=" + planned.trusted.length);
    }
    let leave = null;
    if (blocking) {
      leave = await leaveGroup(groupId);
      patchRecord(groupId, leave.ok ? { lastLeftAt: new Date(now()).toISOString(), leaveError: undefined } : { leaveError: leave.error });
      if (!leave.ok) {
        log("[alphaclaw] telegram groups: group=" + groupId + " blocked but leaveChat failed");
        throw new TelegramGroupsError("leave_failed", leave.error, { sideEffects: "partial", extra: { mode: "blocked" } });
      }
    }
    const after = list({ accountId }).groups.find((group) => group.groupId === groupId);
    return { changed, mode: planned.mode, preview: planned.preview, revision: after?.revision, backup: backupPath ? path.basename(backupPath) : null, leave, group: after };
  };

  const setBlockedSenders = ({ senders } = {}) => {
    if (!Array.isArray(senders)) throw new TelegramGroupsError("invalid_input", "senders must be an array of {id, label}");
    if (senders.length > kMaxBlockedSenders) throw new TelegramGroupsError("invalid_input", "At most " + kMaxBlockedSenders + " blocked people");
    const cfg = readCfg();
    const { owners } = describeAccount({ cfg, state: loadState() });
    const byId = new Map();
    for (const item of senders) {
      const id = String(item?.id ?? "").trim();
      if (!isValidTelegramUserId(id)) throw new TelegramGroupsError("invalid_input", "senders[].id must be a numeric Telegram user id");
      if (owners.includes(id)) throw new TelegramGroupsError("owner_protected", "Telegram user " + id + " is an owner");
      byId.set(id, { id, ...(item?.label ? { label: cleanLabel(item.label) } : {}) });
    }
    const state = loadState();
    const previous = new Map(state.blockedSenders.map((entry) => [String(entry.id), entry]));
    const next = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id)).map((entry) => ({ ...entry, blockedAt: previous.get(entry.id)?.blockedAt || new Date(now()).toISOString() }));
    const changed = stableStringify(next.map(({ id, label }) => ({ id, label }))) !== stableStringify(state.blockedSenders.map(({ id, label }) => ({ id: String(id), label })));
    state.blockedSenders = next;
    state.owners = owners;
    if (changed) {
      saveState(state);
      log("[alphaclaw] telegram groups: blocked senders=" + next.length);
    }
    return { changed, blockedSenders: next };
  };

  // The join watcher's record of a group the bot was added to.
  const noteSeen = (groupId, patch) => {
    const state = loadState();
    state.seen[groupId] = { ...(state.seen[groupId] || {}), ...patch };
    saveState(state);
    return state.seen[groupId];
  };

  // Keeps the owner list the plugin reads current, so a stale state file can
  // never make the plugin drop an owner.
  const syncOwners = () => {
    const cfg = readCfg();
    const state = loadState();
    const { owners } = describeAccount({ cfg, state });
    if (stableStringify(owners) === stableStringify(state.owners)) return false;
    state.owners = owners;
    saveState(state);
    return true;
  };

  return { list, plan: (args) => plan({ cfg: readCfg(), state: loadState(), ...args }), setPolicy, setBlockedSenders, leaveGroup, noteSeen, syncOwners, readState: loadState };
};

// OpenClaw's own config check (openclaw config patch --dry-run) on the group
// entry the save would write: nothing is saved unless OpenClaw accepts it.
const createOpenclawPatchValidator = ({ execFileCmd, gatewayEnv, fsModule = fs, timeoutMs = 60_000 }) => async ({ patch, replacePaths = [] }) => {
  const dir = fsModule.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-group-patch-"));
  const file = path.join(dir, "patch.json");
  try {
    fsModule.writeFileSync(file, JSON.stringify(patch), { mode: 0o600 });
    const args = ["config", "patch", "--file", file, "--dry-run", "--json", ...replacePaths.flatMap((entry) => ["--replace-path", entry])];
    let stdout = "";
    try {
      stdout = await execFileCmd("openclaw", args, { env: typeof gatewayEnv === "function" ? gatewayEnv() : process.env, timeoutMs });
    } catch (error) {
      stdout = String(error?.stdout || "");
      if (!stdout.trim().startsWith("{")) throw new TelegramGroupsError("validator_unavailable", String(error?.stderr || error?.message || error).slice(0, 300));
    }
    let parsed;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new TelegramGroupsError("validator_unavailable", "openclaw config patch --dry-run printed no JSON");
    }
    return { ok: parsed.ok === true, errors: (parsed.errors || []).map((entry) => String(entry?.message || entry)) };
  } finally {
    fsModule.rmSync(dir, { recursive: true, force: true });
  }
};

module.exports = {
  kModes,
  kOwnedKeys,
  assertSafeGroups,
  isBlockedGroupRecord,
  kScopes,
  createTelegramGroups,
  createOpenclawPatchValidator,
  buildOwnedKeys,
  describeAccount,
  groupIdAliases,
  isValidTelegramGroupId,
  isValidTelegramUserId,
  parseTelegramUserId,
  readState,
  resolveOwnerIds,
  resolveStatePaths,
  shortHash,
  pickOwned,
};

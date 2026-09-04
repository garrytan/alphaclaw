const kTelegramTopicConcurrencyMultiplier = 3;
const kAgentConcurrencyFloor = 8;
const kSubagentConcurrencyFloor = 4;
// Hard ceiling (E4.4): auto-scale must not hand the gateway an unbounded
// concurrency budget as discovery grows the registry. With resource autotune
// active the ceiling comes from the machine instead (memory/CPU supply —
// lib/server/autotune.js); this constant remains the disabled-mode fallback
// AND the value the client-side fallback formula mirrors.
const kAgentConcurrencyCap = 64;
const { normalizeAccountId } = require("./utils/channels");
const { isValidChannelAccountId } = require("./agents/shared");
const { getAgentConcurrencyCap } = require("./autotune");
const { kSubagentConcurrencyDelta } = require("./constants");
const { updateOpenclawConfig } = require("./openclaw-config");

const resolveAgentConcurrencyCap = () =>
  getAgentConcurrencyCap() ?? kAgentConcurrencyCap;

const resolveTelegramAccountConfig = ({ telegramConfig, accountId }) => {
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts =
    telegramConfig?.accounts && typeof telegramConfig.accounts === "object"
      ? telegramConfig.accounts
      : null;
  const hasAccounts = !!accounts && Object.keys(accounts).length > 0;
  if (hasAccounts) {
    const nextAccountConfig =
      accounts[normalizedAccountId] && typeof accounts[normalizedAccountId] === "object"
        ? accounts[normalizedAccountId]
        : {};
    return {
      normalizedAccountId,
      hasAccounts,
      accountConfig: nextAccountConfig,
    };
  }
  return {
    normalizedAccountId,
    hasAccounts: false,
    accountConfig: telegramConfig,
  };
};

// Reverse lookup for discovery: session keys carry no accountId, so map a
// group id back to the account whose config claims it. Returns null when no
// account (or the single-account config) knows the group — callers surface
// that as "unattributed" instead of guessing.
const resolveAccountIdForGroup = ({ cfg, groupId }) => {
  const gid = String(groupId || "").trim();
  const telegramConfig = cfg?.channels?.telegram;
  if (!gid || !telegramConfig || typeof telegramConfig !== "object") return null;

  const hasGroup = (container) =>
    !!container?.groups &&
    typeof container.groups === "object" &&
    Object.prototype.hasOwnProperty.call(container.groups, gid);

  const accounts =
    telegramConfig.accounts && typeof telegramConfig.accounts === "object"
      ? telegramConfig.accounts
      : {};
  for (const [accountId, accountConfig] of Object.entries(accounts)) {
    if (hasGroup(accountConfig)) return normalizeAccountId(accountId);
  }
  if (hasGroup(telegramConfig)) return "default";
  return null;
};

// Enable the forum-topic channel actions, preserving an operator's explicit
// false. Returns true when this write changed anything (callers must then
// mark a gateway restart).
const ensureTopicActionsEnabled = (targetConfig) => {
  if (!targetConfig.actions || typeof targetConfig.actions !== "object") {
    targetConfig.actions = {};
  }
  let changed = false;
  for (const key of ["createForumTopic", "editForumTopic"]) {
    if (targetConfig.actions[key] === undefined) {
      targetConfig.actions[key] = true;
      changed = true;
    }
  }
  return changed;
};

const syncConfigForTelegram = ({
  fs,
  openclawDir,
  topicRegistry,
  groupId,
  accountId = "default",
  requireMention = false,
  resolvedUserId = "",
}) => {
  // Last line before accountId becomes an object key in openclaw.json
  // (channels.telegram.accounts[accountId]) — the routes reject first, this
  // fails closed for every other caller (fix wave F084).
  if (!isValidChannelAccountId(normalizeAccountId(accountId))) {
    throw new Error(`Invalid account id: ${JSON.stringify(String(accountId ?? ""))}`);
  }
  // Fail-closed + locked + atomic (E2): an unparseable existing openclaw.json
  // throws OpenclawConfigReadError here instead of being wiped.
  const { actionsChanged, totalTopics, maxConcurrent, subagentMaxConcurrent } =
    updateOpenclawConfig({
      fsModule: fs,
      openclawDir,
      mutate: (cfg) => {
        // Remove legacy root keys from older setup flow.
        delete cfg.sessions;
        delete cfg.groups;
        delete cfg.groupAllowFrom;

        if (!cfg.channels) cfg.channels = {};
        if (!cfg.channels.telegram) cfg.channels.telegram = {};
        const telegramConfig = cfg.channels.telegram;
        const { normalizedAccountId, hasAccounts } = resolveTelegramAccountConfig({
          telegramConfig,
          accountId,
        });
        if (hasAccounts) {
          if (!telegramConfig.accounts || typeof telegramConfig.accounts !== "object") {
            telegramConfig.accounts = {};
          }
          if (
            !telegramConfig.accounts[normalizedAccountId]
            || typeof telegramConfig.accounts[normalizedAccountId] !== "object"
          ) {
            telegramConfig.accounts[normalizedAccountId] = {};
          }
        }
        const targetConfig = hasAccounts
          ? telegramConfig.accounts[normalizedAccountId]
          : telegramConfig;

        if (!targetConfig.groups || typeof targetConfig.groups !== "object") {
          targetConfig.groups = {};
        }
        const existingGroupConfig = targetConfig.groups[groupId] || {};
        targetConfig.groups[groupId] = {
          ...existingGroupConfig,
          requireMention,
        };

        // Discovered topics never write routing config (E3): only topics an
        // operator or the agent explicitly configured may pin prompts/agents.
        const registryTopics = topicRegistry.getGroup(groupId)?.topics || {};
        const promptTopics = {};
        for (const [threadId, topic] of Object.entries(registryTopics)) {
          if (topic?.deleted === true || topic?.discovered === true) continue;
          const systemPrompt = String(topic?.systemInstructions || "").trim();
          const topicAgentId = String(topic?.agentId || "").trim();
          if (!systemPrompt && !topicAgentId) continue;
          promptTopics[threadId] = {
            ...(systemPrompt ? { systemPrompt } : {}),
            ...(topicAgentId ? { agentId: topicAgentId } : {}),
          };
        }
        if (Object.keys(promptTopics).length > 0) {
          targetConfig.groups[groupId].topics = promptTopics;
        } else {
          delete targetConfig.groups[groupId].topics;
        }

        targetConfig.groupPolicy = "allowlist";
        if (!Array.isArray(targetConfig.groupAllowFrom)) {
          targetConfig.groupAllowFrom = [];
        }
        if (
          resolvedUserId
          && !targetConfig.groupAllowFrom.includes(String(resolvedUserId))
        ) {
          targetConfig.groupAllowFrom.push(String(resolvedUserId));
        }

        const nextActionsChanged = ensureTopicActionsEnabled(targetConfig);

        // Persist thread sessions and keep concurrency in schema-valid agent defaults.
        if (!cfg.session) cfg.session = {};
        if (!cfg.session.resetByType) cfg.session.resetByType = {};
        cfg.session.resetByType.thread = { mode: "idle", idleMinutes: 525600 };

        // Auto-scale counts only named, live topics (E4.4) — discovered and
        // stale entries must not inflate the gateway's concurrency budget.
        const activeTopics = topicRegistry.getActiveTopicCount
          ? topicRegistry.getActiveTopicCount()
          : topicRegistry.getTotalTopicCount();
        const nextMaxConcurrent = Math.min(
          Math.max(
            activeTopics * kTelegramTopicConcurrencyMultiplier,
            kAgentConcurrencyFloor,
          ),
          resolveAgentConcurrencyCap(),
        );
        if (!cfg.agents) cfg.agents = {};
        if (!cfg.agents.defaults) cfg.agents.defaults = {};
        cfg.agents.defaults.maxConcurrent = nextMaxConcurrent;
        if (!cfg.agents.defaults.subagents) cfg.agents.defaults.subagents = {};
        cfg.agents.defaults.subagents.maxConcurrent = Math.max(
          nextMaxConcurrent - kSubagentConcurrencyDelta,
          kSubagentConcurrencyFloor,
        );

        return {
          actionsChanged: nextActionsChanged,
          totalTopics: activeTopics,
          maxConcurrent: cfg.agents.defaults.maxConcurrent,
          subagentMaxConcurrent: cfg.agents.defaults.subagents.maxConcurrent,
        };
      },
    });

  if (actionsChanged) {
    // Channel action flags only apply after a gateway restart; the persisted
    // flag reaches the server banner even when this runs from the CLI.
    try {
      const { writeRestartRequiredFlag } = require("./restart-required-flag");
      writeRestartRequiredFlag({
        fsModule: fs,
        reason: "telegram_actions_enabled",
        source: "telegram-workspace",
      });
    } catch {}
  }

  return {
    totalTopics,
    maxConcurrent,
    subagentMaxConcurrent,
    actionsChanged,
  };
};

module.exports = {
  syncConfigForTelegram,
  resolveAccountIdForGroup,
  resolveTelegramAccountConfig,
  resolveAgentConcurrencyCap,
  kTelegramTopicConcurrencyMultiplier,
  kAgentConcurrencyFloor,
  kSubagentConcurrencyFloor,
};

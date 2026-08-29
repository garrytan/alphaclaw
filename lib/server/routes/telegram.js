const fs = require("fs");
const { OPENCLAW_DIR } = require("../constants");
const { isDebugEnabled } = require("../helpers");
const {
  readOpenclawConfig,
  writeOpenclawConfig,
} = require("../openclaw-config");
const { parseBooleanValue } = require("../utils/boolean");
const {
  hasScopedBindingFields,
  normalizeAccountId,
} = require("../utils/channels");
const { quoteShellArg } = require("../utils/shell");
const topicRegistry = require("../topic-registry");
const { syncConfigForTelegram } = require("../telegram-workspace");
const resolveGroupId = (req) => {
  const body = req.body || {};
  const rawGroupId = body.groupId ?? body.chatId;
  return rawGroupId == null ? "" : String(rawGroupId).trim();
};
const resolveAllowUserId = async ({
  telegramApi,
  groupId,
  preferredUserId,
}) => {
  const normalizedPreferred = String(preferredUserId || "").trim();
  if (normalizedPreferred) return normalizedPreferred;
  const admins = await telegramApi.getChatAdministrators(groupId);
  const humanAdmins = admins.filter((entry) => !entry?.user?.is_bot);
  if (humanAdmins.length === 0) return "";
  const creator = humanAdmins.find((entry) => entry.status === "creator");
  const targetAdmin = creator || humanAdmins[0];
  return String(targetAdmin?.user?.id || "").trim();
};
const isMissingTopicError = (errorMessage) => {
  const message = String(errorMessage || "").toLowerCase();
  return [
    "topic_id_invalid",
    "message_thread_id_invalid",
    "message_thread_not_found",
    "topic_not_found",
    "message thread not found",
    "topic not found",
    "invalid thread id",
    "invalid topic id",
  ].some((token) => message.includes(token));
};

// Fail-closed mutation errors (corrupt registry / unparseable openclaw.json):
// surface as 503 + code so the UI can show the repair banner instead of a
// generic failure — and never rewrite a file we could not parse.
const kFailClosedErrorCodes = new Set([
  "TOPIC_REGISTRY_UNREADABLE",
  "OPENCLAW_CONFIG_UNREADABLE",
]);

const respondFailClosed = (res, error) => {
  if (!error || !kFailClosedErrorCodes.has(error.code)) return false;
  res.status(503).json({ ok: false, error: error.message, code: error.code });
  return true;
};

const normalizeGitSyncMessagePart = (value) =>
  String(value || "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const buildTelegramGitSyncCommand = (action, target = "") => {
  const safeAction = normalizeGitSyncMessagePart(action);
  const safeTarget = normalizeGitSyncMessagePart(target);
  const message = `telegram workspace: ${safeAction} ${safeTarget}`.trim();
  return `alphaclaw git-sync -m ${quoteShellArg(message, { strategy: "single" })}`;
};

const { createTelegramApi } = require("../telegram-api");

const kTelegramEnvKeyBase = "TELEGRAM_BOT_TOKEN";

const deriveAccountEnvKey = (accountId) => {
  const normalized = normalizeAccountId(accountId);
  if (normalized === "default") return kTelegramEnvKeyBase;
  return `${kTelegramEnvKeyBase}_${normalized.replace(/-/g, "_").toUpperCase()}`;
};

const resolveAccountTelegramApi = (accountId, defaultApi) => {
  const normalized = normalizeAccountId(accountId);
  if (normalized === "default") return defaultApi;
  const envKey = deriveAccountEnvKey(normalized);
  const token = process.env[envKey];
  if (!token) {
    console.log(
      `[alphaclaw] Telegram account "${normalized}": env var ${envKey} not found, falling back to default token`,
    );
    return defaultApi;
  }
  return createTelegramApi(() => process.env[envKey]);
};

const resolveAccountId = (req) =>
  normalizeAccountId(req.query?.accountId || req.body?.accountId || "");

const resolveTelegramConfigForAccount = ({ telegramConfig, accountId }) => {
  const normalizedAccountId = normalizeAccountId(accountId);
  const accounts =
    telegramConfig?.accounts && typeof telegramConfig.accounts === "object"
      ? telegramConfig.accounts
      : null;
  const hasAccounts = !!accounts && Object.keys(accounts).length > 0;
  if (hasAccounts) {
    const accountConfig =
      accounts[normalizedAccountId] &&
      typeof accounts[normalizedAccountId] === "object"
        ? accounts[normalizedAccountId]
        : {};
    return { normalizedAccountId, hasAccounts, accountConfig };
  }
  return {
    normalizedAccountId,
    hasAccounts: false,
    accountConfig: telegramConfig || {},
  };
};

const resolveBoundAgentIdForAccount = ({ cfg, accountId }) => {
  const bindings = Array.isArray(cfg?.bindings) ? cfg.bindings : [];
  const normalizedAccountId = normalizeAccountId(accountId);
  for (const binding of bindings) {
    const match = binding?.match || {};
    if (hasScopedBindingFields(match)) continue;
    if (String(match.channel || "").trim() !== "telegram") continue;
    const bindingAccountId = normalizeAccountId(match.accountId);
    if (bindingAccountId !== normalizedAccountId) continue;
    const boundAgentId = String(binding?.agentId || "").trim();
    if (boundAgentId) return boundAgentId;
  }
  return normalizedAccountId === "default" ? "default" : "";
};

const registerTelegramRoutes = ({
  app,
  telegramApi,
  syncPromptFiles,
  shellCmd,
  topicDiscovery,
}) => {
  const repairGroupAllowFromIfMissing = async ({
    cfg,
    accountId = "default",
    groupId,
    requireMention = false,
    tgApi = telegramApi,
  }) => {
    const telegramConfig = cfg?.channels?.telegram || {};
    const { accountConfig } = resolveTelegramConfigForAccount({
      telegramConfig,
      accountId,
    });
    if (
      Array.isArray(accountConfig.groupAllowFrom) &&
      accountConfig.groupAllowFrom.length > 0
    ) {
      return { repaired: false, resolvedUserId: "", syncWarning: null };
    }
    const resolvedUserId = await resolveAllowUserId({
      telegramApi: tgApi,
      groupId,
      preferredUserId: "",
    });
    syncConfigForTelegram({
      fs,
      openclawDir: OPENCLAW_DIR,
      topicRegistry,
      groupId,
      accountId,
      requireMention,
      resolvedUserId,
    });
    const syncWarning = await runTelegramGitSync(
      "repair-group-allow-from",
      groupId,
    );
    return { repaired: true, resolvedUserId, syncWarning };
  };

  const runTelegramGitSync = async (action, target = "") => {
    if (typeof shellCmd !== "function") return null;
    try {
      await shellCmd(buildTelegramGitSyncCommand(action, target), {
        timeout: 30000,
      });
      return null;
    } catch (err) {
      return err?.message || "alphaclaw git-sync failed";
    }
  };

  // Verify bot token
  app.get("/api/telegram/bot", async (req, res) => {
    try {
      const reqAccountId = resolveAccountId(req);
      const tgApi = resolveAccountTelegramApi(reqAccountId, telegramApi);
      const me = await tgApi.getMe();
      res.json({ ok: true, bot: me, accountId: reqAccountId || "default" });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // Verify group: checks bot membership, admin rights, topics enabled
  app.post("/api/telegram/groups/verify", async (req, res) => {
    const groupId = resolveGroupId(req);
    if (!groupId)
      return res.status(400).json({ ok: false, error: "groupId is required" });

    try {
      const tgApi = resolveAccountTelegramApi(
        resolveAccountId(req),
        telegramApi,
      );
      const chat = await tgApi.getChat(groupId);
      const me = await tgApi.getMe();
      const member = await tgApi.getChatMember(groupId, me.id);
      const suggestedUserId = await resolveAllowUserId({
        telegramApi: tgApi,
        groupId,
        preferredUserId: "",
      });

      const isAdmin =
        member.status === "administrator" || member.status === "creator";
      const isForum = !!chat.is_forum;

      res.json({
        ok: true,
        chat: {
          id: chat.id,
          title: chat.title,
          type: chat.type,
          isForum,
        },
        bot: {
          status: member.status,
          isAdmin,
          canManageTopics: isAdmin && member.can_manage_topics !== false,
        },
        suggestedUserId: suggestedUserId || null,
      });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  // List topics from registry
  app.get("/api/telegram/groups/:groupId/topics", (req, res) => {
    const group = topicRegistry.getGroup(req.params.groupId);
    res.json({ ok: true, topics: group?.topics || {} });
  });

  // Flat topic listing (all groups, incl. discovered/stale/deleted rows) plus
  // the discovery poller status for the Manage Topics UI.
  app.get("/api/telegram/topics", (req, res) => {
    res.json({
      ok: true,
      topics: topicRegistry.listTopics(),
      discovery: topicDiscovery?.getStatus?.() ?? null,
    });
  });

  // Discovery poller: operator-triggered sweep + status.
  app.post("/api/telegram/discovery/sweep", async (req, res) => {
    if (!topicDiscovery || typeof topicDiscovery.sweep !== "function") {
      return res
        .status(503)
        .json({ ok: false, error: "topic discovery service unavailable" });
    }
    try {
      const result = await topicDiscovery.sweep();
      res.json({ ok: true, result });
    } catch (e) {
      res.json({ ok: false, error: e.message });
    }
  });

  app.get("/api/telegram/discovery/status", (req, res) => {
    if (!topicDiscovery || typeof topicDiscovery.getStatus !== "function") {
      return res
        .status(503)
        .json({ ok: false, error: "topic discovery service unavailable" });
    }
    res.json({ ok: true, status: topicDiscovery.getStatus() });
  });

  // Create a topic via Telegram API + add to registry
  app.post("/api/telegram/groups/:groupId/topics", async (req, res) => {
    const { groupId } = req.params;
    const body = req.body || {};
    const name = String(body.name ?? "").trim();
    const rawIconColor = body.iconColor;
    const systemInstructions = String(
      body.systemInstructions ?? body.systemPrompt ?? "",
    ).trim();
    const hasAgentId = Object.prototype.hasOwnProperty.call(body, "agentId");
    const agentId = String(body.agentId ?? "").trim();
    const iconColorValue =
      rawIconColor == null ? null : Number.parseInt(String(rawIconColor), 10);
    const iconColor = Number.isFinite(iconColorValue)
      ? iconColorValue
      : undefined;
    if (!name)
      return res.status(400).json({ ok: false, error: "name is required" });

    try {
      const tgApi = resolveAccountTelegramApi(
        resolveAccountId(req),
        telegramApi,
      );
      const result = await tgApi.createForumTopic(groupId, name, {
        iconColor,
      });
      const threadId = result.message_thread_id;
      topicRegistry.addTopic(
        groupId,
        threadId,
        {
          name: result.name,
          iconColor: result.icon_color,
          ...(systemInstructions ? { systemInstructions } : {}),
          ...(hasAgentId ? { agentId: agentId || undefined } : {}),
        },
        { source: "ui" },
      );
      syncConfigForTelegram({
        fs,
        openclawDir: OPENCLAW_DIR,
        topicRegistry,
        groupId,
        accountId: resolveAccountId(req),
        requireMention: false,
        resolvedUserId: "",
      });
      syncPromptFiles();
      const syncWarning = await runTelegramGitSync("create-topic", result.name);
      res.json({
        ok: true,
        topic: {
          threadId,
          name: result.name,
          iconColor: result.icon_color,
          ...(hasAgentId ? { agentId } : {}),
        },
        syncWarning,
      });
    } catch (e) {
      if (respondFailClosed(res, e)) return;
      res.json({ ok: false, error: e.message });
    }
  });

  // Bulk-create topics
  app.post("/api/telegram/groups/:groupId/topics/bulk", async (req, res) => {
    const { groupId } = req.params;
    const body = req.body || {};
    const topics = Array.isArray(body.topics) ? body.topics : [];
    if (!Array.isArray(topics) || topics.length === 0) {
      return res
        .status(400)
        .json({ ok: false, error: "topics array is required" });
    }

    const tgApi = resolveAccountTelegramApi(resolveAccountId(req), telegramApi);
    const results = [];
    for (const t of topics) {
      if (!t.name) {
        results.push({ name: t.name, ok: false, error: "name is required" });
        continue;
      }
      try {
        const result = await tgApi.createForumTopic(groupId, t.name, {
          iconColor: t.iconColor || undefined,
        });
        const threadId = result.message_thread_id;
        const systemInstructions = String(
          t.systemInstructions ?? t.systemPrompt ?? "",
        ).trim();
        const hasAgentId = Object.prototype.hasOwnProperty.call(t, "agentId");
        const agentId = String(t.agentId ?? "").trim();
        topicRegistry.addTopic(
          groupId,
          threadId,
          {
            name: result.name,
            iconColor: result.icon_color,
            ...(systemInstructions ? { systemInstructions } : {}),
            ...(hasAgentId ? { agentId: agentId || undefined } : {}),
          },
          { source: "ui" },
        );
        results.push({ name: result.name, threadId, ok: true });
      } catch (e) {
        results.push({ name: t.name, ok: false, error: e.message });
      }
    }
    try {
      syncConfigForTelegram({
        fs,
        openclawDir: OPENCLAW_DIR,
        topicRegistry,
        groupId,
        accountId: resolveAccountId(req),
        requireMention: false,
        resolvedUserId: "",
      });
      syncPromptFiles();
    } catch (e) {
      if (respondFailClosed(res, e)) return;
      return res.json({ ok: false, error: e.message });
    }
    const syncWarning = await runTelegramGitSync("bulk-create-topics", groupId);
    res.json({ ok: true, results, syncWarning });
  });

  // Delete a topic
  app.delete(
    "/api/telegram/groups/:groupId/topics/:topicId",
    async (req, res) => {
      const { groupId, topicId } = req.params;
      try {
        const tgApi = resolveAccountTelegramApi(
          resolveAccountId(req),
          telegramApi,
        );
        await tgApi.deleteForumTopic(groupId, parseInt(topicId, 10));
        topicRegistry.removeTopic(groupId, topicId, { source: "ui" });
        syncConfigForTelegram({
          fs,
          openclawDir: OPENCLAW_DIR,
          topicRegistry,
          groupId,
          accountId: resolveAccountId(req),
          requireMention: false,
          resolvedUserId: "",
        });
        syncPromptFiles();
        const syncWarning = await runTelegramGitSync("delete-topic", topicId);
        res.json({ ok: true, syncWarning });
      } catch (e) {
        if (respondFailClosed(res, e)) return;
        if (!isMissingTopicError(e?.message)) {
          return res.json({ ok: false, error: e.message });
        }
        try {
          // Lazy stale: record the failed probe before tombstoning.
          topicRegistry.updateTopic(
            groupId,
            topicId,
            { stale: true },
            { source: "send-failure" },
          );
          topicRegistry.removeTopic(groupId, topicId, { source: "ui" });
          syncConfigForTelegram({
            fs,
            openclawDir: OPENCLAW_DIR,
            topicRegistry,
            groupId,
            accountId: resolveAccountId(req),
            requireMention: false,
            resolvedUserId: "",
          });
          syncPromptFiles();
        } catch (err) {
          if (respondFailClosed(res, err)) return;
          return res.json({ ok: false, error: err.message });
        }
        const syncWarning = await runTelegramGitSync(
          "delete-stale-topic",
          topicId,
        );
        return res.json({
          ok: true,
          removedFromRegistryOnly: true,
          warning:
            "Topic no longer exists in Telegram; removed stale registry entry.",
          syncWarning,
        });
      }
    },
  );

  // Restore a tombstoned (deleted) topic so discovery may see it again
  app.post(
    "/api/telegram/groups/:groupId/topics/:topicId/restore",
    (req, res) => {
      const { groupId, topicId } = req.params;
      try {
        topicRegistry.restoreTopic(groupId, topicId, { source: "ui" });
        syncPromptFiles();
        res.json({ ok: true });
      } catch (e) {
        if (respondFailClosed(res, e)) return;
        res.json({ ok: false, error: e.message });
      }
    },
  );

  // Verify a topic still exists in Telegram by probing it with a typing
  // chat action; marks the registry entry stale on a missing-topic error.
  app.post(
    "/api/telegram/groups/:groupId/topics/:topicId/verify",
    async (req, res) => {
      const { groupId, topicId } = req.params;
      const threadId = Number.parseInt(String(topicId), 10);
      if (!Number.isFinite(threadId)) {
        return res
          .status(400)
          .json({ ok: false, error: "topicId must be numeric" });
      }
      const tgApi = resolveAccountTelegramApi(
        resolveAccountId(req),
        telegramApi,
      );
      try {
        await tgApi.sendChatAction(groupId, "typing", {
          messageThreadId: threadId,
        });
      } catch (e) {
        if (!isMissingTopicError(e?.message)) {
          // Transient/auth/rights failures say nothing about the topic —
          // report upstream trouble without marking anything stale.
          return res.status(502).json({ ok: false, error: e.message });
        }
        try {
          topicRegistry.updateTopic(
            groupId,
            threadId,
            { stale: true },
            { source: "verify" },
          );
          syncPromptFiles();
        } catch (err) {
          if (respondFailClosed(res, err)) return;
          return res.json({ ok: false, error: err.message });
        }
        return res.json({ ok: true, status: "stale" });
      }
      try {
        topicRegistry.updateTopic(
          groupId,
          threadId,
          { stale: false, lastSeenAt: Date.now() },
          { source: "verify" },
        );
      } catch (err) {
        if (respondFailClosed(res, err)) return;
        return res.json({ ok: false, error: err.message });
      }
      return res.json({ ok: true, status: "ok" });
    },
  );

  // Update a topic (rename, system instructions, agent routing)
  app.put("/api/telegram/groups/:groupId/topics/:topicId", async (req, res) => {
    const { groupId, topicId } = req.params;
    const body = req.body || {};
    const name = String(body.name ?? "").trim();
    const hasSystemInstructions =
      Object.prototype.hasOwnProperty.call(body, "systemInstructions") ||
      Object.prototype.hasOwnProperty.call(body, "systemPrompt");
    const systemInstructions = String(
      body.systemInstructions ?? body.systemPrompt ?? "",
    ).trim();
    const hasAgentId = Object.prototype.hasOwnProperty.call(body, "agentId");
    const agentId = String(body.agentId ?? "").trim();
    if (!name)
      return res.status(400).json({ ok: false, error: "name is required" });
    try {
      const threadId = Number.parseInt(String(topicId), 10);
      if (!Number.isFinite(threadId)) {
        return res
          .status(400)
          .json({ ok: false, error: "topicId must be numeric" });
      }
      const tgApi = resolveAccountTelegramApi(
        resolveAccountId(req),
        telegramApi,
      );
      const existingTopic =
        topicRegistry.getGroup(groupId)?.topics?.[String(threadId)] || {};
      const existingName = String(existingTopic.name || "").trim();
      const shouldRename = !existingName || existingName !== name;
      if (shouldRename) {
        try {
          await tgApi.editForumTopic(groupId, threadId, { name });
        } catch (e) {
          // Telegram returns TOPIC_NOT_MODIFIED when the name is unchanged.
          if (!String(e.message || "").includes("TOPIC_NOT_MODIFIED")) {
            throw e;
          }
        }
      }
      topicRegistry.updateTopic(
        groupId,
        threadId,
        {
          ...existingTopic,
          name,
          ...(hasSystemInstructions ? { systemInstructions } : {}),
          ...(hasAgentId ? { agentId: agentId || undefined } : {}),
        },
        { source: "ui" },
      );
      syncConfigForTelegram({
        fs,
        openclawDir: OPENCLAW_DIR,
        topicRegistry,
        groupId,
        accountId: resolveAccountId(req),
        requireMention: false,
        resolvedUserId: "",
      });
      syncPromptFiles();
      const syncWarning = await runTelegramGitSync("update-topic", name);
      return res.json({
        ok: true,
        topic: {
          threadId,
          name,
          ...(hasSystemInstructions ? { systemInstructions } : {}),
          ...(hasAgentId ? { agentId } : {}),
        },
        syncWarning,
      });
    } catch (e) {
      if (respondFailClosed(res, e)) return;
      if (isMissingTopicError(e?.message)) {
        // Lazy stale: the rename probe proved the topic is gone.
        try {
          topicRegistry.updateTopic(
            groupId,
            topicId,
            { stale: true },
            { source: "send-failure" },
          );
        } catch {}
      }
      return res.json({ ok: false, error: e.message });
    }
  });

  // Configure openclaw.json for a group
  app.post("/api/telegram/groups/:groupId/configure", async (req, res) => {
    const { groupId } = req.params;
    const body = req.body || {};
    const userId = body.userId ?? "";
    const groupName = body.groupName ?? "";
    const accountId = resolveAccountId(req);
    const requireMention = parseBooleanValue(body.requireMention, false);
    try {
      const tgApi = resolveAccountTelegramApi(
        accountId,
        telegramApi,
      );
      const resolvedUserId = await resolveAllowUserId({
        telegramApi: tgApi,
        groupId,
        preferredUserId: userId,
      });
      syncConfigForTelegram({
        fs,
        openclawDir: OPENCLAW_DIR,
        topicRegistry,
        groupId,
        accountId,
        requireMention,
        resolvedUserId,
      });

      // Save metadata in local topic registry only.
      const cfg = readOpenclawConfig({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
        fallback: {},
      });
      const boundAgentId = resolveBoundAgentIdForAccount({ cfg, accountId });
      topicRegistry.setGroup(groupId, {
        ...(groupName ? { name: groupName } : {}),
        accountId,
        ...(boundAgentId ? { agentId: boundAgentId } : {}),
      });
      syncPromptFiles();
      const syncWarning = await runTelegramGitSync("configure-group", groupId);

      res.json({ ok: true, userId: resolvedUserId || null, syncWarning });
    } catch (e) {
      if (respondFailClosed(res, e)) return;
      res.json({ ok: false, error: e.message });
    }
  });

  // Get full topic registry
  app.get("/api/telegram/topic-registry", (req, res) => {
    res.json({ ok: true, registry: topicRegistry.readRegistry() });
  });

  // Workspace bootstrap info (lets UI jump straight to management)
  app.get("/api/telegram/workspace", async (req, res) => {
    try {
      const accountId = resolveAccountId(req);
      const debugEnabled = isDebugEnabled();
      let cfg = readOpenclawConfig({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
        fallback: {},
      });
      let telegramConfig = cfg.channels?.telegram || {};
      const { accountConfig } = resolveTelegramConfigForAccount({
        telegramConfig,
        accountId,
      });
      const configuredGroups =
        accountConfig?.groups && typeof accountConfig.groups === "object"
          ? accountConfig.groups
          : {};
      const groupIds = Object.keys(configuredGroups);
      const registryFallbackGroups = topicRegistry.getGroupsForAccount(accountId);
      const registryFallbackGroupIds = Object.keys(registryFallbackGroups);
      const useRegistryFallback =
        groupIds.length === 0 && registryFallbackGroupIds.length > 0;
      if (groupIds.length === 0 && !useRegistryFallback) {
        return res.json({
          ok: true,
          configured: false,
          groups: [],
          debugEnabled,
        });
      }

      const tgApi = resolveAccountTelegramApi(accountId, telegramApi);
      let activeGroupIds = useRegistryFallback ? registryFallbackGroupIds : groupIds;
      if (!useRegistryFallback) {
        let anyRepaired = false;
        for (const gId of groupIds) {
          const gConfig = configuredGroups[gId] || {};
          const repairResult = await repairGroupAllowFromIfMissing({
            cfg,
            accountId,
            groupId: gId,
            requireMention: !!gConfig.requireMention,
            tgApi,
          });
          if (repairResult.repaired) {
            anyRepaired = true;
          }
        }
        if (anyRepaired) {
          cfg = readOpenclawConfig({
            fsModule: fs,
            openclawDir: OPENCLAW_DIR,
            fallback: {},
          });
          telegramConfig = cfg.channels?.telegram || {};
        }
        const refreshedAccountConfig = resolveTelegramConfigForAccount({
          telegramConfig,
          accountId,
        }).accountConfig;
        const refreshedGroups =
          refreshedAccountConfig?.groups &&
          typeof refreshedAccountConfig.groups === "object"
            ? refreshedAccountConfig.groups
            : {};
        activeGroupIds = Object.keys(refreshedGroups);
      }

      const groups = [];
      for (const gId of activeGroupIds) {
        const registryGroup = topicRegistry.getGroup(gId);
        let gName = registryGroup?.name || gId;
        try {
          const chat = await tgApi.getChat(gId);
          if (chat?.title) gName = chat.title;
        } catch {}
        groups.push({
          groupId: gId,
          groupName: gName,
          topics: registryGroup?.topics || {},
        });
      }

      const first = groups[0] || {};
      return res.json({
        ok: true,
        configured: true,
        groups,
        groupId: first.groupId,
        groupName: first.groupName,
        topics: first.topics,
        debugEnabled,
        concurrency: (() => {
          // Server-computed values so the client's fallback formula never has
          // to guess the machine-derived cap (lib/server/autotune.js).
          const {
            resolveAgentConcurrencyCap,
            kTelegramTopicConcurrencyMultiplier,
            kAgentConcurrencyFloor,
            kSubagentConcurrencyFloor,
          } = require("../telegram-workspace");
          const { getAgentConcurrencyCap } = require("../autotune");
          const machineCap = getAgentConcurrencyCap();
          const resourceCap = machineCap ?? resolveAgentConcurrencyCap();
          // Same demand signal as syncConfigForTelegram (E4.4): named, live
          // topics from the registry — never the raw per-group topic map.
          const activeTopics = topicRegistry.getActiveTopicCount
            ? topicRegistry.getActiveTopicCount()
            : Object.keys(first.topics || {}).length;
          const computedMaxConcurrent = Math.min(
            Math.max(
              activeTopics * kTelegramTopicConcurrencyMultiplier,
              kAgentConcurrencyFloor,
            ),
            resourceCap,
          );
          return {
            agentMaxConcurrent: cfg.agents?.defaults?.maxConcurrent ?? null,
            subagentMaxConcurrent:
              cfg.agents?.defaults?.subagents?.maxConcurrent ?? null,
            computedMaxConcurrent,
            computedSubagentMaxConcurrent: Math.max(
              computedMaxConcurrent - 2,
              kSubagentConcurrencyFloor,
            ),
            resourceCap,
            // "machine" only when autotune actually derived the cap — the
            // client must not claim "capped by machine size" for the legacy
            // constant.
            resourceCapSource: machineCap != null ? "machine" : "legacy",
          };
        })(),
      });
    } catch (e) {
      if (respondFailClosed(res, e)) return;
      return res.json({ ok: false, error: e.message });
    }
  });

  // Reset Telegram workspace onboarding state
  app.post("/api/telegram/workspace/reset", async (req, res) => {
    try {
      const accountId = resolveAccountId(req);
      // "keep" (default) preserves tombstones so discovery cannot resurrect
      // deleted topics; "rediscover" clears them so the next sweep may.
      const mode =
        String(req.body?.mode || "keep").trim() === "rediscover"
          ? "rediscover"
          : "keep";
      const cfg = readOpenclawConfig({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
        fallback: {},
      });
      const telegramConfig = cfg.channels?.telegram;
      if (!telegramConfig || typeof telegramConfig !== "object") {
        return res.json({ ok: true, syncWarning: null });
      }
      const { normalizedAccountId, hasAccounts, accountConfig } =
        resolveTelegramConfigForAccount({
          telegramConfig,
          accountId,
        });
      const telegramGroups = Object.keys(accountConfig?.groups || {});
      const groupsToRemove =
        telegramGroups.length > 0
          ? telegramGroups
          : Object.keys(topicRegistry.getGroupsForAccount(accountId));
      if (hasAccounts) {
        const accountEntry = telegramConfig.accounts?.[normalizedAccountId];
        if (accountEntry && typeof accountEntry === "object") {
          delete accountEntry.groups;
          delete accountEntry.groupAllowFrom;
        }
      } else {
        delete telegramConfig.groups;
        delete telegramConfig.groupAllowFrom;
      }
      writeOpenclawConfig({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
        config: cfg,
        spacing: 2,
      });

      // Remove corresponding groups from topic registry (fail-closed: a
      // corrupt registry throws instead of being rewritten).
      topicRegistry.mutateRegistry(
        (registry) => {
          for (const groupId of groupsToRemove) {
            delete registry.groups[groupId];
          }
          return registry;
        },
        { source: "reset", event: { action: "reset", groups: groupsToRemove } },
      );
      if (mode === "rediscover") {
        topicRegistry.clearTombstones({ source: "reset" });
      }

      syncPromptFiles();
      const syncWarning = await runTelegramGitSync(
        "reset-workspace",
        "telegram",
      );
      return res.json({ ok: true, syncWarning });
    } catch (e) {
      if (respondFailClosed(res, e)) return;
      return res.json({ ok: false, error: e.message });
    }
  });
};

module.exports = { registerTelegramRoutes, buildTelegramGitSyncCommand };

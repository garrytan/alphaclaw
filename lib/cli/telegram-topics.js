// `alphaclaw telegram topic add|create` and `alphaclaw telegram topics`.
// bin/alphaclaw.js dispatches here after the .env load; every server module
// is required lazily inside the command that needs it.
const fs = require("fs");
const path = require("path");

const createTelegramTopicCommands = ({ commandArgs, flagValue, openclawDir }) => {
  // Base URL for prompt-file links: same env chain the server uses (E4.17);
  // an empty result lets resolveSetupUiUrl keep its Railway/localhost fallback.
  const kBaseUrlEnvKeys = [
    "ALPHACLAW_SETUP_URL",
    "ALPHACLAW_BASE_URL",
    "RENDER_EXTERNAL_URL",
    "URL",
  ];
  const resolveCliBaseUrl = () => {
    for (const key of kBaseUrlEnvKeys) {
      const value = String(process.env[key] || "").trim();
      if (value) return value;
    }
    return "";
  };

  // Telegram groups can live at channels.telegram.groups or under
  // channels.telegram.accounts.<id>.groups; collect both shapes.
  const collectTelegramGroupConfigs = (cfg) => {
    const telegramConfig = cfg?.channels?.telegram || {};
    const groupConfigs = new Map();
    const record = (groups) => {
      if (!groups || typeof groups !== "object") return;
      for (const [groupId, groupConfig] of Object.entries(groups)) {
        if (!groupConfigs.has(groupId)) {
          groupConfigs.set(groupId, groupConfig || {});
        }
      }
    };
    const accounts =
      telegramConfig.accounts && typeof telegramConfig.accounts === "object"
        ? telegramConfig.accounts
        : {};
    for (const accountConfig of Object.values(accounts)) {
      record(accountConfig?.groups);
    }
    record(telegramConfig.groups);
    return groupConfigs;
  };

  const resolveTelegramGroupTarget = ({ cfg, requestedGroupId }) => {
    const groupConfigs = collectTelegramGroupConfigs(cfg);
    let groupId = requestedGroupId;
    if (!groupId) {
      const configuredGroups = [...groupConfigs.keys()];
      if (configuredGroups.length === 1) {
        [groupId] = configuredGroups;
      } else if (configuredGroups.length === 0) {
        return {
          error:
            "[alphaclaw] No Telegram group configured. Configure Telegram workspace first.",
        };
      } else {
        return {
          error: `[alphaclaw] Multiple Telegram groups detected (${configuredGroups.join(", ")}). Provide --group <groupId>.`,
        };
      }
    }
    const {
      resolveAccountIdForGroup,
    } = require("../server/telegram-workspace");
    return {
      groupId,
      accountId: resolveAccountIdForGroup({ cfg, groupId }) || "default",
      requireMention: !!groupConfigs.get(groupId)?.requireMention,
    };
  };

  const readCliOpenclawConfig = () => {
    const configPath = path.join(openclawDir, "openclaw.json");
    if (!fs.existsSync(configPath)) return null;
    // Read-only fallback here; syncConfigForTelegram re-reads fail-closed before
    // writing, so an unparseable config aborts with OpenclawConfigReadError.
    const { readOpenclawConfig } = require("../server/openclaw-config");
    return readOpenclawConfig({ fsModule: fs, openclawDir });
  };

  const syncTelegramWorkspaceArtifacts = ({
    topicRegistry,
    groupId,
    accountId,
    requireMention,
  }) => {
    const { syncConfigForTelegram } = require("../server/telegram-workspace");
    const {
      syncBootstrapPromptFiles,
    } = require("../server/onboarding/workspace");
    const syncResult = syncConfigForTelegram({
      fs,
      openclawDir,
      topicRegistry,
      groupId,
      accountId,
      requireMention,
      resolvedUserId: "",
    });
    syncBootstrapPromptFiles({
      fs,
      workspaceDir: path.join(openclawDir, "workspace"),
      baseUrl: resolveCliBaseUrl(),
    });
    console.log(
      `[alphaclaw] Concurrency updated: agent=${syncResult.maxConcurrent} subagents=${syncResult.subagentMaxConcurrent} topics=${syncResult.totalTopics}`,
    );
  };

  const runTelegramTopicAdd = () => {
    const topicName = String(flagValue(commandArgs, "--name") || "").trim();
    const threadId = String(flagValue(commandArgs, "--thread") || "").trim();
    const systemInstructions = String(
      flagValue(commandArgs, "--system") || "",
    ).trim();
    const agentId = String(flagValue(commandArgs, "--agent") || "").trim();
    const requestedGroupId = String(
      flagValue(commandArgs, "--group") || "",
    ).trim();
    if (!threadId) {
      console.error("[alphaclaw] Missing --thread for telegram topic add");
      return 1;
    }
    if (!topicName) {
      console.error("[alphaclaw] Missing --name for telegram topic add");
      return 1;
    }

    try {
      const cfg = readCliOpenclawConfig();
      if (!cfg) {
        console.error("[alphaclaw] Missing openclaw.json. Run setup first.");
        return 1;
      }
      const target = resolveTelegramGroupTarget({ cfg, requestedGroupId });
      if (target.error) {
        console.error(target.error);
        return 1;
      }
      const { groupId, accountId, requireMention } = target;

      const topicRegistry = require("../server/topic-registry");
      topicRegistry.updateTopic(
        groupId,
        threadId,
        {
          name: topicName,
          ...(systemInstructions ? { systemInstructions } : {}),
          ...(agentId ? { agentId } : {}),
        },
        { source: "cli" },
      );

      const agentSuffix = agentId ? ` agent=${agentId}` : "";
      console.log(
        `[alphaclaw] Topic mapped: group=${groupId} thread=${threadId} name=${topicName}${agentSuffix}`,
      );
      syncTelegramWorkspaceArtifacts({
        topicRegistry,
        groupId,
        accountId,
        requireMention,
      });
      return 0;
    } catch (e) {
      console.error(`[alphaclaw] telegram topic add failed: ${e.message}`);
      return 1;
    }
  };
  // Mirrors routes/telegram.js token resolution: per-account env key with a
  // fallback to the default bot token.
  const kTelegramEnvKeyBase = "TELEGRAM_BOT_TOKEN";
  const deriveTelegramAccountEnvKey = (accountId) => {
    if (accountId === "default") return kTelegramEnvKeyBase;
    return `${kTelegramEnvKeyBase}_${accountId.replace(/-/g, "_").toUpperCase()}`;
  };

  const runTelegramTopicCreate = async () => {
    const topicName = String(flagValue(commandArgs, "--name") || "").trim();
    const agentId = String(flagValue(commandArgs, "--agent") || "").trim();
    const requestedGroupId = String(
      flagValue(commandArgs, "--group") || "",
    ).trim();
    if (!requestedGroupId) {
      console.error("[alphaclaw] Missing --group for telegram topic create");
      return 1;
    }
    if (!topicName) {
      console.error("[alphaclaw] Missing --name for telegram topic create");
      return 1;
    }

    try {
      const cfg = readCliOpenclawConfig();
      if (!cfg) {
        console.error("[alphaclaw] Missing openclaw.json. Run setup first.");
        return 1;
      }
      const target = resolveTelegramGroupTarget({ cfg, requestedGroupId });
      if (target.error) {
        console.error(target.error);
        return 1;
      }
      const { groupId, accountId, requireMention } = target;

      const { createTelegramApi } = require("../server/telegram-api");
      const accountEnvKey = deriveTelegramAccountEnvKey(accountId);
      const telegramApi = createTelegramApi(
        () => process.env[accountEnvKey] || process.env[kTelegramEnvKeyBase],
      );

      let created;
      try {
        created = await telegramApi.createForumTopic(groupId, topicName);
      } catch (e) {
        // Telegram 400/429/rights errors must reach the operator verbatim.
        console.error(String(e.message || e));
        return 1;
      }
      const threadId = String(created?.message_thread_id ?? "").trim();
      if (!threadId) {
        console.error(
          "[alphaclaw] Telegram did not return a message_thread_id for the new topic",
        );
        return 1;
      }

      const topicRegistry = require("../server/topic-registry");
      topicRegistry.addTopic(
        groupId,
        threadId,
        {
          name: topicName,
          ...(agentId ? { agentId } : {}),
        },
        { source: "cli" },
      );

      const agentSuffix = agentId ? ` agent=${agentId}` : "";
      console.log(
        `[alphaclaw] Topic created: group=${groupId} thread=${threadId} name=${topicName}${agentSuffix}`,
      );
      syncTelegramWorkspaceArtifacts({
        topicRegistry,
        groupId,
        accountId,
        requireMention,
      });
      return 0;
    } catch (e) {
      console.error(`[alphaclaw] telegram topic create failed: ${e.message}`);
      return 1;
    }
  };
  const runTelegramTopicsList = () => {
    const requestedGroupId = String(
      flagValue(commandArgs, "--group") || "",
    ).trim();
    const asJson = commandArgs.includes("--json");

    try {
      const topicRegistry = require("../server/topic-registry");
      const rows = topicRegistry.listTopics({ groupId: requestedGroupId });
      if (asJson) {
        // The only stdout write under --json; bin sends console.log to stderr.
        process.stdout.write(`${JSON.stringify(rows)}\n`);
        return 0;
      }
      if (rows.length === 0) {
        console.log("[alphaclaw] No topics registered.");
        return 0;
      }

      const headers = ["GROUP", "THREAD", "NAME", "FLAGS", "LAST SEEN", "AGENT"];
      const cells = rows.map((row) => [
        `${row.groupName} (${row.groupId})`,
        row.threadId,
        row.name || "(unnamed, discovered)",
        [row.stale ? "stale" : "", row.deleted ? "deleted" : ""]
          .filter(Boolean)
          .join(",") || "-",
        row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : "-",
        row.agentId || "-",
      ]);
      const widths = headers.map((header, column) =>
        Math.max(header.length, ...cells.map((row) => row[column].length)),
      );
      const renderRow = (row) =>
        row
          .map((cell, column) => cell.padEnd(widths[column]))
          .join("  ")
          .trimEnd();
      console.log([headers, ...cells].map(renderRow).join("\n"));
      return 0;
    } catch (e) {
      console.error(`[alphaclaw] telegram topics list failed: ${e.message}`);
      return 1;
    }
  };

  return { runTelegramTopicAdd, runTelegramTopicCreate, runTelegramTopicsList };
};

module.exports = { createTelegramTopicCommands };

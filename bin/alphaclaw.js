#!/usr/bin/env node
"use strict";

// Primitive boot-time crash guards: before the server loads, an unhandled
// rejection must not kill boot silently (Node 22 default) and an uncaught
// exception must exit LOUDLY. The server lifecycle orchestrator
// (lib/server/init/server-lifecycle.js) replaces these with the full guarded
// versions once it installs.
process.on("unhandledRejection", (reason) => {
  console.error(
    `[alphaclaw] Unhandled rejection during boot (continuing): ${reason?.stack || reason}`,
  );
});
process.on("uncaughtException", (error) => {
  console.error(`[alphaclaw] Uncaught exception during boot: ${error?.stack || error}`);
  process.exit(1);
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");
const {
  shouldSkipSystemCronInstall,
  resolveGitAskPassPath,
  resolveGitShimPath,
  prependGitShimDirToPath,
  normalizeGitSyncFilePath,
  validateGitSyncFilePath,
  resolveRealGitPath,
  shouldRefreshHourlyGitSyncScript,
} = require("../lib/cli/git-runtime");
const {
  ensureMainUpstream,
  restoreMissingOpenclawConfigFromRemote,
} = require("../lib/cli/openclaw-config-restore");
const { buildSecretReplacements } = require("../lib/server/helpers");
const { resolveSelfDependency } = require("../lib/server/self-dependency");
const {
  migrateLegacyTelegramStreamingConfig,
} = require("../lib/server/openclaw-config-migrations");
const {
  migrateManagedInternalFiles,
} = require("../lib/server/internal-files-migration");
const { assertSupportedNodeVersion } = require("../lib/node-runtime");

const kUsageTrackerPluginPath = path.resolve(
  __dirname,
  "..",
  "lib",
  "plugin",
  "usage-tracker",
);

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);

const flagValue = (argv, ...flags) => {
  for (const flag of flags) {
    const idx = argv.indexOf(flag);
    if (idx !== -1 && idx + 1 < argv.length) {
      return argv[idx + 1];
    }
  }
  return undefined;
};

const kGlobalValueFlags = new Set(["--root-dir", "--port"]);
const splitGlobalAndCommandArgs = (argv) => {
  const globalArgs = [];
  let index = 0;
  while (index < argv.length) {
    const token = argv[index];
    if (!token.startsWith("-")) break;
    globalArgs.push(token);
    if (kGlobalValueFlags.has(token) && index + 1 < argv.length) {
      globalArgs.push(argv[index + 1]);
      index += 2;
      continue;
    }
    index += 1;
  }
  return {
    globalArgs,
    commandArgs: argv.slice(index),
  };
};

const { globalArgs, commandArgs } = splitGlobalAndCommandArgs(args);
const command = commandArgs[0];
const commandScope = commandArgs[1];
const commandAction = commandArgs[2];

const pkg = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
);

if (
  args.includes("--version") ||
  args.includes("-v") ||
  command === "version"
) {
  console.log(pkg.version);
  process.exit(0);
}

if (!command || command === "help" || args.includes("--help")) {
  console.log(`
alphaclaw v${pkg.version}

Usage: alphaclaw <command> [options]

Commands:
  start     Start the AlphaClaw server (Setup UI + gateway manager)
  git-sync  Commit and push /data/.openclaw safely using GITHUB_TOKEN
  doctor finding complete  Mark a queued Doctor finding fixed after verification
  telegram topic add  Add/update Telegram topic mapping by thread ID
  telegram topic create  Create a Telegram forum topic and register it
  telegram topics list  List registered, discovered, and stale Telegram topics
  admin <METHOD> <path>  Administer AlphaClaw via the local API (requires features.agentAdmin)
  admin manifest  Print the agent-admin operation catalog
  version   Print version

Global options:
--version, -v       Print version
--help              Show this help message

start options:
--root-dir <path>   Persistent data directory (default: ~/.alphaclaw)
--port <number>     Server port (default: 3000)

git-sync options:
  --message, -m <text> Commit message
  --file, -f <path>    Optional file path in .openclaw to sync only one file

telegram topic add options:
  --thread <id>       Telegram thread ID
  --name <text>       Topic name
  --system <text>     Optional system instructions
  --agent <id>        Optional agent ID for per-topic routing
  --group <id>        Optional group ID override (auto-resolves when one group exists)

telegram topic create options:
  --group <id>        Telegram group (chat) ID
  --name <text>       Topic name
  --agent <id>        Optional agent ID for per-topic routing

telegram topics list options:
  --group <id>        Optional group ID filter
  --json              Machine-readable JSON output

doctor finding complete options:
  --id <id>           Doctor finding ID
  --run <run-id>      Queued fix run ID
  --token <token>     One-time completion token

Examples:
  alphaclaw git-sync --message "sync workspace"
  alphaclaw git-sync --message "update config" --file "workspace/app/config.json"
  alphaclaw telegram topic add --thread 12 --name "Testing"
  alphaclaw telegram topic add --thread 12 --name "Testing" --system "Handle QA requests"
  alphaclaw telegram topic add --thread 12 --name "Ops" --agent ops
  alphaclaw telegram topic create --group -1001234567890 --name "Launch"
  alphaclaw telegram topics list --group -1001234567890 --json
`);
  process.exit(0);
}

if (command === "start") {
  try {
    assertSupportedNodeVersion();
  } catch (error) {
    console.error(`[alphaclaw] ${error.message}`);
    process.exit(1);
  }
}

const quoteArg = (value) => `'${String(value || "").replace(/'/g, "'\"'\"'")}'`;
const resolveGithubRepoPath = (value) =>
  String(value || "")
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");

// ---------------------------------------------------------------------------
// 1. Resolve root directory (before requiring any lib/ modules)
// ---------------------------------------------------------------------------

const rootDir =
  flagValue(args, "--root-dir") ||
  process.env.ALPHACLAW_ROOT_DIR ||
  path.join(os.homedir(), ".alphaclaw");

process.env.ALPHACLAW_ROOT_DIR = rootDir;

const portFlag = flagValue(args, "--port");
if (portFlag) {
  process.env.PORT = portFlag;
}

// ---------------------------------------------------------------------------
// 2. Create directory structure
// ---------------------------------------------------------------------------

const openclawDir = path.join(rootDir, ".openclaw");
fs.mkdirSync(openclawDir, { recursive: true });
const { hourlyGitSyncPath } = migrateManagedInternalFiles({
  fs,
  openclawDir,
});
console.log(`[alphaclaw] Root directory: ${rootDir}`);

// Check for pending update marker (written by the update endpoint before restart).
// In environments where the container filesystem is ephemeral (Railway, etc.),
// the npm install from the update endpoint is lost on restart. This re-runs it
// from the fresh container using the persistent volume marker.
const pendingUpdateMarker = path.join(rootDir, ".alphaclaw-update-pending");
if (fs.existsSync(pendingUpdateMarker)) {
  const selfDep = resolveSelfDependency({ fsImpl: fs });
  if (selfDep.isGit) {
    // Git-based installs update by redeploying (which reinstalls from the pinned
    // ref), not by `npm install <pkg>@latest`. Clear the marker and move on.
    console.log(
      "[alphaclaw] Pending update marker found, but this install is git-based; updates apply on redeploy. Skipping npm install.",
    );
    fs.unlinkSync(pendingUpdateMarker);
  } else {
    const selfUpdatePackageName = selfDep.key || "alphaclaw";
    console.log(
      `[alphaclaw] Pending update detected, installing ${selfUpdatePackageName}@latest...`,
    );
    try {
      execSync(
        `npm install ${selfUpdatePackageName}@latest --omit=dev --prefer-online`,
        {
          cwd: selfDep.installDir,
          stdio: "inherit",
          timeout: 180000,
        },
      );
      fs.unlinkSync(pendingUpdateMarker);
      console.log("[alphaclaw] Update applied successfully");
    } catch (e) {
      console.log(`[alphaclaw] Update install failed: ${e.message}`);
      fs.unlinkSync(pendingUpdateMarker);
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Symlink ~/.openclaw -> <root>/.openclaw
// ---------------------------------------------------------------------------

const homeOpenclawLink = path.join(os.homedir(), ".openclaw");
try {
  if (!fs.existsSync(homeOpenclawLink)) {
    fs.symlinkSync(openclawDir, homeOpenclawLink);
    console.log(`[alphaclaw] Symlinked ${homeOpenclawLink} -> ${openclawDir}`);
  }
} catch (e) {
  console.log(`[alphaclaw] Symlink skipped: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 4. Ensure <rootDir>/.env exists (seed from template if missing)
// ---------------------------------------------------------------------------

const envFilePath = path.join(rootDir, ".env");
const setupDir = path.join(__dirname, "..", "lib", "setup");
const templatePath = path.join(setupDir, "env.template");

try {
  if (!fs.existsSync(envFilePath) && fs.existsSync(templatePath)) {
    fs.copyFileSync(templatePath, envFilePath);
    console.log(`[alphaclaw] Created env at ${envFilePath}`);
  }
} catch (e) {
  console.log(`[alphaclaw] .env setup skipped: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 5. Load .env into process.env
// ---------------------------------------------------------------------------

if (fs.existsSync(envFilePath)) {
  const content = fs.readFileSync(envFilePath, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    if (value) process.env[key] = value;
  }
  console.log("[alphaclaw] Loaded .env");
}

const runGitSync = () => {
  const githubToken = String(process.env.GITHUB_TOKEN || "").trim();
  const githubRepo = resolveGithubRepoPath(
    process.env.GITHUB_WORKSPACE_REPO || "",
  );
  const commitMessage = String(
    flagValue(commandArgs, "--message", "-m") || "",
  ).trim();
  const requestedFilePath = String(
    flagValue(commandArgs, "--file", "-f") || "",
  ).trim();
  const normalizedFilePath = normalizeGitSyncFilePath(requestedFilePath);
  if (!commitMessage) {
    console.error("[alphaclaw] Missing --message for git-sync");
    return 1;
  }
  if (normalizedFilePath) {
    const pathValidation = validateGitSyncFilePath(normalizedFilePath);
    if (!pathValidation.ok) {
      console.error(pathValidation.error);
      return 1;
    }
  }
  if (!githubToken) {
    console.error("[alphaclaw] Missing GITHUB_TOKEN for git-sync");
    return 1;
  }
  if (!githubRepo) {
    console.error("[alphaclaw] Missing GITHUB_WORKSPACE_REPO for git-sync");
    return 1;
  }
  if (!fs.existsSync(path.join(openclawDir, ".git"))) {
    console.error("[alphaclaw] No git repository at /data/.openclaw");
    return 1;
  }

  const realGitPath = resolveRealGitPath({
    shimPath: resolveGitShimPath(),
  });
  if (!realGitPath) {
    console.error(
      "[alphaclaw] Missing git binary for git-sync; install git in the runtime image",
    );
    return 1;
  }

  const originUrl = `https://github.com/${githubRepo}.git`;
  let branch = "main";
  try {
    branch =
      String(
        execSync("git symbolic-ref --short HEAD", {
          cwd: openclawDir,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ).trim() || "main";
  } catch {}
  const askPassPath = path.join(
    os.tmpdir(),
    `alphaclaw-git-askpass-${process.pid}.sh`,
  );
  const runGit = (gitCommand, { withAuth = false } = {}) => {
    const cmd = withAuth
      ? `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=${quoteArg(askPassPath)} ${quoteArg(realGitPath)} ${gitCommand}`
      : `${quoteArg(realGitPath)} ${gitCommand}`;
    return execSync(cmd, {
      cwd: openclawDir,
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_TOKEN: githubToken,
      },
    });
  };

  try {
    fs.writeFileSync(
      askPassPath,
      [
        "#!/usr/bin/env sh",
        'case "$1" in',
        '  *Username*) echo "x-access-token" ;;',
        '  *Password*) echo "${GITHUB_TOKEN:-}" ;;',
        '  *) echo "" ;;',
        "esac",
        "",
      ].join("\n"),
      { mode: 0o700 },
    );

    runGit(`remote set-url origin ${quoteArg(originUrl)}`);
    runGit(`config user.name ${quoteArg("AlphaClaw Agent")}`);
    runGit(`config user.email ${quoteArg("agent@alphaclaw.md")}`);
    try {
      runGit(`ls-remote --exit-code --heads origin ${quoteArg(branch)}`, {
        withAuth: true,
      });
      runGit(`pull --rebase --autostash origin ${quoteArg(branch)}`, {
        withAuth: true,
      });
    } catch {
      console.log(
        `[alphaclaw] Remote branch "${branch}" not found, skipping pull`,
      );
    }
    if (normalizedFilePath) {
      runGit(`add -A -- ${quoteArg(normalizedFilePath)}`);
    } else {
      runGit("add -A");
    }
    try {
      runGit("diff --cached --quiet");
      console.log("[alphaclaw] No changes to commit");
      return 0;
    } catch {}
    if (normalizedFilePath) {
      runGit(
        `commit -m ${quoteArg(commitMessage)} -- ${quoteArg(normalizedFilePath)}`,
      );
    } else {
      runGit(`commit -m ${quoteArg(commitMessage)}`);
    }
    runGit(`push origin ${quoteArg(branch)}`, { withAuth: true });
    const hash = String(runGit("rev-parse --short HEAD")).trim();
    console.log(`[alphaclaw] Git sync complete (${hash})`);
    console.log(
      `[alphaclaw] Commit URL: https://github.com/${githubRepo}/commit/${hash}`,
    );
    return 0;
  } catch (e) {
    const details = String(e.stderr || e.stdout || e.message || "").trim();
    console.error(`[alphaclaw] git-sync failed: ${details.slice(0, 400)}`);
    return 1;
  } finally {
    try {
      fs.rmSync(askPassPath, { force: true });
    } catch {}
  }
};

if (command === "git-sync") {
  process.exit(runGitSync());
}

const runDoctorFindingComplete = () => {
  const cardId = Number.parseInt(
    String(flagValue(commandArgs, "--id") || ""),
    10,
  );
  const runId = String(flagValue(commandArgs, "--run") || "").trim();
  const token = String(flagValue(commandArgs, "--token") || "").trim();
  if (!Number.isInteger(cardId) || cardId <= 0 || !runId || !token) {
    console.error(
      "[alphaclaw] doctor finding complete requires --id, --run, and --token",
    );
    return 1;
  }

  const {
    closeDoctorDb,
    completeDoctorCardFix,
    initDoctorDb,
  } = require("../lib/server/db/doctor");
  const {
    hashDoctorFixToken,
  } = require("../lib/server/doctor/fix-completion");
  try {
    initDoctorDb({ rootDir, markInterruptedRuns: false });
    const card = completeDoctorCardFix({
      id: cardId,
      runId,
      tokenHash: hashDoctorFixToken(token),
    });
    if (!card) {
      console.error("[alphaclaw] Doctor fix completion was not accepted");
      return 1;
    }
    console.log(`[alphaclaw] Doctor finding ${cardId} marked fixed`);
    return 0;
  } catch (error) {
    console.error(
      `[alphaclaw] Doctor fix completion failed: ${error.message || "Unknown error"}`,
    );
    return 1;
  } finally {
    closeDoctorDb();
  }
};

if (
  command === "doctor" &&
  commandScope === "finding" &&
  commandAction === "complete"
) {
  process.exit(runDoctorFindingComplete());
}

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
  } = require("../lib/server/telegram-workspace");
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
  const { readOpenclawConfig } = require("../lib/server/openclaw-config");
  return readOpenclawConfig({ fsModule: fs, openclawDir });
};

const syncTelegramWorkspaceArtifacts = ({
  topicRegistry,
  groupId,
  accountId,
  requireMention,
}) => {
  const { syncConfigForTelegram } = require("../lib/server/telegram-workspace");
  const {
    syncBootstrapPromptFiles,
  } = require("../lib/server/onboarding/workspace");
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

    const topicRegistry = require("../lib/server/topic-registry");
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

if (
  command === "telegram" &&
  commandScope === "topic" &&
  commandAction === "add"
) {
  process.exit(runTelegramTopicAdd());
}

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

    const { createTelegramApi } = require("../lib/server/telegram-api");
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

    const topicRegistry = require("../lib/server/topic-registry");
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

if (
  command === "telegram" &&
  commandScope === "topic" &&
  commandAction === "create"
) {
  runTelegramTopicCreate().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`[alphaclaw] telegram topic create failed: ${e.message}`);
      process.exit(1);
    },
  );
  return;
}

const runTelegramTopicsList = () => {
  const requestedGroupId = String(
    flagValue(commandArgs, "--group") || "",
  ).trim();
  const asJson = commandArgs.includes("--json");

  try {
    const topicRegistry = require("../lib/server/topic-registry");
    const rows = topicRegistry.listTopics({ groupId: requestedGroupId });
    if (asJson) {
      // Single line so consumers can take the last stdout line even with
      // startup logs above it.
      console.log(JSON.stringify(rows));
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

if (
  command === "telegram" &&
  commandScope === "topics" &&
  commandAction === "list"
) {
  process.exit(runTelegramTopicsList());
}

// `alphaclaw admin ...` — an out-of-process HTTP client for the running
// server's /api surface. Early-exit BEFORE the release-channel boot sync so it
// can never race an activation (same contract as the telegram/doctor verbs).
if (command === "admin") {
  const { runAdminCommand } = require("../lib/cli/admin");
  runAdminCommand({ argv: commandArgs.slice(1), rootDir })
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, code: "cli_error", message: error.message })}\n`,
      );
      process.exit(1);
    });
  return;
}

const kPort = String(process.env.PORT || "3000").trim();
if (kPort === "18789") {
  console.error(
    [
      "[alphaclaw] Fatal config error: AlphaClaw cannot be started on port 18789.",
      "[alphaclaw] Port 18789 is reserved for the OpenClaw gateway.",
    ].join("\n"),
  );
  process.exit(1);
}

const kSetupPassword = String(process.env.SETUP_PASSWORD || "").trim();
if (!kSetupPassword) {
  console.error(
    [
      "[alphaclaw] Fatal config error: SETUP_PASSWORD is missing or empty.",
      "[alphaclaw] Set SETUP_PASSWORD in your deployment environment variables and restart.",
      "[alphaclaw] Examples:",
      "[alphaclaw] - Render: Dashboard -> Environment -> Add SETUP_PASSWORD",
      "[alphaclaw] - Railway: Project -> Variables -> Add SETUP_PASSWORD",
    ].join("\n"),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 6b. Boot placeholder server
// ---------------------------------------------------------------------------
// The heavy pre-listen work below (pending-update npm install up to 3min,
// gog CLI download, git fetches, migrations) used to leave the port silently
// closed — users saw connection-refused and platform health checks failed.
// The placeholder runs as a CHILD PROCESS (lib/boot-placeholder-child.js):
// the boot work below blocks THIS process's event loop for minutes (execSync
// npm install, gog download), so an in-process server would accept TCP but
// never answer HTTP during exactly the windows it exists to cover. The
// handler itself lives in lib/boot-placeholder.js where it is unit-testable.
// SIGTERM'd right before the real server starts; the real server's
// EADDRINUSE retry covers the close/rebind race.
const bootPlaceholder = (() => {
  try {
    const { spawn } = require("child_process");
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "..", "lib", "boot-placeholder-child.js")],
      {
        env: {
          ...process.env,
          ALPHACLAW_PLACEHOLDER_PORT: String(Number.parseInt(kPort, 10) || 3000),
        },
        stdio: "ignore",
      },
    );
    child.on("error", () => {});
    return child;
  } catch {
    return null;
  }
})();

// ---------------------------------------------------------------------------
// 7. Set OPENCLAW_HOME globally so all child processes inherit it
// ---------------------------------------------------------------------------

process.env.OPENCLAW_HOME = rootDir;
process.env.HOME = rootDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(openclawDir, "openclaw.json");
process.env.OPENCLAW_STATE_DIR = openclawDir;
process.env.GOG_KEYRING_PASSWORD =
  process.env.GOG_KEYRING_PASSWORD || "alphaclaw";

// ---------------------------------------------------------------------------
// 8. Install gog (Google Workspace CLI) if not present
// ---------------------------------------------------------------------------

process.env.XDG_CONFIG_HOME = openclawDir;

// ---------------------------------------------------------------------------
// 7b. OpenClaw release-channel boot sync (offline, synchronous, fail-open)
// ---------------------------------------------------------------------------
// Re-applies the explicitly selected OpenClaw version (overlay store / dev
// checkout shim) BEFORE anything below shells `openclaw`. Runs only in the
// `start` path — CLI subcommands (git-sync, doctor, telegram) exited earlier,
// so hourly cron processes can never race an activation. Any failure must fall
// back to the image's pinned install; startup itself is never blocked.
try {
  const { kOpenclawBinShimDir } = require("../lib/server/constants");
  const shimPathPrefix = `${kOpenclawBinShimDir}${path.delimiter}`;
  if (!String(process.env.PATH || "").startsWith(shimPathPrefix)) {
    process.env.PATH = `${shimPathPrefix}${process.env.PATH || ""}`;
  }
  const {
    runOpenclawChannelBootSync,
  } = require("../lib/server/openclaw-channel-sync");
  runOpenclawChannelBootSync({});
} catch (e) {
  console.log(`[openclaw-channel] boot sync failed (fail-open): ${e.message}`);
}

const ensureGogCliCompatConfigPath = () => {
  const configDir = path.join(rootDir, ".config");
  const compatPath = path.join(configDir, "gogcli");
  const managedPath = path.join(openclawDir, "gogcli");

  try {
    fs.mkdirSync(configDir, { recursive: true });
    if (!fs.existsSync(compatPath)) {
      fs.symlinkSync(managedPath, compatPath, "dir");
      console.log(
        `[alphaclaw] Linked gogcli config path ${compatPath} -> ${managedPath}`,
      );
      return;
    }

    const stat = fs.lstatSync(compatPath);
    if (!stat.isSymbolicLink()) return;
    const linkTarget = fs.readlinkSync(compatPath);
    const resolvedTarget = path.resolve(configDir, linkTarget);
    if (resolvedTarget !== managedPath) {
      console.log(
        `[alphaclaw] gogcli config path already exists at ${compatPath}; leaving existing symlink in place`,
      );
    }
  } catch (error) {
    console.log(
      `[alphaclaw] gogcli config path compatibility setup skipped: ${error.message}`,
    );
  }
};

ensureGogCliCompatConfigPath();

const gogInstalled = (() => {
  try {
    execSync("command -v gog", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

if (!gogInstalled) {
  console.log("[alphaclaw] Installing gog CLI...");
  try {
    const gogVersion = process.env.GOG_VERSION || "0.11.0";
    const platform = os.platform() === "darwin" ? "darwin" : "linux";
    const arch = os.arch() === "arm64" ? "arm64" : "amd64";
    const tarball = `gogcli_${gogVersion}_${platform}_${arch}.tar.gz`;
    const url = `https://github.com/steipete/gogcli/releases/download/v${gogVersion}/${tarball}`;
    execSync(
      `curl -fsSL "${url}" -o /tmp/gog.tar.gz && tar -xzf /tmp/gog.tar.gz -C /tmp/ && mv /tmp/gog /usr/local/bin/gog && chmod +x /usr/local/bin/gog && rm -f /tmp/gog.tar.gz`,
      // A hung download must not stall boot forever (the placeholder page is
      // covering the port, but /health flips to 503 after 15min).
      { stdio: "inherit", timeout: 120000 },
    );
    console.log("[alphaclaw] gog CLI installed");
  } catch (e) {
    console.log(`[alphaclaw] gog install skipped: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 9. Install/reconcile system cron entry
// ---------------------------------------------------------------------------

const packagedHourlyGitSyncPath = path.join(setupDir, "hourly-git-sync.sh");

try {
  if (fs.existsSync(packagedHourlyGitSyncPath)) {
    const packagedSyncScript = fs.readFileSync(
      packagedHourlyGitSyncPath,
      "utf8",
    );
    const installedSyncScript = fs.existsSync(hourlyGitSyncPath)
      ? fs.readFileSync(hourlyGitSyncPath, "utf8")
      : "";
    if (
      shouldRefreshHourlyGitSyncScript({
        packagedSyncScript,
        installedSyncScript,
      })
    ) {
      fs.writeFileSync(hourlyGitSyncPath, packagedSyncScript, { mode: 0o755 });
      console.log("[alphaclaw] Refreshed hourly git sync script");
    }
  }
} catch (e) {
  console.log(
    `[alphaclaw] Hourly git sync script refresh skipped: ${e.message}`,
  );
}

if (fs.existsSync(hourlyGitSyncPath)) {
  try {
    const syncCronConfig = path.join(openclawDir, "cron", "system-sync.json");
    let cronEnabled = true;
    let cronSchedule = "0 * * * *";

    if (fs.existsSync(syncCronConfig)) {
      try {
        const cfg = JSON.parse(fs.readFileSync(syncCronConfig, "utf8"));
        cronEnabled = cfg.enabled !== false;
        const schedule = String(cfg.schedule || "").trim();
        if (/^(\S+\s+){4}\S+$/.test(schedule)) cronSchedule = schedule;
      } catch {}
    }

    const cronFilePath = "/etc/cron.d/openclaw-hourly-sync";
    if (shouldSkipSystemCronInstall()) {
      console.log(
        "[alphaclaw] System cron setup skipped by ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL",
      );
    } else if (cronEnabled) {
      const cronContent = [
        "SHELL=/bin/bash",
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        `${cronSchedule} root bash "${hourlyGitSyncPath}" >> /var/log/openclaw-hourly-sync.log 2>&1`,
        "",
      ].join("\n");
      fs.writeFileSync(cronFilePath, cronContent, { mode: 0o644 });
      console.log("[alphaclaw] System cron entry installed");
    } else {
      try {
        fs.unlinkSync(cronFilePath);
      } catch {}
      console.log("[alphaclaw] System cron entry disabled");
    }
  } catch (e) {
    console.log(`[alphaclaw] Cron setup skipped: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 9. Start cron daemon if available
// ---------------------------------------------------------------------------

try {
  execSync("command -v cron", { stdio: "ignore" });
  try {
    execSync("pgrep -x cron", { stdio: "ignore" });
  } catch {
    execSync("cron", { stdio: "ignore" });
  }
  console.log("[alphaclaw] Cron daemon running");
} catch {}

// ---------------------------------------------------------------------------
// 10. Reconcile channels if already onboarded
// ---------------------------------------------------------------------------

const configPath = path.join(openclawDir, "openclaw.json");
const githubRepo = process.env.GITHUB_WORKSPACE_REPO;

if (fs.existsSync(path.join(openclawDir, ".git"))) {
  if (githubRepo) {
    const repoUrl = githubRepo
      .replace(/^git@github\.com:/, "")
      .replace(/^https:\/\/github\.com\//, "")
      .replace(/\.git$/, "");
    const remoteUrl = `https://github.com/${repoUrl}.git`;
    try {
      execSync(`git remote set-url origin "${remoteUrl}"`, {
        cwd: openclawDir,
        stdio: "ignore",
      });
      console.log("[alphaclaw] Repo ready");
    } catch {}
  }

  // Migration path: scrub persisted PATs from existing GitHub origin URLs.
  try {
    const existingOrigin = execSync("git remote get-url origin", {
      cwd: openclawDir,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
    const match = existingOrigin.match(/^https:\/\/[^/@]+@github\.com\/(.+)$/i);
    if (match?.[1]) {
      const cleanedPath = String(match[1]).replace(/\.git$/i, "");
      const cleanedOrigin = `https://github.com/${cleanedPath}.git`;
      execSync(`git remote set-url origin "${cleanedOrigin}"`, {
        cwd: openclawDir,
        stdio: "ignore",
      });
      console.log("[alphaclaw] Scrubbed tokenized GitHub remote URL");
    }
  } catch {}

  restoreMissingOpenclawConfigFromRemote({
    openclawDir,
    configPath,
    env: process.env,
  });
  if (
    ensureMainUpstream({
      openclawDir,
      gitEnv: process.env,
    })
  ) {
    console.log("[alphaclaw] Set main upstream to origin/main");
  }
}

// Persist config-shape migrations before any OpenClaw import or CLI command.
// Newer OpenClaw releases validate config eagerly and cannot repair a shape
// that prevents the CLI from starting.
if (fs.existsSync(configPath)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (migrateLegacyTelegramStreamingConfig(cfg)) {
      let content = `${JSON.stringify(cfg, null, 2)}\n`;
      for (const [secret, envRef] of buildSecretReplacements(process.env)) {
        if (!secret) continue;
        content = content
          .split(JSON.stringify(secret))
          .join(JSON.stringify(envRef));
      }
      fs.writeFileSync(configPath, content, "utf8");
      console.log("[alphaclaw] Migrated legacy Telegram streaming config");
    }
  } catch (error) {
    console.error(
      `[alphaclaw] Preflight config migration failed: ${error.message}`,
    );
  }
}

if (fs.existsSync(configPath)) {
  try {
    execFileSync(process.execPath, [
      path.join(__dirname, "..", "lib", "scripts", "migrate-openclaw-codex.js"),
    ], {
      env: process.env,
      stdio: "inherit",
      timeout: 60_000,
    });
  } catch (error) {
    console.error(`[alphaclaw] Codex migration process failed: ${error.message}`);
  }
}

if (fs.existsSync(configPath)) {
  try {
    execFileSync(process.execPath, [
      path.join(__dirname, "..", "lib", "scripts", "reconcile-codex-plugin.js"),
    ], {
      env: process.env,
      stdio: "inherit",
      timeout: 150_000,
    });
  } catch (error) {
    console.error(
      `[alphaclaw] Codex plugin reconciliation process failed: ${error.message}`,
    );
  }
}

if (fs.existsSync(configPath)) {
  console.log("[alphaclaw] Config exists, reconciling channels...");

  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!cfg.channels) cfg.channels = {};
    if (!cfg.plugins) cfg.plugins = {};
    if (!cfg.plugins.load) cfg.plugins.load = {};
    if (!Array.isArray(cfg.plugins.load.paths)) cfg.plugins.load.paths = [];
    if (!cfg.plugins.entries) cfg.plugins.entries = {};
    let changed = migrateLegacyTelegramStreamingConfig(cfg);
    if (changed) {
      console.log("[alphaclaw] Migrated legacy Telegram streaming config");
    }

    if (process.env.TELEGRAM_BOT_TOKEN && !cfg.channels.telegram) {
      cfg.channels.telegram = {
        enabled: true,
        botToken: process.env.TELEGRAM_BOT_TOKEN,
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
      };
      cfg.plugins.entries.telegram = { enabled: true };
      console.log("[alphaclaw] Telegram added");
      changed = true;
    }

    if (process.env.DISCORD_BOT_TOKEN && !cfg.channels.discord) {
      cfg.channels.discord = {
        enabled: true,
        token: process.env.DISCORD_BOT_TOKEN,
        dmPolicy: "pairing",
        groupPolicy: "allowlist",
      };
      cfg.plugins.entries.discord = { enabled: true };
      console.log("[alphaclaw] Discord added");
      changed = true;
    }
    // Drop usage-tracker plugin paths left by a previous install location (e.g. a
    // prior @chrysb/alphaclaw npm install at /app/node_modules/@chrysb/alphaclaw/...
    // after switching to a git dependency at /app/node_modules/alphaclaw/...). The
    // dead path makes OpenClaw reject the whole config. This block runs on every
    // boot whenever a config exists — onboarded or not — so it is the migration's
    // load-bearing prune; the onboarded reconcile prune is a backstop.
    const usageTrackerPathPattern = /[\\/]plugin[\\/]usage-tracker[\\/]?$/;
    const prunedPaths = cfg.plugins.load.paths.filter(
      (entry) =>
        entry === kUsageTrackerPluginPath ||
        !usageTrackerPathPattern.test(String(entry || "")),
    );
    if (prunedPaths.length !== cfg.plugins.load.paths.length) {
      cfg.plugins.load.paths = prunedPaths;
      changed = true;
    }
    if (!cfg.plugins.load.paths.includes(kUsageTrackerPluginPath)) {
      cfg.plugins.load.paths.push(kUsageTrackerPluginPath);
      changed = true;
    }
    if (cfg.plugins.entries["usage-tracker"]?.enabled !== true) {
      cfg.plugins.entries["usage-tracker"] = { enabled: true };
      changed = true;
    }

    if (changed) {
      let content = JSON.stringify(cfg, null, 2);
      const replacements = buildSecretReplacements(process.env);
      for (const [secret, envRef] of replacements) {
        if (secret) {
          // Only replace the secret if it is an exact match for a JSON string value
          // This ensures we do not replace substrings inside other strings
          const secretJson = JSON.stringify(secret);
          content = content.replace(
            new RegExp(
              secretJson.replace(/[-\/\\^$*+?.()|[\]{}]/g, "\\$&"),
              "g",
            ),
            JSON.stringify(envRef),
          );
        }
      }
      fs.writeFileSync(configPath, content);
      console.log("[alphaclaw] Config updated and sanitized");
    }
  } catch (e) {
    console.error(`[alphaclaw] Channel reconciliation error: ${e.message}`);
  }
} else {
  console.log(
    "[alphaclaw] No config yet -- onboarding will run from the Setup UI",
  );
}

// ---------------------------------------------------------------------------
// 12. Install systemctl shim if in Docker (no real systemd)
// ---------------------------------------------------------------------------

try {
  execSync("command -v systemctl", { stdio: "ignore" });
} catch {
  const shimSrc = path.join(__dirname, "..", "lib", "scripts", "systemctl");
  const shimDest = "/usr/local/bin/systemctl";
  try {
    fs.copyFileSync(shimSrc, shimDest);
    fs.chmodSync(shimDest, 0o755);
    console.log("[alphaclaw] systemctl shim installed");
  } catch (e) {
    console.log(`[alphaclaw] systemctl shim skipped: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 13. Install git auth shim
// ---------------------------------------------------------------------------

try {
  const gitAskPassSrc = path.join(__dirname, "..", "lib", "scripts", "git-askpass");
  const gitAskPassDest = resolveGitAskPassPath({
    tmpDir: os.tmpdir(),
  });
  const gitShimTemplatePath = path.join(__dirname, "..", "lib", "scripts", "git");
  const gitShimDest = resolveGitShimPath();
  process.env.PATH = prependGitShimDirToPath({
    shimPath: gitShimDest,
  });

  if (fs.existsSync(gitAskPassSrc)) {
    fs.mkdirSync(path.dirname(gitAskPassDest), { recursive: true });
    fs.copyFileSync(gitAskPassSrc, gitAskPassDest);
    fs.chmodSync(gitAskPassDest, 0o755);
  }

  if (fs.existsSync(gitShimTemplatePath)) {
    const realGitPath =
      resolveRealGitPath({
        shimPath: gitShimDest,
      }) || "/usr/bin/git";

    const gitShimTemplate = fs.readFileSync(gitShimTemplatePath, "utf8");
    const gitShimContent = gitShimTemplate
      .replace("@@REAL_GIT@@", realGitPath)
      .replace("@@OPENCLAW_REPO_ROOT@@", openclawDir)
      .replace("@@ASKPASS_PATH@@", gitAskPassDest);
    fs.mkdirSync(path.dirname(gitShimDest), { recursive: true });
    fs.writeFileSync(gitShimDest, gitShimContent, { mode: 0o755 });
    console.log("[alphaclaw] git auth shim installed");
  }
} catch (e) {
  console.log(`[alphaclaw] git auth shim skipped: ${e.message}`);
}

// ---------------------------------------------------------------------------
// 14. Start Express server
// ---------------------------------------------------------------------------

console.log("[alphaclaw] Setup complete -- starting server");
if (bootPlaceholder) {
  try {
    // The child latches on SIGTERM (no further bind retries), destroys its
    // connections, and exits within ~1s — the real server's EADDRINUSE
    // retry covers any overlap.
    bootPlaceholder.kill("SIGTERM");
  } catch {}
}
require("../lib/server.js");

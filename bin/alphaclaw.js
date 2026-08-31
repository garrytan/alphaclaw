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

// constants.js snapshots ALPHACLAW_ROOT_DIR at first require — the env MUST
// be set before any ../lib require (v0.9.38 regression: helpers/
// self-dependency load constants), or a `--root-dir` run splits state across
// two roots. Same precedence as the re-derivation further down:
// --root-dir flag → ALPHACLAW_ROOT_DIR env → ~/.alphaclaw.
const resolveRootDirFromArgv = (argv) => {
  const flagIndex = argv.indexOf("--root-dir");
  const flagRootDir =
    flagIndex !== -1 && flagIndex + 1 < argv.length
      ? argv[flagIndex + 1]
      : undefined;
  return (
    flagRootDir ||
    process.env.ALPHACLAW_ROOT_DIR ||
    path.join(os.homedir(), ".alphaclaw")
  );
};
process.env.ALPHACLAW_ROOT_DIR = resolveRootDirFromArgv(process.argv.slice(2));

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
const { buildSystemCronFile, isSafeCronSchedule } = require("../lib/cli/system-cron");
const {
  ensureMainUpstream,
  restoreMissingOpenclawConfigFromRemote,
} = require("../lib/cli/openclaw-config-restore");
const {
  writeGitAskpassScript,
  kGitAskpassScript,
} = require("../lib/git-askpass-script");
const { buildSecretReplacements } = require("../lib/server/helpers");
const { resolveSelfDependency } = require("../lib/server/self-dependency");
const {
  migrateLegacyTelegramStreamingConfig,
} = require("../lib/server/openclaw-config-migrations");
const {
  migrateManagedInternalFiles,
} = require("../lib/server/internal-files-migration");
const { assertSupportedNodeVersion } = require("../lib/node-runtime");
const { isEarlyExitCliCommand } = require("../lib/boot-cli-verbs");

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
  git-sync  Commit and push the managed .openclaw directory safely using GITHUB_TOKEN
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
// 1. Resolve root directory
// ---------------------------------------------------------------------------

// Idempotent re-derivation of the pre-require resolution at the top of this
// file (same helper, same argv, and ALPHACLAW_ROOT_DIR already carries the
// resolved value) — it cannot disagree with the root the ../lib requires
// snapshotted.
const rootDir = resolveRootDirFromArgv(args);

process.env.ALPHACLAW_ROOT_DIR = rootDir;

const portFlag = flagValue(args, "--port");
if (portFlag) {
  process.env.PORT = portFlag;
}

// PORT is final after the --port flag above; the SETUP_PASSWORD check
// further down still guards before the real server binds.
const kPort = String(process.env.PORT || "3000").trim();

// ---------------------------------------------------------------------------
// 1a. Reserved-port guard
// ---------------------------------------------------------------------------
// This guard MUST precede the placeholder spawn below: the placeholder binds
// kPort immediately, and a misconfigured PORT=18789 would briefly squat the
// gateway's own port before this fatal exit fired.
if (kPort === "18789") {
  console.error(
    [
      "[alphaclaw] Fatal config error: AlphaClaw cannot be started on port 18789.",
      "[alphaclaw] Port 18789 is reserved for the OpenClaw gateway.",
    ].join("\n"),
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 1b. Boot placeholder server
// ---------------------------------------------------------------------------
// The heavy pre-listen work below (pending-update npm install up to 3min,
// gog CLI download, git fetches, migrations) used to leave the port silently
// closed — users saw connection-refused and platform health checks failed.
// Spawned HERE, right after ALPHACLAW_ROOT_DIR (which it inherits for live
// update-progress rendering) and PORT are resolved, so it also covers the
// pending self-update npm install below — previously a ~3-minute blind
// window before the old spawn point.
// The placeholder runs as a CHILD PROCESS (lib/boot-placeholder-child.js):
// the boot work below blocks THIS process's event loop for minutes (execSync
// npm install, gog download), so an in-process server would accept TCP but
// never answer HTTP during exactly the windows it exists to cover. The
// handler itself lives in lib/boot-placeholder.js where it is unit-testable.
// SIGTERM'd right before the real server starts; the real server's
// EADDRINUSE retry covers the close/rebind race. This now runs ABOVE the
// port/SETUP_PASSWORD fatal exits — safe, because the child self-exits via
// its ppid orphan check within ~3s of this process dying.
// The verb matrix lives in lib/boot-cli-verbs.js (unit-tested there). Anyone
// adding or changing an early-exit dispatch site below MUST update that
// module too, or the placeholder will fight a live server for the port.
const kIsEarlyExitCliCommand = isEarlyExitCliCommand({
  command,
  commandScope,
  commandAction,
});
const bootPlaceholder = (() => {
  // CLI verbs exit long before the server boots — don't bind a placeholder
  // web server for them (it would fight a live server for the port).
  if (kIsEarlyExitCliCommand) return null;
  try {
    const { spawn } = require("child_process");
    const child = spawn(
      process.execPath,
      [path.join(__dirname, "..", "lib", "boot-placeholder-child.js")],
      {
        env: {
          ...process.env,
          ALPHACLAW_PLACEHOLDER_PORT: String(Number.parseInt(kPort, 10) || 3000),
          // Explicit parent identity for the child's orphan check — the
          // sampled-ppid fallback races a parent that exits before the
          // child's first sample (fatal PORT/password guards below).
          ALPHACLAW_PARENT_PID: String(process.pid),
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

// Divergence warning (issue #25): a REAL ~/.openclaw directory with its own
// state db means some openclaw invocation ran without OPENCLAW_STATE_DIR and
// built a second, divergent state database (the incident box had a 1.1MB
// stray next to the real 392MB one — and `openclaw status` read the stray,
// reporting a healthy gateway as "No channels configured"). The symlink above
// is skipped whenever the path exists, so this warning is the only signal.
try {
  if (path.resolve(homeOpenclawLink) !== path.resolve(openclawDir)) {
    const linkStat = fs.lstatSync(homeOpenclawLink);
    if (
      linkStat.isDirectory() &&
      !linkStat.isSymbolicLink() &&
      fs.existsSync(path.join(homeOpenclawLink, "state", "openclaw.sqlite"))
    ) {
      console.warn(
        [
          `[alphaclaw] WARNING: ${homeOpenclawLink} is a real directory with its own state database,`,
          `[alphaclaw]          separate from the managed state dir ${openclawDir}.`,
          "[alphaclaw]          Something ran `openclaw` without OPENCLAW_STATE_DIR (operator shell, cron)",
          "[alphaclaw]          and built a second, divergent state db — commands reading it will show",
          "[alphaclaw]          empty channels/sessions while the real gateway runs. Move it aside, e.g.:",
          `[alphaclaw]          mv ${homeOpenclawLink} ${homeOpenclawLink}.stray`,
        ].join("\n"),
      );
    }
  }
} catch {}

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

// ---------------------------------------------------------------------------
// 5b. Export the OpenClaw state-resolution env for EVERY verb (issue #25)
// ---------------------------------------------------------------------------
// Every CLI verb (git-sync, admin, telegram …) — not just `start` — can shell
// `openclaw` or spawn children that do. Without these vars openclaw resolves
// state to ~/.openclaw, and on >= 2026.9.1-beta.1 a wrong-dir invocation
// CREATES and migrates a whole divergent state database. Placed after the
// .env load so the managed values always win over a hand-edited .env, and
// before the first verb dispatch. Deliberately only the three OPENCLAW_*
// vars: exporting HOME/XDG_CONFIG_HOME here would reroute npm (~/.npmrc in
// the pending-update install above), git config/SSH for git-sync, and the
// ~/.openclaw symlink logic — the `start` path below keeps its full
// five-var block for the server + its children.
process.env.OPENCLAW_HOME = rootDir;
process.env.OPENCLAW_STATE_DIR = openclawDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(openclawDir, "openclaw.json");

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
    console.error(`[alphaclaw] No git repository at ${openclawDir}`);
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
  // Shared hardened askpass (H9 host-parse) in a private mkdtemp dir (H14 —
  // no predictable ${pid} path a symlink can hijack, since git executes it).
  const { scriptPath: askPassPath } = writeGitAskpassScript();
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
      // Remove the private mkdtemp dir, not just the script (H14).
      fs.rmSync(path.dirname(askPassPath), { recursive: true, force: true });
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

// (The reserved-port 18789 guard moved to 1a above — it must run before the
// placeholder binds kPort.)

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

// (Section 6b, the boot placeholder server, moved to 1b above so it also
// covers the pending self-update npm install.)

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

// Supervisor contract (plan 1.1): every `openclaw` this process (or the boot
// sync below) shells — including the once-per-version `doctor --fix` — must
// carry OPENCLAW_SUPERVISOR_MODE/SERVICE_REPAIR_POLICY before lib/server.js
// loads and mirrors them itself.
try {
  const {
    ensureOpenclawStartupEnv,
  } = require("../lib/server/openclaw-runtime-env");
  ensureOpenclawStartupEnv();
} catch (e) {
  console.log(`[openclaw] supervisor env setup failed (fail-open): ${e.message}`);
}

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
        if (isSafeCronSchedule(schedule)) {
          cronSchedule = schedule;
        } else if (schedule) {
          console.log(
            `[alphaclaw] Ignoring invalid stored sync-cron schedule ${JSON.stringify(schedule)}; using the default (${cronSchedule})`,
          );
        }
      } catch {}
    }

    const cronFilePath = "/etc/cron.d/openclaw-hourly-sync";
    if (shouldSkipSystemCronInstall()) {
      console.log(
        "[alphaclaw] System cron setup skipped by ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL",
      );
    } else if (cronEnabled) {
      // Shared builder (issue #25): this boot-time reconcile used to rewrite
      // the file WITHOUT the env lines on every start, destroying the correct
      // onboarding-written copy — cron then ran against a phantom
      // ~/.alphaclaw install.
      const cronContent = buildSystemCronFile({
        schedule: cronSchedule,
        scriptPath: hourlyGitSyncPath,
        rootDir,
        openclawDir,
      });
      if (cronContent) {
        // Atomic install (dotted temp names are ignored by cron.d).
        if (typeof fs.renameSync === "function") {
          fs.writeFileSync(`${cronFilePath}.tmp`, cronContent, { mode: 0o644 });
          fs.renameSync(`${cronFilePath}.tmp`, cronFilePath);
        } else {
          fs.writeFileSync(cronFilePath, cronContent, { mode: 0o644 });
        }
        console.log("[alphaclaw] System cron entry installed");
      } else {
        // The builder refused — never leave a stale (possibly pre-fix
        // poisoned) managed file behind for cron to keep executing.
        try {
          fs.unlinkSync(cronFilePath);
          console.log(
            "[alphaclaw] Removed managed cron file: builder refused the current configuration",
          );
        } catch {}
      }
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
// 8b. Operator-shell openclaw env: /usr/local/bin wrapper + profile.d (issue #25)
// ---------------------------------------------------------------------------
// `docker exec <c> openclaw status` runs with HOME=/root and none of the
// OPENCLAW_* vars — on >= 2026.9.1-beta.1 that CREATES a divergent state db
// in /root/.openclaw and reports a healthy gateway as "No channels
// configured" (the exact incident misdirection). The wrapper catches every
// shell (docker exec included, via PATH); profile.d only covers login shells
// and is the secondary layer. Best-effort and never silent: the outcome is
// logged either way. Values are single-quoted with escaping — rootDir is
// operator-controlled. Never overwrites a file alphaclaw did not author.
const kManagedSnippetMarker = "# alphaclaw-managed openclaw environment";
const shQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;
const kWrapperPathOverride = String(
  process.env.ALPHACLAW_OPENCLAW_WRAPPER_PATH || "",
).trim();
const kProfileSnippetPathOverride = String(
  process.env.ALPHACLAW_PROFILE_SNIPPET_PATH || "",
).trim();
if (String(process.env.ALPHACLAW_SKIP_PROFILE_ENV || "") === "1") {
  console.log(
    "[alphaclaw] Operator-shell openclaw env skipped by ALPHACLAW_SKIP_PROFILE_ENV",
  );
} else if (
  !kWrapperPathOverride &&
  typeof process.getuid === "function" &&
  process.getuid() !== 0
) {
  // Writing /usr/local/bin and /etc/profile.d is a root-deployment concern
  // (the Docker images run as root); a non-root dev/test run must not spray
  // files onto the host. Overriding the path opts back in (tests use this).
  console.log(
    "[alphaclaw] Operator-shell openclaw env skipped (not running as root) — `openclaw` in operator shells will not carry the managed state dir",
  );
} else {
  // Persisted install outcome (never silent, survives the boot log): the
  // post-deploy smoke and operators can check this instead of scrolling logs.
  const operatorShellEnvOutcome = { at: new Date().toISOString() };
  const persistOperatorShellEnvOutcome = () => {
    try {
      const outcomePath = path.join(
        openclawDir,
        ".alphaclaw",
        "operator-shell-env.json",
      );
      fs.mkdirSync(path.dirname(outcomePath), { recursive: true });
      fs.writeFileSync(
        outcomePath,
        JSON.stringify(operatorShellEnvOutcome, null, 2),
      );
    } catch {}
  };
  const wrapperPath = kWrapperPathOverride || "/usr/local/bin/openclaw";
  const { kOpenclawBinShimDir } = require("../lib/server/constants");
  const managedShimPath = path.join(kOpenclawBinShimDir, "openclaw");
  // The pinned install's real bin, resolved at generation time — the wrapper
  // execs this when no release-channel shim exists (pin/beta channels).
  let installedOpenclawBinPath = "/nonexistent/openclaw";
  try {
    const openclawPkgDir = path.dirname(
      require.resolve("openclaw/package.json"),
    );
    const openclawPkg = JSON.parse(
      fs.readFileSync(path.join(openclawPkgDir, "package.json"), "utf8"),
    );
    const binRel =
      typeof openclawPkg.bin === "string"
        ? openclawPkg.bin
        : Object.values(openclawPkg.bin || {})[0];
    if (binRel) installedOpenclawBinPath = path.join(openclawPkgDir, binRel);
  } catch {}
  const wrapperContent = [
    "#!/bin/sh",
    `${kManagedSnippetMarker} (wrapper) — regenerated at boot, do not edit.`,
    `export ALPHACLAW_ROOT_DIR=${shQuote(rootDir)}`,
    `export OPENCLAW_HOME=${shQuote(rootDir)}`,
    `export OPENCLAW_STATE_DIR=${shQuote(openclawDir)}`,
    `export OPENCLAW_CONFIG_PATH=${shQuote(path.join(openclawDir, "openclaw.json"))}`,
    // Prefer the release-channel shim (the version alphaclaw manages — it
    // only exists on the dev channel; pin/beta activation removes it), then
    // the alphaclaw install's own openclaw bin, then a portable PATH walk
    // that skips this wrapper itself. NOTE: `command -v -a` is NOT the
    // fallback here — POSIX sh (dash, bash-as-sh) rejects the -a flag, which
    // would leave the wrapper exiting 127 in front of a perfectly good
    // openclaw on every non-dev box.
    `if [ -x ${shQuote(managedShimPath)} ]; then exec ${shQuote(managedShimPath)} "$@"; fi`,
    `if [ -x ${shQuote(installedOpenclawBinPath)} ]; then exec ${shQuote(installedOpenclawBinPath)} "$@"; fi`,
    '_ifs="$IFS"; IFS=:',
    "for _dir in $PATH; do",
    '  [ -n "$_dir" ] || continue',
    `  [ "$_dir/openclaw" = ${shQuote(wrapperPath)} ] && continue`,
    '  if [ -x "$_dir/openclaw" ]; then IFS="$_ifs"; exec "$_dir/openclaw" "$@"; fi',
    "done",
    'IFS="$_ifs"',
    `echo "openclaw: no managed openclaw found (expected ${managedShimPath})" >&2`,
    "exit 127",
    "",
  ].join("\n");
  try {
    const existing = fs.existsSync(wrapperPath)
      ? fs.readFileSync(wrapperPath, "utf8")
      : null;
    if (existing !== null && !existing.includes(kManagedSnippetMarker)) {
      operatorShellEnvOutcome.wrapper = "skipped: existing non-managed file";
      console.log(
        `[alphaclaw] openclaw wrapper NOT installed: ${wrapperPath} exists and is not alphaclaw-managed`,
      );
    } else {
      if (existing !== wrapperContent) {
        fs.writeFileSync(wrapperPath, wrapperContent, { mode: 0o755 });
        console.log(`[alphaclaw] openclaw wrapper installed at ${wrapperPath}`);
      }
      operatorShellEnvOutcome.wrapper = `installed: ${wrapperPath}`;
    }
  } catch (e) {
    operatorShellEnvOutcome.wrapper = `failed: ${e.message}`;
    console.log(
      `[alphaclaw] openclaw wrapper NOT installed (${e.message}) — operator shells resolve openclaw without the managed state dir`,
    );
  }
  const profileSnippetPath =
    kProfileSnippetPathOverride || "/etc/profile.d/alphaclaw-openclaw.sh";
  const profileContent = [
    `${kManagedSnippetMarker} — regenerated at boot, do not edit.`,
    `export ALPHACLAW_ROOT_DIR=${shQuote(rootDir)}`,
    `export OPENCLAW_HOME=${shQuote(rootDir)}`,
    `export OPENCLAW_STATE_DIR=${shQuote(openclawDir)}`,
    `export OPENCLAW_CONFIG_PATH=${shQuote(path.join(openclawDir, "openclaw.json"))}`,
    "",
  ].join("\n");
  try {
    const existing = fs.existsSync(profileSnippetPath)
      ? fs.readFileSync(profileSnippetPath, "utf8")
      : null;
    if (existing !== profileContent) {
      fs.writeFileSync(profileSnippetPath, profileContent, { mode: 0o644 });
      console.log(`[alphaclaw] login-shell env snippet installed at ${profileSnippetPath}`);
    }
    operatorShellEnvOutcome.profileSnippet = `installed: ${profileSnippetPath}`;
  } catch (e) {
    operatorShellEnvOutcome.profileSnippet = `failed: ${e.message}`;
    console.log(`[alphaclaw] login-shell env snippet NOT installed (${e.message})`);
  }
  persistOperatorShellEnvOutcome();
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
  // H14: never copy the askpass helper to a predictable shared-tmp name —
  // copyFileSync follows a pre-planted symlink and chmod makes it executable,
  // and the git shim then runs whatever lives at that path. Default to the
  // shared writer's private mkdtemp (0700) dir; honor an explicit operator
  // override, but write it exclusively (wx) so a symlink re-planted between
  // the rm and the write fails the boot step instead of redirecting it.
  const explicitAskPassPath = resolveGitAskPassPath();
  let gitAskPassDest;
  if (explicitAskPassPath) {
    fs.mkdirSync(path.dirname(explicitAskPassPath), { recursive: true });
    fs.rmSync(explicitAskPassPath, { force: true });
    fs.writeFileSync(explicitAskPassPath, kGitAskpassScript, {
      mode: 0o700,
      flag: "wx",
    });
    gitAskPassDest = explicitAskPassPath;
  } else {
    ({ scriptPath: gitAskPassDest } = writeGitAskpassScript());
  }
  const gitShimTemplatePath = path.join(__dirname, "..", "lib", "scripts", "git");
  const gitShimDest = resolveGitShimPath();
  process.env.PATH = prependGitShimDirToPath({
    shimPath: gitShimDest,
  });

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

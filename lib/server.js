const express = require("express");
const http = require("http");
const httpProxy = require("http-proxy");
const path = require("path");
const fs = require("fs");

const constants = require("./server/constants");
const { initLogWriter, readLogTail } = require("./server/log-writer");
initLogWriter({
  rootDir: constants.kRootDir,
  maxBytes: constants.kLogMaxBytes,
});
const {
  parseJsonFromNoisyOutput,
  normalizeOnboardingModels,
  resolveModelProvider,
  resolveGithubRepoUrl,
  createPkcePair,
  parseCodexAuthorizationInput,
  getCodexAccountId,
  getBaseUrl,
  getApiEnableUrl,
  readGoogleCredentials,
  getClientKey,
} = require("./server/helpers");
const {
  initWebhooksDb,
  insertRequest,
  getRequests,
  getRequestById,
  getHookSummaries,
  deleteRequestsByHook,
  createOauthCallback,
  getOauthCallbackByHook,
  getOauthCallbackById,
  rotateOauthCallback,
  deleteOauthCallback,
  markOauthCallbackUsed,
} = require("./server/db/webhooks");
const {
  initWatchdogDb,
  insertWatchdogEvent,
  getRecentEvents,
} = require("./server/db/watchdog");
const {
  initUsageDb,
  getDailySummary,
  getSessionsList,
  getSessionDetail,
  getSessionTimeSeries,
  getSessionUsageByKeyPattern,
  getTelegramSessionKeysAfterId,
} = require("./server/db/usage");
const topicRegistry = require("./server/topic-registry");
const { createTopicDiscoveryService } = require("./server/topic-discovery");
const { readTopicNameCache } = require("./server/topic-name-cache");
const { resolveAccountIdForGroup } = require("./server/telegram-workspace");
const { parseTelegramSessionKey } = require("./server/utils/session-keys");
const {
  initDoctorDb,
  listDoctorRuns,
  listDoctorCards,
  getInitialWorkspaceBaseline,
  setInitialWorkspaceBaseline,
  createDoctorRun,
  completeDoctorRun,
  insertDoctorCards,
  getDoctorRun,
  getDoctorCardsByRunId,
  getDoctorCard,
  updateDoctorCardStatus,
  startDoctorCardFix,
  cancelDoctorCardFix,
} = require("./server/db/doctor");
const {
  initAuthDb,
  createLoginThrottleStore,
} = require("./server/db/auth");
const { createWebhookMiddleware } = require("./server/webhook-middleware");
const {
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  startEnvWatcher,
} = require("./server/env");
const {
  gatewayEnv,
  getGatewayPort,
  getGatewayUrl,
  isOnboarded,
  isGatewayRunning,
  startGateway,
  restartGateway: restartGatewayWithReload,
  restartGatewayLight: restartGatewayLightWithReload,
  attachGatewaySignalHandlers,
  ensureGatewayProxyConfig,
  syncChannelConfig,
  getChannelStatus,
  launchGatewayProcess,
  setGatewayExitHandler,
  setGatewayFeatureGates,
  setGatewayLaunchHandler,
  stopGatewayChildAndWait,
} = require("./server/gateway");
const { createCommands } = require("./server/commands");
const { createAuthProfiles } = require("./server/auth-profiles");
const { createLoginThrottle } = require("./server/login-throttle");
const { createOpenclawVersionService } = require("./server/openclaw-version");
const { createAlphaclawVersionService } = require("./server/alphaclaw-version");
const {
  createRestartRequiredState,
} = require("./server/restart-required-state");
const {
  ensureOpenclawRuntimeArtifacts,
  resolveSetupUiUrl,
  syncBootstrapPromptFiles,
} = require("./server/onboarding/workspace");
const {
  cleanupStaleImportTempDirs,
} = require("./server/onboarding/import/import-temp");
const {
  migrateManagedInternalFiles,
} = require("./server/internal-files-migration");
const { installGogCliSkill } = require("./server/gog-skill");
const { createTelegramApi } = require("./server/telegram-api");
const { createDiscordApi } = require("./server/discord-api");
const { createSlackApi } = require("./server/slack-api");
const { createWatchdogNotifier } = require("./server/watchdog-notify");
const { createUpgradeNotifier } = require("./server/upgrade-notifier");
const { createNotifyOutbox } = require("./server/notify-outbox");
const { createOperatorsStore } = require("./server/operators-store");
const { createFeatureGates } = require("./server/openclaw-feature-gates");
const { createUpgradeOverseer } = require("./server/upgrade-overseer");
const { createRunStream } = require("./server/openclaw-run-stream");
const { createWatchdog } = require("./server/watchdog");
const {
  createOpenclawChannelSync,
} = require("./server/openclaw-channel-sync");
const {
  createOpenclawReleasesService,
} = require("./server/openclaw-releases");
const { createWatchdogTerminalService } = require("./server/watchdog-terminal");
const {
  createWatchdogTerminalWsBridge,
} = require("./server/watchdog-terminal-ws");
const { createDoctorService } = require("./server/doctor/service");
const { createAgentsService } = require("./server/agents/service");
const { createOperationEventsService } = require("./server/operation-events");
const { createChatWsService } = require("./server/chat-ws");
const { runOnboardedBootSequence } = require("./server/startup");
const { createCronService } = require("./server/cron-service");
const {
  initializeServerRuntime,
  initializeServerDatabases,
} = require("./server/init/runtime-init");
const {
  registerServerRoutes,
} = require("./server/init/register-server-routes");
const {
  startServerLifecycle,
  registerServerShutdown,
} = require("./server/init/server-lifecycle");
const {
  ensureUsageTrackerPluginConfig,
} = require("./server/usage-tracker-config");
const {
  ensureManagedExecDefaults,
} = require("./server/exec-defaults-config");
const {
  ensureOpenclawStartupEnv,
} = require("./server/openclaw-runtime-env");
const {
  isOpenAiCompatApiEnabled,
  readOpenclawOverseerEnabled,
} = require("./server/alphaclaw-config");

const { PORT, kTrustProxyHops, SETUP_API_PREFIXES } = constants;

initializeServerRuntime({
  fs,
  constants,
  ensureOpenclawStartupEnv,
  startEnvWatcher,
  attachGatewaySignalHandlers,
  cleanupStaleImportTempDirs,
  migrateManagedInternalFiles,
});

const app = express();
app.set("trust proxy", kTrustProxyHops);
app.use(["/webhook", "/hooks"], express.raw({ type: "*/*", limit: "5mb" }));
app.use("/gmail-pubsub", express.raw({ type: "*/*", limit: "5mb" }));
const openAiCompatJsonParser = express.json({ limit: "50mb" });
const isOpenAiCompatApiCurrentlyEnabled = () =>
  isOpenAiCompatApiEnabled({
    fsModule: fs,
    openclawDir: constants.OPENCLAW_DIR,
  });
app.use("/v1", (req, res, next) => {
  if (!isOpenAiCompatApiCurrentlyEnabled()) {
    return res.status(404).json({ error: "Not found" });
  }
  return openAiCompatJsonParser(req, res, next);
});
app.use(express.json({ limit: "5mb" }));

const proxy = httpProxy.createProxyServer({
  target: getGatewayUrl(),
  ws: true,
  changeOrigin: true,
});
proxy.on("error", (err, req, res) => {
  if (res && res.writeHead) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Gateway unavailable" }));
  }
});

const authProfiles = createAuthProfiles();
const { shellCmd, clawCmd, gogCmd } = createCommands({ gatewayEnv });
const agentsService = createAgentsService({
  fs,
  OPENCLAW_DIR: constants.OPENCLAW_DIR,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  restartGateway: () => restartGatewayWithReload(reloadEnv),
  clawCmd,
});
const loginThrottleStore = createLoginThrottleStore();
const loginThrottle = {
  ...createLoginThrottle({ store: loginThrottleStore }),
  getClientKey,
};
const openAiCompatApiThrottle = {
  ...createLoginThrottle({
    store: loginThrottleStore,
    scope: "openai-compat-api",
    windowMs: constants.kOpenAiCompatApiRateWindowMs,
    maxAttempts: constants.kOpenAiCompatApiRateMaxAttempts,
    baseLockMs: constants.kOpenAiCompatApiRateBaseLockMs,
    maxLockMs: constants.kOpenAiCompatApiRateMaxLockMs,
    globalWindowMs: constants.kOpenAiCompatApiRateGlobalWindowMs,
    globalMaxAttempts: constants.kOpenAiCompatApiRateGlobalMaxAttempts,
    globalBaseLockMs: constants.kOpenAiCompatApiRateGlobalBaseLockMs,
    globalMaxLockMs: constants.kOpenAiCompatApiRateGlobalMaxLockMs,
    stateTtlMs: constants.kOpenAiCompatApiRateStateTtlMs,
  }),
  getClientKey,
};
// Separate scope from the login buckets (F2): agent-bearer failures must
// never lock a human out of the dashboard. Reuses the openai-compat rate
// knobs — same "automated caller" shape.
const agentAdminThrottle = {
  ...createLoginThrottle({
    store: loginThrottleStore,
    scope: "agent-admin",
    windowMs: constants.kOpenAiCompatApiRateWindowMs,
    maxAttempts: constants.kOpenAiCompatApiRateMaxAttempts,
    baseLockMs: constants.kOpenAiCompatApiRateBaseLockMs,
    maxLockMs: constants.kOpenAiCompatApiRateMaxLockMs,
    globalWindowMs: constants.kOpenAiCompatApiRateGlobalWindowMs,
    globalMaxAttempts: constants.kOpenAiCompatApiRateGlobalMaxAttempts,
    globalBaseLockMs: constants.kOpenAiCompatApiRateGlobalBaseLockMs,
    globalMaxLockMs: constants.kOpenAiCompatApiRateGlobalMaxLockMs,
    stateTtlMs: constants.kOpenAiCompatApiRateStateTtlMs,
  }),
  getClientKey,
};
const resolveSetupUrl = () =>
  resolveSetupUiUrl(
    process.env.ALPHACLAW_SETUP_URL ||
      process.env.ALPHACLAW_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.URL,
  );
const restartGateway = () => restartGatewayWithReload(reloadEnv);
const openclawVersionService = createOpenclawVersionService({
  gatewayEnv,
  restartGateway,
  isOnboarded,
});
const alphaclawVersionService = createAlphaclawVersionService({
  readOpenclawVersion: () => openclawVersionService.readOpenclawVersion(),
});
const restartRequiredState = createRestartRequiredState({ isGatewayRunning });
const operationEvents = createOperationEventsService();
const chatWsService = createChatWsService({
  fs,
  openclawDir: constants.OPENCLAW_DIR,
  getGatewayPort,
});
const cronService = createCronService({
  clawCmd,
  OPENCLAW_DIR: constants.OPENCLAW_DIR,
  getSessionUsageByKeyPattern,
});

app.use(express.static(path.join(__dirname, "public")));
initializeServerDatabases({
  constants,
  initAuthDb,
  initWebhooksDb,
  initWatchdogDb,
  initUsageDb,
  initDoctorDb,
});
// Agent-admin confirm store (dangerous-op one-time codes). Initialized
// unconditionally like the other DBs; unused while the flag is off.
require("./server/db/agent-admin").initAgentAdminDb({
  rootDir: constants.kRootDir,
});
const webhookMiddleware = createWebhookMiddleware({
  getGatewayUrl,
  insertRequest,
  maxPayloadBytes: constants.kMaxPayloadBytes,
});
const telegramApi = createTelegramApi(() => process.env.TELEGRAM_BOT_TOKEN);
const discordApi = createDiscordApi(() => process.env.DISCORD_BOT_TOKEN);
const slackApi = createSlackApi(() => process.env.SLACK_BOT_TOKEN);
const watchdogNotifier = createWatchdogNotifier({
  telegramApi,
  discordApi,
  slackApi,
  clawCmd,
  readEnvFile,
});
// Durable, admin-routed delivery on top of the raw fan-out notifier: events
// are persisted first (outbox), routed to explicit admin targets when
// configured (preferred channel first, fallback only on delivery error), and
// re-drained after the activation restart.
const operatorsStore = createOperatorsStore({});
const notifyOutbox = createNotifyOutbox({});
const upgradeNotifier = createUpgradeNotifier({
  notifier: watchdogNotifier,
  outbox: notifyOutbox,
  operatorsStore,
  getBaseUrl: () => resolveSetupUrl(),
});
upgradeNotifier.start();
// AlphaClaw self-version status, delivered like every other update event.
// The outbox dedups by id, so each new upstream version notifies exactly once
// no matter how many boots or daily checks see it.
const kAlphaclawUpdateCheckDelayMs = 60_000;
const kAlphaclawUpdateCheckIntervalMs = 24 * 60 * 60 * 1000;
const notifyAlphaclawUpdateStatus = async () => {
  try {
    const status = await alphaclawVersionService.getVersionStatus(false);
    if (status?.ok && status.hasUpdate && status.latestVersion) {
      await upgradeNotifier.notify(
        `⬆️ AlphaClaw ${status.latestVersion} is available (running ${status.currentVersion}). Update from the sidebar dialog.`,
        { eventType: "info", id: `alphaclaw-update-${status.latestVersion}` },
      );
    }
  } catch {}
};
setTimeout(notifyAlphaclawUpdateStatus, kAlphaclawUpdateCheckDelayMs).unref();
setInterval(notifyAlphaclawUpdateStatus, kAlphaclawUpdateCheckIntervalMs).unref();
const openclawReleasesService = createOpenclawReleasesService({
  getGithubToken: () => process.env.GITHUB_TOKEN || null,
});
let watchdogRef = null;
const openclawChannelService = createOpenclawChannelSync({
  releases: openclawReleasesService,
  isOnboarded,
  restartProcess: async () => {
    // VPS restarts respawn detached + exit(0), skipping the SIGTERM handlers
    // that reap the managed gateway; an orphan would keep the OLD OpenClaw
    // alive on the port, the new process would skip the gateway start, and
    // health checks would "verify" a version that never ran. Escalating stop:
    // SIGTERM -> 2s grace -> SIGKILL, waiting for the exit.
    try {
      await stopGatewayChildAndWait();
    } catch {}
    alphaclawVersionService.restartProcess();
  },
  isSelfUpdateInProgress: () =>
    alphaclawVersionService.isUpdateInProgress?.() === true,
  clearVersionCache: () => openclawVersionService.clearVersionCache(),
  notify: (message, opts) => upgradeNotifier.notify(message, opts),
  insertEvent: insertWatchdogEvent,
  operationEvents,
  watchdogLatch: () => watchdogRef?.latchManualIntervention?.(),
  // Gateway exits during a version swap must not feed crash accounting.
  watchdogManagedOperation: {
    begin: () => watchdogRef?.beginManagedOperation?.(),
    end: () => watchdogRef?.endManagedOperation?.(),
  },
});
// Version-gated OpenClaw feature detection (fail-closed): beta-only UI
// affordances hide against an older gateway instead of breaking.
const openclawFeatureGates = createFeatureGates({
  getInstalledVersion: () => {
    const info = openclawChannelService.getChannelInfo();
    // A dev build's identity is a commit sha — installedVersion is only the
    // dormant pin the shim would fall back to, NOT what's running. Returning
    // it would let a dev commit inherit beta-only gates (e.g. supervisorMode,
    // whose handoff is unimplemented). Fail closed for dev; the comparator
    // already fails closed on a null/sha version.
    if (info.applied?.channel === "dev") return null;
    return info.installedVersion;
  },
});
// Version-gated supervisor handoff: on 2026.8.1+ betas the gateway env gains
// OPENCLAW_SUPERVISOR_MODE=external (AlphaClaw owns the lifecycle). Fail-closed
// on stable — see the TODO in gateway.js for the verified restart handoff.
setGatewayFeatureGates(openclawFeatureGates);
// Upgrade overseer (recommend-only, default off): after an update run settles
// (acceptance resolved or terminal failure), ask a local `claude` CLI for an
// advisory verdict and notify. The deterministic watchdog stays the ONLY
// enforcement layer — the overseer never calls mark-good/rollback itself.
const upgradeOverseer = createUpgradeOverseer({
  ledger: openclawChannelService.runLedger,
  getChannelInfo: () => openclawChannelService.getChannelInfo(),
  isEnabled: () =>
    readOpenclawOverseerEnabled({ openclawDir: constants.OPENCLAW_DIR }),
  notify: (message, opts) => upgradeNotifier.notify(message, opts),
  getDoctorJson: async () => {
    const result = await clawCmd("doctor --json", {
      quiet: true,
      timeoutMs: 60_000,
    });
    return result.ok ? result.stdout : result.stderr || null;
  },
});
upgradeOverseer.start();
// Verified SQLite backup runner (beta `backup sqlite` subcommand): the route
// is gated on supportsFeature("sqliteBackup"); this just runs the command.
const backupRunStream = createRunStream({});
const runBackupSqlite = () =>
  backupRunStream.runStreamed({
    command: "openclaw",
    args: ["backup", "sqlite", "create", "--verify"],
    env: gatewayEnv(),
    timeoutMs: constants.kOpenclawBackupTimeoutMs,
  });
// Claim the single-instance pidfile: a second `alphaclaw start`'s boot sync
// must no-op instead of mutating the tree this process is serving from.
openclawChannelService.store.writeServerPid?.();
process.on("exit", () => {
  try {
    openclawChannelService.store.clearServerPid?.();
  } catch {}
});

const watchdog = createWatchdog({
  clawCmd,
  launchGatewayProcess,
  insertWatchdogEvent,
  // Watchdog alerts (crash/recovery/safe-mode) get the same durable outbox +
  // admin routing as upgrade lifecycle events.
  notifier: upgradeNotifier,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  resolveSetupUrl,
  resolveGatewayHealthUrl: () => `${getGatewayUrl()}/health`,
  resolveGatewayReadyzUrl: () => `${getGatewayUrl()}/readyz`,
  releaseChannelHooks: {
    getInfo: () => openclawChannelService.getChannelInfo(),
    requestRollback: (payload) =>
      openclawChannelService.requestChannelRollback(payload),
    onHealthy: () => openclawChannelService.onGatewayHealthy(),
    onUnhealthy: () => openclawChannelService.onGatewayUnhealthy(),
  },
});
watchdogRef = watchdog;
// Boot-sync warnings were queued by the pre-server process phase; surface them
// once the notifier stack (telegram pairing etc.) has had time to come up.
const kChannelBootNotifyDelayMs = 10_000;
setTimeout(() => {
  openclawChannelService.flushBootNotifications();
}, kChannelBootNotifyDelayMs).unref();
const watchdogTerminal = createWatchdogTerminalService({
  cwd: constants.OPENCLAW_DIR,
});
const doctorService = createDoctorService({
  clawCmd,
  listDoctorRuns,
  listDoctorCards,
  getInitialWorkspaceBaseline,
  setInitialWorkspaceBaseline,
  createDoctorRun,
  completeDoctorRun,
  insertDoctorCards,
  getDoctorRun,
  getDoctorCardsByRunId,
  getDoctorCard,
  updateDoctorCardStatus,
  startDoctorCardFix,
  cancelDoctorCardFix,
  workspaceRoot: constants.WORKSPACE_DIR,
  managedRoot: constants.OPENCLAW_DIR,
  alphaclawRootDir: constants.kRootDir,
  protectedPaths: Array.from(constants.kProtectedBrowsePaths || []),
  lockedPaths: Array.from(constants.kLockedBrowsePaths || []),
});
setGatewayExitHandler((payload) => watchdog.onGatewayExit(payload));
setGatewayLaunchHandler((payload) => watchdog.onGatewayLaunch(payload));
// Order matters (A23): token → skill → bootstrap. The bootstrap TOOLS.md
// stanza is conditional on the agent-admin skill being installed, so the
// skill must exist first or the stanza misses on first enable.
const syncAgentAdminArtifacts = () => {
  try {
    const {
      isAgentAdminEnabled,
    } = require("./server/alphaclaw-config");
    const tokenStore = require("./server/agent-admin/token-store");
    const openclawDir = constants.OPENCLAW_DIR;
    if (isAgentAdminEnabled({ openclawDir })) {
      const { error } = tokenStore.ensureToken({ openclawDir });
      if (error) {
        insertWatchdogEvent({
          eventType: "agent_admin",
          source: "agent-admin",
          status: "failed",
          details: { phase: "token_mint_failed", error: error.message },
        });
      }
    } else {
      tokenStore.removeToken({ openclawDir });
    }
    // Skill install/unlink AFTER the token exists (A23 ordering).
    const {
      installAlphaclawAdminSkill,
    } = require("./server/agent-admin/skill");
    installAlphaclawAdminSkill({ fs, openclawDir });
  } catch (e) {
    console.error("[agent-admin] artifact sync error:", e.message);
  }
};
const doSyncPromptFiles = () => {
  const setupUiUrl = resolveSetupUrl();
  ensureOpenclawRuntimeArtifacts({
    fs,
    openclawDir: constants.OPENCLAW_DIR,
  });
  syncAgentAdminArtifacts();
  syncBootstrapPromptFiles({
    fs,
    workspaceDir: constants.WORKSPACE_DIR,
    baseUrl: setupUiUrl,
  });
  installGogCliSkill({ fs, openclawDir: constants.OPENCLAW_DIR });
};
const { readOpenclawConfig } = require("./server/openclaw-config");
const topicDiscovery = createTopicDiscoveryService({
  openclawDir: constants.OPENCLAW_DIR,
  topicRegistry,
  usageDb: { getTelegramSessionKeysAfterId },
  readConfig: () =>
    readOpenclawConfig({ openclawDir: constants.OPENCLAW_DIR, fallback: {} }),
  readNameCache: readTopicNameCache,
  resolveAccountIdForGroup,
  parseTelegramSessionKey,
  syncPromptFiles: doSyncPromptFiles,
  notify: (message, opts) => {
    if (watchdog.getSettings().notificationsEnabled === false) {
      return { ok: false, skipped: true, reason: "notifications_disabled" };
    }
    return watchdogNotifier.notify(message, opts);
  },
  logEvent: ({ status, source, details }) => {
    try {
      insertWatchdogEvent({
        eventType: "topic_discovery",
        source,
        status,
        details,
      });
    } catch {}
  },
});
topicDiscovery.start();
const {
  isAuthorizedRequest,
  resolveRequestOperator,
  gmailWatchService,
  runOnboardedBootSequence: runOnboardedBoot,
} = registerServerRoutes({
  app,
  fs,
  constants,
  loginThrottle,
  shellCmd,
  clawCmd,
  gogCmd,
  gatewayEnv,
  parseJsonFromNoisyOutput,
  normalizeOnboardingModels,
  authProfiles,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  isOnboarded,
  isGatewayRunning,
  resolveGithubRepoUrl,
  resolveModelProvider,
  ensureGatewayProxyConfig,
  isOpenAiCompatApiEnabled: isOpenAiCompatApiCurrentlyEnabled,
  openAiCompatApiThrottle,
  agentAdminThrottle,
  getBaseUrl,
  startGateway,
  ensureManagedExecDefaults: () =>
    ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir: constants.OPENCLAW_DIR,
    }),
  ensureUsageTrackerPluginConfig: () =>
    ensureUsageTrackerPluginConfig({
      fsModule: fs,
      openclawDir: constants.OPENCLAW_DIR,
    }),
  resolveSetupUrl,
  syncChannelConfig,
  getChannelStatus,
  openclawVersionService,
  alphaclawVersionService,
  restartGateway,
  restartRequiredState,
  topicRegistry,
  createPkcePair,
  parseCodexAuthorizationInput,
  getCodexAccountId,
  readGoogleCredentials,
  getApiEnableUrl,
  telegramApi,
  doSyncPromptFiles,
  getRequests,
  getRequestById,
  getHookSummaries,
  deleteRequestsByHook,
  createOauthCallback,
  getOauthCallbackByHook,
  getOauthCallbackById,
  rotateOauthCallback,
  deleteOauthCallback,
  markOauthCallbackUsed,
  watchdog,
  watchdogNotifier,
  getRecentEvents,
  readLogTail,
  watchdogTerminal,
  getDailySummary,
  getSessionsList,
  getSessionDetail,
  getSessionTimeSeries,
  cronService,
  doctorService,
  agentsService,
  operationEvents,
  openclawChannelService,
  openclawReleasesService,
  openclawFeatureGates,
  operatorsStore,
  upgradeNotifier,
  upgradeOverseer,
  runBackupSqlite,
  proxy,
  getGatewayUrl,
  SETUP_API_PREFIXES,
  webhookMiddleware,
  topicDiscovery,
});
app.get("/api/chat/history", async (req, res) => {
  const upgradeReq = {
    headers: req.headers,
    path: req.path,
    query: req.query || {},
  };
  if (!isAuthorizedRequest(upgradeReq)) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }
  const sessionKey = String(req.query?.sessionKey || "").trim();
  if (!sessionKey) {
    return res.status(400).json({ ok: false, error: "sessionKey is required" });
  }
  try {
    const { messages, rawHistory } = await chatWsService.fetchHistory(sessionKey);
    return res.json({
      ok: true,
      sessionKey,
      messages,
      rawHistory,
    });
  } catch (err) {
    return res.status(502).json({
      ok: false,
      error: err?.message || "Could not load chat history",
    });
  }
});

const server = http.createServer(app);
createWatchdogTerminalWsBridge({
  server,
  proxy,
  getGatewayUrl,
  isAuthorizedRequest,
  watchdogTerminal,
  chatWsService,
  resolveProxyIdentity: resolveRequestOperator,
});

startServerLifecycle({
  server,
  PORT,
  isOnboarded,
  runOnboardedBootSequence: runOnboardedBoot,
});
registerServerShutdown({
  gmailWatchService,
  watchdogTerminal,
});

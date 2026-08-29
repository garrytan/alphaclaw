const express = require("express");
const compression = require("compression");
const { shouldCompress } = require("./server/compression-filter");
const http = require("http");
// http-proxy-3: maintained, API-compatible rewrite of node-http-proxy
// (unmaintained since 2018 with documented socket-leak classes). Pinned exact.
const httpProxy = require("http-proxy-3");
const { createTeamPresence } = require("./server/team/presence");
const path = require("path");
const fs = require("fs");

const constants = require("./server/constants");
const { initLogWriter, readLogTail, flushLogWriter } = require("./server/log-writer");
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
const watchdogDb = require("./server/db/watchdog");
const {
  createWatchdogIncidentTracker,
} = require("./server/watchdog-incidents");
const { getSystemResources } = require("./server/system-resources");
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
  listDoctorRunSummaries,
  listDoctorCards,
  getInitialWorkspaceBaseline,
  setInitialWorkspaceBaseline,
  createDoctorRun,
  completeDoctorRun,
  insertDoctorCards,
  getDoctorRun,
  getDoctorRunManifest,
  getLatestCompletedRunSummary,
  getDoctorCardsByRunId,
  getDoctorCard,
  updateDoctorCardStatus,
  startDoctorCardFix,
  cancelDoctorCardFix,
} = require("./server/db/doctor");
const {
  initAuthDb,
  createLoginThrottleStore,
  getAuthDb,
} = require("./server/db/auth");
const { createMembersStore } = require("./server/db/auth/members");
const { createWebhookMiddleware } = require("./server/webhook-middleware");
const {
  readEnvFile,
  readEnvFileStrict,
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
  probeGatewayTcp,
  setGatewayTcpTransitionHandler,
  startGateway,
  restartGateway: restartGatewayWithReload,
  attachGatewaySignalHandlers,
  restartGatewayLight: restartGatewayLightWithReload,
  stopGatewayForShutdown,
  ensureGatewayProxyConfig,
  syncChannelConfig,
  getChannelStatus,
  launchGatewayProcess,
  setGatewayExitHandler,
  setGatewayLaunchHandler,
  stopGatewayChild,
} = require("./server/gateway");
const { createCommands } = require("./server/commands");
const { createAuthProfiles } = require("./server/auth-profiles");
const { createLoginThrottle } = require("./server/login-throttle");
const { createOpenclawVersionService } = require("./server/openclaw-version");
const { createIsProxiedPath } = require("./server/routes/proxy");
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
const {
  createWatchdogNotifier,
  resolveTelegramBotToken,
} = require("./server/watchdog-notify");
const { createUpgradeNotifier } = require("./server/upgrade-notifier");
const { createNotifyOutbox } = require("./server/notify-outbox");
const { createOperatorsStore } = require("./server/operators-store");
const { createFeatureGates } = require("./server/openclaw-feature-gates");
const { createUpgradeOverseer } = require("./server/upgrade-overseer");
const { createRunStream } = require("./server/openclaw-run-stream");
const { createWatchdog } = require("./server/watchdog");
const {
  createOpenclawCapabilities,
} = require("./server/openclaw-capabilities");
const {
  createGatewayLifecycleLock,
} = require("./server/gateway-lifecycle-lock");
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
const { closeCronStoreDb } = require("./server/cron-store");
const {
  initializeServerRuntime,
  initializeServerDatabases,
} = require("./server/init/runtime-init");
const {
  registerServerRoutes,
} = require("./server/init/register-server-routes");
const {
  createServerLifecycle,
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
  readTeamSettings,
  readOpenclawMedicEnabled,
  readOpenclawOverseerEnabled,
  readWatchdogOverseerEnabled,
  updateWatchdogOverseerEnabled,
} = require("./server/alphaclaw-config");
const { createWatchdogOverseer } = require("./server/watchdog-overseer");
const { createGatewayMedic } = require("./server/gateway-medic");
const { createFrontierLlmClient } = require("./server/llm-client");

const { PORT, kTrustProxyHops, SETUP_API_PREFIXES } = constants;

initializeServerRuntime({
  fs,
  constants,
  ensureOpenclawStartupEnv,
  startEnvWatcher,
  cleanupStaleImportTempDirs,
  migrateManagedInternalFiles,
});

const app = express();
app.set("trust proxy", kTrustProxyHops);
app.use(compression({ filter: shouldCompress }));
app.use(["/webhook", "/hooks"], express.raw({ type: "*/*", limit: "5mb" }));
app.use("/gmail-pubsub", express.raw({ type: "*/*", limit: "5mb" }));
// 20mb (was 50mb): parsing a 50MB JSON body can transiently need hundreds of
// MB — an OOM vector on the 512MB instances this app commonly runs on.
const openAiCompatJsonParser = express.json({ limit: "20mb" });
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
// Body parsing must SKIP proxied paths: a parsed request stream is already
// consumed when http-proxy pipes it, so the gateway waits forever on a body
// that never arrives (every proxied JSON POST/PUT used to hang until the
// gateway timed out). createIsProxiedPath is the single routing authority
// shared with routes/proxy.js. Proxied bodies get their own streamed-bytes
// cap there instead of this parser's limit.
const isProxiedPath = createIsProxiedPath(constants.SETUP_API_PREFIXES);
const localJsonParser = express.json({ limit: "5mb" });
app.use((req, res, next) => {
  if (isProxiedPath(req)) return next();
  return localJsonParser(req, res, next);
});

// Env-tunable so operators with slow gateways can raise it — and so the e2e
// suite can prove the hung-gateway 504 path without waiting out 30 seconds.
const kProxyTimeoutMs =
  Number.parseInt(process.env.ALPHACLAW_PROXY_TIMEOUT_MS || "", 10) || 30000;
const proxy = httpProxy.createProxyServer({
  target: getGatewayUrl(),
  ws: true,
  changeOrigin: true,
  // Fail fast on a hung gateway instead of dangling the request forever.
  proxyTimeout: kProxyTimeoutMs,
});
// http-proxy-3 arms proxyTimeout as an IDLE timeout on the gateway socket for
// the whole exchange, so a legitimately slow streaming response (>30s between
// bytes) would be destroyed mid-stream. The timeout's only clean-504 window
// is before headers arrive anyway — once the gateway responds, relax the idle
// bound to 15 minutes: generous enough for slow streams, still reaps zombie
// connections whose peer stopped reading forever.
// Known limitation: http-proxy-3 skips the proxyReq event for requests
// carrying an Expect header (e.g. curl's automatic 100-continue on large
// uploads), so those keep the strict 30s idle bound for their whole exchange.
const kProxyPostHeaderIdleMs = 15 * 60 * 1000;
proxy.on("proxyReq", (proxyReq, req) => {
  // http-proxy-3's timeout handler destroys proxyReq with NO error, so the
  // error handler below would see ECONNRESET and report 502 — mark the
  // request so a genuine gateway timeout still surfaces as 504.
  proxyReq.on("timeout", () => {
    if (req) req.__gatewayTimedOut = true;
  });
  proxyReq.on("response", () => proxyReq.setTimeout(kProxyPostHeaderIdleMs));
});
// Identity handling for gateway-bound traffic (4.3) lives in ONE layer:
// routes/proxy.js forwardToGateway (HTTP) and watchdog-terminal-ws (WS
// upgrades) sanitize inbound identity/forwarded-evidence headers and inject
// the VERIFIED member identity via lib/server/proxy-identity.js.
const teamPresence = createTeamPresence();
// Roster-change hook filled in once the team gateway-config service exists.
const teamHooks = { onMemberRosterChanged: async () => {} };
proxy.on("error", (err, req, res) => {
  // `res` is a ServerResponse for HTTP requests but a raw net.Socket for
  // failed WS upgrades — and for HTTP it may already have flushed headers.
  // writeHead in either state throws from inside an EventEmitter handler,
  // which (with no uncaughtException handler) kills the whole process.
  if (!res) return;
  if (typeof res.writeHead !== "function") {
    // WS upgrade socket: destroy it or it leaks an FD per retry.
    try {
      res.destroy();
    } catch {}
    return;
  }
  if (res.headersSent || res.writableEnded) {
    try {
      res.destroy();
    } catch {}
    return;
  }
  const status =
    err?.code === "ETIMEDOUT" || req?.__gatewayTimedOut ? 504 : 502;
  try {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: status === 504 ? "Gateway timed out" : "Gateway unavailable",
      }),
    );
  } catch {
    try {
      res.destroy();
    } catch {}
  }
});

const authProfiles = createAuthProfiles();
const { shellCmd, clawCmd, clawCmdWithRetry, gogCmd } = createCommands({
  gatewayEnv,
});
const agentsService = createAgentsService({
  fs,
  OPENCLAW_DIR: constants.OPENCLAW_DIR,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  // Channel create/delete/WhatsApp flows restart the gateway from service
  // code; serialize them through the shared lifecycle lock so they can never
  // interleave with a route restart, repair, or boot. (User paths queue.)
  restartGateway: async () => {
    const release = await gatewayLifecycleLock.acquire("restart");
    try {
      return await restartGatewayWithReload(reloadEnv);
    } finally {
      release();
    }
  },
  clawCmd,
  gatewayEnv,
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
const restartGateway = (options) => restartGatewayWithReload(reloadEnv, options);
const openclawVersionService = createOpenclawVersionService({
  gatewayEnv,
  restartGateway,
  isOnboarded,
});
// Prewarm the version cache off the event loop so the first status snapshot
// (and the model catalog) never wait on a cold `openclaw --version` spawn.
openclawVersionService.refreshOpenclawVersion().catch(() => {});
// Assigned at the bottom of this file once the HTTP server exists; the drain
// hook below late-binds to it so restart paths can drain before exiting.
let serverLifecycle = null;

const alphaclawVersionService = createAlphaclawVersionService({
  readOpenclawVersion: () => openclawVersionService.readOpenclawVersion(),
  // Every restart path (self-update, version switch, rollback) drains through
  // the single lifecycle orchestrator instead of raw process.exit.
  drain: async () => {
    if (serverLifecycle) await serverLifecycle.drain();
    else await stopGatewayForShutdown().catch(() => {});
  },
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
// Team mode (4.1/4.2): member accounts live in the auth DB; team settings in
// alphaclaw.json.
const membersStore = createMembersStore({ getDb: getAuthDb });
const readTeamSettingsFromConfig = () =>
  readTeamSettings({ openclawDir: constants.OPENCLAW_DIR });
const webhookMiddleware = createWebhookMiddleware({
  getGatewayUrl,
  insertRequest,
  maxPayloadBytes: constants.kMaxPayloadBytes,
});
// Shared Telegram token resolver: env first, then the literal token
// onboarding writes into openclaw.json (channels.telegram.botToken). Wired
// into BOTH the API client and the notifier's configured-check so a box
// whose token lives only in openclaw.json can still deliver alerts (the #21
// no_channels_delivered gap). Config read failures degrade to env-only.
const getTelegramToken = () =>
  resolveTelegramBotToken({ openclawDir: constants.OPENCLAW_DIR });
const telegramApi = createTelegramApi(getTelegramToken);
const discordApi = createDiscordApi(() => process.env.DISCORD_BOT_TOKEN);
const slackApi = createSlackApi(() => process.env.SLACK_BOT_TOKEN);
const watchdogNotifier = createWatchdogNotifier({
  telegramApi,
  discordApi,
  slackApi,
  clawCmd,
  readEnvFile,
  getTelegramToken,
});
// Durable, admin-routed delivery on top of the raw fan-out notifier: events
// are persisted first (outbox), routed to explicit admin targets when
// configured (preferred channel first, fallback only on delivery error), and
// re-drained after the activation restart.
const operatorsStore = createOperatorsStore({});
const notifyOutbox = createNotifyOutbox({
  // 48h age-outs persist a `notification_abandoned` watchdog event so a lost
  // alert is visible in the incidents UI even when no channel ever worked.
  // (initializeServerDatabases above has already opened the watchdog DB.)
  insertEvent: insertWatchdogEvent,
});
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
// One-shot catalog prewarm so the first Upgrade-page visit isn't a cold
// multi-second fan-out. Deliberately NO interval: SWR refreshes on demand and
// a perpetual poll would burn the anonymous GitHub quota (60/hr).
setTimeout(
  () => {
    openclawReleasesService.getCatalog().catch(() => {});
  },
  constants.kOpenclawCatalogPrewarmDelayMs +
    Math.floor(Math.random() * constants.kOpenclawCatalogPrewarmJitterMs),
).unref();
let watchdogRef = null;
const openclawChannelService = createOpenclawChannelSync({
  // Lazy: the lock const is defined below; calls happen at request time.
  getActiveGatewayOperation: () => gatewayLifecycleLock.getActiveOperation(),
  releases: openclawReleasesService,
  isOnboarded,
  restartProcess: async () => {
    // restartProcess drains through the lifecycle orchestrator (terminator,
    // gateway child reap, log flush) before either exit path — no orphaned
    // OpenClaw on the port, no dropped in-flight responses.
    await alphaclawVersionService.restartProcess();
  },
  isSelfUpdateInProgress: () =>
    alphaclawVersionService.isUpdateInProgress?.() === true,
  clearVersionCache: () => {
    openclawVersionService.clearVersionCache();
    openclawCapabilities?.invalidate();
  },
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
// Feature-detect what the INSTALLED OpenClaw supports (probe-not-version-gate).
// Lazy + cached; NEVER called on the 2s status-SSE hot path — consumers are the
// capabilities API route, channel gating, and the Team upsell.
const openclawCapabilities = createOpenclawCapabilities({
  clawCmd,
  getInstalledVersion: () => openclawVersionService.readOpenclawVersion(),
});
// Plugin-dependent capability probes (buzz, clickclack) can change when a
// channel is added or removed — refresh after those mutations.
for (const method of ["createChannelAccount", "deleteChannelAccount"]) {
  const original = agentsService[method];
  if (typeof original !== "function") continue;
  agentsService[method] = async (...args) => {
    const result = await original(...args);
    try {
      openclawCapabilities.invalidate();
    } catch {}
    return result;
  };
}

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

// Shared with registerServerRoutes: one lock serializes route restarts,
// applies, boot, and the watchdog's own background recovery.
const gatewayLifecycleLock = createGatewayLifecycleLock();
const repairRunStream = createRunStream({ fsModule: fs });
// Streamed doctor --fix: spawn-based (no shell, no 1MB maxBuffer), 10min
// ceiling, output tail captured — a real repair can actually finish instead
// of being SIGTERM'd at clawCmd's 15s default and parking the watchdog.
// Shared by the watchdog's auto-repair and the startup medic.
const runStreamedDoctorFix = async ({ timeoutMs = 10 * 60 * 1000 } = {}) => {
  const result = await repairRunStream.runStreamed({
    command: "openclaw",
    args: ["doctor", "--fix", "--yes"],
    env: gatewayEnv(),
    timeoutMs,
  });
  return {
    ok: !!result.ok,
    stdout: result.tail,
    stderr: result.timedOut ? "doctor --fix timed out after 10m" : "",
    code: result.code,
  };
};
// Gateway startup medic: automatic EX_CONFIG repair consulted by the watchdog
// before the exit-78 restart-paused latch. Deterministic whitelisted actions;
// the AI tier (smartest frontier model with a configured key) only ever picks
// from that whitelist. Default ON, opt-out at updates.openclaw.medic.enabled.
const gatewayMedic = createGatewayMedic({
  openclawDir: constants.OPENCLAW_DIR,
  isEnabled: () =>
    readOpenclawMedicEnabled({ openclawDir: constants.OPENCLAW_DIR }),
  llmClient: createFrontierLlmClient({}),
  runDoctorFix: runStreamedDoctorFix,
  collectDoctorJson: async () => {
    const result = await clawCmd("doctor --json", {
      quiet: true,
      timeoutMs: 60_000,
    });
    return result.ok ? result.stdout : result.stderr || null;
  },
  getChannelInfo: () => openclawChannelService.getChannelInfo(),
  readEnvFile,
  isManagedStripeValue: (value) =>
    openclawChannelService.isStripeManaged(value),
});

// Incident tracker: wraps ONLY the watchdog's event sink (foreign writers
// keep the unwrapped insertWatchdogEvent), deriving persisted incident rows
// from event transitions. It never touches the watchdog's in-memory incident
// bookkeeping — that is the notification-dedup seam. getStatus is late-bound
// (the tracker is constructed before createWatchdog), same closure pattern as
// watchdogLatch above.
const watchdogIncidentTracker = createWatchdogIncidentTracker({
  db: watchdogDb,
  getStatus: () => watchdogRef?.getStatus?.() ?? null,
  getResourceSample: () => {
    try {
      return getSystemResources({
        gatewayPid: watchdogRef?.getStatus?.()?.gatewayPid ?? null,
      });
    } catch {
      return null;
    }
  },
});
watchdogIncidentTracker.abandonDanglingOnBoot();

const watchdog = createWatchdog({
  clawCmd,
  clawCmdWithRetry,
  launchGatewayProcess,
  probeGatewayTcp,
  gatewayLifecycleLock,
  insertWatchdogEvent: watchdogIncidentTracker.wrapInsertEvent(
    insertWatchdogEvent,
  ),
  // Watchdog alerts (crash/recovery/safe-mode) get the same durable outbox +
  // admin routing as upgrade lifecycle events.
  notifier: upgradeNotifier,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  resolveSetupUrl,
  repairRunner: runStreamedDoctorFix,
  configMedic: gatewayMedic,
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
// Watchdog incident overseer: advisory-only by construction — its DI gets
// read functions, incident persistence, and notify; never triggerRepair /
// requestRollback / resumeChannels. Default off (alphaclaw.json
// watchdog.overseer.enabled); reviews only run from a healthy steady state.
const watchdogOverseer = createWatchdogOverseer({
  incidentsDb: watchdogDb,
  getWatchdogStatus: () => watchdog.getStatus(),
  readLogTail,
  getDoctorJson: async () => {
    const result = await clawCmd("doctor --json", {
      quiet: true,
      timeoutMs: 60_000,
    });
    return result.ok ? result.stdout : result.stderr || null;
  },
  notify: (message, opts) => upgradeNotifier.notify(message, opts),
  isEnabled: () =>
    readWatchdogOverseerEnabled({ openclawDir: constants.OPENCLAW_DIR }),
  notificationsEnabled: () =>
    watchdog.getSettings().notificationsEnabled !== false,
  getBaseUrl: () => resolveSetupUrl(),
  // Richer redaction sources (gateway-medic bar): .env values + inline
  // openclaw.json secrets join the env-var scrub before any Anthropic send.
  // STRICT readers: a legitimately-absent file reads as empty, but a real
  // read/parse failure THROWS so the overseer refuses the review (fail
  // closed) rather than sending evidence with an incomplete secret list.
  readEnvFile: readEnvFileStrict,
  getConfigObject: () =>
    readOpenclawConfigForWrite({ openclawDir: constants.OPENCLAW_DIR }),
});
watchdogOverseer.start();
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
  // Doctor's `gateway call` sites hit the beta's 30/min per-method control-
  // plane rate limit — honor {code:"UNAVAILABLE", retryAfterMs} (1.9).
  clawCmd: clawCmdWithRetry,
  listDoctorRuns,
  listDoctorRunSummaries,
  getDoctorRunManifest,
  getLatestCompletedRunSummary,
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
setGatewayTcpTransitionHandler(() => watchdog.onGatewayTcpTransition());
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
const {
  readOpenclawConfig,
  readOpenclawConfigForWrite,
} = require("./server/openclaw-config");
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
  isAdminRequest,
  requireAdmin,
  resolveRequestIdentity,
  resolveProxyIdentity,
  gmailWatchService,
  runOnboardedBootSequence: runOnboardedBoot,
} = registerServerRoutes({
  app,
  fs,
  constants,
  probeGatewayTcp,
  gatewayLifecycleLock,
  gatewayStatePersistPath: path.join(constants.ALPHACLAW_DIR, "gateway-state.json"),
  loginThrottle,
  membersStore,
  readTeamSettings: readTeamSettingsFromConfig,
  onMemberActivity: (identity) => teamPresence.touch(identity),
  // Late-bound: the team gateway-config service is constructed after routes
  // register; the hook resolves through this holder at call time.
  onMemberRosterChanged: (event) => teamHooks.onMemberRosterChanged(event),
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
  // Late-bound: serverLifecycle is created after routes register.
  getRejectionStats: () =>
    serverLifecycle?.getRejectionStats?.() || { total: 0, inWindow: 0 },
  incidentsDb: watchdogDb,
  watchdogOverseer,
  readWatchdogOverseerEnabled: () =>
    readWatchdogOverseerEnabled({ openclawDir: constants.OPENCLAW_DIR }),
  updateWatchdogOverseerEnabled: ({ enabled }) =>
    updateWatchdogOverseerEnabled({
      openclawDir: constants.OPENCLAW_DIR,
      enabled,
    }),
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
  gatewayMedic,
  runBackupSqlite,
  proxy,
  getGatewayUrl,
  SETUP_API_PREFIXES,
  webhookMiddleware,
  topicDiscovery,
});
// Team routes (4.5): roster, invites, enable/disable — mounted after the auth
// + role-matrix middleware, admin-gated per mutation inside the module.
{
  const { updateOpenclawConfig } = require("./server/openclaw-config");
  const { updateTeamSettings } = require("./server/alphaclaw-config");
  const { createTeamStateStore } = require("./server/team/state");
  const { createTeamGatewayConfig } = require("./server/team/gateway-config");
  const { createTeamService } = require("./server/team-service");
  const { registerTeamRoutes } = require("./server/routes/team");
  const teamStateStore = createTeamStateStore({ rootDir: constants.kRootDir });
  const teamGatewayConfig = createTeamGatewayConfig({
    openclawDir: constants.OPENCLAW_DIR,
    updateOpenclawConfig,
    teamStateStore,
    membersStore,
  });
  // Transition facade: enable/disable run snapshot -> write-from-roster ->
  // restart -> identity probe -> auto-restore, under a mutex.
  const teamService = createTeamService({
    fsModule: fs,
    openclawDir: constants.OPENCLAW_DIR,
    // Transitions restart the gateway up to twice; hold the shared lifecycle
    // lock per restart like every other restart path (agents/watchdog/route),
    // so a team enable/disable can never interleave with them.
    restartGateway: async (...args) => {
      const release = await gatewayLifecycleLock.acquire("restart");
      try {
        return await restartGateway(...args);
      } finally {
        release();
      }
    },
    getGatewayUrl,
    membersStore,
    applyTeamGatewayConfig: () => teamGatewayConfig.applyTeamGatewayConfig(),
  });
  // E-C8: invite acceptance mutates the roster outside the admin routes —
  // rebuild the gateway auth from the roster and flag the restart.
  teamHooks.onMemberRosterChanged = async () => {
    if (readTeamSettingsFromConfig().enabled !== true) return;
    await teamGatewayConfig.applyTeamGatewayConfig();
    try {
      restartRequiredState?.markRequired?.("team_member_accepted");
    } catch {}
  };
  registerTeamRoutes({
    app,
    requireAdmin,
    membersStore,
    teamGatewayConfig,
    teamStateStore,
    teamService,
    presence: teamPresence,
    readTeamSettings: readTeamSettingsFromConfig,
    updateTeamSettings: ({ enabled, disableLegacyLogin }) =>
      updateTeamSettings({
        openclawDir: constants.OPENCLAW_DIR,
        enabled,
        disableLegacyLogin,
      }),
    restartRequiredState,
    openclawCapabilities,
    insertWatchdogEvent,
    resolveSetupUrl,
  });
}
// Buzz channel wizard (5.2): resumable server-side setup state machine.
{
  const { createRunStream } = require("./server/openclaw-run-stream");
  const { createTeamStateStore } = require("./server/team/state");
  const { createBuzzSetup, kBuzzStateFileName } = require("./server/buzz-setup");
  const { registerBuzzRoutes } = require("./server/routes/buzz");
  const buzzSetup = createBuzzSetup({
    openclawDir: constants.OPENCLAW_DIR,
    stateStore: createTeamStateStore({
      rootDir: constants.kRootDir,
      fileName: kBuzzStateFileName,
    }),
    runStream: createRunStream(),
    clawCmd,
    gatewayEnv,
    restartRequiredState,
    openclawCapabilities,
  });
  registerBuzzRoutes({ app, requireAdmin, buzzSetup });
}
// Capability probes for the installed OpenClaw (feature-detect, never version-gate).
// Lazy: the probes run on first demand here — never on the 2s status-SSE tick — and
// serve cached results afterward. Consumers: Envars secrets banner, channel gating,
// the Team upsell.
app.get("/api/openclaw/capabilities", async (req, res) => {
  try {
    res.json({ ok: true, capabilities: await openclawCapabilities.getAll() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "capability probe failed" });
  }
});
// Static assets come AFTER the API routes: with static first, every API call
// paid a filesystem stat against public/ before reaching its handler.
app.use(express.static(path.join(__dirname, "public")));
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

// Terminal JSON error middleware: wrapAsync'd handlers forward rejections to
// next(err); without this, Express's default handler answers API clients
// with an HTML 500 page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(`[alphaclaw] Request error on ${req.method} ${req.path}: ${err?.stack || err}`);
  if (res.headersSent) {
    try {
      res.destroy();
    } catch {}
    return;
  }
  const status = Number(err?.status || err?.statusCode) || 500;
  // 5xx messages can embed internals (fs errors carry absolute paths) and
  // this middleware fronts unauthenticated routes — clients get a generic
  // body; the console.error above keeps the detail in the server log.
  const message =
    status >= 500 ? "Internal server error" : err?.message || "Request failed";
  res.status(status).json({ ok: false, error: message });
});

const server = http.createServer(app);
createWatchdogTerminalWsBridge({
  server,
  proxy,
  getGatewayUrl,
  isAuthorizedRequest,
  isAdminRequest,
  watchdogTerminal,
  chatWsService,
  resolveProxyIdentity,
});

serverLifecycle = createServerLifecycle({
  server,
  PORT,
  isOnboarded,
  runOnboardedBootSequence: runOnboardedBoot,
  stopGateway: stopGatewayForShutdown,
  stopWatchdog: () => watchdog.stop(),
  // Synchronous last-ditch reap for the abandoned-drain escape hatches.
  killGatewayNow: () => stopGatewayChild({ signal: "SIGKILL", force: true }),
  gmailWatchService,
  watchdogTerminal,
  disposeServices: () => {
    doctorService.dispose();
    closeCronStoreDb();
    // Both overseers' poll timers are unref'd, but a review can be mid-spawn
    // during a drain — stop them so no new review starts while shutting down.
    upgradeOverseer.stop();
    watchdogOverseer.stop();
  },
  flushLogs: () => flushLogWriter(),
});
serverLifecycle.installCrashGuards();
serverLifecycle.startListening();

const express = require("express");
const http = require("http");
const httpProxy = require("http-proxy");
const {
  stripForwardedHeadersFromProxyReq,
  resolveWsClientIp,
  applyIdentityProxyHeaders,
} = require("./server/utils/forwarded-headers");
const { createTeamPresence } = require("./server/team/presence");
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
  getAuthDb,
} = require("./server/db/auth");
const { createMembersStore } = require("./server/db/auth/members");
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
const { createWatchdog } = require("./server/watchdog");
const {
  createOpenclawCapabilities,
} = require("./server/openclaw-capabilities");
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
  readTeamSettings,
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
// Strip client-supplied forwarding/identity headers on every proxied hop (HTTP and
// WS upgrades) before they reach the gateway; when team mode is active, re-inject
// the VERIFIED member identity after the strip (4.3). Late-bound: the identity
// resolver comes from the auth module once routes register.
const teamPresence = createTeamPresence();
const teamProxyContext = {
  resolveIdentity: null,
  isTeamActive: () => false,
};
const injectTeamIdentity = (proxyReq, req) => {
  if (!req || !teamProxyContext.resolveIdentity) return;
  if (!teamProxyContext.isTeamActive()) return;
  const identity =
    req.alphaclawIdentity ||
    teamProxyContext.resolveIdentity({
      headers: req.headers || {},
      path: req.url || "",
    });
  if (!identity || identity.kind !== "member") return;
  teamPresence.touch(identity);
  // Trust-proxy-resolved client address (C5): Express resolved req.ip for HTTP
  // requests; raw WS upgrade requests apply the same hop logic manually. The
  // inbound headers are read BEFORE the strip (the strip edits proxyReq only).
  const clientIp =
    typeof req.ip === "string" && req.ip
      ? req.ip
      : resolveWsClientIp({
          remoteAddress: req.socket?.remoteAddress || "",
          xForwardedFor: req.headers?.["x-forwarded-for"] || "",
          trustProxyHops: kTrustProxyHops,
        });
  applyIdentityProxyHeaders({ proxyReq, identity, clientIp });
};
proxy.on("proxyReq", (proxyReq, req) => {
  stripForwardedHeadersFromProxyReq(proxyReq);
  injectTeamIdentity(proxyReq, req);
});
proxy.on("proxyReqWs", (proxyReq, req) => {
  stripForwardedHeadersFromProxyReq(proxyReq);
  injectTeamIdentity(proxyReq, req);
});
proxy.on("error", (err, req, res) => {
  if (res && res.writeHead) {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Gateway unavailable" }));
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
// Team mode (4.1/4.2): member accounts live in the auth DB; team settings in
// alphaclaw.json.
const membersStore = createMembersStore({ getDb: getAuthDb });
const readTeamSettingsFromConfig = () =>
  readTeamSettings({ openclawDir: constants.OPENCLAW_DIR });
// Enabled-flag check on the proxy hot path — cache briefly instead of reading
// alphaclaw.json per proxied request. The enable/disable routes reset it.
let teamActiveCache = { value: false, at: 0 };
const isTeamActive = () => {
  const now = Date.now();
  if (now - teamActiveCache.at > 5000) {
    let value = false;
    try {
      value = readTeamSettingsFromConfig().enabled === true;
    } catch {}
    teamActiveCache = { value, at: now };
  }
  return teamActiveCache.value;
};
const invalidateTeamActiveCache = () => {
  teamActiveCache = { value: false, at: 0 };
};
teamProxyContext.isTeamActive = isTeamActive;
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
  clearVersionCache: () => {
    openclawVersionService.clearVersionCache();
    openclawCapabilities?.invalidate();
  },
  notify: (message) => watchdogNotifier.notify(message),
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
  clawCmdWithRetry,
  launchGatewayProcess,
  insertWatchdogEvent,
  notifier: watchdogNotifier,
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
const doSyncPromptFiles = () => {
  const setupUiUrl = resolveSetupUrl();
  ensureOpenclawRuntimeArtifacts({
    fs,
    openclawDir: constants.OPENCLAW_DIR,
  });
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
  isAdminRequest,
  requireAdmin,
  resolveRequestIdentity,
  gmailWatchService,
  runOnboardedBootSequence: runOnboardedBoot,
} = registerServerRoutes({
  app,
  fs,
  constants,
  loginThrottle,
  membersStore,
  readTeamSettings: readTeamSettingsFromConfig,
  onMemberActivity: (identity) => teamPresence.touch(identity),
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
  proxy,
  getGatewayUrl,
  SETUP_API_PREFIXES,
  webhookMiddleware,
  topicDiscovery,
});
// 4.3: the proxy identity injector needs the auth module's identity parser.
teamProxyContext.resolveIdentity = resolveRequestIdentity;
// Team routes (4.5): roster, invites, enable/disable — mounted after the auth
// + role-matrix middleware, admin-gated per mutation inside the module.
{
  const { updateOpenclawConfig } = require("./server/openclaw-config");
  const { updateTeamSettings } = require("./server/alphaclaw-config");
  const { createTeamStateStore } = require("./server/team/state");
  const { createTeamGatewayConfig } = require("./server/team/gateway-config");
  const { registerTeamRoutes } = require("./server/routes/team");
  const teamStateStore = createTeamStateStore({ rootDir: constants.kRootDir });
  const teamGatewayConfig = createTeamGatewayConfig({
    openclawDir: constants.OPENCLAW_DIR,
    updateOpenclawConfig,
    teamStateStore,
    membersStore,
  });
  registerTeamRoutes({
    app,
    requireAdmin,
    membersStore,
    teamGatewayConfig,
    teamStateStore,
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
    invalidateTeamActiveCache,
    resolveSetupUrl,
  });
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
  isAdminRequest,
  watchdogTerminal,
  chatWsService,
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

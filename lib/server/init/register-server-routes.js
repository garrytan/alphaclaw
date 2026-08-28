const { runOnboardedBootSequence } = require("../startup");
const {
  createGatewayLifecycleLock,
} = require("../gateway-lifecycle-lock");
const { registerAuthRoutes } = require("../routes/auth");
const { registerPageRoutes } = require("../routes/pages");
const { registerModelRoutes } = require("../routes/models");
const { registerOnboardingRoutes } = require("../routes/onboarding");
const { registerSystemRoutes } = require("../routes/system");
const { registerPairingRoutes } = require("../routes/pairings");
const { registerCodexRoutes } = require("../routes/codex");
const { registerGoogleRoutes } = require("../routes/google");
const { registerBrowseRoutes } = require("../routes/browse");
const { registerProxyRoutes } = require("../routes/proxy");
const { registerTelegramRoutes } = require("../routes/telegram");
const { registerWebhookRoutes } = require("../routes/webhooks");
const { registerWatchdogRoutes } = require("../routes/watchdog");
const { registerUsageRoutes } = require("../routes/usage");
const { registerGmailRoutes } = require("../routes/gmail");
const { ensureWebhookMappingIds } = require("../webhooks");
const { registerDoctorRoutes } = require("../routes/doctor");
const { registerAgentRoutes } = require("../routes/agents");
const { registerCronRoutes } = require("../routes/cron");
const { registerNodeRoutes } = require("../routes/nodes");
const {
  registerOpenclawChannelRoutes,
} = require("../routes/openclaw-channel");
const {
  createOauthCallbackMiddleware,
} = require("../oauth-callback-middleware");

const registerServerRoutes = ({
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
  probeGatewayTcp,
  gatewayLifecycleLock: sharedGatewayLifecycleLock = null,
  gatewayStatePersistPath,
  resolveGithubRepoUrl,
  resolveModelProvider,
  ensureGatewayProxyConfig,
  isOpenAiCompatApiEnabled,
  openAiCompatApiThrottle,
  getBaseUrl,
  startGateway,
  ensureManagedExecDefaults,
  ensureUsageTrackerPluginConfig,
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
}) => {
  const { requireAuth, isAuthorizedRequest } = registerAuthRoutes({
    app,
    loginThrottle,
  });

  // Serializes gateway-mutating operations (boot, restart, repair, apply).
  // The caller may pass a shared instance (server.js shares it with the
  // watchdog so background recovery skips while a route operation runs).
  const gatewayLifecycleLock =
    sharedGatewayLifecycleLock || createGatewayLifecycleLock();

  registerPageRoutes({ app, requireAuth, isGatewayRunning });
  const modelCatalogCache = registerModelRoutes({
    app,
    shellCmd,
    gatewayEnv,
    parseJsonFromNoisyOutput,
    normalizeOnboardingModels,
    readOpenclawVersion: () => openclawVersionService?.readOpenclawVersion(),
    readOpenclawVersionAsync: () =>
      openclawVersionService?.readOpenclawVersionAsync(),
    isOnboarded,
    authProfiles,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
  });
  registerSystemRoutes({
    app,
    fs,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    kKnownVars: constants.kKnownVars,
    kKnownKeys: constants.kKnownKeys,
    kSystemVars: constants.kSystemVars,
    syncChannelConfig,
    isGatewayRunning,
    probeGatewayTcp,
    gatewayLifecycleLock,
    gatewayStatePersistPath,
    operationEvents,
    isOnboarded,
    getChannelStatus,
    openclawVersionService,
    alphaclawVersionService,
    kAlphaclawGithubReleasesBaseUrl: constants.kAlphaclawGithubReleasesBaseUrl,
    clawCmd,
    restartGateway,
    OPENCLAW_DIR: constants.OPENCLAW_DIR,
    restartRequiredState,
    topicRegistry,
    authProfiles,
    watchdog,
    doctorService,
    ensureGatewayProxyConfig,
    getBaseUrl,
    openclawChannelService,
    topicDiscovery,
  });
  registerOpenclawChannelRoutes({
    app,
    fs,
    OPENCLAW_DIR: constants.OPENCLAW_DIR,
    isOnboarded,
    openclawChannelService,
    openclawReleasesService,
    operationEvents,
    restartRequiredState,
  });
  registerBrowseRoutes({
    app,
    fs,
    kRootDir: constants.OPENCLAW_DIR,
  });
  registerPairingRoutes({ app, clawCmd, isOnboarded });
  registerCodexRoutes({
    app,
    createPkcePair,
    parseCodexAuthorizationInput,
    getCodexAccountId,
    authProfiles,
    onAuthChanged: () => modelCatalogCache.markStale(),
  });
  registerGoogleRoutes({
    app,
    fs,
    isGatewayRunning,
    gogCmd,
    getBaseUrl,
    readGoogleCredentials,
    getApiEnableUrl,
    constants,
  });
  const gmailWatchService = registerGmailRoutes({
    app,
    fs,
    constants,
    gogCmd,
    getBaseUrl,
    readGoogleCredentials,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    restartRequiredState,
  });
  const runOnboardedBoot = () =>
    runOnboardedBootSequence({
      acquireLifecycleLock: (kind) => gatewayLifecycleLock.acquire(kind),
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      ensureWebhookMappingIds: () => ensureWebhookMappingIds({ fs, constants }),
      doSyncPromptFiles,
      reloadEnv,
      syncChannelConfig,
      readEnvFile,
      ensureGatewayProxyConfig,
      resolveSetupUrl,
      startGateway,
      watchdog,
      gmailWatchService,
    });
  registerOnboardingRoutes({
    app,
    fs,
    constants,
    shellCmd,
    gatewayEnv,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    isOnboarded,
    resolveGithubRepoUrl,
    resolveModelProvider,
    hasCodexOauthProfile: authProfiles.hasCodexOauthProfile,
    authProfiles,
    ensureGatewayProxyConfig,
    getBaseUrl,
    runOnboardedBootSequence: runOnboardedBoot,
  });
  registerTelegramRoutes({
    app,
    telegramApi,
    syncPromptFiles: doSyncPromptFiles,
    shellCmd,
    topicDiscovery,
  });
  registerWebhookRoutes({
    app,
    fs,
    constants,
    getBaseUrl,
    shellCmd,
    webhooksDb: {
      getRequests,
      getRequestById,
      getHookSummaries,
      deleteRequestsByHook,
      createOauthCallback,
      getOauthCallbackByHook,
      rotateOauthCallback,
      deleteOauthCallback,
    },
    restartRequiredState,
  });
  const oauthCallbackMiddleware = createOauthCallbackMiddleware({
    getOauthCallbackById,
    markOauthCallbackUsed,
    webhookMiddleware,
  });
  registerWatchdogRoutes({
    app,
    requireAuth,
    watchdog,
    watchdogNotifier,
    getRecentEvents,
    readLogTail,
    watchdogTerminal,
  });
  registerUsageRoutes({
    app,
    requireAuth,
    getDailySummary,
    getSessionsList,
    getSessionDetail,
    getSessionTimeSeries,
    topicDiscovery,
  });
  registerCronRoutes({
    app,
    requireAuth,
    cronService,
  });
  registerDoctorRoutes({
    app,
    requireAuth,
    doctorService,
  });
  registerAgentRoutes({
    app,
    agentsService,
    restartRequiredState,
    operationEvents,
  });
  registerNodeRoutes({
    app,
    clawCmd,
    openclawDir: constants.OPENCLAW_DIR,
    gatewayToken: constants.GATEWAY_TOKEN,
    fsModule: fs,
  });
  registerProxyRoutes({
    app,
    proxy,
    getGatewayUrl,
    getGatewayToken: () =>
      process.env.OPENCLAW_GATEWAY_TOKEN || constants.GATEWAY_TOKEN || "",
    isOpenAiCompatApiEnabled,
    openAiCompatApiThrottle,
    SETUP_API_PREFIXES,
    requireAuth,
    oauthCallbackMiddleware,
    webhookMiddleware,
  });

  return {
    requireAuth,
    isAuthorizedRequest,
    gmailWatchService,
    runOnboardedBootSequence: runOnboardedBoot,
  };
};

module.exports = {
  registerServerRoutes,
};

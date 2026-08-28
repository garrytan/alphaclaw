const { runOnboardedBootSequence } = require("../startup");
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
const { registerTeamRoutes } = require("../routes/team");
const { createTeamService } = require("../team-service");
const { getGatewayCredential } = require("../gateway-credential");
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
  getRejectionStats = () => ({ total: 0, inWindow: 0 }),
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
  openclawFeatureGates = null,
  operatorsStore = null,
  upgradeNotifier = null,
  upgradeOverseer = null,
  runBackupSqlite = null,
  proxy,
  getGatewayUrl,
  SETUP_API_PREFIXES,
  webhookMiddleware,
  topicDiscovery,
}) => {
  const teamService = createTeamService({
    fsModule: fs,
    openclawDir: constants.OPENCLAW_DIR,
    restartGateway,
    getGatewayUrl,
  });
  // Divergence detector: team.enabled (alphaclaw.json) and gateway.auth.mode
  // (openclaw.json) are written by a two-file transition — a crash in that
  // window, or a container redeploy resetting one file, leaves them split and
  // every dashboard→gateway request 401s with no explanation. Detect loudly at
  // boot (notify + log); an admin re-toggling team mode converges them. We do
  // NOT auto-flip auth config at boot — that could fight a manual recovery.
  setTimeout(() => {
    try {
      const teamEnabled = teamService.isTeamEnabled();
      const credentialMode = getGatewayCredential({
        fsModule: fs,
        openclawDir: constants.OPENCLAW_DIR,
      }).mode;
      const gatewayTrustedProxy = credentialMode !== "token";
      if (teamEnabled !== gatewayTrustedProxy) {
        const message = `⚠️ Team-mode state is split: alphaclaw team.enabled=${teamEnabled} but the gateway auth mode is ${gatewayTrustedProxy ? "trusted-proxy" : "token"}. Dashboard→gateway requests will fail until they agree — open the Team tab and toggle team mode to converge.`;
        console.error(`[alphaclaw] ${message}`);
        upgradeNotifier
          ?.notify?.(message, {
            eventType: "health",
            id: `team-auth-divergence-${teamEnabled}-${credentialMode}`,
          })
          ?.catch?.(() => {});
      }
    } catch {}
  }, 15_000).unref?.();
  const { requireAuth, isAuthorizedRequest, resolveRequestOperator } =
    registerAuthRoutes({
      app,
      loginThrottle,
      teamService,
    });

  registerPageRoutes({
    app,
    requireAuth,
    isGatewayRunning,
    isOnboarded,
    getWatchdogStatus: () => watchdog?.getStatus?.() || null,
  });
  const modelCatalogCache = registerModelRoutes({
    app,
    shellCmd,
    gatewayEnv,
    parseJsonFromNoisyOutput,
    normalizeOnboardingModels,
    readOpenclawVersion: (options) =>
      openclawVersionService?.readOpenclawVersion(options),
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
    openclawFeatureGates,
    operatorsStore,
    upgradeOverseer,
    runBackupSqlite,
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
      primeStatusCaches: () => {
        // Warm the caches the status hot path serves from, off the boot tick.
        try {
          void openclawVersionService?.fetchOpenclawVersion?.();
        } catch {}
        try {
          void doctorService?.refreshWorkspaceSnapshot?.();
        } catch {}
      },
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
    getRejectionStats,
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
  // Lazy credential resolution (mode-aware): token normally, the internal
  // gateway password when team mode has trusted-proxy auth active. Keeps the
  // env fallback that constants.GATEWAY_TOKEN used to provide.
  const resolveGatewayCredentialValue = () => {
    try {
      return (
        getGatewayCredential({
          fsModule: fs,
          openclawDir: constants.OPENCLAW_DIR,
        }).value || ""
      );
    } catch {
      return process.env.OPENCLAW_GATEWAY_TOKEN || constants.GATEWAY_TOKEN || "";
    }
  };
  registerTeamRoutes({ app, teamService });
  registerNodeRoutes({
    app,
    clawCmd,
    openclawDir: constants.OPENCLAW_DIR,
    gatewayToken: constants.GATEWAY_TOKEN,
    // Nodes connect with OPENCLAW_GATEWAY_TOKEN; in team mode the gateway
    // refuses token auth, so connect-info intentionally returns no token then
    // (documented degradation) instead of a credential that cannot work.
    getGatewayToken: () => {
      const credential = getGatewayCredential({
        fsModule: fs,
        openclawDir: constants.OPENCLAW_DIR,
      });
      if (credential.mode !== "token") {
        console.warn(
          "[alphaclaw] Node connect-info: gateway is in trusted-proxy (team) mode; token-based node onboarding is unavailable until team mode is disabled",
        );
        return "";
      }
      return credential.value;
    },
    getGatewayAuthMode: () =>
      getGatewayCredential({
        fsModule: fs,
        openclawDir: constants.OPENCLAW_DIR,
      }).mode,
    fsModule: fs,
  });
  registerProxyRoutes({
    app,
    proxy,
    getGatewayUrl,
    getGatewayToken: resolveGatewayCredentialValue,
    isOpenAiCompatApiEnabled,
    openAiCompatApiThrottle,
    SETUP_API_PREFIXES,
    requireAuth,
    oauthCallbackMiddleware,
    webhookMiddleware,
    resolveProxyIdentity: resolveRequestOperator,
  });

  return {
    requireAuth,
    isAuthorizedRequest,
    resolveRequestOperator,
    gmailWatchService,
    runOnboardedBootSequence: runOnboardedBoot,
  };
};

module.exports = {
  registerServerRoutes,
};

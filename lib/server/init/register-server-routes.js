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
const { registerClaudeCodeRoutes } = require("../routes/claude-code");
const { createClaudeCodeService } = require("../claude-code-service");
const { registerUsageRoutes } = require("../routes/usage");
const { registerGmailRoutes } = require("../routes/gmail");
const { ensureWebhookMappingIds } = require("../webhooks");
const { registerDoctorRoutes } = require("../routes/doctor");
const { registerAgentRoutes } = require("../routes/agents");
const { registerCronRoutes } = require("../routes/cron");
const { registerNodeRoutes } = require("../routes/nodes");
const { getGatewayCredential } = require("../gateway-credential");
const { isTeamEnabled } = require("../alphaclaw-config");
const {
  registerOpenclawChannelRoutes,
} = require("../routes/openclaw-channel");
const {
  createOauthCallbackMiddleware,
} = require("../oauth-callback-middleware");
const { registerAdminRoutes } = require("../routes/admin");
const {
  createAgentAdminEnforcement,
} = require("../agent-admin/enforcement");
const {
  createConfirmService,
} = require("../agent-admin/confirm-service");
const tokenStore = require("../agent-admin/token-store");
const { isAgentAdminEnabled } = require("../alphaclaw-config");
const {
  getAgentAdminEvents,
} = require("../db/watchdog");

const registerServerRoutes = ({
  app,
  fs,
  constants,
  loginThrottle,
  shellCmd,
  execFileCmd,
  clawCmd,
  clawCmdWithRetry = null,
  // Era resolver from openclaw-state-era (issue #23): threaded to onboarding
  // so its exec-defaults call never recreates the legacy approvals file on a
  // sqlite-era box.
  resolveExecApprovalsBackend = null,
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
  agentAdminThrottle = null,
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
  incidentsDb = null,
  claudeCodeService = null,
  watchdogOverseer = null,
  readWatchdogOverseerEnabled = null,
  updateWatchdogOverseerEnabled = null,
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
  openclawCapabilities = null,
  openclawFeatureGates = null,
  operatorsStore = null,
  upgradeNotifier = null,
  upgradeOverseer = null,
  gatewayMedic = null,
  runBackupSqlite = null,
  proxy,
  getGatewayUrl,
  SETUP_API_PREFIXES,
  webhookMiddleware,
  topicDiscovery,
  membersStore = null,
  readTeamSettings = undefined,
  onMemberActivity = undefined,
  onMemberRosterChanged = undefined,
}) => {
  const { insertWatchdogEvent } = require("../db/watchdog");
  const openclawDir = constants.OPENCLAW_DIR;
  const agentAdminEnabled = () => isAgentAdminEnabled({ openclawDir });
  // The machine-auth bundle handed to auth's bearer branch. Its own throttle
  // scope keeps agent-bearer failures off the human login buckets (F2).
  const agentAdminAuth = {
    isEnabled: agentAdminEnabled,
    readToken: () => tokenStore.readToken({ openclawDir }),
    throttle: agentAdminThrottle || loginThrottle,
    onAuthEvent: ({ event, clientKey }) => {
      try {
        insertWatchdogEvent({
          eventType: "agent_admin",
          source: "agent-admin",
          status: "warning",
          details: { phase: event, clientKey: String(clientKey || "") },
        });
      } catch {}
    },
  };

  const {
    requireAuth,
    requireAdmin,
    isAuthorizedRequest,
    isAdminRequest,
    resolveRequestIdentity,
    resolveProxyIdentity,
    resolveRequestActor,
  } = registerAuthRoutes({
    app,
    loginThrottle,
    membersStore,
    agentAdmin: agentAdminAuth,
    ...(readTeamSettings ? { readTeamSettings } : {}),
    ...(onMemberActivity ? { onMemberActivity } : {}),
    ...(onMemberRosterChanged ? { onMemberRosterChanged } : {}),
  });
  // Divergence detector: team.enabled (alphaclaw.json) and gateway.auth.mode
  // (openclaw.json) are written by a two-file transition — a crash in that
  // window, or a container redeploy resetting one file, leaves them split and
  // every dashboard→gateway request 401s with no explanation. Detect loudly at
  // boot (notify + log); an admin re-toggling team mode converges them. We do
  // NOT auto-flip auth config at boot — that could fight a manual recovery.
  setTimeout(() => {
    try {
      const teamEnabled = isTeamEnabled({
        fsModule: fs,
        openclawDir: constants.OPENCLAW_DIR,
      });
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
  // Admin identity for dangerous-op confirm delivery: an op cannot mint a
  // confirm code with nowhere to send it (KTD5). Reads the same notification
  // prefs the upgrade notifier uses.
  const readAdminTargets = () => {
    try {
      const prefs = operatorsStore?.read?.()?.notifications;
      return Array.isArray(prefs?.adminTargets) ? prefs.adminTargets : [];
    } catch {
      return [];
    }
  };
  const confirmService = createConfirmService({
    hasAdminTargets: () => readAdminTargets().length > 0,
    deliver: ({ code, summary, expiresAt, confirmId }) => {
      const minutes = Math.max(
        1,
        Math.round((new Date(expiresAt).getTime() - Date.now()) / 60000),
      );
      upgradeNotifier
        ?.notify?.(
          `🔐 *Agent Administration*\nThe agent wants to: ${summary}\nReply with code \`${code}\` to approve (expires in ${minutes} min). Confirm id: ${confirmId}`,
          { eventType: "agent_admin_confirm", id: `agent-admin-confirm-${confirmId}` },
        )
        ?.catch?.(() => {});
    },
  });

  // On a completed restart/dangerous mutation, tell the admins what landed.
  const notifyAdminsOfChange = ({ op }) => {
    upgradeNotifier
      ?.notify?.(`🐺 *AlphaClaw change by agent*\n${op.title || op.id} applied.`, {
        eventType: "agent_admin",
        id: `agent-admin-change-${op.id}-${Date.now()}`,
      })
      ?.catch?.(() => {});
  };

  // Enforcement runs immediately after requireAuth so every /api request the
  // agent actor makes is tier-checked and redacted before any route handler.
  // No-ops for cookie (human) sessions.
  app.use(
    "/api",
    createAgentAdminEnforcement({
      resolveRequestActor,
      insertWatchdogEvent,
      confirmService,
      notifyAdmins: notifyAdminsOfChange,
    }),
  );

  registerAdminRoutes({
    app,
    isAgentAdminEnabled: agentAdminEnabled,
    resolveRequestActor,
    tokenStore,
    openclawDir,
    getAgentAdminEvents,
    confirmService,
    insertWatchdogEvent,
  });

  // Serializes gateway-mutating operations (boot, restart, repair, apply).
  // The caller may pass a shared instance (server.js shares it with the
  // watchdog so background recovery skips while a route operation runs).
  const gatewayLifecycleLock =
    sharedGatewayLifecycleLock || createGatewayLifecycleLock();

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
    execFileCmd,
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
    doSyncPromptFiles,
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
    gatewayMedic,
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
    execFileCmd,
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
    resolveExecApprovalsBackend,
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
    incidentsDb,
    watchdogOverseer,
    readWatchdogOverseerEnabled,
    updateWatchdogOverseerEnabled,
  });
  registerClaudeCodeRoutes({
    app,
    requireAuth,
    claudeCodeService: claudeCodeService || createClaudeCodeService(),
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
  registerNodeRoutes({
    app,
    clawCmd,
    clawCmdWithRetry,
    // SQLite-era exec approvals (issue #23): the exec-approvals routes probe
    // this before touching the legacy file, and legacy WRITES additionally
    // require a determinate file-era answer from the resolver.
    openclawCapabilities,
    resolveExecApprovalsBackend,
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
    resolveProxyIdentity,
  });

  return {
    requireAuth,
    requireAdmin,
    isAuthorizedRequest,
    isAdminRequest,
    resolveRequestIdentity,
    resolveProxyIdentity,
    gmailWatchService,
    runOnboardedBootSequence: runOnboardedBoot,
  };
};

module.exports = {
  registerServerRoutes,
};

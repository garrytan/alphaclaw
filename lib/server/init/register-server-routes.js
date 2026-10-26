const { runOnboardedBootSequence, runPostDoctorConvergence } = require("../startup");
const { runBootNativeMaintenance } = require("../boot-native-maintenance");
const { normalizeBootConfig } = require("../boot-config-normalization");
const {
  createGatewayLifecycleLock,
} = require("../gateway-lifecycle-lock");
const { registerAuthRoutes } = require("../routes/auth");
const { registerPageRoutes } = require("../routes/pages");
const { registerModelRoutes } = require("../routes/models");
const { registerOnboardingRoutes } = require("../routes/onboarding");
const { registerSystemRoutes, kOperationBadgeLabels } = require("../routes/system");
const { findStaleEnvProcesses } = require("../env-stale-processes");
const { resolveServingIdentity } = require("../gateway");
const { registerOpenclawUpgradeRoutes } = require("../routes/openclaw-upgrade");
const { registerPairingRoutes } = require("../routes/pairings");
const { registerCodexRoutes } = require("../routes/codex");
const { registerGoogleRoutes } = require("../routes/google");
const { registerBrowseRoutes } = require("../routes/browse");
const { registerProxyRoutes } = require("../routes/proxy");
const {
  registerDashboardLaunchRoutes,
} = require("../routes/dashboard-launch");
const {
  createDashboardUrlService,
  isTokenlessAuthMode,
} = require("../gateway-dashboard-url");
const {
  registerControlUiAttachRoutes,
} = require("../routes/control-ui-attach");
const { createControlUiAttachRedirect } = require("../control-ui-attach");
const { readOpenclawConfig } = require("../openclaw-config");
const { registerTelegramRoutes } = require("../routes/telegram");
const { registerWebhookRoutes } = require("../routes/webhooks");
const { createCallerGitSync } = require("../git-sync-runner");
const { registerWatchdogRoutes } = require("../routes/watchdog");
const { registerDiagnoseRoutes } = require("../routes/diagnose");
const { registerBoxRoutes } = require("../routes/box");
const { createProcessTable } = require("../box-status/processes");
const { createLastRestartStore, readRestartStatus } = require("../box-status/last-restart");
const { createScheduleReader } = require("../box-status/schedules");
const { createDiskReader } = require("../box-status/disk");
const { createMcpReader } = require("../box-status/mcp");
const { scheduleRegistry } = require("../box-status/schedule-registry");
const { readGitSyncStatus, resolveGitSyncStatusPath } = require("../../cli/git-sync-status");
const { readBootHistory } = require("../boot-progress/history");
const { setGatewayRestartRecorder } = require("../gateway");
const { getProcessBootId } = require("../boot-id");
const { resolveGatewayMemoryTarget } = require("../gateway-memory/resources");
const { registerRescueLinkRoutes } = require("../routes/rescue-link");
const { createLoginThrottle } = require("../login-throttle");
const { registerAutotuneRoutes } = require("../routes/autotune");
const { registerClaudeCodeRoutes } = require("../routes/claude-code");
const { registerSidecarRoutes } = require("../routes/sidecars");
const { registerDeployRoutes } = require("../routes/deploy");
const { createClaudeCodeService } = require("../claude-code-service");
const { registerUsageRoutes } = require("../routes/usage");
const { registerGmailRoutes } = require("../routes/gmail");
const { refreshDetectedGogAccounts } = require("../gog-accounts");
const { ensureWebhookMappingIds } = require("../webhooks");
const { registerDoctorRoutes } = require("../routes/doctor");
const { registerAgentRoutes } = require("../routes/agents");
const { registerCronRoutes } = require("../routes/cron");
const { registerNodeRoutes } = require("../routes/nodes");
const { getGatewayCredential } = require("../gateway-credential");
const { isTeamEnabled } = require("../alphaclaw-config");
const { registerOpenclawSettingsRoutes } = require("../routes/openclaw-settings");
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

// Module-level so a route restart (registerServerRoutes re-invocation in the
// same process) replaces the rescue-gate sweep timer instead of stacking a
// new one that roots the previous gates' Maps forever.
let rescueLinkGateSweepTimer = null;

const registerServerRoutes = ({
  app,
  mcpWatch = null,
  modelCheck = null,
  modelFailureWatch = null,
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
  gatewayLaunchEnv = null,
  bootSignal = null,
  resolveDoctorTimeoutMs = null,
  checkUpgradeDisk = null,
  parseJsonFromNoisyOutput,
  normalizeOnboardingModels,
  authProfiles,
  readEnvFile,
  readEnvFileStrict,
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
  claudeCodeLocalService = null,
  sidecarService = null,
  deployAnnouncer = null,
  watchdogOverseer = null,
  readWatchdogOverseerEnabled = null,
  updateWatchdogOverseerEnabled = null,
  readWatchdogMemorySettings = null,
  updateWatchdogMemorySettings = null,
  getDailySummary,
  getSessionsList,
  getSessionDetail,
  getSessionTimeSeries,
  cronService,
  doctorService,
  doctorAutoRunSettings = null,
  doctorScanSettings = null,
  agentsService,
  operationEvents,
  openclawRuntime,
  openclawFeatureGates = null,
  operatorsStore = null,
  upgradeNotifier = null,
  gatewayMedic = null,
  // Issue #76: the boot sequence's listening-path steps (dangling-record
  // closers + boot-report server phase), composed in lib/server.js from
  // boot-report-steps.js. Optional: absent = today's boot (tests, older wiring).
  bootSteps = null,
  // The streamed, guard-wrapped `openclaw doctor --fix` (doctor-fix-runner):
  // Retry upgrade's Doctor. Optional: absent = no Retry upgrade route work.
  runDoctorFix = null,
  proxy,
  getGatewayUrl,
  SETUP_API_PREFIXES,
  webhookMiddleware,
  topicDiscovery,
  membersStore = null,
  readTeamSettings = undefined,
  onMemberActivity = undefined,
  readDiskFullNotice = undefined,
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
    ...(readDiskFullNotice ? { readDiskFullNotice } : {}),
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
          {
            eventType: "agent_admin_confirm",
            id: `agent-admin-confirm-${confirmId}`,
            // Audit class: exempt from the operator's notification toggles —
            // the agent must never be able to silence its own approval gate
            // (e.g. by first PUTting notificationsEnabled:false).
            audit: true,
          },
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
        // Audit class (see above): the agent disabling notifications must
        // still announce THAT change to the operator.
        audit: true,
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
  const callerGitSync = createCallerGitSync();
  const modelCatalogCache = registerModelRoutes({
    app,
    shellCmd,
    execFileCmd,
    gitSync: callerGitSync,
    gatewayEnv,
    parseJsonFromNoisyOutput,
    normalizeOnboardingModels,
    readOpenclawVersion: () => openclawVersionService?.readOpenclawVersion(),
    readOpenclawVersionAsync: () =>
      openclawVersionService?.readOpenclawVersionAsync(),
    isOnboarded,
    authProfiles,
    restartRequiredState,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    modelCheck,
    modelFailureWatch,
  });
  // The SHARED dashboard-URL resolver: ONE instance behind
  // /api/gateway/dashboard, the /gateway/launch redirect, and the doctor's
  // token-resolvable check, so the single-flight CLI memo spans every
  // consumer that can spawn `openclaw dashboard`.
  const dashboardUrlService = createDashboardUrlService({
    fsModule: fs,
    openclawDir: constants.OPENCLAW_DIR,
    readEnvFile,
    // Doctor-probe reads fail CLOSED (throw → no card), resolution stays
    // lenient — see the service's readEnvFileStrict comment.
    readEnvFileStrict,
    clawCmd,
  });
  // Resource autotune as the boot applies it; Retry upgrade re-applies it
  // after its Doctor (runPostDoctorConvergence) with its own trigger.
  const applyResourceAutotuneFor = (trigger) => {
    const { applyResourceAutotune } = require("../autotune");
    const { buildAutotuneApplyDeps } = require("../routes/autotune");
    return applyResourceAutotune({
      trigger,
      deps: buildAutotuneApplyDeps({
        restartRequiredState,
        // Durable pipeline: autotune notices ride the outbox (upgradeNotifier
        // is constructed at server.js module init, well before this runs;
        // enqueue is durable even pre-drain).
        notifier: upgradeNotifier,
        watchdogNotifier,
        insertWatchdogEvent,
        // The convergence runs doSyncPromptFiles right after this step — no
        // double sync needed here.
        doSyncPromptFiles: null,
      }),
    });
  };
  // The boot's post-Doctor steps, for Retry upgrade (eng review F1).
  const convergeAfterDoctor = ({ hold, operation, shouldContinue }) =>
    runPostDoctorConvergence({
      label: "Retry upgrade",
      hold,
      operation,
      shouldContinue,
      applyResourceAutotuneOnBoot: () => applyResourceAutotuneFor("upgrade_retry"),
      runBootNativeMaintenance: (options) => runBootNativeMaintenance({
        ...options,
        execFileCmd,
        gatewayEnv,
        managedDir: constants.kOpenclawManagedDir,
      }),
      ensureManagedExecDefaults,
      ensureUsageTrackerPluginConfig,
      ensureWebhookMappingIds: () => ensureWebhookMappingIds({ fs, constants }),
      doSyncPromptFiles,
      reloadEnv,
      syncChannelConfig,
      readEnvFile,
      ensureGatewayProxyConfig,
      resolveSetupUrl,
    });
  const alphaclawVersion = (() => {
    try {
      return require("../../../package.json").version || null;
    } catch {
      return null;
    }
  })();
  registerSystemRoutes({
    app,
    requireAdmin,
    runDoctorFix,
    convergeAfterDoctor,
    ...(resolveDoctorTimeoutMs ? { resolveDoctorTimeoutMs } : {}),
    ...(checkUpgradeDisk ? { checkUpgradeDisk } : {}),
    managedDir: constants.kOpenclawManagedDir,
    alphaclawVersion,
    getInstalledOpenclawVersion: () => openclawRuntime?.getInfo?.()?.installedVersion ?? null,
    getOpenclawInfo: () => openclawRuntime?.getInfo?.() ?? null,
    fs,
    // Notification links prefer the configured public URL over request headers.
    resolveSetupUrl,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    gatewayLaunchEnv,
    scanStaleEnvProcesses: (options) =>
      findStaleEnvProcesses({
        ...options,
        getGatewayRootPid: () => resolveServingIdentity()?.rootPid ?? null,
      }),
    dashboardUrlService,
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
    topicDiscovery,
    doSyncPromptFiles,
    // Operator notifications for the restart route's failed restarts
    // (`restart-failed-<operationId>`, important class) ride the durable
    // outbox like every other watchdog/upgrade event. Optional-chained: the
    // notifier is constructed at server.js module init, but this module stays
    // constructible from its injected deps alone.
    notify: (message, opts) => upgradeNotifier?.notify?.(message, opts),
  });
  registerOpenclawSettingsRoutes({
    app,
    fs,
    OPENCLAW_DIR: constants.OPENCLAW_DIR,
    openclawRuntime,
    openclawFeatureGates,
    operatorsStore,
    gatewayMedic,
  });
  registerOpenclawUpgradeRoutes({
    app,
    fs,
    requireAdmin,
    openclawDir: constants.OPENCLAW_DIR,
    managedDir: constants.kOpenclawManagedDir,
    backupsDir: constants.kOpenclawBackupsDir,
    stateDir: () => gatewayEnv().OPENCLAW_STATE_DIR || constants.OPENCLAW_DIR,
    openclawRuntime,
    alphaclawVersion,
    getBusyOperation: () => {
      const active = gatewayLifecycleLock?.getActiveOperation?.();
      return active?.kind
        ? { kind: active.kind, label: kOperationBadgeLabels[active.kind] || "Another gateway operation" }
        : null;
    },
  });
  registerBrowseRoutes({
    app,
    fs,
    kRootDir: constants.OPENCLAW_DIR,
    restartRequiredState,
  });
  registerPairingRoutes({ app, clawCmd, isOnboarded, isGatewayRunning });
  registerCodexRoutes({
    app,
    createPkcePair,
    parseCodexAuthorizationInput,
    getCodexAccountId,
    authProfiles,
    restartRequiredState,
    onAuthChanged: () => modelCatalogCache.markStale(),
  });
  // Build the gmail-watch service FIRST so the Google routes can stop an
  // account's watch (local push-serve process + Google users.stop) when it is
  // disconnected — deleting the account row without this orphans the serve
  // process on its port and leaves Google delivering for up to 7 days. Route
  // registration order on `app` is independent (disjoint path namespaces).
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
  registerGoogleRoutes({
    app,
    fs,
    isGatewayRunning,
    gogCmd,
    getBaseUrl,
    readGoogleCredentials,
    getApiEnableUrl,
    constants,
    stopGmailWatch: (args) => gmailWatchService.stopWatch(args),
    runGoogleAccountDisconnect: (args) => gmailWatchService.disconnectAccount(args),
    refreshGogAccounts: () =>
      refreshDetectedGogAccounts({ execFileCmd }).catch(() => false),
  });
  // { progress } only from the listen-time boot (lib/server.js); the
  // onboarding-completion run reports no boot timeline.
  const runOnboardedBoot = ({ progress = null } = {}) =>
    runOnboardedBootSequence({
      progress,
      onboarded: isOnboarded(),
      signal: bootSignal,
      acquireLifecycleLock: (kind, options) =>
        gatewayLifecycleLock.acquire(kind, options),
      applyResourceAutotuneOnBoot: () => applyResourceAutotuneFor("boot"),
      // Issue #76 A7/A1: first steps inside the boot lock (startup.js owns
      // the order); each is optional and swallow-and-log there.
      reconcileRestartOperationAtBoot: bootSteps?.reconcileRestartOperationAtBoot
        ? () => bootSteps.reconcileRestartOperationAtBoot()
        : null,
      recordBootReportServerPhase: bootSteps?.recordBootReportServerPhase
        ? () => bootSteps.recordBootReportServerPhase()
        : null,
      finalizeBootReport: bootSteps?.finalizeBootReport
        ? (outcome) => bootSteps.finalizeBootReport(outcome)
        : null,
      // `openclaw doctor --fix` once per pinned OpenClaw version, before the
      // gateway starts (lib/server.js composes it with the doctor guard).
      runBootMigration: bootSteps?.runBootMigration
        ? (options) => bootSteps.runBootMigration(options)
        : null,
      resolveDoctorTimeoutMs,
      normalizeBootConfig: (options) => normalizeBootConfig({ ...options, env: gatewayEnv() }),
      runBootNativeMaintenance: (options) => runBootNativeMaintenance({
        ...options,
        execFileCmd,
        gatewayEnv,
        managedDir: constants.kOpenclawManagedDir,
      }),
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
        // gog accounts added outside the Setup UI reach the prompt once
        // listed; the boot's own prompt sync never waits on gog.
        void refreshDetectedGogAccounts({ execFileCmd })
          .then((changed) => {
            if (changed) doSyncPromptFiles();
          })
          .catch((error) => {
            console.error(`[alphaclaw] gog account prompt sync failed: ${error.message}`);
          });
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
    gitSync: callerGitSync,
    topicDiscovery,
  });
  registerWebhookRoutes({
    app,
    fs,
    constants,
    getBaseUrl,
    gitSync: callerGitSync,
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
    readWatchdogMemorySettings,
    updateWatchdogMemorySettings,
  });
  const lastRestartStore = createLastRestartStore({
    managedDir: constants.kOpenclawManagedDir,
    bootId: getProcessBootId(),
  });
  setGatewayRestartRecorder(lastRestartStore.recorder);
  registerBoxRoutes({
    app,
    requireAuth,
    readRestartStatus: () => readRestartStatus({
      store: lastRestartStore,
      readBootHistory: () => readBootHistory({ managedDir: constants.kOpenclawManagedDir }),
      getWatchdogStatus: () => watchdog.getStatus(),
    }),
    processTable: createProcessTable({
      getGatewayTarget: () => resolveGatewayMemoryTarget(watchdog.getStatus()),
      readEnvFile,
      alphaclawVersion,
      getOpenclawVersion: () => openclawRuntime?.getInfo?.()?.installedVersion ?? null,
    }),
    scheduleReader: createScheduleReader({
      clawCmd,
      execFileCmd,
      registry: scheduleRegistry,
      readEnvFile,
      readGitSyncSchedule: () => {
        const parsed = JSON.parse(fs.readFileSync(`${openclawDir}/cron/system-sync.json`, "utf8"));
        return parsed && typeof parsed === "object" ? parsed : null;
      },
      readGitSyncStatus: () => readGitSyncStatus({ statusPath: resolveGitSyncStatusPath(openclawDir), fsModule: fs }),
    }),
    diskReader: createDiskReader({
      resolveStateDir: () => gatewayEnv().OPENCLAW_STATE_DIR || constants.OPENCLAW_DIR,
      backupsDir: constants.kOpenclawBackupsDir,
      resolveEnv: gatewayEnv,
    }),
    mcpReader: createMcpReader({
      readConfig: () => readOpenclawConfig({ fsModule: fs, openclawDir: constants.OPENCLAW_DIR }),
      watch: mcpWatch,
      clawCmd,
      readEnvFile,
    }),
  });
  // GET /api/diagnose (#76 A9): the `alphaclaw diagnose` collector over THIS
  // process's live seams. The getters are late-bound (called per request, not
  // here).
  registerDiagnoseRoutes({
    app,
    requireAuth,
    fsModule: fs,
    rootDir: constants.kRootDir ?? null,
    openclawDir,
    readLogTail,
    incidentsDb,
    getWatchdogStatus: () => watchdog?.getStatus?.() ?? null,
    openclawRuntime,
  });
  registerAutotuneRoutes({
    notifier: upgradeNotifier,
    app,
    requireAuth,
    gatewayLifecycleLock,
    restartRequiredState,
    watchdogNotifier,
    insertWatchdogEvent,
    doSyncPromptFiles,
  });
  if (sidecarService) registerSidecarRoutes({ app, requireAuth, sidecarService });
  if (deployAnnouncer) registerDeployRoutes({ app, requireAuth, deployAnnouncer });
  registerClaudeCodeRoutes({
    app,
    requireAuth,
    claudeCodeService: claudeCodeService || createClaudeCodeService(),
    claudeCodeLocalService,
    getBaseUrl,
  });
  // Rescue capability link (/rescue/<token>) — deliberately OUTSIDE the
  // auth-gated prefixes; the 256-bit session-bound token is the credential.
  // FRESH throttle instances (never shared with login state): these are
  // audit-WRITE caps, not response throttles — a capped request still gets
  // the normal 404/302. Gate windows live in constants.js
  // (kRescueLinkProbeGate / kRescueLinkRedeemGate) so the route tests pin the
  // real production values instead of a copy.
  const rescueLinkGates = {
    probe: createLoginThrottle(constants.kRescueLinkProbeGate),
    redeem: createLoginThrottle(constants.kRescueLinkRedeemGate),
  };
  // Sweep the gates' in-memory stores like auth.js does for the login
  // throttle: /rescue is unauthenticated, so without eviction every unique
  // client IP (spoofable via X-Forwarded-For under trust proxy) inserts a
  // Map entry that lives for the process lifetime — an OOM lever on the
  // break-glass box itself.
  if (rescueLinkGateSweepTimer) clearInterval(rescueLinkGateSweepTimer);
  rescueLinkGateSweepTimer = setInterval(() => {
    rescueLinkGates.probe.cleanupLoginAttemptStates();
    rescueLinkGates.redeem.cleanupLoginAttemptStates();
  }, constants.kLoginCleanupIntervalMs);
  rescueLinkGateSweepTimer.unref();
  registerRescueLinkRoutes({
    app,
    claudeCodeLocalService,
    recordOperationEvent: (event) => watchdog?.recordOperationEvent?.(event),
    throttle: rescueLinkGates,
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
    readDoctorAutoRunEnabled: doctorAutoRunSettings?.read,
    updateDoctorAutoRunEnabled: doctorAutoRunSettings?.update,
    readDoctorScanConfig: doctorScanSettings?.read,
    updateDoctorScanConfig: doctorScanSettings?.update,
    updateDoctorSettingsCombined: doctorScanSettings?.updateCombined,
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
  registerDashboardLaunchRoutes({
    app,
    requireAuth,
    isAdminRequest,
    isOnboarded,
    dashboardUrlService,
    // Redaction sources for the resolver-failure log: the same env-file and
    // config surfaces the resolver reads tokens from. STRICT reader on
    // purpose — a failed .env read must throw into the redactor's
    // fail-closed catch (code-only log), never silently shrink the secret
    // set (same convention as the watchdog-overseer's redaction sources).
    fsModule: fs,
    openclawDir: constants.OPENCLAW_DIR,
    readEnvFile: readEnvFileStrict,
  });
  registerControlUiAttachRoutes({
    app,
    requireAuth,
    isAuthorizedRequest,
    isAdminRequest,
    isOnboarded,
    dashboardUrlService,
  });
  // Late DI: the doctor service boots before route wiring, so the check's
  // resolver lands here (config-only entry point — never the CLI path).
  doctorService?.registerDashboardTokenCheck?.(dashboardUrlService);
  // Same late-DI pattern: the doctor's model-drift check reads the shared
  // catalog cache's exec-free peek (falls back to the bundled bootstrap
  // catalog until this registration lands).
  doctorService?.registerModelCatalog?.(modelCatalogCache);
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
    getTrustedBrowserOrigin: resolveSetupUrl,
    resolveControlUiAttachRedirect: createControlUiAttachRedirect({
      isAdminRequest,
      isOnboarded,
      isTokenlessGateway: () =>
        isTokenlessAuthMode(
          readOpenclawConfig({ fsModule: fs, openclawDir: constants.OPENCLAW_DIR }),
        ),
    }),
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

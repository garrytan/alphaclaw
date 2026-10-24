const { createGatewayMutationPolicy } = require("../gateway-mutation-policy");
const { buildManagedPaths } = require("../internal-files-migration");
const { readOpenclawConfig } = require("../openclaw-config");
const { resolveDefaultAgentId } = require("../openclaw-config-migrations");
const { createDashboardUrlService } = require("../gateway-dashboard-url");
const { shouldSkipSystemCronInstall } = require("../../cli/git-runtime");
const {
  buildSystemCronFile,
  isSafeCronSchedule,
  resolveSyncScheduleOptions,
} = require("../../cli/system-cron");
const {
  readGitSyncStatus,
  resolveGitSyncStatusPath,
} = require("../../cli/git-sync-status");
const { getGitSyncCode } = require("../../cli/git-sync-codes");
const { kRootDir } = require("../constants");
const { kDeploymentOnlyEnvKeys } = require("../deployment-only-env");
const {
  readAlphaclawConfig,
  updateOpenAiCompatApiFeature,
  updateAgentAdminFeature,
} = require("../alphaclaw-config");
const {
  parseTelegramSessionKey,
  getReplyTargetFromSessionKey,
} = require("../utils/session-keys");
const { createStatusSnapshotService } = require("../status-snapshot");
const { describeOpenclawPin } = require("../openclaw-pin-state");
const {
  reduceGatewayState,
  createGatewayStateTracker,
} = require("../gateway-state");
const { getBootPhase, setBootPhase } = require("../boot-phase");
const {
  projectBootOverlay,
  projectBootProgressHuman,
  pickPublicFrame,
} = require("../boot-progress/projections");
const { wrapAsync } = require("../utils/wrap-async");
const { describeActor } = require("../utils/input-audit");
const { formatRestartLogLine } = require("../gateway-restart-log");
const {
  collectSecretValues,
  redactSecrets,
  scrubTokenParams,
  redactSecretShapes,
  stripAnsi,
  stripControlChars,
} = require("../utils/redact");
const { pickCauseLine } = require("../utils/cause-line");
const { writeFileAtomic } = require("../utils/safe-file");
const {
  kGatewayRestartOperationBudgetMs,
  kOpenclawBootMigrationLeaseMarginMs,
  kOpenclawBootMigrationTimeoutMs,
} = require("../constants");
const { createRepairOperation } = require("../repair-operation");
const { summarizeDoctorResult } = require("../doctor-outcome");
const { describeDoctorFailure } = require("../doctor-plain-language");
const {
  buildFailureKey,
  readMigrationRecord,
  rememberDoctorFailure,
} = require("../openclaw-boot-migration");
const { readRetryEligibility } = require("../openclaw-upgrade-status");
const { sendIfConfigUnreadable } = require("../utils/config-unreadable");
const { quoteShellArg } = require("../utils/shell");

// Default for the injected `resolveSetupUrl`: the same env keys server.js's
// resolveSetupUrl reads (explicit public URL, else the platform's domain),
// "" when none is configured — never anything request-derived.
const resolveConfiguredSetupUrl = () => {
  const explicit = String(
    process.env.ALPHACLAW_SETUP_URL ||
      process.env.ALPHACLAW_BASE_URL ||
      process.env.RENDER_EXTERNAL_URL ||
      process.env.URL ||
      "",
  ).trim();
  if (explicit) return explicit;
  const railwayPublicDomain = String(process.env.RAILWAY_PUBLIC_DOMAIN || "").trim();
  if (railwayPublicDomain) return `https://${railwayPublicDomain}`;
  return String(process.env.RAILWAY_STATIC_URL || "").trim();
};
// The restart primitive's failure class (gateway.js THROWS on every outcome
// that is not "a new gateway is up and ready"; the subclass GatewayStopError
// carries `code` stop_refused | stop_failed, every other failure carries its
// user-facing class in `evidence.code`).
const { GatewayRestartError } = require("../gateway");

const { createSwrCache } = require("../utils/swr-cache");

// Every lifecycle-lock kind acquired anywhere in lib/server gets a label:
// while any of them holds the lock the card disables Restart with "Another
// operation is in progress", and an unlabeled "Working…" badge would leave the
// operator guessing what to wait for. (boot is expressed through bootPhase,
// never through the badge.)
const kOperationBadgeLabels = {
  restart: "Restarting gateway",
  openclaw_upgrade: "Upgrading OpenClaw data",
  team_transition: "Updating team access",
  repair: "Repairing",
  native_notification: "Sending notification",
  medic: "Running startup medic",
  crash_restart: "Relaunching after crash",
  config_retry: "Retrying start after config change",
  memory_mitigation: "Memory-pressure restart",
  autotune_resize: "Retuning resources",
  env_sync: "Saving environment",
  autotune_settings: "Saving resource settings",
  autotune_reapply: "Reapplying resource tuning",
  // Stage 3 (#76 B1): the watchdog's cause-keyed structural repair.
  structural_repair: "Repairing the installed build",
};
const https = require("https");

const {
  kRestartFailureCopy,
  describeUpgradeRetryFailure,
  describeStopFailed,
  kHumanPhases,
  describeRecovery,
  classifyRestartFailure,
} = require("../restart-failure-copy");

const registerSystemRoutes = ({
  app,
  fs,
  // Session-list micro-cache TTL (0 disables). Hermetic tests that drive one
  // app with per-request CLI mocks pass 0.
  agentSessionsCacheTtlMs = 15_000,
  readEnvFile,
  writeEnvFile,
  reloadEnv,
  kKnownVars,
  kKnownKeys,
  kSystemVars,
  syncChannelConfig,
  isGatewayRunning,
  isOnboarded,
  getChannelStatus,
  openclawVersionService,
  alphaclawVersionService,
  requireAdmin = (req, res, next) => req.alphaclawIdentity?.role === "admin" ? next() :
    res.status(403).json({ ok: false, code: "admin_required", error: "Admin access required" }),
  kAlphaclawGithubReleasesBaseUrl,
  // The process's boot timeline snapshot (boot-progress/index.js), null when
  // there is none (no listen-time boot, or a test harness).
  getBootSnapshot = () => require("../boot-progress").getBootSnapshot(),
  clawCmd,
  restartGateway,
  OPENCLAW_DIR,
  restartRequiredState,
  topicRegistry,
  authProfiles,
  watchdog,
  doctorService,
  ensureGatewayProxyConfig,
  getBaseUrl,
  // Configured public URL (server.js resolveSetupUrl shape: env-derived,
  // never request-derived). Preferred for links embedded in operator
  // notifications; the default reads the same env keys so the module stays
  // constructible from its injected deps alone.
  resolveSetupUrl = resolveConfiguredSetupUrl,
  topicDiscovery = null,
  probeGatewayTcp = null,
  gatewayLifecycleLock = null,
  gatewayStatePersistPath = null,
  operationEvents = null,
  doSyncPromptFiles = null,
  // Production passes the SHARED resolver (register-server-routes) so the
  // single-flight CLI memo spans /api/gateway/dashboard, /gateway/launch,
  // and the doctor check; the local default keeps this module constructible
  // from its injected deps alone (routes-system.test.js parity gate).
  dashboardUrlService = null,
  // Operator notifications (upgradeNotifier.notify shape). Optional: a
  // failed restart is important-class (never verbose) — a restart that did
  // not take effect is exactly what an operator must hear about.
  notify = null,
  // Retry upgrade (POST /api/openclaw/boot-migration/retry): the streamed
  // doctor --fix runner, the boot's post-Doctor convergence
  // (startup.js runPostDoctorConvergence) and the migration record's home.
  runDoctorFix = null,
  convergeAfterDoctor = null,
  // (floorMs) → ms: Retry upgrade's Doctor ceiling sized from the measured
  // state (doctor-budget.js), the same one the boot migration uses.
  resolveDoctorTimeoutMs = (floorMs) => floorMs,
  managedDir = null,
  alphaclawVersion = null,
  getInstalledOpenclawVersion = () => null,
  // openclawRuntime.getInfo(): the installed-vs-pinned answer for the status
  // payload's openclawPin field.
  getOpenclawInfo = () => null,
}) => {
  let envRestartPending = false;
  const dashboardUrl =
    dashboardUrlService ||
    createDashboardUrlService({
      fsModule: fs,
      openclawDir: OPENCLAW_DIR,
      readEnvFile,
      clawCmd,
    });
  // Reserved/managed env-key helpers are shared with the agent-admin env tier
  // resolver (utils/env-keys.js) so both classify keys identically.
  const {
    kReservedUserEnvVarKeys,
    isManagedChannelTokenKey,
    isReservedUserEnvVar,
  } = require("../utils/env-keys");
  const kSystemCronPath = "/etc/cron.d/openclaw-hourly-sync";
  const kSystemCronConfigPath = `${OPENCLAW_DIR}/cron/system-sync.json`;
  const { hourlyGitSyncPath: kSystemCronScriptPath } = buildManagedPaths({
    openclawDir: OPENCLAW_DIR,
  });
  // Offset minute, never :00 (issue #140). Derived per read from the repo
  // and managed path, so it needs no storage and every reader agrees.
  const getSyncScheduleOptions = (schedule = "") =>
    resolveSyncScheduleOptions({
      repo: process.env.GITHUB_WORKSPACE_REPO,
      openclawDir: OPENCLAW_DIR,
      schedule,
    });
  // Shared builder (issue #25): all three cron-file writers must emit the
  // same env lines or a later rewrite strips them (cron applies no
  // environment beyond what the file declares).
  const buildSystemCronContent = (schedule) =>
    buildSystemCronFile({
      schedule,
      scriptPath: kSystemCronScriptPath,
      rootDir: kRootDir,
      openclawDir: OPENCLAW_DIR,
    });
  // Shared with the Doctor fix dispatch's session validation — see
  // lib/server/utils/agent-session-lookup.js.
  const {
    kSessionsListCommand,
    parseJsonFromStdout,
    getRawSessionKey,
    getRawSessionsFromPayload,
    getAgentLabelFromSessionKey,
    parseChannelFromSessionKey,
  } = require("../utils/agent-session-lookup");
  const getSessionTopicContext = (sessionKey = "") => {
    const key = String(sessionKey || "");
    const parsed = parseTelegramSessionKey(key);
    if (!parsed || parsed.scope !== "group" || !parsed.threadId) {
      return {
        groupName: "",
        topicName: "",
      };
    }
    // Label-path bonus discovery: this request already proved the topic has
    // real traffic; feed it to the registry without blocking the response.
    try {
      topicDiscovery?.noteSessionSeen?.(key);
    } catch {}
    const { groupId, threadId: topicId } = parsed;
    let groupEntry = null;
    try {
      groupEntry = topicRegistry?.getGroup?.(groupId) || null;
    } catch {}
    return {
      groupName: String(groupEntry?.name || "").trim(),
      topicName: String(groupEntry?.topics?.[topicId]?.name || "").trim(),
    };
  };
  const syncApiKeyAuthProfilesFromEnvVars = (nextEnvVars) => {
    if (!authProfiles) return;
    const envMap = new Map(
      (nextEnvVars || []).map((entry) => [
        String(entry?.key || "").trim(),
        String(entry?.value || ""),
      ]),
    );
    const providers = authProfiles.listApiKeyProviders?.() || [];
    for (const provider of providers) {
      const envKey = authProfiles.getEnvVarForApiKeyProvider?.(provider);
      if (!envKey) continue;
      const value = envMap.get(envKey) || "";
      if (!value.trim()) {
        authProfiles.removeApiKeyProfileForEnvVar?.(provider);
        continue;
      }
      authProfiles.upsertApiKeyProfileForEnvVar(provider, value);
    }
  };
  // Reply targets derive through the canonical suffix/account-tolerant parser
  // — the hand-rolled $-anchored regexes this replaced silently dropped
  // delivery for account-scoped/suffixed Telegram keys, bare groups, and
  // every Discord/Slack DM (the "fix queued but never arrived" bug).
  const getSessionReplyTarget = (sessionKey = "") =>
    getReplyTargetFromSessionKey(sessionKey);

  const listSendableAgentSessions = async () => {
    const result = await clawCmd(kSessionsListCommand, {
      quiet: true,
    });
    if (!result.ok) {
      throw new Error(result.stderr || "Could not load agent sessions");
    }
    const payload = parseJsonFromStdout(result.stdout);
    const sessions = getRawSessionsFromPayload(payload);
    const config = readOpenclawConfig({
      fsModule: fs,
      openclawDir: OPENCLAW_DIR,
      fallback: {},
    });
    return sessions
      .map((sessionRow) => {
        const key = getRawSessionKey(sessionRow);
        if (!key) return null;
        const replyTarget = getSessionReplyTarget(key);
        const agentKeyMatch = key.match(/^agent:([^:]+):/);
        const agentId = String(agentKeyMatch?.[1] || "").trim();
        const channel =
          parseChannelFromSessionKey(key) || replyTarget.replyChannel || "";
        const topicContext = getSessionTopicContext(key);
        return {
          key,
          sessionId: String(sessionRow?.sessionId || sessionRow?.id || ""),
          updatedAt:
            Number(
              sessionRow?.updatedAt ||
                sessionRow?.lastActivityAt ||
                sessionRow?.lastActiveAt,
            ) || 0,
          agentId,
          agentLabel: getAgentLabelFromSessionKey(key, config),
          channel,
          groupName: topicContext.groupName,
          topicName: topicContext.topicName,
          replyChannel: replyTarget.replyChannel,
          replyTo: replyTarget.replyTo,
          replyAccountId: replyTarget.replyAccountId || "",
          deliverable: !!(replyTarget.replyChannel && replyTarget.replyTo),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  };
  // A fresh install has no session until its first turn, which left the Chat
  // tab with nothing to select and no way to send. Offer the default agent's
  // main session; OpenClaw creates it on the first message.
  const withStarterSession = (sessions) => {
    if (sessions.length > 0 || !isOnboarded()) return sessions;
    const config = readOpenclawConfig({ fsModule: fs, openclawDir: OPENCLAW_DIR, fallback: {} });
    const agentId = resolveDefaultAgentId(config);
    const key = `agent:${agentId}:main`;
    return [{
      key,
      sessionId: "",
      updatedAt: 0,
      agentId,
      agentLabel: getAgentLabelFromSessionKey(key, config),
      channel: "",
      groupName: "",
      topicName: "",
      replyChannel: "",
      replyTo: "",
      replyAccountId: "",
      deliverable: false,
    }];
  };
  const readSystemCronConfig = () => {
    try {
      const raw = fs.readFileSync(kSystemCronConfigPath, "utf8");
      const parsed = JSON.parse(raw);
      const enabled = parsed.enabled !== false;
      const rawSchedule =
        typeof parsed.schedule === "string" ? parsed.schedule.trim() : "";
      const valid = isSafeCronSchedule(rawSchedule);
      if (rawSchedule && !valid) {
        // An invalid schedule in this file is exactly the injection signal
        // the shared guard exists for — fall back loudly, never silently.
        console.warn(
          `[alphaclaw] Ignoring invalid stored sync-cron schedule ${JSON.stringify(rawSchedule)}; using the default (${getSyncScheduleOptions().defaultSchedule})`,
        );
      }
      return {
        enabled,
        schedule: valid ? rawSchedule : getSyncScheduleOptions().defaultSchedule,
        ...(rawSchedule && !valid
          ? { scheduleFallback: true, invalidStoredSchedule: rawSchedule }
          : {}),
      };
    } catch {
      return { enabled: true, schedule: getSyncScheduleOptions().defaultSchedule };
    }
  };
  // Last git-sync run for the General tab. Rides the status snapshot, which
  // the agent can read, so it carries code, times and counts only: never the
  // status file's detail or the owning process list (issue #140).
  const readGitSyncLastRun = () => {
    const status = readGitSyncStatus({ statusPath: resolveGitSyncStatusPath(OPENCLAW_DIR), fsModule: fs });
    if (!status?.at) return null;
    return {
      at: status.at,
      outcome: status.outcome,
      code: status.code,
      headline: getGitSyncCode(status.code).headline,
      trigger: status.trigger || "",
      shortHash: status.shortHash || "",
      lastSuccessAt: status.lastSuccessAt || null,
      firstFailureAt: status.firstFailureAt || null,
      consecutiveFailures: Number(status.consecutiveFailures) || 0,
      liveTreeBehindCount: Array.isArray(status.liveTreeBehind?.paths) ? status.liveTreeBehind.paths.length : 0,
      liveTreeBehindSince: status.liveTreeBehind?.since || null,
    };
  };
  const getSystemCronStatus = () => {
    const config = readSystemCronConfig();
    const { offsetMinute, presets, scheduleLabel } = getSyncScheduleOptions(config.schedule);
    return {
      enabled: config.enabled,
      schedule: config.schedule,
      scheduleLabel,
      offsetMinute,
      presets,
      lastRun: readGitSyncLastRun(),
      ...(config.scheduleFallback
        ? {
            scheduleFallback: true,
            invalidStoredSchedule: config.invalidStoredSchedule,
          }
        : {}),
      installed: fs.existsSync(kSystemCronPath),
      scriptExists: fs.existsSync(kSystemCronScriptPath),
    };
  };
  const applySystemCronConfig = (nextConfig) => {
    fs.mkdirSync(`${OPENCLAW_DIR}/cron`, { recursive: true });
    fs.writeFileSync(
      kSystemCronConfigPath,
      JSON.stringify(nextConfig, null, 2),
    );
    if (shouldSkipSystemCronInstall()) {
      return getSystemCronStatus();
    }
    if (nextConfig.enabled) {
      const cronContent = buildSystemCronContent(nextConfig.schedule);
      // null = the builder refused (unsafe path/schedule); never write "null",
      // and never report success while /etc/cron.d keeps a stale line.
      if (cronContent) {
        // Atomic install: a crash/ENOSPC mid-write must never leave a
        // truncated root cron file. The dotted temp name is ignored by
        // cron.d until the rename lands; injected fs mocks without renameSync
        // fall back to a plain write inside the helper.
        writeFileAtomic(kSystemCronPath, cronContent, {
          fsModule: fs,
          mode: 0o644,
        });
      } else {
        return { ...getSystemCronStatus(), cronWriteRefused: true };
      }
    } else {
      fs.rmSync(kSystemCronPath, { force: true });
    }
    return getSystemCronStatus();
  };
  const isVisibleInEnvars = (def) => def?.visibleInEnvars !== false;
  const kReleaseNotesCacheTtlMs = 5 * 60 * 1000;
  let kReleaseNotesCache = {
    key: "",
    fetchedAt: 0,
    payload: null,
  };
  const isValidReleaseTag = (value) =>
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(String(value || ""));
  const fetchGitHubRelease = (tag = "") =>
    new Promise((resolve, reject) => {
      const normalizedTag = String(tag || "").trim();
      const endpointPath = normalizedTag
        ? `/tags/${encodeURIComponent(normalizedTag)}`
        : "/latest";
      const requestUrl = `${kAlphaclawGithubReleasesBaseUrl}${endpointPath}`;
      const token = String(process.env.GITHUB_TOKEN || "").trim();
      const headers = {
        Accept: "application/vnd.github+json",
        "User-Agent": "alphaclaw-release-notes",
      };
      if (token) headers.Authorization = `Bearer ${token}`;
      const request = https.get(
        requestUrl,
        { headers, timeout: 7000 },
        (response) => {
          let raw = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            raw += chunk;
          });
          response.on("end", () => {
            let parsed = null;
            try {
              parsed = raw ? JSON.parse(raw) : null;
            } catch {
              parsed = null;
            }
            const statusCode = Number(response.statusCode) || 500;
            if (statusCode >= 400) {
              const message =
                parsed?.message ||
                `GitHub release lookup failed with status ${statusCode}`;
              return reject(
                Object.assign(new Error(message), {
                  statusCode,
                }),
              );
            }
            resolve({
              tag: String(parsed?.tag_name || normalizedTag || ""),
              name: String(parsed?.name || "").trim(),
              body: String(parsed?.body || ""),
              htmlUrl: String(parsed?.html_url || "").trim(),
              publishedAt: String(parsed?.published_at || "").trim(),
            });
          });
        },
      );
      request.on("timeout", () => {
        request.destroy(new Error("GitHub release request timed out"));
      });
      request.on("error", (error) => {
        reject(error);
      });
    });

  app.get("/api/env", (req, res) => {
    const fileVars = readEnvFile();
    const merged = [];

    for (const def of kKnownVars) {
      if (isReservedUserEnvVar(def.key)) continue;
      if (!isVisibleInEnvars(def)) continue;
      const fileEntry = fileVars.find((v) => v.key === def.key);
      const value = fileEntry?.value || "";
      merged.push({
        key: def.key,
        value,
        label: def.label,
        group: def.group,
        hint: def.hint,
        features: def.features,
        source: fileEntry?.value ? "env_file" : "unset",
        editable: true,
      });
    }

    for (const v of fileVars) {
      if (
        kKnownKeys.has(v.key) ||
        isReservedUserEnvVar(v.key) ||
        isManagedChannelTokenKey(v.key)
      ) {
        continue;
      }
      merged.push({
        key: v.key,
        value: v.value,
        label: v.key,
        group: "custom",
        hint: "",
        source: "env_file",
        editable: true,
      });
    }

    res.json({
      vars: merged,
      reservedKeys: kReservedUserEnvVarKeys,
      restartRequired: envRestartPending && isOnboarded(),
    });
  });

  app.put("/api/env", wrapAsync(async (req, res) => {
    const { vars } = req.body;
    if (!Array.isArray(vars)) {
      return res.status(400).json({ ok: false, error: "Missing vars array" });
    }
    // Reject malformed keys at the boundary (defense in depth for the
    // agent-admin tier gate). Two classes are dangerous because the write
    // path String()-coerces + strips line breaks + trims, so they can
    // silently canonicalize into a DIFFERENT (protected) key that the tier
    // resolver never saw:
    //   1. a non-string key ({"key":["CLAUDE_CODE_ROUTINE_URL"]} coerces to
    //      the protected string), and
    //   2. a string key with interior whitespace/control chars or characters
    //      outside the env-name charset.
    // Grammar is [A-Za-z0-9_] (the exact output of the UI's client-side
    // key normalizer, leading digits included, e.g. 2CAPTCHA_API_KEY);
    // missing/empty keys are dropped by normalizeEnvVars, so they are no-ops
    // here, not errors.
    const malformedKey = vars.find((v) => {
      if (!v || v.key === undefined || v.key === null || v.key === "") return false;
      if (typeof v.key !== "string") return true;
      const trimmed = v.key.trim();
      return trimmed !== "" && !/^[A-Za-z0-9_]+$/.test(trimmed);
    });
    if (malformedKey) {
      return res.status(400).json({
        ok: false,
        error: `Invalid environment variable name: ${JSON.stringify(String(malformedKey.key).slice(0, 64))}`,
      });
    }
    // Express 4 does not forward async rejections; an fs failure in
    // writeEnvFile (ENOSPC/EACCES) must become a 500, not a process crash.
    let releaseEnvSyncLock = null;
    try {
    // The save is a multi-step read-modify-write of openclaw.json (channels
    // remove -> env file write -> channels add). It was event-loop-atomic
    // when these were execSync; now it must serialize against concurrent
    // saves, boot, and restarts or interleaved writes lose channel config.
    if (gatewayLifecycleLock) {
      releaseEnvSyncLock = await gatewayLifecycleLock.acquire("env_sync");
    }

    const blockedKeys = Array.from(
      new Set(
        vars
          .map((v) => String(v?.key || "").trim())
          .filter((key) => key && isReservedUserEnvVar(key)),
      ),
    );
    if (blockedKeys.length) {
      const deploymentHint = blockedKeys.some((key) => kDeploymentOnlyEnvKeys.includes(key))
        ? ". Set deployment-only variables in the deployment environment, not Envars or .env."
        : "";
      return res.status(400).json({
        ok: false,
        error: `Reserved environment variables cannot be edited: ${blockedKeys.join(", ")}${deploymentHint}`,
      });
    }

    const filtered = vars.filter(
      (v) => !isReservedUserEnvVar(v.key) && !isManagedChannelTokenKey(v.key),
    );
    const existingLockedVars = readEnvFile().filter((v) =>
      isReservedUserEnvVar(v.key),
    );
    const existingManagedChannelVars = readEnvFile().filter((v) =>
      isManagedChannelTokenKey(v.key),
    );
    const hiddenKnownVarKeys = new Set(
      kKnownVars
        .filter(
          (def) => !isReservedUserEnvVar(def.key) && !isVisibleInEnvars(def),
        )
        .map((def) => def.key),
    );
    const existingHiddenKnownVars = readEnvFile().filter((v) =>
      hiddenKnownVarKeys.has(v.key),
    );
    const nextEnvVars = [
      ...filtered,
      ...existingHiddenKnownVars,
      ...existingManagedChannelVars,
      ...existingLockedVars,
    ];
    await syncChannelConfig(nextEnvVars, "remove");
    writeEnvFile(nextEnvVars);
    const changed = reloadEnv();
    // The auth-profile sync can now fail closed (shared state db busy on the
    // sqlite era). The env file IS already written at this point — aborting
    // here would 500 with half-applied state (channels removed but never
    // re-added, restart never marked). Degrade to a response warning instead.
    let authSyncWarning = null;
    try {
      syncApiKeyAuthProfilesFromEnvVars(nextEnvVars);
    } catch (err) {
      authSyncWarning = `Env saved, but syncing API-key auth profiles failed (${err.message}) — retry the save shortly`;
      console.warn(`[alphaclaw] ${authSyncWarning}`);
    }
    if (changed && isOnboarded()) {
      envRestartPending = true;
      restartRequiredState.markRequired?.("env_vars_changed");
    }
    const restartRequired = envRestartPending && isOnboarded();
    console.log(
      `[alphaclaw] Env vars saved (${nextEnvVars.length} vars, changed=${changed})`,
    );
    await syncChannelConfig(nextEnvVars, "add");

    // Channel state just changed — the next status poll must see it, not a
    // <=5s-stale SWR value.
    invalidateStatusCaches();
    res.json({
      ok: true,
      changed,
      restartRequired,
      ...(authSyncWarning ? { warning: authSyncWarning } : {}),
    });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    } finally {
      releaseEnvSyncLock?.();
    }
  }));

  // Legacy /api/status `gateway` values are running|starting|not_onboarded.
  // Map the unified headline onto that vocabulary (kept for one minor
  // release): port-up states -> "running", pre-onboarding -> "not_onboarded",
  // everything else (down, booting, unknown, errors) -> "starting" — matching
  // what the old independent computation showed in those situations.
  const kLegacyRunningStates = new Set([
    "running",
    "degraded",
    "safe_mode",
    "flapping",
  ]);
  const legacyGatewayProjection = (state) => {
    if (state === "not_onboarded") return "not_onboarded";
    return kLegacyRunningStates.has(state) ? "running" : "starting";
  };

  // One TCP observation per snapshot compute, shared with the reducer. The
  // injected shared probe records observations and fires up↔down transition
  // events; the fallback wraps the plain probe for test harnesses.
  const observeGatewayTcp = async () => {
    // A probe failure (e.g. a config edit producing an invalid port makes
    // net.createConnection throw) must degrade to "no observation" — the
    // reducer then reports "unknown" honestly. Letting it reject would fail
    // the whole snapshot compute and freeze the last-good payload forever.
    try {
      if (typeof probeGatewayTcp === "function") return await probeGatewayTcp();
      return { running: await isGatewayRunning(), observedAt: Date.now() };
    } catch {
      return { running: null, observedAt: 0 };
    }
  };

  const kStatusReaderTtlMs = 5000;
  const getChannelStatusCached = createSwrCache(() => getChannelStatus(), kStatusReaderTtlMs);
  const getSystemCronStatusCached = createSwrCache(
    () => getSystemCronStatus(),
    kStatusReaderTtlMs,
  );
  const readAlphaclawConfigCached = createSwrCache(
    () =>
      readAlphaclawConfig({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
      }),
    kStatusReaderTtlMs,
  );
  // The autotune sub-reads (isAutotuneActive, getAgentConcurrencyCap) each
  // cost a statSync — fine per request, not per 2s snapshot tick. SWR-cache
  // the whole summary; the profile itself is already a boot memo.
  // Two small package.json reads; cached like the other status readers so the
  // 2s snapshot loop does no fs work per tick.
  const getOpenclawPinCached = createSwrCache(
    () => describeOpenclawPin(getOpenclawInfo()),
    kStatusReaderTtlMs,
  );
  const buildMachineSummaryCached = createSwrCache(
    () => buildMachineSummary(),
    kStatusReaderTtlMs,
  );
  const invalidateStatusCaches = () => {
    getChannelStatusCached.invalidate();
    getSystemCronStatusCached.invalidate();
    readAlphaclawConfigCached.invalidate();
    buildMachineSummaryCached.invalidate();
    getOpenclawPinCached.invalidate();
  };

  const buildStatusPayload = async (tcp) => {
    const configExists = fs.existsSync(`${OPENCLAW_DIR}/openclaw.json`);
    const running = tcp
      ? !!tcp.running
      : (await observeGatewayTcp()).running === true;
    const repo = process.env.GITHUB_WORKSPACE_REPO || "";
    const openclawVersion = openclawVersionService.readOpenclawVersion();
    const alphaclawVersion =
      typeof alphaclawVersionService?.readAlphaclawVersion === "function"
        ? alphaclawVersionService.readAlphaclawVersion()
        : null;
    return {
      gateway: running
        ? "running"
        : configExists
          ? "starting"
          : "not_onboarded",
      configExists,
      channels: getChannelStatusCached(),
      repo,
      openclawVersion,
      // Installed OpenClaw vs the pin (openclaw-pin-state.js); the General
      // tab warns on anything but match/unknown.
      openclawPin: getOpenclawPinCached(),
      alphaclawVersion,
      alphaclaw: readAlphaclawConfigCached(),
      // Both underlying reads are mtime-cached (config + token file), so this
      // stays event-loop-cheap inside the 2s status snapshot.
      agentAdmin: buildAgentAdminStatus(),
      syncCron: getSystemCronStatusCached(),
      bootPhase: getBootPhase(),
      // Capacity summary for the CLI digest and agent surfaces. The profile is
      // an in-memory boot memo and the whole summary is SWR-cached — zero fs
      // work on the 2s snapshot loop's hot path.
      machine: buildMachineSummaryCached(),
    };
  };

  function buildMachineSummary() {
    try {
      const { getMachineProfile } = require("../machine-profile");
      const { getAgentConcurrencyCap, isAutotuneActive } = require("../autotune");
      const profile = getMachineProfile();
      const memoryGb = profile?.memory?.limitBytes
        ? Math.round((profile.memory.limitBytes / 1024 ** 3) * 10) / 10
        : null;
      const gpuDevice = profile?.gpu?.devices?.[0] || null;
      return {
        tier: profile?.tier ?? null,
        memoryGb,
        cores: profile?.cpu?.cores ?? null,
        environment: profile?.environment ?? null,
        gpu: profile?.gpu?.present
          ? { present: true, ...(gpuDevice?.name ? { name: gpuDevice.name } : {}) }
          : { present: false },
        autotune: {
          enabled: isAutotuneActive({ openclawDir: OPENCLAW_DIR }),
          agentConcurrencyCap: getAgentConcurrencyCap({ openclawDir: OPENCLAW_DIR }),
        },
      };
    } catch {
      // Status must render even if the profile probe fails — the machine
      // block is additive.
      return null;
    }
  }

  // Observable tri-state (A39): the server can attest artifact readiness (flag
  // + token file), never whether a chat session has loaded the skill.
  function buildAgentAdminStatus() {
    try {
      const {
        isAgentAdminEnabled,
      } = require("../alphaclaw-config");
      if (!isAgentAdminEnabled({ openclawDir: OPENCLAW_DIR })) {
        return { state: "disabled" };
      }
      const tokenStore = require("../agent-admin/token-store");
      const token = tokenStore.readToken({ openclawDir: OPENCLAW_DIR });
      if (!token) {
        return {
          state: "unavailable",
          reason: "token_missing",
          hint: "Flag is on but no token file exists (mint failure?) — check server logs.",
        };
      }
      return { state: "enabled" };
    } catch {
      return { state: "unavailable", reason: "error" };
    }
  }

  // Frames must stay small: the doctor's full run payload includes the whole
  // workspace manifest and raw result, which nothing client-side reads.
  const slimDoctorStatus = (doctorStatus) => {
    if (!doctorStatus || typeof doctorStatus !== "object") {
      return doctorStatus ?? null;
    }
    const { latestRun, bootstrapContext, changeSummary, ...rest } = doctorStatus;
    const slim = { ...rest };
    // changedPaths lists every drifted workspace file (bounded only by the
    // fingerprint scan cap); the Doctor tab reads it from /api/doctor/status,
    // and the shell only needs the counts and flags.
    if (changeSummary && typeof changeSummary === "object") {
      const { changedPaths, ...slimChangeSummary } = changeSummary;
      slim.changeSummary = slimChangeSummary;
    } else if (changeSummary !== undefined) {
      slim.changeSummary = changeSummary;
    }
    if (latestRun && typeof latestRun === "object") {
      const { workspaceManifest, rawResult, ...slimRun } = latestRun;
      slim.latestRun = slimRun;
    } else if (latestRun !== undefined) {
      slim.latestRun = latestRun;
    }
    // The status stream only feeds the shell's truncation warnings — the full
    // per-file listing (several KB per frame) stays on /api/doctor/status.
    if (bootstrapContext && typeof bootstrapContext === "object") {
      const {
        files,
        activeFiles,
        inactiveTruncatedFiles,
        truncationGuidance,
        ...slimContext
      } = bootstrapContext;
      slim.bootstrapContext = slimContext;
    } else if (bootstrapContext !== undefined) {
      slim.bootstrapContext = bootstrapContext;
    }
    return slim;
  };

  // Per-source failure isolation: a broken watchdog or doctor (e.g. the
  // workspace directory not existing pre-onboarding) must degrade its own
  // field to null, never take down the whole status payload — and never
  // crash the process via an unhandled rejection in the route handler.
  let statusSourceWarned = false;
  const readStatusSource = (label, read) => {
    try {
      return read();
    } catch (err) {
      if (!statusSourceWarned) {
        statusSourceWarned = true;
        console.warn(
          `[alphaclaw] status source "${label}" failed: ${err?.message || err}`,
        );
      }
      return null;
    }
  };

  // Doctor status is the heaviest per-tick source even when memoized inside
  // the service; a 30s route-level SWR (upstream v0.9.36 behavior) keeps the
  // 2s loop off it entirely. Drift acceptance up to ~60s is per the design.
  const readDoctorStatusCached = createSwrCache(
    () =>
      readStatusSource("doctor", () =>
        typeof doctorService?.buildStatus === "function"
          ? slimDoctorStatus(doctorService.buildStatus())
          : null,
      ),
    30000,
  );

  const gatewayStateTracker = createGatewayStateTracker({
    persistPath: gatewayStatePersistPath,
  });

  const activeOperationBadge = () => {
    const active = gatewayLifecycleLock?.getActiveOperation?.() || null;
    if (!active || active.kind === "boot") return null;
    return {
      kind: active.kind,
      label: active.phase === "cleanup_blocked" ? "Repair cleanup needs attention"
        : active.phase === "cleanup" ? "Stopping repair processes"
          : kOperationBadgeLabels[active.kind] || "Working…",
      startedAt: active.startedAt,
    };
  };

  const statusSnapshot = createStatusSnapshotService({
    compute: async () => {
      const tcp = await observeGatewayTcp();
      const status = await buildStatusPayload(tcp);
      const watchdogStatus = readStatusSource("watchdog", () =>
        typeof watchdog?.getStatus === "function" ? watchdog.getStatus() : null,
      );
      const doctorStatus = readDoctorStatusCached();
      // gateway-state.json annotations (#76 A3/A4): the crash classifier's
      // last cause and the watchdog's latched version mismatch ride beside the
      // headline; the tracker persists them only on a change.
      gatewayStateTracker.setCause?.(watchdogStatus?.lastExit?.cause ?? null);
      gatewayStateTracker.setVersionMismatch?.(watchdogStatus?.versionMismatch ?? null);
      // Honest boot status: the human shape rides every frame; the agent
      // actor's response/subscription is cut to the public whitelist below.
      const bootSnapshot = readStatusSource("boot progress", () => getBootSnapshot());
      status.bootProgress = bootSnapshot ? projectBootProgressHuman(bootSnapshot) : null;
      // The unified, user-facing gateway state — derived from the same inputs
      // the legacy fields project from, so old and new can never disagree.
      status.state = gatewayStateTracker.track(
        reduceGatewayState({
          configExists: status.configExists,
          tcp,
          watchdog: watchdogStatus,
          operation: activeOperationBadge(),
          bootPhase: status.bootPhase,
          boot: projectBootOverlay(bootSnapshot),
        }),
      );
      // Compat contract: the legacy field is a PROJECTION of the reduced
      // state, never an independent computation — the two can't disagree.
      status.gateway = legacyGatewayProjection(status.state.state);
      return { status, watchdogStatus, doctorStatus };
    },
    // While a browser is watching, the watchdog tightens its health cadence
    // (wedged-but-TCP-up detection in ~30s instead of ~120s). Suppressed while
    // the degraded retry loop is armed or in flight — that loop
    // (WATCHDOG_DEGRADED_CHECK_INTERVAL → WATCHDOG_DEGRADED_CHECK_MAX_INTERVAL
    // backoff) owns the cadence then.
    onClientCountChange: (count) =>
      watchdog?.setStatusClientsConnected?.(count > 0),
  });

  // Frames are computed actor-neutrally; the agent actor gets the boot
  // timeline in its public shape (no versions, steps, trace text or reasons).
  const isAgentActor = (req) => req?.alphaclawActor?.type === "agent";
  const projectStatusForAgent = (body) =>
    body && typeof body === "object" && body.bootProgress
      ? { ...body, bootProgress: pickPublicFrame(body.bootProgress) }
      : body;

  app.get("/api/status", wrapAsync(async (req, res) => {
    try {
      const payload = await statusSnapshot.getSnapshotPayload();
      const status = isAgentActor(req) ? projectStatusForAgent(payload.status) : payload.status;
      // Staleness markers ride on the wrapper; the REST projection must keep
      // them or a persistently failing compute serves stale state as fresh.
      res.json({
        ...status,
        timestamp: payload.timestamp,
        snapshotEpoch: payload.snapshotEpoch,
        snapshotRevision: payload.snapshotRevision,
        snapshotStale: payload.snapshotStale,
        ...(payload.snapshotErrorCount ? { snapshotErrorCount: payload.snapshotErrorCount } : {}),
        watchdogStatus: payload.watchdogStatus,
        doctorStatus: payload.doctorStatus,
      });
    } catch (err) {
      // Express 4 does not forward async rejections; without this an early
      // failure here kills the whole process.
      res
        .status(500)
        .json({ ok: false, error: err?.message || "status unavailable" });
    }
  }));

  app.get("/api/events/status", wrapAsync(async (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    // A client whose socket stays backed up across consecutive writes is
    // disconnected rather than allowed to buffer status frames without bound
    // (upstream v0.9.36 hardening). The guard lives in a wrapper client so
    // res.write itself is untouched; snapshot frames and keepalives both go
    // through it.
    const kMaxBackpressuredTicks = 5;
    let backpressuredTicks = 0;
    const sseClient = {
      ...(isAgentActor(req)
        ? { projectFrame: (envelope) => ({ ...envelope, status: projectStatusForAgent(envelope.status) }) }
        : {}),
      write: (chunk) => {
        if (res.destroyed || res.writableEnded) return false;
        const flushed = res.write(chunk);
        if (flushed) {
          backpressuredTicks = 0;
          return true;
        }
        backpressuredTicks += 1;
        if (backpressuredTicks >= kMaxBackpressuredTicks) {
          res.destroy?.();
        }
        return false;
      },
    };

    const keepAliveIntervalId = setInterval(() => {
      sseClient.write(": keepalive\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(keepAliveIntervalId);
      statusSnapshot.removeClient(sseClient);
      res.end();
    });

    await statusSnapshot.addClient(sseClient);
  }));

  app.get("/api/sync-cron", (req, res) => {
    res.json({ ok: true, ...getSystemCronStatus() });
  });

  app.put("/api/sync-cron", (req, res) => {
    const current = readSystemCronConfig();
    const { enabled, schedule } = req.body || {};
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return res
        .status(400)
        .json({ ok: false, error: "enabled must be a boolean" });
    }
    if (schedule !== undefined && !isSafeCronSchedule(schedule)) {
      return res.status(400).json({
        ok: false,
        error:
          "schedule must be five space-separated numeric cron fields (ranges/steps allowed; names and @aliases are not)",
      });
    }
    const nextConfig = {
      enabled: typeof enabled === "boolean" ? enabled : current.enabled,
      schedule:
        typeof schedule === "string" && schedule.trim()
          ? schedule.trim()
          : current.schedule,
    };
    const status = applySystemCronConfig(nextConfig);
    if (status.cronWriteRefused) {
      return res.status(500).json({
        ok: false,
        error:
          "cron file not written: the builder refused the current path configuration — check server logs",
        syncCron: status,
      });
    }
    res.json({ ok: true, syncCron: status });
  });

  app.get("/api/alphaclaw/config", (req, res) => {
    res.json({
      ok: true,
      config: readAlphaclawConfig({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
      }),
    });
  });

  app.put("/api/alphaclaw/config/features/openai-compat-api", wrapAsync(async (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res
        .status(400)
        .json({ ok: false, error: "enabled must be a boolean" });
    }

    try {
      const { config, changed } = updateOpenAiCompatApiFeature({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
        enabled,
      });
      let gatewayConfigChanged = false;
      if (enabled && isOnboarded() && typeof ensureGatewayProxyConfig === "function") {
        gatewayConfigChanged = ensureGatewayProxyConfig(getBaseUrl?.(req));
        if (gatewayConfigChanged && restartRequiredState?.markRequired) {
          restartRequiredState.markRequired("openai_compat_api_enabled");
        }
      }
      const snapshot =
        typeof restartRequiredState?.getSnapshot === "function"
          ? await restartRequiredState.getSnapshot()
          : null;
      res.json({
        ok: true,
        changed,
        gatewayConfigChanged,
        config,
        restartRequired:
          Boolean(snapshot?.restartRequired) || (envRestartPending && isOnboarded()),
      });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message || "Could not update AlphaClaw config",
      });
    }
  }));

  app.put("/api/alphaclaw/config/features/agent-admin", (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") {
      return res
        .status(400)
        .json({ ok: false, error: "enabled must be a boolean" });
    }
    try {
      const { config, changed } = updateAgentAdminFeature({
        fsModule: fs,
        openclawDir: OPENCLAW_DIR,
        enabled,
      });
      // Mint/remove the token immediately so the UI can confirm readiness
      // without waiting for the next boot sync.
      const tokenStore = require("../agent-admin/token-store");
      let tokenState = "disabled";
      if (enabled) {
        const { error } = tokenStore.ensureToken({ openclawDir: OPENCLAW_DIR });
        tokenState = error ? "unavailable" : "enabled_pending_artifacts";
      } else {
        tokenStore.removeToken({ openclawDir: OPENCLAW_DIR });
      }
      // Regenerate prompt/skill artifacts so the change reaches the agent's
      // next session (no live reload — see A6).
      try {
        doSyncPromptFiles?.();
      } catch {}
      res.json({ ok: true, changed, config, agentAdmin: { state: tokenState } });
    } catch (err) {
      res.status(500).json({
        ok: false,
        error: err.message || "Could not update AlphaClaw config",
      });
    }
  });

  app.get("/api/alphaclaw/version", wrapAsync(async (req, res) => {
    const refresh = String(req.query.refresh || "") === "1";
    try { res.json(await alphaclawVersionService.getVersionStatus(refresh)); }
    catch (error) { if (!sendIfConfigUnreadable(res, error)) throw error; }
  }));

  app.get("/api/alphaclaw/release-notes", wrapAsync(async (req, res) => {
    const requestedTag = String(req.query.tag || "").trim();
    if (requestedTag && !isValidReleaseTag(requestedTag)) {
      return res.status(400).json({ ok: false, error: "Invalid release tag" });
    }
    const cacheKey = requestedTag || "latest";
    const now = Date.now();
    if (
      kReleaseNotesCache.payload &&
      kReleaseNotesCache.key === cacheKey &&
      now - kReleaseNotesCache.fetchedAt < kReleaseNotesCacheTtlMs
    ) {
      return res.json({ ok: true, ...kReleaseNotesCache.payload });
    }
    try {
      const payload = await fetchGitHubRelease(requestedTag);
      kReleaseNotesCache = {
        key: cacheKey,
        fetchedAt: Date.now(),
        payload,
      };
      return res.json({ ok: true, ...payload });
    } catch (err) {
      const statusCode = Number(err?.statusCode) || 502;
      return res.status(statusCode).json({
        ok: false,
        error: err?.message || "Could not fetch release notes",
      });
    }
  }));

  app.post("/api/alphaclaw/update", wrapAsync(async (req, res) => {
    console.log("[alphaclaw] /api/alphaclaw/update requested");
    let result;
    try { result = await alphaclawVersionService.updateAlphaclaw(); }
    catch (error) { if (sendIfConfigUnreadable(res, error)) return; throw error; }
    console.log(
      `[alphaclaw] /api/alphaclaw/update result: status=${result.status} ok=${result.body?.ok === true}`,
    );
    if (result.status === 200 && result.body?.ok) {
      res.json(result.body);
      if (!result.body?.managedUpdate) {
        setTimeout(() => alphaclawVersionService.restartProcess(), 1000);
      }
    } else {
      res.status(result.status).json(result.body);
    }
  }));

  app.post("/api/alphaclaw/update/:attemptId/resolve", requireAdmin, wrapAsync(async (req, res) => {
    if (req.alphaclawActor?.type === "agent") {
      return res.status(403).json({ ok: false, code: "human_required", error: "A human admin must check the deployment provider." });
    }
    try {
      const result = await alphaclawVersionService.resolveManagedUpdate({
        attemptId: req.params.attemptId, confirmProviderChecked: req.body?.confirmProviderChecked, outcome: req.body?.outcome,
      });
      res.status(result.status).json(result.body);
    } catch (error) { if (!sendIfConfigUnreadable(res, error)) throw error; }
  }));

  // Session-list micro-cache: every uncached hit spawns an OpenClaw CLI
  // process (`clawCmd("sessions ...")` above) and CLI calls serialize on the
  // startup-migration lease on >=2026.9.1 — with the chat sidebar polling
  // this endpoint, N tabs must share ONE spawn per TTL window, not one each.
  let cachedAgentSessions = null;
  let agentSessionsInFlight = null;
  app.get("/api/agent/sessions", wrapAsync(async (req, res) => {
    try {
      if (
        agentSessionsCacheTtlMs > 0 &&
        cachedAgentSessions &&
        Date.now() - cachedAgentSessions.atMs < agentSessionsCacheTtlMs
      ) {
        return res.json({ ok: true, sessions: cachedAgentSessions.sessions });
      }
      if (!agentSessionsInFlight) {
        agentSessionsInFlight = listSendableAgentSessions().finally(() => {
          agentSessionsInFlight = null;
        });
      }
      const sessions = await agentSessionsInFlight;
      // Cache only non-empty lists: an empty result is the transient
      // pre-onboarding state (and would mask a just-created first session).
      if (Array.isArray(sessions) && sessions.length > 0) {
        cachedAgentSessions = { atMs: Date.now(), sessions };
      }
      return res.json({ ok: true, sessions: withStarterSession(sessions) });
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message });
    }
  }));

  app.post("/api/agent/message", wrapAsync(async (req, res) => {
    const rawMessage = String(req.body?.message || "");
    const message = rawMessage.trim();
    const sessionKey = String(req.body?.sessionKey || "").trim();
    if (!message) {
      return res.status(400).json({ ok: false, error: "message is required" });
    }
    if (message.length > 4000) {
      return res
        .status(400)
        .json({ ok: false, error: "message must be 4000 characters or fewer" });
    }
    let command = `agent --agent main --message ${quoteShellArg(message, { strategy: "single" })}`;
    if (sessionKey) {
      let selectedSession = null;
      try {
        const sessions = withStarterSession(await listSendableAgentSessions());
        selectedSession =
          sessions.find((sessionRow) => sessionRow.key === sessionKey) || null;
      } catch (err) {
        return res.status(502).json({ ok: false, error: err.message });
      }
      if (!selectedSession) {
        return res
          .status(400)
          .json({ ok: false, error: "Selected session was not found" });
      }
      // The turn must run under the SELECTED session's agent — the deliver
      // path passes no sessionKey/sessionId, so a hardcoded `main` would run
      // the wrong agent and deliver its answer into another agent's chat
      // (crossing workspace/tool-policy boundaries).
      const sessionAgentId = String(selectedSession.agentId || "").trim() || "main";
      if (sessionAgentId !== "main") {
        command = `agent --agent ${quoteShellArg(sessionAgentId, { strategy: "single" })} --message ${quoteShellArg(message, { strategy: "single" })}`;
      }
      if (selectedSession.replyChannel && selectedSession.replyTo) {
        command +=
          ` --deliver --reply-channel ${quoteShellArg(selectedSession.replyChannel, { strategy: "single" })}` +
          ` --reply-to ${quoteShellArg(selectedSession.replyTo, { strategy: "single" })}`;
        if (selectedSession.replyAccountId) {
          // Account-scoped DM keys (…:<channel>:<account>:direct:<peer>)
          // deliver through that account, not the default one.
          command += ` --reply-account ${quoteShellArg(selectedSession.replyAccountId, { strategy: "single" })}`;
        }
      } else if (selectedSession.sessionId) {
        command += ` --session-id ${quoteShellArg(selectedSession.sessionId, { strategy: "single" })}`;
      }
    }
    const result = await clawCmd(command, { quiet: true });
    if (!result.ok) {
      return res
        .status(502)
        .json({
          ok: false,
          error: result.stderr || "Could not send message to agent",
        });
    }
    return res.json({ ok: true, stdout: result.stdout || "" });
  }));

  app.get("/api/gateway/dashboard", wrapAsync(async (req, res) => {
    // The url field can carry a live credential — keep it out of the browser
    // HTTP cache (Express's default ETag makes the JSON revalidatable).
    res.set("Cache-Control", "no-store");
    if (!isOnboarded()) return res.json({ ok: false, url: "/openclaw" });
    const { token, source } = await dashboardUrl.resolveDashboardToken();
    if (token && source === "config") {
      return res.json({
        ok: true,
        url: dashboardUrl.buildDashboardUrl(token),
        source: "config",
      });
    }
    if (token) {
      // CLI-scraped fallback: deliberately no `source` key — the response
      // shape is pinned by consumers and tests.
      return res.json({
        ok: true,
        url: dashboardUrl.buildDashboardUrl(token),
      });
    }
    res.json({ ok: true, url: "/openclaw", needsAuth: true });
  }));

  // Stop evidence (pids, process descriptions, the CLI's refusal line) is
  // operator material: admins see it in the Watchdog tab, members and the
  // agent actor (redactResponse in admin-manifest/domains/system.js) get
  // the record without it.
  const stripOperatorEvidence = (operation) => {
    if (!operation) return operation;
    const { stopEvidence, timeline, timelineOmitted, ...rest } = operation;
    return rest;
  };

  app.get("/api/restart-status", wrapAsync(async (req, res) => {
    try {
      const snapshot = await restartRequiredState.getSnapshot();
      const isAdmin = req.alphaclawIdentity?.role === "admin";
      const lastOperationRaw =
        typeof restartRequiredState.getLastRestartOperation === "function"
          ? restartRequiredState.getLastRestartOperation()
          : null;
      const lastOperation = isAdmin ? lastOperationRaw : stripOperatorEvidence(lastOperationRaw);
      res.json({
        ok: true,
        restartRequired: snapshot.restartRequired || envRestartPending,
        restartInProgress: snapshot.restartInProgress,
        gatewayRunning: snapshot.gatewayRunning,
        // The banner finally gets to say WHY a restart is required.
        reasons: snapshot.reasons || [],
        activeOperation: snapshot.activeOperation || null,
        lastOperation: lastOperation
          ? (({ evidenceTail, ...rest }) => ({
              ...rest,
              // Evidence precedence: the in-memory copy only when it belongs
              // to THIS operation (stale evidence from a prior operation must
              // never serve under a newer one); otherwise the persisted tail
              // — which survives an AlphaClaw supervisor restart. The raw
              // evidenceTail key is deliberately stripped: `evidence` is the
              // single response contract the UI reads. Empty ⇒ null, not "".
              evidence:
                (lastRestartEvidence?.operationId === lastOperation.operationId
                  ? lastRestartEvidence.redactedTail
                  : evidenceTail) || null,
            }))(lastOperation)
          : null,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  app.post("/api/restart-status/dismiss", wrapAsync(async (req, res) => {
    try {
      envRestartPending = false;
      restartRequiredState.clearRequired();
      const snapshot = await restartRequiredState.getSnapshot();
      res.json({
        ok: true,
        restartRequired: snapshot.restartRequired || envRestartPending,
        restartInProgress: snapshot.restartInProgress,
        gatewayRunning: snapshot.gatewayRunning,
      });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  }));

  // Human step labels — internal step ids never render.
  const kRestartStepLabels = {
    preparing_plugins: "Checking plugins",
    stopping: "Stopping gateway",
    launching: "Starting gateway",
    waiting_ready: "Waiting for health check",
    upgrading_data: "Upgrading OpenClaw data",
    converging: "Re-applying AlphaClaw settings",
    ready: "Ready",
  };

  // The most recent restart failure's redacted evidence, served by reference
  // via /api/restart-status (never embedded in status frames).
  let lastRestartEvidence = null; // { operationId, redactedTail }
  // One active restart or upgrade retry at a time; a second Restart click
  // attaches to a restart, every other combination is refused (409).
  let restartInFlight = null; // { operationId, promise, kind }
  // The operation an operator asked to cut short ("Restart now"): the ladder
  // polls it between ask probes and moves on to SIGTERM (ALPH-17).
  let expediteRequestedFor = null;

  const collectEvidenceSecrets = () =>
    collectSecretValues({
      env: process.env,
      envFileVars: typeof readEnvFile === "function" ? readEnvFile() : [],
      // Tokens written inline in openclaw.json (instead of ${ENV} refs) can
      // be echoed to stderr by the gateway — mask those too.
      configObjects: [
        readOpenclawConfig({
          fsModule: fs,
          openclawDir: OPENCLAW_DIR,
          fallback: {},
        }),
      ],
    });

  // Best-effort defense-in-depth (NOT a guarantee — the 0600 operation file
  // and member-gated route are the other layers). Order matters:
  //   1. byte pre-cap (8x the final cap, so a secret straddling the final cut
  //      is still matched whole; ring lines are individually capped upstream)
  //   2. ANSI/control normalization FIRST — an escape inserted inside a
  //      Bearer/JWT/secret defeats matching; stripping after would reveal it
  //   3. value-match (collected secrets), then token params, then shapes
  //   4. final tail-keeping cap — identical for the in-memory copy and the
  //      persisted record, so evidence doesn't change across a restart.
  const redactEvidenceText = (text) => {
    const preCapped = String(text ?? "").slice(-32768);
    if (!preCapped) return "";
    const normalized = stripControlChars(stripAnsi(preCapped));
    return redactSecretShapes(
      scrubTokenParams(
        redactSecrets(normalized, { secrets: collectEvidenceSecrets() }),
      ),
    ).slice(-4000);
  };

  // stdout FIRST, stderr LAST: both tail-keeping caps preserve the end of the
  // merged text, so stderr (where crash causes usually live) survives when
  // the caps bite. Full rings — the byte caps are the real bound.
  const redactEvidenceTail = (stderrTail, stdoutTail) => {
    const merged = [
      ...(Array.isArray(stdoutTail) ? stdoutTail : []),
      ...(Array.isArray(stderrTail) ? stderrTail : []),
    ];
    if (merged.length === 0) return "";
    return redactEvidenceText(merged.join("\n"));
  };

  // Failure MESSAGES can embed gateway output (a bind error quoting a URL
  // with a token) — they get the same masking as the stderr tail.
  const redactFailureMessage = (message) =>
    redactSecretShapes(
      scrubTokenParams(
        redactSecrets(stripControlChars(stripAnsi(String(message || ""))), {
          secrets: collectEvidenceSecrets(),
        }),
      ),
    );

  // Failure body for the synchronous endpoint: the user sentence in `error`,
  // the technical summary in `detail`, class + hint beside them.
  const restartFailureBody = (err) =>
    err?.restartFailure
      ? {
          code: err.restartFailure.code,
          hint: err.restartFailure.hint,
          error: err.restartFailure.error,
          detail: redactFailureMessage(err.message),
          ...(err.restartFailure.phase ? { phase: err.restartFailure.phase } : {}),
          ...(err.restartFailure.how ? { how: err.restartFailure.how } : {}),
          ...(err.restartFailure.budgetMs ? { budgetMs: err.restartFailure.budgetMs } : {}),
        }
      : { error: redactFailureMessage(err?.message) };

  // The link an operator notification may carry: the CONFIGURED public URL
  // when one exists (env-derived, not spoofable), else the request-derived
  // base — which comes from X-Forwarded-Proto/Host, so a forged header could
  // otherwise plant a phishing host or Markdown delimiters inside an
  // important-class message. The request-derived value is embedded only when
  // it parses as http(s) with a plain hostname (letters/digits/dots/hyphens,
  // optional port) and nothing else; anything else costs the link, never the
  // notification. A localhost default from the resolver is "unconfigured"
  // (team.js inviteUrlFor makes the same call).
  const kNotificationLinkBasePattern = /^https?:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?(?::\d{1,5})?$/;
  const notificationLinkBase = (requestBaseUrl) => {
    let configured = "";
    try {
      configured = String(resolveSetupUrl?.() || "").trim().replace(/\/+$/, "");
    } catch {
      configured = "";
    }
    if (configured && !/^https?:\/\/localhost(:|\/|$)/i.test(configured)) {
      return kNotificationLinkBasePattern.test(configured) ? configured : "";
    }
    const fromRequest = String(requestBaseUrl || "").trim().replace(/\/+$/, "");
    return kNotificationLinkBasePattern.test(fromRequest) ? fromRequest : "";
  };

  // `baseUrl` is the REQUEST-derived setup URL (getBaseUrl(req), resolved by
  // the route handler where `req` exists); the injected getBaseUrl is
  // req-shaped in production and dereferences `req.headers`, so it must never
  // be called from this request-less async tail. Whole body under the catch:
  // a notification failure of any shape is logged, never a rejection that
  // could mask the restart outcome or surface as an unhandled rejection.
  const notifyRestartFailed = async ({ operationId, code, summary, recoveryText = "", baseUrl = "", kind = "restart" }) => {
    if (typeof notify !== "function") return;
    try {
      const base = notificationLinkBase(baseUrl);
      const logsLink = base ? ` - [View logs](${base}/#/watchdog)` : "";
      const message = [
        "🐺 *AlphaClaw Watchdog*",
        `🔴 ${kind === "upgrade" ? "OpenClaw data upgrade retry failed" : "Gateway restart failed"}${logsLink}`,
        summary,
        code === "stop_refused"
          ? "Nothing was stopped: the previous gateway is still running, so the restart-required banner stays up."
          : recoveryText || kRestartFailureCopy[code]?.hint || "Try the restart again; if it keeps failing, open View logs.",
      ].join("\n");
      await notify(message, {
        eventType: "restart_failed",
        id: `restart-failed-${operationId}`,
        operationId,
      });
    } catch (err) {
      console.warn(
        `[alphaclaw] restart-failure notification failed: ${String(err?.message || err)}`,
      );
    }
  };

  const gatewayMutationPolicy = createGatewayMutationPolicy({ lock: gatewayLifecycleLock });
  const readRestartBlocker = (options) => gatewayMutationPolicy.read(options);

  const runRestartOperation = async ({
    operationId,
    baseUrl = "",
    kind = "restart",
    failureKey = null,
    actor = "unknown",
    doctorTimeoutMs = kOpenclawBootMigrationTimeoutMs,
  }) => {
    const restartSource = kind === "upgrade" ? "api:upgrade" : "api:restart";
    const isUpgrade = kind === "upgrade";
    // F4: an upgrade's lease and record are sized once for the whole Doctor
    // (the boot migration's lease); the lock is never renewed, only the
    // record's expiresAt is refreshed from steps and the Doctor heartbeat.
    const operationBudgetMs = isUpgrade ? doctorTimeoutMs + kOpenclawBootMigrationLeaseMarginMs : kGatewayRestartOperationBudgetMs;
    const ledgerKind = isUpgrade ? "openclaw_upgrade" : "gateway_restart";
    // Step details are structured for the card ({ phase, how, graceSeconds,
    // activeWork }); a string detail (legacy warning text) is redacted like a
    // failure message. `at` is the server clock: the card's elapsed timer
    // counts from step timestamps, never from the click.
    let lastPhase = null;
    const emitStep = ({ step, status, budgetMs, detail }) => {
      const at = Date.now();
      const safeDetail =
        detail == null
          ? undefined
          : typeof detail === "string"
            ? redactFailureMessage(detail)
            : Object.fromEntries(
                Object.entries(detail).map(([key, value]) => [
                  key,
                  typeof value === "string" ? redactFailureMessage(value).slice(0, 240) : value,
                ]),
              );
      if (status === "running") {
        lastPhase =
          step === "stopping" && safeDetail?.phase
            ? kHumanPhases[safeDetail.phase] || String(safeDetail.phase)
            : step === "launching" || step === "waiting_ready"
              ? "starting"
              : step === "preparing_plugins"
                ? "preparing"
                : lastPhase;
      }
      operationEvents?.publish(operationId, {
        event: "step",
        data: {
          name: step,
          label: kRestartStepLabels[step] || step,
          status,
          at,
          ...(budgetMs ? { budgetMs } : {}),
          ...(safeDetail !== undefined ? { detail: safeDetail } : {}),
        },
      });
      // Every step lands on the record's timeline (bounded there); only a
      // running step moves lastStep / phaseAt / the keepalive.
      restartRequiredState.updateRestartOperation?.({
        operationId,
        timelineEntry: { at, step, status, ...(safeDetail && typeof safeDetail === "object" ? { detail: safeDetail } : {}) },
        ...(status === "running"
          ? {
              lastStep: step,
              phaseAt: { [step]: at },
              ...(budgetMs ? { budgetMs } : {}),
              // Step-transition keepalive: an actively-progressing operation can
              // never be reaped as "interrupted" under its own feet.
              expiresAt: Date.now() + operationBudgetMs,
            }
          : {}),
      });
    };

    let release = null;
    // The expected-restart window is opened only once the restart really
    // starts; a policy refusal must not "settle" a window it never armed.
    let expectedRestartArmed = false;
    // A failure after the gateway was signalled: handed to the watchdog in
    // `finally`, once the lock is released; the terminal stream event
    // follows the recovery clause it produces.
    let pendingFailure = null;
    let emitTerminalFailure = null;
    // Retry upgrade: the Doctor's writers drain through this operation's
    // cleanup before the lease is released (cancellation included).
    const upgradeOperation = isUpgrade
      ? createRepairOperation({ isCurrent: () => release?.isValid?.() !== false })
      : null;
    let doctor = null; // { doctor: ok|failed, reason, sentence, durationMs, captureState }
    let heldAfterStop = false;
    const afterStop = isUpgrade
      ? async () => {
          const doctorStartedAt = Date.now();
          emitStep({ step: "upgrading_data", status: "running" });
          let result;
          try {
            result = await runDoctorFix({
              operation: upgradeOperation,
              timeoutMs: doctorTimeoutMs,
              source: "retry",
              onProgress: ({ elapsedMs, sinceOutputMs, progress }) =>
                emitStep({
                  step: "upgrading_data",
                  status: "running",
                  detail: { elapsedMs, sinceOutputMs, ...(progress?.words ? { words: progress.words } : {}) },
                }),
            });
          } catch (error) {
            result = {
              ok: false,
              stdout: "",
              stderr: String(error?.message || error),
              code: error?.code || "operation_cancelled",
              ...(error?.code === "operation_timed_out" ? { timedOut: true } : { cancelled: true }),
            };
          }
          const summary = summarizeDoctorResult(result, { secrets: collectEvidenceSecrets() });
          doctor = {
            doctor: summary.status === "ok" ? "ok" : "failed",
            reason: summary.reason || null,
            sentence: summary.status === "ok" ? null : describeDoctorFailure(summary),
            durationMs: Date.now() - doctorStartedAt,
            captureState: summary.captureState || null,
          };
          if (summary.status !== "ok" && summary.class === "deterministic" && failureKey && managedDir) {
            try {
              rememberDoctorFailure({ managedDir, key: failureKey, summary, fsModule: fs });
            } catch (error) {
              console.warn(`[alphaclaw] could not remember the retried doctor --fix failure: ${error.message}`);
            }
          }
          emitStep({
            step: "upgrading_data",
            status: summary.status === "ok" ? "done" : "failed",
            detail: { reason: summary.reason || null },
          });
          if (upgradeOperation.signal.aborted) return {};
          // eng review F1: the same convergence the boot runs after its
          // Doctor, whatever the outcome, then the launch is re-prepared.
          emitStep({ step: "converging", status: "running" });
          const convergence = await convergeAfterDoctor({
            hold: release,
            operation: upgradeOperation,
            shouldContinue: () => !upgradeOperation.signal.aborted && release?.isValid?.() !== false,
          });
          emitStep({ step: "converging", status: convergence?.held ? "failed" : "done" });
          heldAfterStop = convergence?.held === true;
          return {
            reprepare: true,
            holdGateway: heldAfterStop,
            holdReason: convergence?.heldReason || null,
          };
        }
      : null;
    try {
      release =
        gatewayLifecycleLock?.tryAcquire?.(isUpgrade ? "openclaw_upgrade" : "restart", {
          leaseMs: operationBudgetMs,
          ...(upgradeOperation ? { cleanup: upgradeOperation.cleanup } : {}),
        }) || null;
      if (gatewayLifecycleLock && !release) {
        throw Object.assign(new Error("Another gateway operation is in progress."), { blocked: true,
          code: "operation_in_progress", statusCode: 409, hint: "Wait for it to finish, then deliberately retry." });
      }
      const blocker = readRestartBlocker({ hold: release });
      if (blocker) {
        throw Object.assign(new Error(blocker.error), {
          code: blocker.code,
          hint: blocker.hint,
          statusCode: blocker.statusCode,
          blocked: true,
        });
      }
      // Re-anchor the record's lifetime at the moment work actually starts,
      // and open the watchdog suppression window to the same deadline.
      const deadline = Date.now() + operationBudgetMs;
      upgradeOperation?.start(operationBudgetMs, release?.expiresAt ?? Infinity);
      restartRequiredState.updateRestartOperation?.({
        operationId,
        expiresAt: deadline,
      });
      const lease =
        restartRequiredState.getActiveRestartOperation?.()?.expiresAt ||
        deadline;
      // A new user restart supersedes any earlier failed restart's note.
      watchdog?.onExpectedRestart?.({ expiresAt: lease, supersedes: "user" });
      expectedRestartArmed = true;
      const result = await gatewayMutationPolicy.restart({
        hold: release,
        restartGateway,
        options: {
          onStep: emitStep,
          deadlineAt: deadline,
          opId: operationId,
          source: restartSource,
          reason: `actor=${actor}`,
          shouldExpedite: () => expediteRequestedFor === operationId,
          ...(afterStop
            ? { afterStop, shouldAbort: () => upgradeOperation.signal.aborted === true }
            : {}),
        },
      });
      if (result && result.ok === false) {
        // Contract guard: the restart primitive THROWS on every failure
        // (GatewayRestartError / GatewayStopError); a resolved
        // ok:false would otherwise be recorded below as a success — the #54
        // class. Fail loudly instead of trusting it.
        throw new GatewayRestartError(
          `Gateway restart reported failure without throwing${
            result.detail ? ` — ${result.detail}` : ""
          }`,
          result.evidence || {},
        );
      }
      // Reaching here means a NEW gateway is up and ready (every failure
      // throws and leaves envRestartPending set: nothing new is running).
      envRestartPending = false;
      const durationMs = result?.durationMs ?? null;
      const downtimeMs = result?.downtimeMs ?? null;
      const how = result?.how ?? null;
      const stopEvidence = result?.stopEvidence ?? null;
      const upgrade = isUpgrade ? doctor || { doctor: "not_run" } : null;
      const retryTarget = upgrade?.doctor === "failed" ? "upgrade" : null;
      restartRequiredState.completeRestart?.({
        operationId,
        ok: true,
        durationMs,
        downtimeMs,
        how,
        stopEvidence,
        ...(upgrade ? { upgrade, retryTarget } : {}),
      });
      restartRequiredState.markRestartComplete();
      // A verified-ready gateway supersedes a failed boot: without this the
      // reducer's boot_failed gate outranks reality forever and the state's
      // own Retry action can never clear the headline it remediates.
      if (getBootPhase().phase === "failed") setBootPhase("ready");
      invalidateStatusCaches();
      emitStep({ step: "ready", status: "done" });
      // The card's success sentence qualifies a forced stop and names how
      // many non-gateway processes exited; the full evidence is the admin's
      // on /api/restart-status.
      const observedExitsCount =
        (stopEvidence?.observedExits?.helpers ?? 0) +
        (Array.isArray(stopEvidence?.observedExits?.other) ? stopEvidence.observedExits.other.length : 0);
      operationEvents?.complete(operationId, {
        ok: true,
        durationMs,
        downtimeMs,
        ...(how ? { how } : {}),
        ...(stopEvidence ? { observedExitsCount, stillRunningCount: stopEvidence.stillRunning?.length ?? 0 } : {}),
        ...(upgrade ? { upgrade, retryTarget } : {}),
      });
      watchdog?.recordOperationEvent?.({
        kind: ledgerKind,
        status: upgrade?.doctor === "failed" ? "warning" : "ok",
        details: {
          operationId,
          restartSource,
          trigger: "manual",
          durationMs,
          downtimeMs,
          how,
          observedExitsCount,
          ...(upgrade ? { doctor: upgrade.doctor, reason: upgrade.reason } : {}),
        },
      });
      return result;
    } catch (err) {
      if (err?.blocked) {
        // Policy refusal, not a failed restart: the UI needs a terminal event
        // carrying the blocker's code so the card can name the remedy, the
        // record closes not-ok, but the incident ledger books it as SKIPPED —
        // a safety gate doing its job must never read as a gateway failure.
        restartRequiredState.completeRestart?.({
          operationId,
          ok: false,
          errorSummary: err.message,
          code: err.code,
        });
        restartRequiredState.markRestartComplete();
        operationEvents?.fail(
          operationId,
          Object.assign(new Error(err.message), {
            code: err.code,
            hint: err.hint,
          }),
        );
        watchdog?.recordOperationEvent?.({
          kind: ledgerKind,
          status: "skipped",
          details: { operationId, restartSource, trigger: "manual", reason: err.code },
        });
        throw err;
      }
      const failure = classifyRestartFailure(err);
      if (failure.code === "stop_failed") failure.error = describeStopFailed(err?.evidence);
      const redactedTail = redactEvidenceTail(
        err?.evidence?.stderrTail,
        err?.evidence?.stdoutTail,
      );
      lastRestartEvidence = redactedTail ? { operationId, redactedTail } : null;
      const safeMessage = redactFailureMessage(err.message);
      const signalled = err?.evidence?.signalled === true;
      const stopEvidence = err?.evidence?.stopEvidence ?? null;
      const failedPhase =
        kHumanPhases[err?.evidence?.phase] || lastPhase || (failure.code.startsWith("stop") ? "stopping" : "starting");
      // The record keeps the technical summary (what gateway.js said plus
      // the last error-shaped gateway line); the user-facing `error` the card
      // renders is the fixed sentence for the failure class, with the cause
      // line appended only where it is the whole point (OpenClaw failed to
      // start). Composition guarantees the cause survives the length cap.
      const causeLine = pickCauseLine(redactedTail);
      const errorSummary = causeLine
        ? `${safeMessage.slice(0, 150)} — last gateway error: ${causeLine.slice(0, 240)}`
        : safeMessage.slice(0, 400);
      const upgrade = isUpgrade ? doctor || { doctor: "not_run" } : null;
      const retryTarget = upgrade ? (upgrade.doctor === "ok" ? "restart" : "upgrade") : null;
      const baseError = upgrade
        ? describeUpgradeRetryFailure({ code: failure.code, doctor: upgrade, held: heldAfterStop, fallback: failure.error })
        : failure.error;
      const userError =
        failure.code === "launch_failed" && causeLine && !heldAfterStop
          ? `${baseError} ${causeLine.slice(0, 240)}`
          : baseError;
      const how = err?.evidence?.how ?? null;
      const budgetMs = err?.evidence?.budgetMs ?? null;
      // The record closes `failed` SYNCHRONOUSLY here, before the lock is
      // released: no probe can see "ready" against a record that still says
      // running. The recovery clause is learned in `finally`.
      restartRequiredState.completeRestart?.({
        operationId,
        ok: false,
        errorSummary,
        code: failure.code,
        hint: failure.hint,
        how,
        budgetMs,
        evidenceTail: redactedTail || null,
        stopEvidence,
        failedPhase,
        ...(upgrade ? { upgrade, retryTarget } : {}),
      });
      restartRequiredState.markRestartComplete();
      // The terminal stream event is sent from `finally`, AFTER the recovery
      // event: `error` closes the client's stream, so the recovery clause
      // must precede it.
      emitTerminalFailure = () =>
        operationEvents?.fail(
          operationId,
          Object.assign(new Error(userError), {
            code: failure.code,
            hint: failure.hint,
            phase: failedPhase,
            ...(budgetMs ? { budgetMs } : {}),
            ...(how ? { how } : {}),
            ...(upgrade ? { upgrade, retryTarget } : {}),
          }),
        );
      watchdog?.recordOperationEvent?.({
        kind: ledgerKind,
        status: "failed",
        details: { operationId, restartSource, trigger: "manual", error: errorSummary, code: failure.code, phase: failedPhase, signalled },
      });
      // A stop that happened (signalled) hands the aftermath to the watchdog
      // in `finally`, after the lock is released; a refusal or a pre-stop
      // abort left the old gateway serving and needs no recovery story.
      if (signalled || failure.code === "launch_failed" || failure.code === "ready_timeout") {
        pendingFailure = {
          operationId,
          code: failure.code,
          phase: failedPhase,
          signalled,
          gatewayDown: failure.code !== "ready_timeout",
          summary: userError,
          kind,
        };
      } else if (failure.code !== "aborted") {
        void notifyRestartFailed({ operationId, code: failure.code, summary: userError, baseUrl, kind });
      }
      // The synchronous endpoint and joiners render the same envelope the
      // SSE stream carried.
      err.restartFailure = { code: failure.code, error: userError, hint: failure.hint, how, budgetMs, phase: failedPhase };
      throw err;
    } finally {
      // Every Doctor writer and restore guard drains before a successor can
      // take the lifecycle lock.
      if (upgradeOperation) {
        try {
          await upgradeOperation.cleanup.wait();
        } catch {}
      }
      release?.();
      // Close the watchdog's expected-restart window NOW — success or
      // failure, the operation is over; a failed restart must degrade
      // detection-fast, not sit suppressed until the lease expires.
      if (expectedRestartArmed) watchdog?.onExpectedRestartSettled?.();
      // Handoff (bug #137 D): with the lock released and the window
      // settled, the watchdog takes the failure note, previews its repair
      // admission (pure) and starts its repair-eligible rechecks; the
      // record, the card and the notification get the resulting clause.
      if (pendingFailure) handRestartFailureToWatchdog(pendingFailure, baseUrl);
      emitTerminalFailure?.();
    }
  };

  const handRestartFailureToWatchdog = ({ operationId, code, phase, signalled, gatewayDown, summary, kind = "restart" }, baseUrl) => {
    let admission = null;
    try {
      const noted = watchdog?.noteRestartFailure?.({ operationId, code, phase, signalled, gatewayDown });
      admission = noted?.admission ?? null;
    } catch (err) {
      console.warn(`[alphaclaw] restart failure note failed: ${String(err?.message || err)}`);
    }
    const recovery = code === "ready_timeout"
      ? { status: "watching", reason: null, text: kRestartFailureCopy.ready_timeout.hint }
      : describeRecovery(admission);
    try {
      restartRequiredState.patchRestartOperation?.({ operationId, recovery: { status: recovery.status, reason: recovery.reason } });
    } catch {}
    operationEvents?.publish(operationId, {
      event: "recovery",
      data: { status: recovery.status, reason: recovery.reason, text: recovery.text, at: Date.now() },
    });
    // Never awaited: an outbox-unavailable direct send blocks on channel I/O.
    if (code !== "aborted") {
      void notifyRestartFailed({ operationId, code, summary, recoveryText: recovery.text, baseUrl, kind });
    }
  };

  app.post("/api/gateway/restart", wrapAsync(async (req, res) => {
    if (!isOnboarded()) {
      return res.status(400).json({ ok: false, error: "Not onboarded" });
    }
    const wantsAsync = String(req.query.async || "") === "1";
    // Attach semantics first: a second click (or second tab) joins the active
    // restart instead of starting a competing one.
    if (restartInFlight?.kind === "upgrade") {
      return res.status(409).json({
        ok: false,
        code: "operation_in_progress",
        error: "OpenClaw's data upgrade is running.",
        hint: "Wait for it to finish; the gateway restarts as part of it.",
        activeOperation: { operationId: restartInFlight.operationId, kind: "openclaw_upgrade" },
        nextActions: ["observe_operation"],
      });
    }
    if (restartInFlight) {
      const { operationId, promise } = restartInFlight;
      if (wantsAsync) {
        return res.status(202).json({ ok: true, attached: true, operationId });
      }
      try {
        await promise;
        const snapshot = await restartRequiredState.getSnapshot();
        return res.json({
          ok: true,
          attached: true,
          operationId,
          restartRequired: snapshot.restartRequired,
        });
      } catch (err) {
        // A joiner sees the same outcome shape as the initiator: a post-lock
        // policy refusal carries its 409 + code + hint, everything else 500.
        const blocked = err?.blocked === true;
        return res.status(blocked ? err.statusCode || 409 : 500).json({
          ok: false,
          attached: true,
          operationId,
          ...(blocked ? { code: err.code, hint: err.hint, error: err.message } : restartFailureBody(err)),
        });
      }
    }

    // Fast gate (no record yet): the same policy runs again once the
    // lifecycle lock is held.
    const blocker = readRestartBlocker({ preLock: true });
    const watchdogStatus = watchdog?.getStatus?.();
    if (blocker?.code !== "booting" &&
        (gatewayLifecycleLock?.getActiveOperation?.() || watchdogStatus?.replacementPending ||
          watchdogStatus?.recoveryPending || watchdogStatus?.operationInProgress)) {
      return res.status(409).json({ ok: false, code: "operation_in_progress",
        error: "Another gateway operation or relaunch is in progress.",
        hint: "View its progress, wait for it to finish, then deliberately retry.", nextActions: ["observe_operation"] });
    }
    if (blocker) {
      return res.status(blocker.statusCode).json({
        ok: false,
        code: blocker.code,
        error: blocker.error,
        hint: blocker.hint,
      });
    }

    restartRequiredState.markRestartInProgress();
    const begin =
      typeof restartRequiredState.beginRestart === "function"
        ? restartRequiredState.beginRestart()
        : { operationId: null };
    const operationId = begin.operationId;
    operationEvents?.createOperation({ type: "gateway_restart", operationId });

    // The setup URL for the failure notification's "View logs" link is
    // resolved HERE, where the request exists (getBaseUrl is req-shaped);
    // a resolver failure costs the link, never the notification or the
    // restart outcome.
    const baseUrl = (() => {
      try {
        return typeof getBaseUrl === "function" ? String(getBaseUrl(req) || "") : "";
      } catch {
        return "";
      }
    })();
    const promise = runRestartOperation({ operationId, baseUrl, actor: describeActor(req) });
    restartInFlight = { operationId, promise, kind: "restart" };
    const clearInFlight = () => {
      if (restartInFlight?.promise === promise) restartInFlight = null;
    };
    promise.then(clearInFlight, clearInFlight);

    if (wantsAsync) {
      return res.status(202).json({ ok: true, operationId });
    }
    try {
      await promise;
      const snapshot = await restartRequiredState.getSnapshot();
      res.json({
        ok: true,
        operationId,
        restartRequired: snapshot.restartRequired,
      });
    } catch (err) {
      // A post-lock policy refusal carries its own status (409), code and
      // hint so the synchronous caller sees the same shape as the fast gate;
      // any other error stays a 500 (no statusCode passthrough from arbitrary
      // upstream errors).
      const blocked = err?.blocked === true;
      res.status(blocked ? err.statusCode || 409 : 500).json({
        ok: false,
        operationId,
        ...(blocked ? { code: err.code, hint: err.hint, error: err.message } : restartFailureBody(err)),
        evidence:
          lastRestartEvidence?.operationId === operationId
            ? lastRestartEvidence.redactedTail
            : undefined,
      });
    }
  }));

  // "Restart now": a routine restart lets OpenClaw finish its active work for
  // up to ALPHACLAW_GATEWAY_RESTART_GRACE_SECONDS; the operator can cut that
  // drain short. Only the operation that is running can be expedited, and it
  // only changes the ask phase: an expedite that lands after the ask is a
  // harmless no-op. Human-only (the agent must not cut its own turns short).
  app.post("/api/gateway/restart/expedite", (req, res) => {
    const operationId = String(req.body?.operationId || "");
    if (!restartInFlight || !operationId || restartInFlight.operationId !== operationId) {
      return res.status(409).json({
        ok: false,
        code: "no_matching_restart",
        error: "That restart is no longer running.",
      });
    }
    expediteRequestedFor = operationId;
    console.log(formatRestartLogLine(operationId, "expedite", { requested: true, actor: describeActor(req) }));
    return res.json({ ok: true, operationId });
  });

  // Retry upgrade: stop the gateway, run doctor --fix with it down, re-apply
  // AlphaClaw's settings exactly like a boot, relaunch. Admin + dangerous
  // tier; async only (202 + the operation stream). Busy is a 409 — never
  // queued, never attached.
  app.post("/api/openclaw/boot-migration/retry", requireAdmin, wrapAsync(async (req, res) => {
    if (!isOnboarded()) {
      return res.status(400).json({ ok: false, error: "Not onboarded" });
    }
    if (typeof runDoctorFix !== "function" || typeof convergeAfterDoctor !== "function" || !managedDir) {
      return res.status(503).json({ ok: false, code: "unavailable", error: "Retry upgrade isn't available on this server." });
    }
    const busy = (activeOperation) =>
      res.status(409).json({
        ok: false,
        code: "operation_in_progress",
        error: `${kOperationBadgeLabels[activeOperation?.kind] || "Another gateway operation"} is in progress.`,
        hint: "Wait for it to finish, then retry the upgrade.",
        activeOperation: activeOperation || null,
        nextActions: ["observe_operation"],
      });
    if (restartInFlight) {
      return busy({
        operationId: restartInFlight.operationId,
        kind: restartInFlight.kind === "upgrade" ? "openclaw_upgrade" : "restart",
      });
    }
    const blocker = readRestartBlocker({ preLock: true });
    const lockActive = gatewayLifecycleLock?.getActiveOperation?.() || null;
    const watchdogStatus = watchdog?.getStatus?.();
    if (blocker?.code !== "booting" &&
        (lockActive || watchdogStatus?.replacementPending || watchdogStatus?.recoveryPending || watchdogStatus?.operationInProgress)) {
      return busy(lockActive ? { kind: lockActive.kind } : { kind: "repair" });
    }
    if (blocker) {
      return res.status(blocker.statusCode).json({ ok: false, code: blocker.code, error: blocker.error, hint: blocker.hint });
    }
    const installedVersion = getInstalledOpenclawVersion() || null;
    const failureKey = installedVersion
      ? buildFailureKey({ openclawDir: OPENCLAW_DIR, installedVersion, alphaclawVersion, fsModule: fs })
      : null;
    const eligibility = readRetryEligibility({
      record: readMigrationRecord({ managedDir, fsModule: fs }),
      installedVersion,
      currentKey: failureKey,
      confirmUnchanged: req.body?.confirmUnchanged === true,
    });
    if (!eligibility.ok) {
      const { ok, ...refusal } = eligibility;
      return res.status(409).json({ ok: false, ...refusal });
    }
    restartRequiredState.markRestartInProgress();
    let doctorTimeoutMs = kOpenclawBootMigrationTimeoutMs;
    try {
      doctorTimeoutMs = resolveDoctorTimeoutMs(kOpenclawBootMigrationTimeoutMs) ?? kOpenclawBootMigrationTimeoutMs;
    } catch {}
    const begin =
      typeof restartRequiredState.beginRestart === "function"
        ? restartRequiredState.beginRestart({
            kind: "openclaw_upgrade",
            budgetMs: doctorTimeoutMs + kOpenclawBootMigrationLeaseMarginMs,
          })
        : { operationId: null };
    const operationId = begin.operationId;
    operationEvents?.createOperation({ type: "openclaw_upgrade", operationId });
    const baseUrl = (() => {
      try {
        return typeof getBaseUrl === "function" ? String(getBaseUrl(req) || "") : "";
      } catch {
        return "";
      }
    })();
    const promise = runRestartOperation({
      operationId,
      baseUrl,
      kind: "upgrade",
      failureKey,
      actor: describeActor(req),
      doctorTimeoutMs,
    });
    restartInFlight = { operationId, promise, kind: "upgrade" };
    const clearInFlight = () => {
      if (restartInFlight?.promise === promise) restartInFlight = null;
    };
    promise.then(clearInFlight, clearInFlight);
    res.status(202).json({ ok: true, operationId, kind: "openclaw_upgrade" });
  }));
};

module.exports = { registerSystemRoutes, kOperationBadgeLabels };

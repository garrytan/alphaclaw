const { buildManagedPaths } = require("../internal-files-migration");
const { readOpenclawConfig } = require("../openclaw-config");
const { createDashboardUrlService } = require("../gateway-dashboard-url");
const { shouldSkipSystemCronInstall } = require("../../cli/git-runtime");
const { buildSystemCronFile, isSafeCronSchedule } = require("../../cli/system-cron");
const { kRootDir } = require("../constants");
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
const {
  reduceGatewayState,
  createGatewayStateTracker,
} = require("../gateway-state");
const { getBootPhase, setBootPhase } = require("../boot-phase");
const { wrapAsync } = require("../utils/wrap-async");
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
const { kGatewayRestartOperationBudgetMs } = require("../constants");
const { isStateDbQuiet } = require("../state-db-quiet");
// The restart primitive's failure classes. GatewayIncumbentRestartError is
// THROWN by gateway.js's cold restart when "ready" came from the old gateway;
// runRestartOperation catches it by instanceof (one class, defined where it is
// thrown — every restartGateway() caller sees the same throw contract).
const {
  GatewayRestartError,
  GatewayIncumbentRestartError,
  kGatewayIncumbentRestartReason,
} = require("../gateway");

// Stale-while-revalidate cache for small-but-synchronous status readers
// (config/credential file reads). Seeds synchronously on first use, then
// serves the cached value and refreshes off the request tick, so the 2s SSE
// loop never runs sync FS work inline. (Upstream v0.9.36 design.)
//
// `shouldRefresh` (optional) is consulted before every background refresh:
// when it returns false the stale value keeps being served and no compute
// runs — the seam the state-DB quiet period uses to keep status readers off
// the db while a backup snapshots it. The first read still seeds.
const createSwrCache = (compute, ttlMs, { shouldRefresh = null } = {}) => {
  const cache = { value: undefined, fetchedAt: 0, seeded: false, refreshing: false };
  const refreshAllowed = () => typeof shouldRefresh !== "function" || shouldRefresh() !== false;
  const read = () => {
    const now = Date.now();
    if (!cache.seeded) {
      cache.value = compute();
      cache.fetchedAt = now;
      cache.seeded = true;
      return cache.value;
    }
    if (now - cache.fetchedAt >= ttlMs && !cache.refreshing && refreshAllowed()) {
      cache.refreshing = true;
      setImmediate(() => {
        try {
          cache.value = compute();
          cache.fetchedAt = Date.now();
        } catch {
          // keep stale value
        } finally {
          cache.refreshing = false;
        }
      });
    }
    return cache.value;
  };
  // Mutations that change what the cache reflects (env save, gateway
  // restart) invalidate so the next status read recomputes immediately.
  read.invalidate = () => {
    cache.seeded = false;
    cache.fetchedAt = 0;
  };
  return read;
};

// Operation-badge labels by lifecycle-lock kind (boot is expressed through
// bootPhase, not the badge).
const kOperationBadgeLabels = {
  restart: "Restarting gateway",
  repair: "Repairing",
  apply: "Applying update",
  rollback: "Rolling back",
};
const https = require("https");

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
  kAlphaclawGithubReleasesBaseUrl,
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
  openclawChannelService = null,
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
  // Operator notifications (upgradeNotifier.notify shape). Optional: the
  // incumbent-restart outcome below is important-class (never verbose) — a
  // restart that silently did not take effect is exactly what an operator
  // must hear about.
  notify = null,
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
  const kDefaultSystemCronSchedule = "0 * * * *";
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
  const shellEscapeArg = (value) => {
    const safeValue = String(value || "");
    return `'${safeValue.replace(/'/g, `'\\''`)}'`;
  };
  // Shared with the Doctor fix dispatch's session validation — see
  // lib/server/utils/agent-session-lookup.js.
  const {
    kSessionsListCommand,
    parseJsonFromStdout,
    getRawSessionKey,
    getRawSessionsFromPayload,
  } = require("../utils/agent-session-lookup");
  const toTitleWords = (value) =>
    String(value || "")
      .trim()
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
  const getDefaultAgentLabel = (config = {}) => {
    return "Main Agent";
  };
  const getFallbackAgentLabel = (agentId = "") => {
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) return "Agent";
    const titledAgentId = toTitleWords(normalizedAgentId) || normalizedAgentId;
    return `${titledAgentId} Agent`;
  };
  const getConfiguredAgentLabel = (config = {}, agentId = "") => {
    const normalizedAgentId = String(agentId || "").trim();
    if (!normalizedAgentId) return "Agent";
    const configuredAgents = Array.isArray(config?.agents?.list)
      ? config.agents.list
      : [];
    const configuredAgent = configuredAgents.find(
      (entry) => String(entry?.id || "").trim() === normalizedAgentId,
    );
    const configuredName =
      String(configuredAgent?.name || "").trim() ||
      String(configuredAgent?.identity?.name || "").trim();
    if (configuredName) return configuredName;
    if (normalizedAgentId === "main") return getDefaultAgentLabel(config);
    return getFallbackAgentLabel(normalizedAgentId);
  };
  const getAgentLabelFromSessionKey = (key = "", config = {}) => {
    const match = String(key || "").match(/^agent:([^:]+):/);
    const agentId = String(match?.[1] || "").trim();
    if (!agentId) return "Agent";
    return getConfiguredAgentLabel(config, agentId);
  };
  const parseChannelFromSessionKey = (key = "") => {
    const k = String(key || "");
    if (k.includes(":telegram:")) return "telegram";
    if (k.includes(":discord:")) return "discord";
    if (k.includes(":slack:")) return "slack";
    if (k.includes(":whatsapp:")) return "whatsapp";
    return "";
  };
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
          `[alphaclaw] Ignoring invalid stored sync-cron schedule ${JSON.stringify(rawSchedule)}; using the default (${kDefaultSystemCronSchedule})`,
        );
      }
      return {
        enabled,
        schedule: valid ? rawSchedule : kDefaultSystemCronSchedule,
        ...(rawSchedule && !valid
          ? { scheduleFallback: true, invalidStoredSchedule: rawSchedule }
          : {}),
      };
    } catch {
      return { enabled: true, schedule: kDefaultSystemCronSchedule };
    }
  };
  const getSystemCronStatus = () => {
    const config = readSystemCronConfig();
    return {
      enabled: config.enabled,
      schedule: config.schedule,
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
      return res.status(400).json({
        ok: false,
        error: `Reserved environment variables cannot be edited: ${blockedKeys.join(", ")}`,
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
  // The channel-status reader opens the state db (pairing counts): while the
  // state-DB quiet period holds, keep serving the last-known value instead
  // of contending with the backup.
  const getChannelStatusCached = createSwrCache(() => getChannelStatus(), kStatusReaderTtlMs, {
    shouldRefresh: () => !isStateDbQuiet(),
  });
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
  const buildMachineSummaryCached = createSwrCache(
    () => buildMachineSummary(),
    kStatusReaderTtlMs,
  );
  const invalidateStatusCaches = () => {
    getChannelStatusCached.invalidate();
    getSystemCronStatusCached.invalidate();
    readAlphaclawConfigCached.invalidate();
    buildMachineSummaryCached.invalidate();
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
      alphaclawVersion,
      alphaclaw: readAlphaclawConfigCached(),
      // Both underlying reads are mtime-cached (config + token file), so this
      // stays event-loop-cheap inside the 2s status snapshot.
      agentAdmin: buildAgentAdminStatus(),
      openclawChannel: buildOpenclawChannelSummary(),
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

  function buildOpenclawChannelSummary() {
    try {
      const info = openclawChannelService?.getChannelInfo?.();
      if (!info) return null;
      return {
        releaseChannel: info.releaseChannel,
        installedVersion: info.installedVersion,
        pinVersion: info.pinVersion,
        appliedId: info.appliedId,
        appliedVersion: info.appliedVersion ?? null,
        isPin: info.isPin,
        // "running <applied> over the declared pin — expected" (computed once
        // in getChannelInfo; consumers can render expected divergence without
        // re-deriving it, and anomalies never read as expected).
        pinDiverged: Boolean(info.pinDiverged),
        acceptedAt: info.acceptedAt,
        inStabilizationWindow: info.inStabilizationWindow,
        applyInProgress: Boolean(openclawChannelService?.isApplyInProgress?.()),
        // Issue #20: the restart-handoff verdict banner must not show green
        // "activation verified" while the reconciler is holding the gateway.
        gatewayHold: info.gatewayHold || null,
      };
    } catch {
      return null;
    }
  }

  // Frames must stay small: the doctor's full run payload includes the whole
  // workspace manifest and raw result, which nothing client-side reads.
  const slimDoctorStatus = (doctorStatus) => {
    if (!doctorStatus || typeof doctorStatus !== "object") {
      return doctorStatus ?? null;
    }
    const { latestRun, bootstrapContext, ...rest } = doctorStatus;
    const slim = { ...rest };
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
      label: kOperationBadgeLabels[active.kind] || "Working…",
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
      // The unified, user-facing gateway state — derived from the same inputs
      // the legacy fields project from, so old and new can never disagree.
      status.state = gatewayStateTracker.track(
        reduceGatewayState({
          configExists: status.configExists,
          tcp,
          watchdog: watchdogStatus,
          operation: activeOperationBadge(),
          bootPhase: status.bootPhase,
          inStabilizationWindow:
            status.openclawChannel?.inStabilizationWindow === true,
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

  app.get("/api/status", wrapAsync(async (req, res) => {
    try {
      const payload = await statusSnapshot.getSnapshotPayload();
      // Staleness markers ride on the wrapper; the REST projection must keep
      // them or a persistently failing compute serves stale state as fresh.
      res.json(
        payload.snapshotStale
          ? {
              ...payload.status,
              snapshotStale: true,
              snapshotErrorCount: payload.snapshotErrorCount,
              timestamp: payload.timestamp,
            }
          : payload.status,
      );
    } catch (err) {
      // Express 4 does not forward async rejections; without this an early
      // failure here kills the whole process.
      res
        .status(500)
        .json({ ok: false, error: err?.message || "status unavailable" });
    }
  }));

  app.get("/api/events/status", async (req, res) => {
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
  });

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

  app.put("/api/alphaclaw/config/features/openai-compat-api", async (req, res) => {
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
  });

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

  app.get("/api/alphaclaw/version", async (req, res) => {
    const refresh = String(req.query.refresh || "") === "1";
    const status = await alphaclawVersionService.getVersionStatus(refresh);
    res.json(status);
  });

  app.get("/api/alphaclaw/release-notes", async (req, res) => {
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
  });

  app.post("/api/alphaclaw/update", async (req, res) => {
    if (openclawChannelService?.isApplyInProgress?.()) {
      // A restartProcess() mid-overlay-write would corrupt the store.
      return res.status(409).json({
        ok: false,
        error:
          "An OpenClaw version change is in progress — retry after it finishes.",
      });
    }
    console.log("[alphaclaw] /api/alphaclaw/update requested");
    const result = await alphaclawVersionService.updateAlphaclaw();
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
  });

  // Session-list micro-cache: every uncached hit spawns an OpenClaw CLI
  // process (`clawCmd("sessions ...")` above) and CLI calls serialize on the
  // startup-migration lease on >=2026.9.1 — with the chat sidebar polling
  // this endpoint, N tabs must share ONE spawn per TTL window, not one each.
  let cachedAgentSessions = null;
  let agentSessionsInFlight = null;
  app.get("/api/agent/sessions", async (req, res) => {
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
      return res.json({ ok: true, sessions });
    } catch (err) {
      return res.status(502).json({ ok: false, error: err.message });
    }
  });

  app.post("/api/agent/message", async (req, res) => {
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
    let command = `agent --agent main --message ${shellEscapeArg(message)}`;
    if (sessionKey) {
      let selectedSession = null;
      try {
        const sessions = await listSendableAgentSessions();
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
        command = `agent --agent ${shellEscapeArg(sessionAgentId)} --message ${shellEscapeArg(message)}`;
      }
      if (selectedSession.replyChannel && selectedSession.replyTo) {
        command +=
          ` --deliver --reply-channel ${shellEscapeArg(selectedSession.replyChannel)}` +
          ` --reply-to ${shellEscapeArg(selectedSession.replyTo)}`;
        if (selectedSession.replyAccountId) {
          // Account-scoped DM keys (…:<channel>:<account>:direct:<peer>)
          // deliver through that account, not the default one.
          command += ` --reply-account ${shellEscapeArg(selectedSession.replyAccountId)}`;
        }
      } else if (selectedSession.sessionId) {
        command += ` --session-id ${shellEscapeArg(selectedSession.sessionId)}`;
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
  });

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

  app.get("/api/restart-status", async (req, res) => {
    try {
      const snapshot = await restartRequiredState.getSnapshot();
      const lastOperation =
        typeof restartRequiredState.getLastRestartOperation === "function"
          ? restartRequiredState.getLastRestartOperation()
          : null;
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
  });

  app.post("/api/restart-status/dismiss", async (req, res) => {
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
  });

  // Human step labels — internal step ids never render.
  const kRestartStepLabels = {
    preparing_plugins: "Checking plugins",
    stopping: "Stopping gateway",
    launching: "Starting gateway",
    waiting_ready: "Waiting for health check",
    ready: "Ready",
  };

  // The most recent restart failure's redacted evidence, served by reference
  // via /api/restart-status (never embedded in status frames).
  let lastRestartEvidence = null; // { operationId, redactedTail }
  // One active restart at a time; concurrent requests attach to it.
  let restartInFlight = null; // { operationId, promise }

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

  // A restart whose "ready" came from the OLD gateway (stop refused/ignored,
  // port never released, pre-restart pids still alive — gateway.js
  // assessRestartIncumbent) is a failure with its own reason: the env/config
  // the operator restarted for is NOT live, so the restart-required banner
  // must stay up and the operator must be told. gateway.js THROWS
  // GatewayIncumbentRestartError for it (imported above); this route adds the
  // operation record, ledger events, and the important-class notification.
  const kIncumbentRestartReason = kGatewayIncumbentRestartReason;

  const incumbentEvidenceSummary = (evidence) => ({
    wasRunningBefore: evidence?.wasRunningBefore ?? null,
    stopConfirmed: evidence?.stopConfirmed ?? null,
    cliRefused: evidence?.cliRefused ?? null,
    cliExitCode: evidence?.cliExitCode ?? null,
    cliForced: evidence?.cliForced ?? null,
    managedChildPid: evidence?.managedChildPid ?? null,
    preStopPids: Array.isArray(evidence?.preStopPids) ? evidence.preStopPids : [],
    postReadyPids: Array.isArray(evidence?.postReadyPids) ? evidence.postReadyPids : [],
    newPids: Array.isArray(evidence?.newPids) ? evidence.newPids : [],
    survivingPids: Array.isArray(evidence?.survivingPids) ? evidence.survivingPids : [],
    supervisorPid: evidence?.supervisorPid ?? null,
  });

  const notifyIncumbentRestart = async ({ operationId, errorSummary, evidence }) => {
    if (typeof notify !== "function") return;
    const base = typeof getBaseUrl === "function" ? String(getBaseUrl() || "") : "";
    const logsLink = base ? ` - [View logs](${base}/#/watchdog)` : "";
    const message = [
      "🐺 *AlphaClaw Watchdog*",
      `🔴 Gateway restart did not take effect${logsLink}`,
      `Reason: \`${kIncumbentRestartReason}\``,
      `Detail: ${errorSummary}`,
      evidence?.cliRefused
        ? "The OpenClaw CLI refused the non-interactive `gateway stop`; the previous gateway kept the port. The restart-required banner stays up — retry, or stop the gateway manually."
        : "The previous gateway kept the port through the restart. The restart-required banner stays up — retry, or stop the gateway manually.",
    ].join("\n");
    try {
      await notify(message, {
        eventType: "restart_incumbent",
        id: `restart-incumbent-${operationId}`,
        operationId,
      });
    } catch (err) {
      console.warn(
        `[alphaclaw] incumbent-restart notification failed: ${String(err?.message || err)}`,
      );
    }
  };

  const runRestartOperation = async ({ operationId }) => {
    const emitStep = ({ step, status, budgetMs, detail }) => {
      operationEvents?.publish(operationId, {
        event: "step",
        data: {
          name: step,
          label: kRestartStepLabels[step] || step,
          status,
          ...(budgetMs ? { budgetMs } : {}),
          ...(detail ? { detail: redactFailureMessage(detail) } : {}),
        },
      });
      if (status === "running") {
        restartRequiredState.updateRestartOperation?.({
          operationId,
          lastStep: step,
          // Step-transition keepalive: an actively-progressing operation can
          // never be reaped as "interrupted" under its own feet.
          expiresAt: Date.now() + kGatewayRestartOperationBudgetMs,
        });
      }
    };

    // Queue keepalive: the record's expiry only exists to catch DEAD owners.
    // While this process is alive and waiting for the lifecycle lock (which
    // can queue behind apply/boot holds of arbitrary length), keep refreshing
    // the record so /api/restart-status polls never close it as interrupted
    // — that silently drops the eventual failure's errorSummary + evidence.
    const queueKeepalive = setInterval(() => {
      restartRequiredState.updateRestartOperation?.({
        operationId,
        expiresAt: Date.now() + kGatewayRestartOperationBudgetMs,
      });
    }, 60_000);
    if (typeof queueKeepalive.unref === "function") queueKeepalive.unref();
    let release = null;
    try {
      // Restart-class holds get the operation budget as their lease: the
      // configured ready wait must never outlive the lock that serializes it
      // (a force-released lock mid-cold-start = two competing launches).
      release = gatewayLifecycleLock
        ? await gatewayLifecycleLock.acquire("restart", {
            leaseMs: kGatewayRestartOperationBudgetMs,
          })
        : null;
    } finally {
      clearInterval(queueKeepalive);
    }
    try {
      // Re-anchor the record's lifetime at the moment work actually starts,
      // and open the watchdog suppression window to the same deadline.
      const deadline = Date.now() + kGatewayRestartOperationBudgetMs;
      restartRequiredState.updateRestartOperation?.({
        operationId,
        expiresAt: deadline,
      });
      const lease =
        restartRequiredState.getActiveRestartOperation?.()?.expiresAt ||
        deadline;
      watchdog?.onExpectedRestart?.({ expiresAt: lease });
      const result = await restartGateway({ onStep: emitStep });
      if (result && result.ok === false) {
        // Contract guard: the restart primitive THROWS on every failure
        // (GatewayRestartError / GatewayIncumbentRestartError); a resolved
        // ok:false would otherwise be recorded below as a success — the #54
        // class. Fail loudly instead of trusting it.
        throw new GatewayRestartError(
          `Gateway restart reported failure without throwing${
            result.detail ? ` — ${result.detail}` : ""
          }`,
          result.evidence || {},
        );
      }
      // Reaching here means a NEW gateway is up (the incumbent verdict throws
      // and leaves envRestartPending set: nothing new is running).
      envRestartPending = false;
      const durationMs = result?.durationMs ?? null;
      const downtimeMs = result?.downtimeMs ?? null;
      restartRequiredState.completeRestart?.({
        operationId,
        ok: true,
        durationMs,
        downtimeMs,
      });
      restartRequiredState.markRestartComplete();
      // A verified-ready gateway supersedes a failed boot: without this the
      // reducer's boot_failed gate outranks reality forever and the state's
      // own Retry action can never clear the headline it remediates.
      if (getBootPhase().phase === "failed") setBootPhase("ready");
      invalidateStatusCaches();
      emitStep({ step: "ready", status: "done" });
      operationEvents?.complete(operationId, {
        ok: true,
        durationMs,
        downtimeMs,
      });
      watchdog?.recordOperationEvent?.({
        kind: "gateway_restart",
        status: "ok",
        details: { operationId, trigger: "manual", durationMs, downtimeMs },
      });
      return result;
    } catch (err) {
      const incumbent = err instanceof GatewayIncumbentRestartError;
      const incumbentEvidence = incumbent
        ? incumbentEvidenceSummary(err.evidence)
        : null;
      const redactedTail = redactEvidenceTail(
        err?.evidence?.stderrTail,
        // The incumbent verdict's pid/port evidence is persisted with the
        // record (structured line at the END of the tail, so the tail-keeping
        // cap never drops it).
        incumbent
          ? [
              ...(Array.isArray(err?.evidence?.stdoutTail)
                ? err.evidence.stdoutTail
                : []),
              `[alphaclaw] incumbent evidence: ${JSON.stringify(incumbentEvidence)}`,
            ]
          : err?.evidence?.stdoutTail,
      );
      lastRestartEvidence = redactedTail ? { operationId, redactedTail } : null;
      const safeMessage = redactFailureMessage(err.message);
      // Surface the blocking CAUSE, not just the symptom: the last
      // error-shaped line of the (redacted) gateway output rides in the
      // summary. Composition guarantees the cause survives the length cap —
      // the message part is bounded before appending.
      const causeLine = incumbent ? null : pickCauseLine(redactedTail);
      const errorSummary = causeLine
        ? `${safeMessage.slice(0, 150)} — last gateway error: ${causeLine.slice(0, 240)}`
        : safeMessage.slice(0, 400);
      if (incumbent) {
        emitStep({ step: "ready", status: "warning", detail: err.message });
      }
      restartRequiredState.completeRestart?.({
        operationId,
        ok: false,
        errorSummary,
        evidenceTail: redactedTail || null,
      });
      restartRequiredState.markRestartComplete();
      operationEvents?.fail(
        operationId,
        Object.assign(new Error(errorSummary), {
          code: incumbent ? "restart_incumbent" : "restart_failed",
          hint: incumbent
            ? "The previous gateway is still running, so your changes are not live yet. Retry the restart, or stop the gateway manually and start it again."
            : "Retry, run Repair, or check the gateway logs.",
          ...(incumbent ? { reason: kIncumbentRestartReason } : {}),
        }),
      );
      watchdog?.recordOperationEvent?.({
        kind: "gateway_restart",
        status: "failed",
        details: {
          operationId,
          trigger: "manual",
          error: errorSummary,
          ...(incumbent ? { reason: kIncumbentRestartReason } : {}),
        },
      });
      if (incumbent) {
        watchdog?.recordOperationEvent?.({
          kind: "restart_incumbent",
          status: "failed",
          details: {
            operationId,
            trigger: "manual",
            reason: kIncumbentRestartReason,
            evidence: incumbentEvidence,
          },
        });
        // Never awaited: the lifecycle lock and restartInFlight are still
        // held here, and an outbox-unavailable direct send blocks on channel
        // I/O for as long as every target takes to fail. The record and the
        // ledger events above are the synchronous truth; the notification
        // settles on its own (its own catch logs a failure).
        void notifyIncumbentRestart({
          operationId,
          errorSummary,
          evidence: incumbentEvidence,
        });
      }
      throw err;
    } finally {
      release?.();
      restartInFlight = null;
      // Close the watchdog's expected-restart window NOW — success or
      // failure, the operation is over; a failed restart must degrade
      // detection-fast, not sit suppressed until the lease expires.
      watchdog?.onExpectedRestartSettled?.();
    }
  };

  app.post("/api/gateway/restart", wrapAsync(async (req, res) => {
    if (!isOnboarded()) {
      return res.status(400).json({ ok: false, error: "Not onboarded" });
    }
    const wantsAsync = String(req.query.async || "") === "1";

    // Attach semantics first: a second click (or second tab) joins the active
    // restart instead of starting a competing one — even if a channel apply
    // has since begun, joining the already-running restart is coherent.
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
        return res
          .status(500)
          .json({ ok: false, attached: true, operationId, error: err.message });
      }
    }

    // Gateway restarts and channel applies mutate the same build/process —
    // never interleave them (mirrors the apply route's own in-progress gate).
    if (openclawChannelService?.isApplyInProgress?.()) {
      return res.status(409).json({
        ok: false,
        code: "apply_in_progress",
        error:
          "A channel update is in progress — wait for it to finish before restarting.",
      });
    }

    // Issue #20: a reconciler hold means the gateway was deliberately NOT
    // started on a config that failed migration. A manual restart would
    // launch it on that exact config — and onGatewayLaunch would dissolve
    // the watchdog latch while the hold stays set.
    const gatewayHold = (() => {
      try {
        return openclawChannelService?.getChannelInfo?.()?.gatewayHold || null;
      } catch {
        return null;
      }
    })();
    if (gatewayHold) {
      return res.status(409).json({
        ok: false,
        code: "gateway_held",
        error:
          "The gateway is held after a failed settings migration — use Retry migration on the Upgrade page instead of restarting.",
      });
    }

    restartRequiredState.markRestartInProgress();
    const begin =
      typeof restartRequiredState.beginRestart === "function"
        ? restartRequiredState.beginRestart()
        : { operationId: null };
    const operationId = begin.operationId;
    operationEvents?.createOperation({ type: "gateway_restart", operationId });

    const promise = runRestartOperation({ operationId });
    restartInFlight = { operationId, promise };
    // Async callers detach here; keep the rejection observed either way.
    promise.catch(() => {});

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
      res.status(500).json({
        ok: false,
        operationId,
        error: err.message,
        evidence:
          lastRestartEvidence?.operationId === operationId
            ? lastRestartEvidence.redactedTail
            : undefined,
      });
    }
  }));
};

module.exports = { registerSystemRoutes, createSwrCache };

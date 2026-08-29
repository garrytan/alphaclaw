const { buildManagedPaths } = require("../internal-files-migration");
const { readOpenclawConfig } = require("../openclaw-config");
const { shouldSkipSystemCronInstall } = require("../../cli/git-runtime");
const { buildSystemCronFile } = require("../../cli/system-cron");
const { kRootDir } = require("../constants");
const {
  readAlphaclawConfig,
  updateOpenAiCompatApiFeature,
  updateAgentAdminFeature,
} = require("../alphaclaw-config");
const { parseTelegramSessionKey } = require("../utils/session-keys");
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
} = require("../utils/redact");

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
}) => {
  let envRestartPending = false;
  let openclawSecretRuntimePromise = null;
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
  const isValidCronSchedule = (value) =>
    typeof value === "string" && /^(\S+\s+){4}\S+$/.test(value.trim());
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
  const parseJsonFromStdout = (stdout) => {
    const raw = String(stdout || "").trim();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {}
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (!(line.startsWith("{") || line.startsWith("["))) continue;
      try {
        return JSON.parse(line);
      } catch {}
    }
    const candidateStarts = [raw.indexOf("{"), raw.indexOf("[")].filter((idx) => idx >= 0);
    for (const start of candidateStarts) {
      for (let end = raw.length; end > start; end -= 1) {
        const candidate = raw.slice(start, end).trim();
        if (!(candidate.endsWith("}") || candidate.endsWith("]"))) continue;
        try {
          return JSON.parse(candidate);
        } catch {}
      }
    }
    return null;
  };
  const getEnvFileValue = (key) =>
    (typeof readEnvFile === "function" ? readEnvFile() : []).find(
      (entry) => entry?.key === key,
    )?.value;
  const normalizeSecretValue = (value) => {
    if (typeof value !== "string") return "";
    const trimmed = String(value || "").trim();
    if (trimmed.length >= 2) {
      const first = trimmed[0];
      const last = trimmed[trimmed.length - 1];
      if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
        return trimmed.slice(1, -1).trim();
      }
    }
    return trimmed;
  };
  const getEnvObject = () => {
    const env = { ...process.env };
    for (const entry of typeof readEnvFile === "function" ? readEnvFile() : []) {
      const key = String(entry?.key || "").trim();
      if (!key) continue;
      if (!normalizeSecretValue(env[key])) {
        env[key] = normalizeSecretValue(entry?.value);
      }
    }
    return env;
  };
  const loadOpenclawSecretRuntime = async () => {
    openclawSecretRuntimePromise ||= Promise.all([
      import("openclaw/plugin-sdk/secret-input"),
      import("openclaw/plugin-sdk/runtime-secret-resolution"),
    ]).then(([secretInput, runtimeSecretResolution]) => ({
      coerceSecretRef: secretInput.coerceSecretRef,
      resolveSecretRefValues: runtimeSecretResolution.resolveSecretRefValues,
    }));
    return openclawSecretRuntimePromise;
  };
  const resolveSecretRefToken = async ({ config, value, env }) => {
    try {
      const { coerceSecretRef, resolveSecretRefValues } =
        await loadOpenclawSecretRuntime();
      const ref = coerceSecretRef(value, config?.secrets?.defaults);
      if (!ref) return "";
      const resolved = await resolveSecretRefValues([ref], { config, env });
      const refKey = `${ref.source}:${ref.provider}:${ref.id}`;
      return normalizeSecretValue(resolved.get(refKey));
    } catch {
      return "";
    }
  };
  const resolveEnvReference = (value) => {
    const match = String(value || "").trim().match(/^\$\{([A-Z_][A-Z0-9_]*)\}$/);
    if (!match) return "";
    const envKey = match[1];
    const envValue = process.env[envKey] || getEnvFileValue(envKey);
    return normalizeSecretValue(envValue);
  };
  const getDashboardTokenFromConfig = async () => {
    const config = readOpenclawConfig({
      fsModule: fs,
      openclawDir: OPENCLAW_DIR,
      fallback: {},
    });
    // Team mode: the gateway runs trusted-proxy auth and rejects shared
    // tokens, so a #token= dashboard URL would carry a dead credential. The
    // proxy injects operator identity instead; link tokenless.
    if (String(config?.gateway?.auth?.mode || "") === "trusted-proxy") {
      return "";
    }
    const env = getEnvObject();
    const configuredToken = config?.gateway?.auth?.token;
    const resolvedSecretRefToken = await resolveSecretRefToken({
      config,
      value: configuredToken,
      env,
    });
    if (resolvedSecretRefToken) return resolvedSecretRefToken;
    if (typeof configuredToken === "string" && configuredToken.trim()) {
      const trimmedToken = normalizeSecretValue(configuredToken);
      if (/^\$\{[A-Z_][A-Z0-9_]*\}$/.test(trimmedToken)) {
        return resolveEnvReference(trimmedToken);
      }
      return trimmedToken;
    }
    return normalizeSecretValue(env.OPENCLAW_GATEWAY_TOKEN);
  };
  const buildDashboardUrl = (token) =>
    token ? `/openclaw/#token=${encodeURIComponent(token)}` : "/openclaw";
  const extractDashboardTokenFromOutput = (stdout) => {
    const tokenMatch = String(stdout || "").match(/[#?&]token=([^\s&#]+)/);
    if (!tokenMatch) return "";
    try {
      return decodeURIComponent(tokenMatch[1]);
    } catch {
      return tokenMatch[1];
    }
  };
  const getRawSessionKey = (sessionRow = {}) =>
    String(sessionRow?.key || sessionRow?.sessionKey || sessionRow?.id || "").trim();
  const getRawSessionsFromPayload = (payload) => {
    if (Array.isArray(payload)) return payload;
    const candidates = [
      payload?.sessions,
      payload?.items,
      payload?.data?.sessions,
      payload?.data?.items,
      payload?.result?.sessions,
      payload?.result?.items,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  };
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
  const getSessionReplyTarget = (sessionKey = "") => {
    const key = String(sessionKey || "");
    const telegramDirectMatch = key.match(/:telegram:direct:([^:]+)$/);
    if (telegramDirectMatch) {
      return {
        replyChannel: "telegram",
        replyTo: String(telegramDirectMatch[1] || ""),
      };
    }
    const telegramTopicMatch = key.match(
      /:telegram:group:([^:]+):topic:([^:]+)$/,
    );
    if (telegramTopicMatch) {
      return {
        replyChannel: "telegram",
        replyTo: `${String(telegramTopicMatch[1] || "")}:${String(telegramTopicMatch[2] || "")}`,
      };
    }
    return {
      replyChannel: "",
      replyTo: "",
    };
  };

  const listSendableAgentSessions = async () => {
    const result = await clawCmd("sessions --json --all-agents", {
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
      const schedule = isValidCronSchedule(parsed.schedule)
        ? parsed.schedule.trim()
        : kDefaultSystemCronSchedule;
      return { enabled, schedule };
    } catch {
      return { enabled: true, schedule: kDefaultSystemCronSchedule };
    }
  };
  const getSystemCronStatus = () => {
    const config = readSystemCronConfig();
    return {
      enabled: config.enabled,
      schedule: config.schedule,
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
      // null = the builder refused (unsafe path/schedule); never write "null".
      if (cronContent) {
        fs.writeFileSync(kSystemCronPath, cronContent, {
          mode: 0o644,
        });
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
    syncApiKeyAuthProfilesFromEnvVars(nextEnvVars);
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
    res.json({ ok: true, changed, restartRequired });
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

  // Stale-while-revalidate cache for small-but-synchronous status readers
  // (config/credential file reads). Seeds synchronously on first use, then
  // serves the cached value and refreshes off the request tick, so the 2s SSE
  // loop never runs sync FS work inline. (Upstream v0.9.36 design.)
  const createSwrCache = (compute, ttlMs) => {
    const cache = { value: undefined, fetchedAt: 0, seeded: false, refreshing: false };
    const read = () => {
      const now = Date.now();
      if (!cache.seeded) {
        cache.value = compute();
        cache.fetchedAt = now;
        cache.seeded = true;
        return cache.value;
      }
      if (now - cache.fetchedAt >= ttlMs && !cache.refreshing) {
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
  const invalidateStatusCaches = () => {
    getChannelStatusCached.invalidate();
    getSystemCronStatusCached.invalidate();
    readAlphaclawConfigCached.invalidate();
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
    };
  };

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
        isPin: info.isPin,
        acceptedAt: info.acceptedAt,
        inStabilizationWindow: info.inStabilizationWindow,
        applyInProgress: Boolean(openclawChannelService?.isApplyInProgress?.()),
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
    // (wedged-but-TCP-up detection in ~30s instead of ~120s).
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
    if (schedule !== undefined && !isValidCronSchedule(schedule)) {
      return res
        .status(400)
        .json({ ok: false, error: "schedule must be a 5-field cron string" });
    }
    const nextConfig = {
      enabled: typeof enabled === "boolean" ? enabled : current.enabled,
      schedule:
        typeof schedule === "string" && schedule.trim()
          ? schedule.trim()
          : current.schedule,
    };
    const status = applySystemCronConfig(nextConfig);
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

  app.get("/api/agent/sessions", async (req, res) => {
    try {
      const sessions = await listSendableAgentSessions();
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
      if (selectedSession.replyChannel && selectedSession.replyTo) {
        command +=
          ` --deliver --reply-channel ${shellEscapeArg(selectedSession.replyChannel)}` +
          ` --reply-to ${shellEscapeArg(selectedSession.replyTo)}`;
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

  app.get("/api/gateway/dashboard", async (req, res) => {
    if (!isOnboarded()) return res.json({ ok: false, url: "/openclaw" });
    const token = await getDashboardTokenFromConfig();
    if (token) {
      return res.json({
        ok: true,
        url: buildDashboardUrl(token),
        source: "config",
      });
    }
    const result = await clawCmd("dashboard --no-open");
    if (result.ok && result.stdout) {
      const cliToken = extractDashboardTokenFromOutput(result.stdout);
      if (cliToken) {
        return res.json({ ok: true, url: buildDashboardUrl(cliToken) });
      }
    }
    res.json({ ok: true, url: "/openclaw", needsAuth: true });
  });

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
          ? {
              ...lastOperation,
              evidence:
                lastRestartEvidence?.operationId === lastOperation.operationId
                  ? lastRestartEvidence.redactedTail
                  : null,
            }
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

  const redactEvidenceTail = (stderrTail) => {
    const tail = Array.isArray(stderrTail) ? stderrTail.slice(-20) : [];
    if (tail.length === 0) return "";
    return redactSecrets(tail.join("\n"), { secrets: collectEvidenceSecrets() });
  };

  // Failure MESSAGES can embed gateway output (a bind error quoting a URL
  // with a token) — they get the same masking as the stderr tail.
  const redactFailureMessage = (message) =>
    redactSecrets(String(message || ""), { secrets: collectEvidenceSecrets() });

  const runRestartOperation = async ({ operationId }) => {
    const emitStep = ({ step, status, budgetMs }) => {
      operationEvents?.publish(operationId, {
        event: "step",
        data: {
          name: step,
          label: kRestartStepLabels[step] || step,
          status,
          ...(budgetMs ? { budgetMs } : {}),
        },
      });
      if (status === "running") {
        restartRequiredState.updateRestartOperation?.({
          operationId,
          lastStep: step,
        });
      }
    };

    const release = gatewayLifecycleLock
      ? await gatewayLifecycleLock.acquire("restart")
      : null;
    try {
      const lease =
        restartRequiredState.getActiveRestartOperation?.()?.expiresAt || 0;
      watchdog?.onExpectedRestart?.({ expiresAt: lease });
      const result = await restartGateway({ onStep: emitStep });
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
      const redactedTail = redactEvidenceTail(err?.evidence?.stderrTail);
      lastRestartEvidence = redactedTail ? { operationId, redactedTail } : null;
      const safeMessage = redactFailureMessage(err.message);
      restartRequiredState.completeRestart?.({
        operationId,
        ok: false,
        errorSummary: safeMessage,
      });
      restartRequiredState.markRestartComplete();
      operationEvents?.fail(
        operationId,
        Object.assign(new Error(safeMessage), {
          code: "restart_failed",
          hint: "Retry, run Repair, or check the gateway logs.",
        }),
      );
      watchdog?.recordOperationEvent?.({
        kind: "gateway_restart",
        status: "failed",
        details: { operationId, trigger: "manual", error: safeMessage },
      });
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

module.exports = { registerSystemRoutes };

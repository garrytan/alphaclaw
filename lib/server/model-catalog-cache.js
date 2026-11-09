const fs = require("fs");
const path = require("path");
const {
  ALPHACLAW_DIR,
  kFallbackOnboardingModels,
  mergeCatalogModels,
} = require("./constants");
const { getCommandOutputCandidates } = require("./utils/command-output");

const kModelCatalogCacheVersion = 2;
const kModelCatalogRefreshBackoffMs = 30 * 1000;
const kModelCatalogLoadTimeoutMs = 120 * 1000;
const kModelCatalogBootstrapSource = "bootstrap";
const kDefaultCachePath = path.join(ALPHACLAW_DIR, "cache", "model-catalog.json");

const createResponse = ({
  source = "fallback",
  fetchedAt = null,
  stale = false,
  refreshing = false,
  models = [],
} = {}) => ({
  ok: true,
  source,
  fetchedAt,
  stale,
  refreshing,
  models,
});

const normalizeOpenclawVersion = (value) => {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
};

const normalizeCachedModels = ({
  models,
  normalizeOnboardingModels = (items) => items,
} = {}) =>
  normalizeOnboardingModels(
    (Array.isArray(models) ? models : []).map((model) => ({
      ...model,
      key: model?.key,
      name: model?.label || model?.name || model?.key,
    })),
  );

const normalizeCacheEntry = ({
  raw,
  normalizeOnboardingModels = (items) => items,
} = {}) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const fetchedAt = Number(raw.fetchedAt || 0);
  const models = normalizeCachedModels({
    models: raw.models,
    normalizeOnboardingModels,
  });
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0 || models.length === 0) {
    return null;
  }
  return {
    version: kModelCatalogCacheVersion,
    fetchedAt,
    openclawVersion: normalizeOpenclawVersion(raw.openclawVersion),
    models,
  };
};

const parseCatalogModelsFromOutput = ({
  rawOutput,
  parseJsonFromNoisyOutput = () => ({}),
  normalizeOnboardingModels = (items) => items,
} = {}) => {
  const parsed = parseJsonFromNoisyOutput(rawOutput);
  return normalizeOnboardingModels(parsed?.models || []);
};

// OpenClaw 2026.11.2 (commands/models/list.list-command.ts) prints this on
// stderr when it found no gateway and answered from the local cache.
const kCliOfflineCatalogPattern = /Gateway is not running\. (?:Showing|Refreshing) the local/;

const createModelCatalogCache = ({
  fsModule = fs,
  pathModule = path,
  execFileCmd,
  gatewayEnv = () => ({}),
  parseJsonFromNoisyOutput = () => ({}),
  normalizeOnboardingModels = (items) => items,
  readOpenclawVersion = () => null,
  readOpenclawVersionAsync = async () => readOpenclawVersion(),
  shouldStartDynamicRefresh = () => true,
  isGatewayRunning = () => true,
  fallbackModels = kFallbackOnboardingModels,
  cachePath = kDefaultCachePath,
  refreshBackoffMs = kModelCatalogRefreshBackoffMs,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  logger = console,
} = {}) => {
  let cacheLoaded = false;
  let memoryCache = null;
  let cacheIsStale = false;
  let refreshPromise = null;
  let retryTimer = null;
  let backoffUntilMs = 0;

  const readCurrentOpenclawVersion = () => {
    try {
      return normalizeOpenclawVersion(readOpenclawVersion());
    } catch {
      return null;
    }
  };

  // Fresh-or-refresh, awaited: never spawns synchronously — the version
  // service's coalesced async execFile does the work off the event loop.
  const refreshCurrentOpenclawVersion = async () => {
    try {
      return normalizeOpenclawVersion(await readOpenclawVersionAsync());
    } catch {
      return null;
    }
  };

  const isCompatibleWithCurrentOpenclaw = ({
    entry,
    currentOpenclawVersion,
  } = {}) => {
    if (!entry) return false;
    if (!currentOpenclawVersion) return true;
    return entry.openclawVersion === currentOpenclawVersion;
  };

  const clearRetryTimer = () => {
    if (!retryTimer) return;
    clearTimeoutFn(retryTimer);
    retryTimer = null;
  };

  const isRefreshPending = () => !!refreshPromise || !!retryTimer;

  const canStartDynamicRefresh = () => {
    try {
      return shouldStartDynamicRefresh() !== false;
    } catch {
      return false;
    }
  };

  const setCacheEntry = (entry, { fresh = false } = {}) => {
    memoryCache = entry;
    cacheLoaded = true;
    cacheIsStale = !fresh;
    backoffUntilMs = 0;
    clearRetryTimer();
    return memoryCache;
  };

  const readDiskCache = () => {
    if (cacheLoaded) return memoryCache;
    cacheLoaded = true;
    try {
      const raw = JSON.parse(fsModule.readFileSync(cachePath, "utf8"));
      const entry = normalizeCacheEntry({
        raw,
        normalizeOnboardingModels,
      });
      if (!entry) return null;
      memoryCache = entry;
      cacheIsStale = true;
      return memoryCache;
    } catch {
      memoryCache = null;
      cacheIsStale = false;
      return null;
    }
  };

  const writeDiskCache = (entry) => {
    fsModule.mkdirSync(pathModule.dirname(cachePath), { recursive: true });
    fsModule.writeFileSync(
      cachePath,
      `${JSON.stringify(entry, null, 2)}\n`,
      "utf8",
    );
  };

  // A boolean when isGatewayRunning answers synchronously, else a promise.
  const probeGateway = () => {
    try {
      const probe = isGatewayRunning();
      return typeof probe?.then === "function" ? probe.then((up) => up !== false, () => false) : probe !== false;
    } catch {
      return false;
    }
  };

  const loadFreshCatalog = async () => {
    const openclawVersion = await refreshCurrentOpenclawVersion();
    let gatewayUpBefore = probeGateway();
    if (typeof gatewayUpBefore !== "boolean") gatewayUpBefore = await gatewayUpBefore;
    let models = [];
    let recoveredFromCommandError = false;
    let stderr = "";
    try {
      const output = await execFileCmd("openclaw", ["models", "list", "--all", "--json"], {
        env: gatewayEnv(),
        timeoutMs: kModelCatalogLoadTimeoutMs,
        processGroup: true,
        onOutput: (text, stream) => {
          if (stream === "stderr") stderr = (stderr + text).slice(-64 * 1024);
        },
      });
      models = parseCatalogModelsFromOutput({
        rawOutput: output,
        parseJsonFromNoisyOutput,
        normalizeOnboardingModels,
      });
    } catch (err) {
      stderr = String(err?.stderr || stderr);
      for (const rawOutput of getCommandOutputCandidates(err)) {
        models = parseCatalogModelsFromOutput({
          rawOutput,
          parseJsonFromNoisyOutput,
          normalizeOnboardingModels,
        });
        if (models.length > 0) {
          recoveredFromCommandError = true;
          logger.warn?.(
            `[models] Recovered model catalog from failed command output: ${err.message || String(err)}`,
          );
          break;
        }
      }
      if (models.length === 0) throw err;
    }
    if (models.length === 0) {
      throw new Error("No models found");
    }
    // Since 2026.10.10 the CLI answers without a gateway from its local
    // cache: the configured models only, not the provider catalog. That
    // partial list is never persisted nor served as fresh; with nothing
    // better in memory it is merged over the bundled catalog, and the
    // backoff retry loads the full catalog once the gateway is up. The CLI
    // decides by itself, seconds after the probe, so its own "Gateway is not
    // running" line counts, and so does a gateway gone by the time it returns.
    let gatewayRunning = gatewayUpBefore && !kCliOfflineCatalogPattern.test(stderr) && probeGateway();
    if (typeof gatewayRunning !== "boolean") gatewayRunning = await gatewayRunning;
    if (!gatewayRunning) {
      if (!memoryCache) {
        setCacheEntry({
          version: kModelCatalogCacheVersion,
          fetchedAt: now(),
          openclawVersion,
          models: mergeCatalogModels(models, fallbackModels),
        });
      }
      backoffUntilMs = now() + refreshBackoffMs;
      scheduleRetry();
      return memoryCache;
    }
    const entry = {
      version: kModelCatalogCacheVersion,
      fetchedAt: now(),
      openclawVersion,
      models,
    };
    writeDiskCache(entry);
    setCacheEntry(entry, { fresh: true });
    if (recoveredFromCommandError) {
      backoffUntilMs = 0;
      clearRetryTimer();
    }
    return entry;
  };

  const scheduleRetry = () => {
    if (!canStartDynamicRefresh()) {
      clearRetryTimer();
      return;
    }
    if (retryTimer) return;
    const delayMs = Math.max(backoffUntilMs - now(), 0);
    retryTimer = setTimeoutFn(() => {
      retryTimer = null;
      if (!canStartDynamicRefresh()) return;
      if (refreshPromise) return;
      if (memoryCache && !cacheIsStale) return;
      void startBackgroundRefresh();
    }, delayMs);
    if (typeof retryTimer?.unref === "function") retryTimer.unref();
  };

  const handleRefreshFailure = (err) => {
    backoffUntilMs = now() + refreshBackoffMs;
    scheduleRetry();
    if (memoryCache) {
      cacheIsStale = true;
      logger.error?.(
        `[models] Failed to refresh cached models: ${err.message || String(err)}`,
      );
      return;
    }
    logger.error?.(
      `[models] Failed to load dynamic models: ${err.message || String(err)}`,
    );
  };

  const startBackgroundRefresh = () => {
    if (!canStartDynamicRefresh()) {
      clearRetryTimer();
      return null;
    }
    readDiskCache();
    if (refreshPromise) return refreshPromise;
    if (retryTimer) return null;
    if (backoffUntilMs > now()) {
      scheduleRetry();
      return null;
    }
    refreshPromise = Promise.resolve()
      .then(() => loadFreshCatalog())
      .catch((err) => {
        handleRefreshFailure(err);
        return null;
      })
      .finally(() => {
        refreshPromise = null;
      });
    return refreshPromise;
  };

  return {
    async getCatalogResponse({ forceRefresh = false } = {}) {
      readDiskCache();
      if (forceRefresh) {
        if (memoryCache) cacheIsStale = true;
        backoffUntilMs = 0;
        clearRetryTimer();
      }
      if (memoryCache && !cacheIsStale) {
        const currentOpenclawVersion = await refreshCurrentOpenclawVersion();
        if (
          !isCompatibleWithCurrentOpenclaw({
            entry: memoryCache,
            currentOpenclawVersion,
          })
        ) {
          cacheIsStale = true;
          backoffUntilMs = 0;
          clearRetryTimer();
        }
      }
      if (memoryCache && !cacheIsStale) {
        return createResponse({
          source: "openclaw",
          fetchedAt: memoryCache.fetchedAt,
          stale: false,
          refreshing: false,
          models: memoryCache.models,
        });
      }
      if (memoryCache) {
        const didStartRefresh = !!startBackgroundRefresh();
        return createResponse({
          source: "cache",
          fetchedAt: memoryCache.fetchedAt,
          stale: true,
          refreshing:
            canStartDynamicRefresh() && (didStartRefresh || isRefreshPending()),
          models: memoryCache.models,
        });
      }
      const didStartRefresh = !!startBackgroundRefresh();
      return createResponse({
        source: kModelCatalogBootstrapSource,
        fetchedAt: null,
        stale: true,
        refreshing:
          canStartDynamicRefresh() && (didStartRefresh || isRefreshPending()),
        models: fallbackModels,
      });
    },

    markStale() {
      readDiskCache();
      if (!memoryCache) return;
      cacheIsStale = true;
      backoffUntilMs = 0;
      clearRetryTimer();
    },

    // Synchronous, exec-free view of the best-known catalog (memory/disk
    // cache, else the bundled fallback). Never triggers a refresh — built
    // for consumers that must not spawn the CLI (e.g. Drift Doctor's
    // model-drift check). `source` mirrors getCatalogResponse's vocabulary:
    // "openclaw" (fresh CLI listing), "cache" (stale CLI listing),
    // "bootstrap" (bundled snapshot) — consumers hedge copy on the weaker
    // sources. Deliberate gap vs getCatalogResponse: the exec-free peek
    // skips the openclaw-version compatibility downgrade (that check is
    // async), so a mid-process CLI upgrade can briefly report "openclaw"
    // for a cache getCatalogResponse would downgrade to "cache".
    peekCatalog() {
      readDiskCache();
      if (memoryCache) {
        return {
          models: memoryCache.models,
          source: cacheIsStale ? "cache" : "openclaw",
        };
      }
      return { models: fallbackModels, source: kModelCatalogBootstrapSource };
    },
  };
};

module.exports = {
  createModelCatalogCache,
  createResponse,
  normalizeCachedModels,
  normalizeCacheEntry,
  kModelCatalogCacheVersion,
  kModelCatalogRefreshBackoffMs,
  kModelCatalogLoadTimeoutMs,
  kModelCatalogBootstrapSource,
  kDefaultCachePath,
};

const { execFile } = require("child_process");
const { kVersionCacheTtlMs, kVersionFailureRetryMs } = require("./constants");
const { normalizeOpenclawVersion } = require("./helpers");

const createOpenclawVersionService = ({ gatewayEnv }) => {
  // `openclaw --version` boots the full OpenClaw CLI (~0.5-3s). It must never
  // run synchronously on a request path: the whole single-threaded server
  // freezes while it spawns. Reads are served from this cache; refreshes are
  // coalesced async execFile calls; failures back off via nextRetryAtMs so a
  // missing binary is not re-probed on every status tick.
  let kOpenclawVersionCache = { value: null, lastSuccessAt: 0, nextRetryAtMs: 0 };
  let kVersionRefreshPromise = null;
  const isVersionCacheFresh = (now) =>
    kOpenclawVersionCache.value != null &&
    now - kOpenclawVersionCache.lastSuccessAt < kVersionCacheTtlMs;

  // Forced, coalesced async refresh. Resolves to the (possibly stale) cached
  // value on failure — same contract the old sync catch had.
  const refreshOpenclawVersion = () => {
    if (kVersionRefreshPromise) return kVersionRefreshPromise;
    kVersionRefreshPromise = new Promise((resolve) => {
      execFile(
        "openclaw",
        ["--version"],
        { env: gatewayEnv(), timeout: 5000, encoding: "utf8" },
        (err, stdout) => {
          const now = Date.now();
          if (err) {
            kOpenclawVersionCache = {
              ...kOpenclawVersionCache,
              nextRetryAtMs: now + kVersionFailureRetryMs,
            };
            resolve(kOpenclawVersionCache.value);
            return;
          }
          const version = normalizeOpenclawVersion(String(stdout || "").trim());
          kOpenclawVersionCache = {
            value: version,
            lastSuccessAt: now,
            nextRetryAtMs: 0,
          };
          resolve(version);
        },
      );
    }).finally(() => {
      kVersionRefreshPromise = null;
    });
    return kVersionRefreshPromise;
  };

  // Sync read: cached value only. When stale (and not inside the failure
  // backoff window) it kicks one background refresh and still returns the
  // last known value immediately — callers on request paths never wait.
  // `refresh: true` forces a background refresh even inside the TTL/backoff
  // window (deduped by the coalesced refresh promise).
  const readOpenclawVersion = ({ refresh = false } = {}) => {
    const now = Date.now();
    if (
      refresh ||
      (!isVersionCacheFresh(now) && now >= kOpenclawVersionCache.nextRetryAtMs)
    ) {
      void refreshOpenclawVersion();
    }
    return kOpenclawVersionCache.value;
  };

  // Async read: fresh cached value, or awaits the coalesced refresh.
  const readOpenclawVersionAsync = async () => {
    if (isVersionCacheFresh(Date.now())) return kOpenclawVersionCache.value;
    return refreshOpenclawVersion();
  };

  const clearVersionCache = () => {
    kOpenclawVersionCache = { value: null, lastSuccessAt: 0, nextRetryAtMs: 0 };
  };

  return {
    readOpenclawVersion,
    readOpenclawVersionAsync,
    refreshOpenclawVersion,
    // Upstream alias: same coalesced forced-refresh contract. Kept because
    // upstream callers (e.g. the register-server-routes prewarm) probe for
    // this name via optional chaining.
    fetchOpenclawVersion: refreshOpenclawVersion,
    clearVersionCache,
  };
};
module.exports = { createOpenclawVersionService };

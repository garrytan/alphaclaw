const { exec, execFile, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  kVersionCacheTtlMs,
  kVersionFailureRetryMs,
  kLatestVersionCacheTtlMs,
  kRootDir,
} = require("./constants");
const { normalizeOpenclawVersion } = require("./helpers");
const { parseJsonObjectFromNoisyOutput } = require("./utils/json");
const { assertSupportedNodeVersion } = require("../node-runtime");

// Standalone: install an exact openclaw version into a throwaway temp dir.
// --install-strategy=nested keeps openclaw fully self-contained (transitive
// deps live under node_modules/openclaw/node_modules), so a later overlay copy
// can never hoist a shared dependency over the app's own tree — the Express
// 4->5 incident class documented in AGENTS.md.
const installOpenclawVersionToTempDir = ({
  versionSpec = "latest",
  execImpl = exec,
  fsModule = fs,
  timeoutMs = 180000,
} = {}) =>
  new Promise((resolve, reject) => {
    try {
      assertSupportedNodeVersion();
    } catch (error) {
      reject(error);
      return;
    }
    const tmpDir = fsModule.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-prepare-"),
    );
    const cleanup = () => {
      try {
        fsModule.rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    };
    fsModule.writeFileSync(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ private: true, dependencies: { openclaw: versionSpec } }),
    );
    // Candidate packages run their (and their deps') install scripts during
    // this npm install — BEFORE verification accepts them. They must not see
    // the gateway's secrets; npm itself only needs PATH/HOME/proxy settings.
    const npmEnv = {};
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "LANG",
      "LC_ALL",
      "TERM",
      "NO_COLOR",
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]) {
      if (process.env[key] !== undefined) npmEnv[key] = process.env[key];
    }
    // HOME is the agent-writable data volume: a planted ~/.npmrc could
    // redirect this install to a different registry, and verification cannot
    // catch a malicious package that controls its own --version output. Pin
    // the config sources and the registry explicitly. The two config paths
    // must be DISTINCT files: npm hard-errors on "double-loading config" when
    // user and global resolve to the same path (live-tier verified).
    const emptyUserConfig = path.join(tmpDir, ".npmrc-empty");
    fsModule.writeFileSync(emptyUserConfig, "");
    const devNull = process.platform === "win32" ? "NUL" : "/dev/null";
    Object.assign(npmEnv, {
      // Candidate lifecycle scripts must not get $HOME-relative reads into
      // the data volume (.openclaw state, .env) — the temp dir is their HOME.
      HOME: tmpDir,
      npm_config_userconfig: emptyUserConfig,
      npm_config_globalconfig: devNull,
      npm_config_registry: "https://registry.npmjs.org",
      npm_config_update_notifier: "false",
      npm_config_fund: "false",
      npm_config_audit: "false",
      // Persistent cache on the volume keeps re-installs fast across restarts.
      npm_config_cache: path.join(kRootDir, "cache", "npm"),
    });
    execImpl(
      "npm install --omit=dev --prefer-online --package-lock=false --install-strategy=nested",
      // 16MB buffer: a cold-cache install of openclaw + deps logs far past
      // exec's 1MB default, which would kill the install mid-run.
      { cwd: tmpDir, env: npmEnv, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (installErr, stdout, stderr) => {
        if (installErr) {
          const message = String(stderr || installErr.message || "").trim();
          cleanup();
          return reject(
            new Error(message || `Failed to install openclaw@${versionSpec}`),
          );
        }
        resolve({
          tmpDir,
          openclawPackageDir: path.join(tmpDir, "node_modules", "openclaw"),
          cleanup,
          stdout: String(stdout || "").trim(),
        });
      },
    );
  });

const createOpenclawVersionService = ({
  gatewayEnv,
  restartGateway,
  isOnboarded,
}) => {
  // `openclaw --version` boots the full OpenClaw CLI (~0.5-3s). It must never
  // run synchronously on a request path: the whole single-threaded server
  // freezes while it spawns. Reads are served from this cache; refreshes are
  // coalesced async execFile calls; failures back off via nextRetryAtMs so a
  // missing binary is not re-probed on every status tick.
  let kOpenclawVersionCache = { value: null, lastSuccessAt: 0, nextRetryAtMs: 0 };
  let kVersionRefreshPromise = null;
  let kOpenclawUpdateStatusCache = {
    latestVersion: null,
    hasUpdate: false,
    fetchedAt: 0,
  };

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
  const readOpenclawVersion = () => {
    const now = Date.now();
    if (!isVersionCacheFresh(now) && now >= kOpenclawVersionCache.nextRetryAtMs) {
      void refreshOpenclawVersion();
    }
    return kOpenclawVersionCache.value;
  };

  // Async read: fresh cached value, or awaits the coalesced refresh.
  const readOpenclawVersionAsync = async () => {
    if (isVersionCacheFresh(Date.now())) return kOpenclawVersionCache.value;
    return refreshOpenclawVersion();
  };

  const readOpenclawUpdateStatus = ({ refresh = false } = {}) => {
    const now = Date.now();
    if (
      !refresh &&
      kOpenclawUpdateStatusCache.fetchedAt &&
      now - kOpenclawUpdateStatusCache.fetchedAt < kLatestVersionCacheTtlMs
    ) {
      return {
        latestVersion: kOpenclawUpdateStatusCache.latestVersion,
        hasUpdate: kOpenclawUpdateStatusCache.hasUpdate,
      };
    }
    try {
      const raw = execSync("openclaw update status --json", {
        env: gatewayEnv(),
        timeout: 8000,
        encoding: "utf8",
      }).trim();
      const parsed = parseJsonObjectFromNoisyOutput(raw);
      if (!parsed) {
        throw new Error("openclaw update status returned invalid JSON payload");
      }
      const latestVersion = normalizeOpenclawVersion(
        parsed?.availability?.latestVersion ||
          parsed?.update?.registry?.latestVersion,
      );
      const hasUpdate = !!parsed?.availability?.available;
      kOpenclawUpdateStatusCache = {
        latestVersion,
        hasUpdate,
        fetchedAt: now,
      };
      return { latestVersion, hasUpdate };
    } catch (err) {
      console.error(
        `[alphaclaw] openclaw update status error: ${err.message || "unknown error"}`,
      );
      throw new Error(err.message || "Failed to read OpenClaw update status");
    }
  };

  const getVersionStatus = async (refresh) => {
    const currentVersion = await readOpenclawVersionAsync();
    try {
      const { latestVersion, hasUpdate } = readOpenclawUpdateStatus({
        refresh,
      });
      return { ok: true, currentVersion, latestVersion, hasUpdate };
    } catch (err) {
      return {
        ok: false,
        currentVersion,
        latestVersion: kOpenclawUpdateStatusCache.latestVersion,
        hasUpdate: kOpenclawUpdateStatusCache.hasUpdate,
        error: err.message || "Failed to fetch latest OpenClaw version",
      };
    }
  };

  // The legacy in-place updater was removed: a second installer with its own
  // lock mutating node_modules would bypass the release-channel apply/rollback
  // machinery (overlay store, acceptance gating, blocklist). Callers must go
  // through the Upgrade page / channel API instead.
  const updateOpenclaw = async () => ({
    status: 410,
    body: {
      ok: false,
      code: "use_release_channel",
      error:
        "OpenClaw updates are managed by release channels. Use the Upgrade page or POST /api/openclaw/apply.",
    },
  });

  const clearVersionCache = () => {
    kOpenclawVersionCache = { value: null, lastSuccessAt: 0, nextRetryAtMs: 0 };
  };

  return {
    readOpenclawVersion,
    readOpenclawVersionAsync,
    refreshOpenclawVersion,
    getVersionStatus,
    updateOpenclaw,
    clearVersionCache,
  };
};

module.exports = {
  createOpenclawVersionService,
  installOpenclawVersionToTempDir,
};

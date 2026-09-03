const { exec, execFile } = require("child_process");
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

// OpenClaw 2026.8 ships dist/openclaw-install-guard in the tarball; its `preinstall`
// deletes it on success and `postinstall` installs bundled plugins. npm fails the
// whole install if postinstall fails, so a guard-free tree after a SUCCESSFUL install
// proves BOTH lifecycle scripts ran. We copy the staged tree into the overlay via
// cpSync (which does not re-run scripts), so the staged tree MUST be complete first —
// never save a guard-bearing (incomplete) tree. Stable tarballs have no guard file.
const kInstallGuardRelPath = path.join("dist", "openclaw-install-guard");
const kLifecycleScripts = [
  path.join("scripts", "preinstall-package-manager-warning.mjs"),
  path.join("scripts", "postinstall-bundled-plugins.mjs"),
];

const runNodeScript = ({ execImpl, scriptPath, cwd, env, timeoutMs = 120000 }) =>
  new Promise((resolve, reject) => {
    execImpl(
      `node ${JSON.stringify(scriptPath)}`,
      { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err) => (err ? reject(err) : resolve()),
    );
  });

// Ensure the staged package's lifecycle actually completed. If npm ran the scripts
// (the default), the guard is already gone and this is a no-op. If some npm config
// skipped scripts, run them manually; if the guard still remains, the install is
// incomplete and must not be trusted.
const verifyStagedLifecycle = async ({
  openclawPackageDir,
  execImpl,
  fsModule,
  env,
}) => {
  const guardPath = path.join(openclawPackageDir, kInstallGuardRelPath);
  if (!fsModule.existsSync(guardPath)) return; // scripts ran (or no guard = stable)
  for (const rel of kLifecycleScripts) {
    const scriptPath = path.join(openclawPackageDir, rel);
    if (!fsModule.existsSync(scriptPath)) continue;
    await runNodeScript({
      execImpl,
      scriptPath,
      cwd: openclawPackageDir,
      env,
    });
  }
  if (fsModule.existsSync(guardPath)) {
    throw new Error(
      "openclaw install incomplete: dist/openclaw-install-guard remains after lifecycle scripts (preinstall did not complete)",
    );
  }
};

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
  // Streaming observer for the durable update log. When set (the release
  // channel apply path), the install runs through spawn so a hang, OOM kill,
  // or timeout still leaves its output in the log — exec buffers everything
  // and dies with it. Tests that inject execImpl keep the legacy path.
  onOutput = null,
  runStreamImpl = null,
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
      JSON.stringify({
        private: true,
        dependencies: { openclaw: versionSpec },
        // npm >= 11.16 gates lifecycle scripts behind an allowlist — in
        // project-scoped installs it must be the manifest field, NOT the
        // --allow-scripts flag (npm 11.19 rejects the flag here; verified
        // live). Older npm ignores unknown manifest fields, so this is safe
        // unconditionally; verifyStagedLifecycle stays as the backstop.
        allowScripts: ["openclaw"],
      }),
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
    // Staged-lifecycle verification runs on BOTH install paths (streamed and
    // exec): a tree that still carries dist/openclaw-install-guard is an
    // incomplete install and must never reach the overlay store (1.4).
    const finishOk = (stdout) => {
      const openclawPackageDir = path.join(tmpDir, "node_modules", "openclaw");
      verifyStagedLifecycle({
        openclawPackageDir,
        execImpl,
        fsModule,
        env: npmEnv,
      })
        .then(() =>
          resolve({
            tmpDir,
            openclawPackageDir,
            cleanup,
            stdout: String(stdout || "").trim(),
            lifecycleVerified: true,
          }),
        )
        .catch((error) => {
          cleanup();
          reject(error);
        });
    };
    if (typeof onOutput === "function" || runStreamImpl) {
      const { createRunStream } = require("./openclaw-run-stream");
      const runner = runStreamImpl || createRunStream({ fsModule });
      runner
        .runStreamed({
          command: "npm",
          args: [
            "install",
            "--omit=dev",
            "--prefer-online",
            "--package-lock=false",
            "--install-strategy=nested",
          ],
          cwd: tmpDir,
          env: npmEnv,
          timeoutMs,
          onOutput,
        })
        .then((result) => {
          if (!result.ok) {
            const message = String(
              result.error || result.tail || "",
            ).trim();
            cleanup();
            return reject(
              new Error(
                (result.timedOut
                  ? `npm install timed out after ${Math.round(timeoutMs / 1000)}s`
                  : message) || `Failed to install openclaw@${versionSpec}`,
              ),
            );
          }
          finishOk(result.tail);
        })
        .catch((error) => {
          cleanup();
          reject(error);
        });
      return;
    }
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
        finishOk(stdout);
      },
    );
  });

const createOpenclawVersionService = ({
  gatewayEnv,
  restartGateway,
  isOnboarded,
  execImpl = exec,
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
  let updateStatusRefreshPromise = null;

  // Injectable exec-to-promise helper for CLI probes that must stay off the
  // event loop; powers the async update-status path.
  const execText = (command, { timeout }) =>
    new Promise((resolve, reject) => {
      execImpl(
        command,
        { env: gatewayEnv(), timeout, encoding: "utf8" },
        (err, stdout, stderr) => {
          if (err) {
            reject(new Error(String(stderr || err.message || "").trim() || `${command} failed`));
            return;
          }
          resolve(String(stdout || "").trim());
        },
      );
    });

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

  const readOpenclawUpdateStatus = async ({ refresh = false } = {}) => {
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
    if (!updateStatusRefreshPromise) {
      updateStatusRefreshPromise = execText("openclaw update status --json", {
        timeout: 8000,
      }).finally(() => {
        updateStatusRefreshPromise = null;
      });
    }
    try {
      const raw = await updateStatusRefreshPromise;
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
        fetchedAt: Date.now(),
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
      const { latestVersion, hasUpdate } = await readOpenclawUpdateStatus({
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
    // Upstream alias: same coalesced forced-refresh contract. Kept because
    // upstream callers (e.g. the register-server-routes prewarm) probe for
    // this name via optional chaining.
    fetchOpenclawVersion: refreshOpenclawVersion,
    getVersionStatus,
    updateOpenclaw,
    clearVersionCache,
  };
};

module.exports = {
  createOpenclawVersionService,
  installOpenclawVersionToTempDir,
  verifyStagedLifecycle,
  kInstallGuardRelPath,
};

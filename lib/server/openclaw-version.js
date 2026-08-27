const { exec, execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  kVersionCacheTtlMs,
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
      },
    );
  });

const createOpenclawVersionService = ({
  gatewayEnv,
  restartGateway,
  isOnboarded,
}) => {
  let kOpenclawVersionCache = { value: null, fetchedAt: 0 };
  let kOpenclawUpdateStatusCache = {
    latestVersion: null,
    hasUpdate: false,
    fetchedAt: 0,
  };

  const readOpenclawVersion = ({ refresh = false } = {}) => {
    const now = Date.now();
    if (
      !refresh &&
      kOpenclawVersionCache.value &&
      now - kOpenclawVersionCache.fetchedAt < kVersionCacheTtlMs
    ) {
      return kOpenclawVersionCache.value;
    }
    try {
      const raw = execSync("openclaw --version", {
        env: gatewayEnv(),
        timeout: 5000,
        encoding: "utf8",
      }).trim();
      const version = normalizeOpenclawVersion(raw);
      kOpenclawVersionCache = { value: version, fetchedAt: now };
      return version;
    } catch {
      return kOpenclawVersionCache.value;
    }
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
    const currentVersion = readOpenclawVersion();
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
    kOpenclawVersionCache = { value: null, fetchedAt: 0 };
  };

  return {
    readOpenclawVersion,
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

const childProcess = require("child_process");

const modulePath = require.resolve("../../lib/server/openclaw-version");
const nodeRuntime = require("../../lib/node-runtime");
const originalExec = childProcess.exec;
const originalExecFile = childProcess.execFile;
const originalExecSync = childProcess.execSync;
const originalAssertSupportedNodeVersion = nodeRuntime.assertSupportedNodeVersion;

const loadVersionModule = ({ execMock, execSyncMock, execFileMock }) => {
  childProcess.exec = execMock;
  childProcess.execSync = execSyncMock;
  if (execFileMock) childProcess.execFile = execFileMock;
  delete require.cache[modulePath];
  return require(modulePath);
};

// Helpers to program the async `openclaw --version` probe (execFile-based).
const versionResult = (raw) => (cmd, args, opts, cb) => cb(null, raw, "");
const versionFailure = (message) => (cmd, args, opts, cb) =>
  cb(new Error(message), "", "");

// Helper to program the async `openclaw update status --json` probe
// (exec-based; the service's injectable execImpl defaults to it).
const updateStatusResult = (raw) => (cmd, opts, cb) => cb(null, raw, "");
const updateStatusFailure = (message) => (cmd, opts, cb) =>
  cb(new Error(message), "", "");

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

const kUpdateStatusCommand = "openclaw update status --json";

describe("server/openclaw-version verifyStagedLifecycle", () => {
  const { verifyStagedLifecycle } = require("../../lib/server/openclaw-version");
  const pkgDir = "/staged/node_modules/openclaw";
  const guardPath = `${pkgDir}/dist/openclaw-install-guard`;

  const makeFs = (present) => {
    const files = new Set(present);
    return {
      existsSync: (p) => files.has(p),
      _delete: (p) => files.delete(p),
      _files: files,
    };
  };

  it("is a no-op when the guard is already gone (scripts ran, or stable)", async () => {
    const execImpl = vi.fn();
    const fsModule = makeFs([]); // no guard
    await verifyStagedLifecycle({ openclawPackageDir: pkgDir, execImpl, fsModule });
    expect(execImpl).not.toHaveBeenCalled();
  });

  it("runs the lifecycle scripts manually when the guard remains, then passes", async () => {
    const fsModule = makeFs([
      guardPath,
      `${pkgDir}/scripts/preinstall-package-manager-warning.mjs`,
      `${pkgDir}/scripts/postinstall-bundled-plugins.mjs`,
    ]);
    const execImpl = vi.fn((cmd, opts, cb) => {
      // The preinstall script deletes the guard on success.
      if (cmd.includes("preinstall")) fsModule._delete(guardPath);
      cb(null, "", "");
    });
    await verifyStagedLifecycle({ openclawPackageDir: pkgDir, execImpl, fsModule });
    expect(execImpl).toHaveBeenCalledTimes(2);
  });

  it("rejects when the guard survives even after running the scripts", async () => {
    const fsModule = makeFs([
      guardPath,
      `${pkgDir}/scripts/preinstall-package-manager-warning.mjs`,
    ]);
    const execImpl = vi.fn((cmd, opts, cb) => cb(null, "", "")); // never deletes guard
    await expect(
      verifyStagedLifecycle({ openclawPackageDir: pkgDir, execImpl, fsModule }),
    ).rejects.toThrow(/install incomplete/i);
  });

  it("propagates a lifecycle-script failure", async () => {
    const fsModule = makeFs([
      guardPath,
      `${pkgDir}/scripts/preinstall-package-manager-warning.mjs`,
    ]);
    const execImpl = vi.fn((cmd, opts, cb) => cb(new Error("script crashed")));
    await expect(
      verifyStagedLifecycle({ openclawPackageDir: pkgDir, execImpl, fsModule }),
    ).rejects.toThrow(/script crashed/);
  });

  it("fails staging when the guard is removed but POSTINSTALL fails (E-C5)", async () => {
    // Guard absence proves only preinstall ran — a postinstall failure after
    // the guard is gone must still fail staging, never save to the overlay.
    const fsModule = makeFs([
      guardPath,
      `${pkgDir}/scripts/preinstall-package-manager-warning.mjs`,
      `${pkgDir}/scripts/postinstall-bundled-plugins.mjs`,
    ]);
    const execImpl = vi.fn((cmd, opts, cb) => {
      if (cmd.includes("preinstall")) {
        fsModule._delete(guardPath); // preinstall succeeded
        return cb(null, "", "");
      }
      cb(new Error("postinstall: bundled plugin prune failed"));
    });
    await expect(
      verifyStagedLifecycle({ openclawPackageDir: pkgDir, execImpl, fsModule }),
    ).rejects.toThrow(/postinstall/);
    // Both scripts were attempted, in order.
    expect(execImpl.mock.calls[0][0]).toContain("preinstall");
    expect(execImpl.mock.calls[1][0]).toContain("postinstall");
  });
});

const createService = ({ isOnboarded = false } = {}) => {
  const execMock = vi.fn();
  const execSyncMock = vi.fn();
  const execFileMock = vi.fn(versionFailure("no execFile mock programmed"));
  const { createOpenclawVersionService } = loadVersionModule({
    execMock,
    execSyncMock,
    execFileMock,
  });
  const gatewayEnv = vi.fn(() => ({ OPENCLAW_GATEWAY_TOKEN: "token" }));
  const restartGateway = vi.fn();
  const service = createOpenclawVersionService({
    gatewayEnv,
    restartGateway,
    isOnboarded: () => isOnboarded,
  });
  return {
    service,
    gatewayEnv,
    restartGateway,
    execMock,
    execSyncMock,
    execFileMock,
  };
};

describe("server/openclaw-version", () => {
  afterEach(() => {
    childProcess.exec = originalExec;
    childProcess.execFile = originalExecFile;
    childProcess.execSync = originalExecSync;
    nodeRuntime.assertSupportedNodeVersion = originalAssertSupportedNodeVersion;
    delete require.cache[modulePath];
    vi.restoreAllMocks();
  });

  it("reads current version async and serves the cache within TTL", async () => {
    const { service, gatewayEnv, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3\n"));

    const first = await service.readOpenclawVersionAsync();
    const second = await service.readOpenclawVersionAsync();
    const syncRead = service.readOpenclawVersion();

    expect(first).toBe("1.2.3");
    expect(second).toBe("1.2.3");
    expect(syncRead).toBe("1.2.3");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock).toHaveBeenCalledWith(
      "openclaw",
      ["--version"],
      { env: gatewayEnv(), timeout: 5000, encoding: "utf8" },
      expect.any(Function),
    );
  });

  it("never spawns synchronously — the sync read returns the cache and kicks a background refresh", async () => {
    const { service, execSyncMock, execFileMock } = createService();
    let releaseProbe;
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      releaseProbe = () => cb(null, "openclaw 1.2.3\n", "");
    });

    // Cold cache: sync read returns null immediately, spawn happens async.
    expect(service.readOpenclawVersion()).toBe(null);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execSyncMock).not.toHaveBeenCalled();
    // A second read while the probe is in flight coalesces onto it.
    expect(service.readOpenclawVersion()).toBe(null);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    releaseProbe();
    expect(await service.readOpenclawVersionAsync()).toBe("1.2.3");
    expect(service.readOpenclawVersion()).toBe("1.2.3");
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("forces a fresh probe on refreshOpenclawVersion even inside the TTL", async () => {
    const { service, execFileMock } = createService();
    execFileMock
      .mockImplementationOnce(versionResult("openclaw 1.2.3\n"))
      .mockImplementationOnce(versionResult("openclaw 1.2.4\n"));

    const first = await service.readOpenclawVersionAsync();
    const refreshed = await service.refreshOpenclawVersion();

    expect(first).toBe("1.2.3");
    expect(refreshed).toBe("1.2.4");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("readOpenclawVersion({ refresh: true }) forces a background probe even inside the TTL", async () => {
    const { service, execFileMock } = createService();
    execFileMock.mockImplementationOnce(versionResult("openclaw 1.2.3\n"));

    expect(await service.readOpenclawVersionAsync()).toBe("1.2.3");
    // Inside the TTL the plain read serves the cache without spawning...
    expect(service.readOpenclawVersion()).toBe("1.2.3");
    expect(execFileMock).toHaveBeenCalledTimes(1);
    // ...but refresh kicks a new background probe (stale value returned now).
    let releaseProbe;
    execFileMock.mockImplementationOnce((cmd, args, opts, cb) => {
      releaseProbe = () => cb(null, "openclaw 1.2.4\n", "");
    });
    expect(service.readOpenclawVersion({ refresh: true })).toBe("1.2.3");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    releaseProbe();
    await flushAsync();
    expect(service.readOpenclawVersion()).toBe("1.2.4");
  });

  it("dedupes rapid refresh reads into a single background probe", async () => {
    const { service, execFileMock } = createService();
    let releaseProbe;
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      releaseProbe = () => cb(null, "openclaw 9.9.9\n", "");
    });

    const first = service.readOpenclawVersion({ refresh: true });
    const second = service.readOpenclawVersion({ refresh: true });

    expect(first).toBe(null);
    expect(second).toBe(null);
    expect(execFileMock).toHaveBeenCalledTimes(1);

    releaseProbe();
    await flushAsync();
    expect(service.readOpenclawVersion()).toBe("9.9.9");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent refreshes into one spawn", async () => {
    const { service, execFileMock } = createService();
    let releaseProbe;
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      releaseProbe = () => cb(null, "openclaw 9.9.9\n", "");
    });

    const a = service.refreshOpenclawVersion();
    const b = service.refreshOpenclawVersion();
    releaseProbe();

    expect(await a).toBe("9.9.9");
    expect(await b).toBe("9.9.9");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("exposes fetchOpenclawVersion as an alias of the coalesced forced refresh", async () => {
    const { service, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 3.0.0\n"));

    // Upstream callers (register-server-routes prewarm) probe for this name.
    expect(service.fetchOpenclawVersion).toBe(service.refreshOpenclawVersion);
    expect(await service.fetchOpenclawVersion()).toBe("3.0.0");
  });

  it("returns update availability when latest version is newer", async () => {
    const { service, gatewayEnv, execMock, execSyncMock, execFileMock } =
      createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execMock.mockImplementationOnce(
      updateStatusResult(
        JSON.stringify({
          availability: { available: true, latestVersion: "1.3.0" },
        }),
      ),
    );

    const status = await service.getVersionStatus(false);

    expect(status).toEqual({
      ok: true,
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      hasUpdate: true,
    });
    // The update-status probe is async exec with an 8s timeout — never a
    // synchronous spawn on the request path.
    expect(execMock).toHaveBeenCalledWith(
      kUpdateStatusCommand,
      { env: gatewayEnv(), timeout: 8000, encoding: "utf8" },
      expect.any(Function),
    );
    expect(execSyncMock).not.toHaveBeenCalled();
  });

  it("uses the cached current version for status without spawning --version again", async () => {
    const { service, execMock, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execMock.mockImplementation(
      updateStatusResult(
        JSON.stringify({
          availability: { available: false, latestVersion: "1.2.3" },
        }),
      ),
    );

    await service.refreshOpenclawVersion();
    const status = await service.getVersionStatus(false);

    expect(status.currentVersion).toBe("1.2.3");
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("parses update status json from noisy CLI output", async () => {
    const { service, execMock, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execMock.mockImplementationOnce(
      updateStatusResult(
        `[plugins] [auth]\n${JSON.stringify({
          availability: { available: true, latestVersion: "1.3.0" },
        })}`,
      ),
    );

    const status = await service.getVersionStatus(false);

    expect(status).toEqual({
      ok: true,
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      hasUpdate: true,
    });
  });

  it("returns error status when update status command fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service, execMock, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execMock.mockImplementationOnce(updateStatusFailure("status check failed"));

    const status = await service.getVersionStatus(false);

    expect(status.ok).toBe(false);
    expect(status.currentVersion).toBe("1.2.3");
    expect(status.latestVersion).toBe(null);
    expect(status.hasUpdate).toBe(false);
    expect(status.error).toContain("status check failed");
  });

  it("keeps the last cached update fields when a later status refresh fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service, execMock, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execMock
      .mockImplementationOnce(
        updateStatusResult(
          JSON.stringify({
            availability: { available: true, latestVersion: "1.3.0" },
          }),
        ),
      )
      .mockImplementationOnce(updateStatusFailure("status check failed"));

    const seeded = await service.getVersionStatus(false);
    expect(seeded.ok).toBe(true);

    const status = await service.getVersionStatus(true);

    expect(status.ok).toBe(false);
    expect(status.currentVersion).toBe("1.2.3");
    // The last successfully cached update fields survive the failure.
    expect(status.latestVersion).toBe("1.3.0");
    expect(status.hasUpdate).toBe(true);
    expect(status.error).toContain("status check failed");
  });

  it("repoints the legacy updater at the release-channel system", async () => {
    const { service, execMock, restartGateway } = createService({
      isOnboarded: true,
    });

    const result = await service.updateOpenclaw();

    expect(result.status).toBe(410);
    expect(result.body).toEqual(
      expect.objectContaining({
        ok: false,
        code: "use_release_channel",
      }),
    );
    // No second installer may mutate node_modules or bounce the gateway.
    expect(execMock).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("clears the version cache on demand", async () => {
    const { service, execFileMock } = createService();
    execFileMock.mockImplementationOnce(versionResult("openclaw 1.2.3\n"));

    expect(await service.readOpenclawVersionAsync()).toBe("1.2.3");
    expect(execFileMock).toHaveBeenCalledTimes(1);

    service.clearVersionCache();
    expect(execFileMock).toHaveBeenCalledTimes(1);
    execFileMock.mockImplementationOnce(versionResult("openclaw 1.3.0\n"));
    expect(await service.readOpenclawVersionAsync()).toBe("1.3.0");
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("returns the cached version when openclaw --version fails", async () => {
    const { service, execFileMock } = createService();
    execFileMock.mockImplementationOnce(
      versionFailure("spawn openclaw ENOENT"),
    );

    expect(await service.refreshOpenclawVersion()).toBe(null);

    execFileMock.mockImplementationOnce(versionResult("openclaw 2.0.0"));
    expect(await service.refreshOpenclawVersion()).toBe("2.0.0");

    execFileMock.mockImplementationOnce(versionFailure("still broken"));
    expect(await service.refreshOpenclawVersion()).toBe("2.0.0");
  });

  it("backs off after a failed probe instead of re-spawning every read", async () => {
    const { service, execFileMock } = createService();
    const baseNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(baseNow);
    execFileMock.mockImplementation(versionFailure("spawn openclaw ENOENT"));

    // First read kicks one probe; the failure arms the backoff window.
    expect(service.readOpenclawVersion()).toBe(null);
    await service.refreshOpenclawVersion();
    execFileMock.mockClear();

    // Inside the backoff window: reads must not re-spawn.
    expect(service.readOpenclawVersion()).toBe(null);
    expect(service.readOpenclawVersion()).toBe(null);
    expect(execFileMock).not.toHaveBeenCalled();

    // After the window: the next read retries (and can recover).
    nowSpy.mockReturnValue(baseNow + 31_000);
    let releaseProbe;
    execFileMock.mockImplementation((cmd, args, opts, cb) => {
      releaseProbe = () => cb(null, "openclaw 2.0.0", "");
    });
    expect(service.readOpenclawVersion()).toBe(null);
    expect(execFileMock).toHaveBeenCalledTimes(1);
    releaseProbe();
    expect(await service.readOpenclawVersionAsync()).toBe("2.0.0");
  });

  it("serves the update status from cache within the TTL", async () => {
    const { service, execMock, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execMock.mockImplementationOnce(
      updateStatusResult(
        JSON.stringify({
          availability: { available: false, latestVersion: "1.2.3" },
        }),
      ),
    );

    const first = await service.getVersionStatus(false);
    const second = await service.getVersionStatus(false);

    expect(first).toEqual({
      ok: true,
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      hasUpdate: false,
    });
    expect(second).toEqual(first);
    expect(execMock).toHaveBeenCalledTimes(1);
  });

  it("reports an error when update status output has no JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service, execMock, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execMock.mockImplementationOnce(updateStatusResult("no json in this output"));

    const status = await service.getVersionStatus(false);

    expect(status.ok).toBe(false);
    expect(status.error).toContain(
      "openclaw update status returned invalid JSON payload",
    );
  });

  it("installs an exact version into a temp dir with the nested strategy", async () => {
    nodeRuntime.assertSupportedNodeVersion = () => {};
    const execMock = vi.fn((cmd, opts, callback) => callback(null, "added", ""));
    const execSyncMock = vi.fn();
    const { installOpenclawVersionToTempDir } = loadVersionModule({
      execMock,
      execSyncMock,
    });

    const result = await installOpenclawVersionToTempDir({
      versionSpec: "2026.8.1-beta.3",
      execImpl: execMock,
    });

    expect(result.tmpDir).toBeTruthy();
    expect(result.openclawPackageDir).toContain("node_modules");
    const fs = require("fs");
    const manifest = JSON.parse(
      fs.readFileSync(require("path").join(result.tmpDir, "package.json"), "utf8"),
    );
    expect(manifest.dependencies.openclaw).toBe("2026.8.1-beta.3");
    // npm >= 11.16 script allowlist — MANIFEST field, not the --allow-scripts
    // flag (npm 11.19 rejects the flag in project-scoped installs; live-tested).
    expect(manifest.allowScripts).toEqual(["openclaw"]);
    expect(execMock).toHaveBeenCalledWith(
      "npm install --omit=dev --prefer-online --package-lock=false --install-strategy=nested",
      expect.objectContaining({
        cwd: result.tmpDir,
        env: expect.objectContaining({
          npm_config_update_notifier: "false",
          npm_config_fund: "false",
          npm_config_audit: "false",
          npm_config_cache: expect.stringContaining("cache"),
        }),
        timeout: 180000,
      }),
      expect.any(Function),
    );
    result.cleanup();
    expect(fs.existsSync(result.tmpDir)).toBe(false);
  });

  it("keeps gateway secrets out of the candidate install's environment", async () => {
    nodeRuntime.assertSupportedNodeVersion = () => {};
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    const previousKeyring = process.env.GOG_KEYRING_PASSWORD;
    process.env.ANTHROPIC_API_KEY = "sk-test-secret";
    process.env.GOG_KEYRING_PASSWORD = "keyring-secret";
    try {
      const execMock = vi.fn((cmd, opts, callback) => callback(null, "added", ""));
      const { installOpenclawVersionToTempDir } = loadVersionModule({
        execMock,
        execSyncMock: vi.fn(),
      });

      const result = await installOpenclawVersionToTempDir({
        versionSpec: "1.0.0",
        execImpl: execMock,
      });

      // npm install runs the candidate package's install scripts BEFORE
      // verification accepts it — they must never see the gateway's secrets.
      const env = execMock.mock.calls[0][1].env;
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GOG_KEYRING_PASSWORD).toBeUndefined();
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.npm_config_cache).toContain("cache");
      // HOME is the temp install dir, not the data volume: lifecycle scripts
      // must not get $HOME-relative reads into .openclaw state or .env.
      expect(env.HOME).toBeTruthy();
      expect(env.HOME).not.toBe(process.env.HOME);
      expect(env.HOME).toContain("openclaw-prepare-");
      // Registry/config pinned away from agent-writable dotfiles — with
      // DISTINCT user/global paths (npm hard-errors on double-loading the
      // same file; caught by the live tier).
      expect(env.npm_config_registry).toBe("https://registry.npmjs.org");
      expect(env.npm_config_userconfig).not.toBe(env.npm_config_globalconfig);
      expect(env.npm_config_userconfig).toContain("openclaw-prepare-");
      result.cleanup();
    } finally {
      if (previousApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = previousApiKey;
      if (previousKeyring === undefined) delete process.env.GOG_KEYRING_PASSWORD;
      else process.env.GOG_KEYRING_PASSWORD = previousKeyring;
    }
  });

  it("rejects temp installs when the Node.js runtime is unsupported", async () => {
    nodeRuntime.assertSupportedNodeVersion = () => {
      throw new Error("Node.js 18.0.0 is not supported.");
    };
    const execMock = vi.fn();
    const execSyncMock = vi.fn();
    const { installOpenclawVersionToTempDir } = loadVersionModule({
      execMock,
      execSyncMock,
    });

    await expect(
      installOpenclawVersionToTempDir({ versionSpec: "1.0.0", execImpl: execMock }),
    ).rejects.toThrow("is not supported");
    expect(execMock).not.toHaveBeenCalled();
  });

  it("rejects with stderr details and cleans up when npm install fails", async () => {
    nodeRuntime.assertSupportedNodeVersion = () => {};
    const execMock = vi.fn((cmd, opts, callback) =>
      callback(new Error("exec failed"), "", "npm ERR! EACCES\n"),
    );
    const execSyncMock = vi.fn();
    const { installOpenclawVersionToTempDir } = loadVersionModule({
      execMock,
      execSyncMock,
    });

    await expect(
      installOpenclawVersionToTempDir({ versionSpec: "1.0.0", execImpl: execMock }),
    ).rejects.toThrow("npm ERR! EACCES");
  });

  it("EXEC path: finishOk runs verifyStagedLifecycle — a guard-bearing tree rejects and is removed", async () => {
    nodeRuntime.assertSupportedNodeVersion = () => {};
    const fs = require("fs");
    const path = require("path");
    let stagedTmpDir;
    const execMock = vi.fn((cmd, opts, callback) => {
      if (String(cmd).startsWith("npm install")) {
        stagedTmpDir = opts.cwd;
        // A "successful" install whose lifecycle scripts were skipped: the
        // staged tree still carries dist/openclaw-install-guard.
        const distDir = path.join(opts.cwd, "node_modules", "openclaw", "dist");
        fs.mkdirSync(distDir, { recursive: true });
        fs.writeFileSync(path.join(distDir, "openclaw-install-guard"), "guard");
        return callback(null, "added", "");
      }
      return callback(null, "", "");
    });
    const { installOpenclawVersionToTempDir } = loadVersionModule({
      execMock,
      execSyncMock: vi.fn(),
    });

    await expect(
      installOpenclawVersionToTempDir({
        versionSpec: "2026.8.1-beta.3",
        execImpl: execMock,
      }),
    ).rejects.toThrow("install incomplete");
    // The incomplete tree must never survive to reach the overlay store.
    expect(stagedTmpDir).toContain("openclaw-prepare-");
    expect(fs.existsSync(stagedTmpDir)).toBe(false);
  });

  // Streamed installs (the release-channel apply path) run through an injected
  // runStreamImpl instead of exec so a hang or OOM kill still leaves output in
  // the durable update log.
  describe("streamed installs via runStreamImpl", () => {
    const fs = require("fs");

    const loadStreamedInstaller = () => {
      nodeRuntime.assertSupportedNodeVersion = () => {};
      const { installOpenclawVersionToTempDir } = loadVersionModule({
        execMock: vi.fn(),
        execSyncMock: vi.fn(),
      });
      return installOpenclawVersionToTempDir;
    };

    it("resolves the temp install dirs with the streamed tail as stdout", async () => {
      const installOpenclawVersionToTempDir = loadStreamedInstaller();
      const runStreamed = vi.fn(async () => ({
        ok: true,
        tail: "added 42 packages\n",
      }));

      const result = await installOpenclawVersionToTempDir({
        versionSpec: "2026.8.1",
        runStreamImpl: { runStreamed },
      });

      expect(result.tmpDir).toContain("openclaw-prepare-");
      expect(result.openclawPackageDir).toBe(
        require("path").join(result.tmpDir, "node_modules", "openclaw"),
      );
      expect(result.stdout).toBe("added 42 packages");
      // The staged-lifecycle verification ran inside finishOk (merge
      // resolution: it covers the streamed path, not just exec).
      expect(result.lifecycleVerified).toBe(true);
      expect(runStreamed).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "npm",
          args: expect.arrayContaining(["install", "--install-strategy=nested"]),
          cwd: result.tmpDir,
          timeoutMs: 180000,
        }),
      );
      expect(fs.existsSync(result.tmpDir)).toBe(true);
      result.cleanup();
      expect(fs.existsSync(result.tmpDir)).toBe(false);
    });

    it("rejects with a timeout message and removes the temp dir when the install times out", async () => {
      const installOpenclawVersionToTempDir = loadStreamedInstaller();
      const runStreamed = vi.fn(async ({ cwd }) => {
        runStreamed.tmpDir = cwd;
        return { ok: false, timedOut: true, tail: "still compiling..." };
      });

      await expect(
        installOpenclawVersionToTempDir({
          versionSpec: "1.0.0",
          timeoutMs: 5000,
          runStreamImpl: { runStreamed },
        }),
      ).rejects.toThrow("npm install timed out after 5s");
      expect(runStreamed.tmpDir).toContain("openclaw-prepare-");
      expect(fs.existsSync(runStreamed.tmpDir)).toBe(false);
    });

    it("rejects with the streamed tail and cleans up when the install fails", async () => {
      const installOpenclawVersionToTempDir = loadStreamedInstaller();
      const runStreamed = vi.fn(async ({ cwd }) => {
        runStreamed.tmpDir = cwd;
        return { ok: false, tail: "npm ERR! E404 openclaw@9.9.9 not found\n" };
      });

      await expect(
        installOpenclawVersionToTempDir({
          versionSpec: "9.9.9",
          runStreamImpl: { runStreamed },
        }),
      ).rejects.toThrow("npm ERR! E404 openclaw@9.9.9 not found");
      expect(fs.existsSync(runStreamed.tmpDir)).toBe(false);
    });

    it("falls back to a generic failure message when the runner reports no details", async () => {
      const installOpenclawVersionToTempDir = loadStreamedInstaller();
      const runStreamed = vi.fn(async ({ cwd }) => {
        runStreamed.tmpDir = cwd;
        return { ok: false, error: "", tail: "   " };
      });

      await expect(
        installOpenclawVersionToTempDir({
          versionSpec: "3.2.1",
          runStreamImpl: { runStreamed },
        }),
      ).rejects.toThrow("Failed to install openclaw@3.2.1");
      expect(fs.existsSync(runStreamed.tmpDir)).toBe(false);
    });

    it("STREAMED path: finishOk runs verifyStagedLifecycle — a guard-bearing tree rejects and is removed", async () => {
      const installOpenclawVersionToTempDir = loadStreamedInstaller();
      const path = require("path");
      // npm reports success but the lifecycle scripts were skipped: the
      // runner plants the guard-bearing staged tree the way npm would leave
      // it. A naive merge would have skipped this check on the streamed
      // (production apply) path entirely.
      const runStreamed = vi.fn(async ({ cwd }) => {
        runStreamed.tmpDir = cwd;
        const distDir = path.join(cwd, "node_modules", "openclaw", "dist");
        fs.mkdirSync(distDir, { recursive: true });
        fs.writeFileSync(path.join(distDir, "openclaw-install-guard"), "guard");
        return { ok: true, tail: "added 42 packages, scripts skipped\n" };
      });

      await expect(
        installOpenclawVersionToTempDir({
          versionSpec: "2026.8.1",
          runStreamImpl: { runStreamed },
        }),
      ).rejects.toThrow("install incomplete");
      expect(runStreamed.tmpDir).toContain("openclaw-prepare-");
      expect(fs.existsSync(runStreamed.tmpDir)).toBe(false);
    });

    it("propagates runner rejections and cleans up the temp dir", async () => {
      const installOpenclawVersionToTempDir = loadStreamedInstaller();
      const runStreamed = vi.fn(async ({ cwd }) => {
        runStreamed.tmpDir = cwd;
        throw new Error("spawn npm ENOENT");
      });

      await expect(
        installOpenclawVersionToTempDir({
          versionSpec: "1.0.0",
          runStreamImpl: { runStreamed },
        }),
      ).rejects.toThrow("spawn npm ENOENT");
      expect(fs.existsSync(runStreamed.tmpDir)).toBe(false);
    });
  });
});

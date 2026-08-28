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

  it("returns update availability when latest version is newer", async () => {
    const { service, execSyncMock, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        availability: { available: true, latestVersion: "1.3.0" },
      }),
    );

    const status = await service.getVersionStatus(false);

    expect(status).toEqual({
      ok: true,
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      hasUpdate: true,
    });
  });

  it("parses update status json from noisy CLI output", async () => {
    const { service, execSyncMock, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execSyncMock.mockReturnValueOnce(
      `[plugins] [auth]\n${JSON.stringify({
        availability: { available: true, latestVersion: "1.3.0" },
      })}`,
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
    const { service, execSyncMock, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execSyncMock.mockImplementationOnce(() => {
      throw new Error("status check failed");
    });

    const status = await service.getVersionStatus(false);

    expect(status.ok).toBe(false);
    expect(status.currentVersion).toBe("1.2.3");
    expect(status.latestVersion).toBe(null);
    expect(status.hasUpdate).toBe(false);
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
    const { service, execSyncMock, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execSyncMock.mockReturnValueOnce(
      JSON.stringify({
        availability: { available: false, latestVersion: "1.2.3" },
      }),
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
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });

  it("reports an error when update status output has no JSON", async () => {
    const { service, execSyncMock, execFileMock } = createService();
    execFileMock.mockImplementation(versionResult("openclaw 1.2.3"));
    execSyncMock.mockReturnValueOnce("no json in this output");

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
});

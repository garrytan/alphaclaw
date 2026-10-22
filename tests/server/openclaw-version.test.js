const childProcess = require("child_process");

const modulePath = require.resolve("../../lib/server/openclaw-version");
const originalExecFile = childProcess.execFile;
const originalExecSync = childProcess.execSync;

const loadVersionModule = ({ execSyncMock, execFileMock }) => {
  childProcess.execSync = execSyncMock;
  childProcess.execFile = execFileMock;
  delete require.cache[modulePath];
  return require(modulePath);
};

// Helpers to program the async `openclaw --version` probe (execFile-based).
const versionResult = (raw) => (cmd, args, opts, cb) => cb(null, raw, "");
const versionFailure = (message) => (cmd, args, opts, cb) =>
  cb(new Error(message), "", "");

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

const createService = () => {
  const execSyncMock = vi.fn();
  const execFileMock = vi.fn(versionFailure("no execFile mock programmed"));
  const { createOpenclawVersionService } = loadVersionModule({ execSyncMock, execFileMock });
  const gatewayEnv = vi.fn(() => ({ OPENCLAW_GATEWAY_TOKEN: "token" }));
  const service = createOpenclawVersionService({ gatewayEnv });
  return { service, gatewayEnv, execSyncMock, execFileMock };
};

describe("server/openclaw-version", () => {
  afterEach(() => {
    childProcess.execFile = originalExecFile;
    childProcess.execSync = originalExecSync;
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
});

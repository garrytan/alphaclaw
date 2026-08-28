const modulePath = require.resolve("../../lib/server/openclaw-version");
const nodeRuntime = require("../../lib/node-runtime");
const originalAssertSupportedNodeVersion = nodeRuntime.assertSupportedNodeVersion;

// installOpenclawVersionToTempDir destructures assertSupportedNodeVersion at
// module load; patch node-runtime first and re-require to control it.
const loadVersionModule = () => {
  delete require.cache[modulePath];
  return require(modulePath);
};

const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

const kVersionCommand = "openclaw --version";
const kUpdateStatusCommand = "openclaw update status --json";

// Node-callback-style exec mock; the version service is constructed with this
// injected (no child_process monkey-patching).
const createService = ({ execImpl, isOnboarded = false } = {}) => {
  const { createOpenclawVersionService } = loadVersionModule();
  const gatewayEnv = vi.fn(() => ({ OPENCLAW_GATEWAY_TOKEN: "token" }));
  const restartGateway = vi.fn();
  const service = createOpenclawVersionService({
    gatewayEnv,
    restartGateway,
    isOnboarded: () => isOnboarded,
    execImpl,
  });
  return { service, gatewayEnv, restartGateway };
};

describe("server/openclaw-version", () => {
  afterEach(() => {
    nodeRuntime.assertSupportedNodeVersion = originalAssertSupportedNodeVersion;
    delete require.cache[modulePath];
  });

  it("fetches and caches the normalized current version", async () => {
    const execImpl = vi.fn((cmd, opts, cb) => cb(null, "openclaw 1.2.3\n", ""));
    const { service, gatewayEnv } = createService({ execImpl });

    const version = await service.fetchOpenclawVersion();

    expect(version).toBe("1.2.3");
    expect(execImpl).toHaveBeenCalledTimes(1);
    expect(execImpl).toHaveBeenCalledWith(
      kVersionCommand,
      { env: gatewayEnv(), timeout: 5000, encoding: "utf8" },
      expect.any(Function),
    );

    // Cached read serves the fetched value without spawning again.
    expect(service.readOpenclawVersion()).toBe("1.2.3");
    expect(execImpl).toHaveBeenCalledTimes(1);
  });

  it("readOpenclawVersion never blocks: null before the first fetch lands, cached after", async () => {
    const callbacks = [];
    const execImpl = vi.fn((cmd, opts, cb) => {
      callbacks.push(cb);
    });
    const { service } = createService({ execImpl });

    // Before any fetch completes the cached read is null but kicks a fetch.
    expect(service.readOpenclawVersion()).toBe(null);
    expect(execImpl).toHaveBeenCalledTimes(1);

    // A second read while the fetch is in flight does not spawn again.
    expect(service.readOpenclawVersion()).toBe(null);
    expect(execImpl).toHaveBeenCalledTimes(1);

    callbacks[0](null, "openclaw 1.2.3\n", "");
    await flushAsync();

    // Fresh cache within the TTL: served without a new spawn.
    expect(service.readOpenclawVersion()).toBe("1.2.3");
    expect(service.readOpenclawVersion()).toBe("1.2.3");
    expect(execImpl).toHaveBeenCalledTimes(1);
  });

  it("dedupes rapid refresh reads into a single background fetch", async () => {
    const callbacks = [];
    const execImpl = vi.fn((cmd, opts, cb) => {
      callbacks.push(cb);
    });
    const { service } = createService({ execImpl });

    const first = service.readOpenclawVersion({ refresh: true });
    const second = service.readOpenclawVersion({ refresh: true });

    expect(first).toBe(null);
    expect(second).toBe(null);
    expect(execImpl).toHaveBeenCalledTimes(1);

    callbacks[0](null, "openclaw 9.9.9\n", "");
    await flushAsync();

    expect(service.readOpenclawVersion()).toBe("9.9.9");
    expect(execImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves fetches to the previous cached value when openclaw --version fails", async () => {
    const execImpl = vi
      .fn()
      .mockImplementationOnce((cmd, opts, cb) => cb(null, "openclaw 2.0.0\n", ""))
      .mockImplementation((cmd, opts, cb) =>
        cb(new Error("spawn openclaw ENOENT"), "", ""),
      );
    const { service } = createService({ execImpl });

    await expect(service.fetchOpenclawVersion()).resolves.toBe("2.0.0");
    // Exec now fails: the fetch resolves (not rejects) to the cached value.
    await expect(service.fetchOpenclawVersion()).resolves.toBe("2.0.0");
    expect(service.readOpenclawVersion()).toBe("2.0.0");
  });

  it("resolves failed fetches to null when nothing was ever cached", async () => {
    const execImpl = vi.fn((cmd, opts, cb) => cb(new Error("still broken"), "", ""));
    const { service } = createService({ execImpl });

    await expect(service.fetchOpenclawVersion()).resolves.toBe(null);
    expect(service.readOpenclawVersion()).toBe(null);
  });

  it("returns update availability when the latest version is newer", async () => {
    const execImpl = vi.fn((cmd, opts, cb) => {
      if (cmd === kVersionCommand) return cb(null, "openclaw 1.2.3\n", "");
      return cb(
        null,
        JSON.stringify({ availability: { available: true, latestVersion: "1.3.0" } }),
        "",
      );
    });
    const { service, gatewayEnv } = createService({ execImpl });

    const status = await service.getVersionStatus(false);

    expect(status).toEqual({
      ok: true,
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      hasUpdate: true,
    });
    expect(execImpl).toHaveBeenCalledWith(
      kUpdateStatusCommand,
      { env: gatewayEnv(), timeout: 8000, encoding: "utf8" },
      expect.any(Function),
    );
  });

  it("uses the cached current version for status without spawning --version again", async () => {
    const execImpl = vi.fn((cmd, opts, cb) => {
      if (cmd === kVersionCommand) return cb(null, "openclaw 1.2.3\n", "");
      return cb(
        null,
        JSON.stringify({ availability: { available: false, latestVersion: "1.2.3" } }),
        "",
      );
    });
    const { service } = createService({ execImpl });

    await service.fetchOpenclawVersion();
    const status = await service.getVersionStatus(false);

    expect(status.currentVersion).toBe("1.2.3");
    const versionCalls = execImpl.mock.calls.filter(
      ([cmd]) => cmd === kVersionCommand,
    );
    expect(versionCalls).toHaveLength(1);
  });

  it("parses update status json from noisy CLI output", async () => {
    const execImpl = vi.fn((cmd, opts, cb) => {
      if (cmd === kVersionCommand) return cb(null, "openclaw 1.2.3", "");
      return cb(
        null,
        `[plugins] [auth]\n${JSON.stringify({
          availability: { available: true, latestVersion: "1.3.0" },
        })}`,
        "",
      );
    });
    const { service } = createService({ execImpl });

    const status = await service.getVersionStatus(false);

    expect(status).toEqual({
      ok: true,
      currentVersion: "1.2.3",
      latestVersion: "1.3.0",
      hasUpdate: true,
    });
  });

  it("serves the update status from cache within the TTL", async () => {
    const execImpl = vi.fn((cmd, opts, cb) => {
      if (cmd === kVersionCommand) return cb(null, "openclaw 1.2.3", "");
      return cb(
        null,
        JSON.stringify({ availability: { available: false, latestVersion: "1.2.3" } }),
        "",
      );
    });
    const { service } = createService({ execImpl });

    const first = await service.getVersionStatus(false);
    const second = await service.getVersionStatus(false);

    expect(first).toEqual({
      ok: true,
      currentVersion: "1.2.3",
      latestVersion: "1.2.3",
      hasUpdate: false,
    });
    expect(second).toEqual(first);
    // One --version spawn plus one update-status spawn, both cached after.
    expect(execImpl).toHaveBeenCalledTimes(2);
  });

  it("returns an error status with cached update fields when the status command fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    let updateStatusCalls = 0;
    const execImpl = vi.fn((cmd, opts, cb) => {
      if (cmd === kVersionCommand) return cb(null, "openclaw 1.2.3", "");
      updateStatusCalls += 1;
      if (updateStatusCalls === 1) {
        return cb(
          null,
          JSON.stringify({ availability: { available: true, latestVersion: "1.3.0" } }),
          "",
        );
      }
      return cb(new Error("status check failed"), "", "");
    });
    const { service } = createService({ execImpl });

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

  it("returns error status when the update status command fails with no cache", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const execImpl = vi.fn((cmd, opts, cb) => {
      if (cmd === kVersionCommand) return cb(null, "openclaw 1.2.3", "");
      return cb(new Error("status check failed"), "", "");
    });
    const { service } = createService({ execImpl });

    const status = await service.getVersionStatus(false);

    expect(status.ok).toBe(false);
    expect(status.currentVersion).toBe("1.2.3");
    expect(status.latestVersion).toBe(null);
    expect(status.hasUpdate).toBe(false);
    expect(status.error).toContain("status check failed");
  });

  it("reports an error when update status output has no JSON", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const execImpl = vi.fn((cmd, opts, cb) => {
      if (cmd === kVersionCommand) return cb(null, "openclaw 1.2.3", "");
      return cb(null, "no json in this output", "");
    });
    const { service } = createService({ execImpl });

    const status = await service.getVersionStatus(false);

    expect(status.ok).toBe(false);
    expect(status.error).toContain(
      "openclaw update status returned invalid JSON payload",
    );
  });

  it("repoints the legacy updater at the release-channel system", async () => {
    const execImpl = vi.fn();
    const { service, restartGateway } = createService({
      execImpl,
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
    expect(execImpl).not.toHaveBeenCalled();
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("clears the version cache on demand and refetches", async () => {
    const execImpl = vi
      .fn()
      .mockImplementationOnce((cmd, opts, cb) => cb(null, "openclaw 1.2.3\n", ""))
      .mockImplementation((cmd, opts, cb) => cb(null, "openclaw 1.3.0\n", ""));
    const { service } = createService({ execImpl });

    await service.fetchOpenclawVersion();
    expect(service.readOpenclawVersion()).toBe("1.2.3");
    expect(execImpl).toHaveBeenCalledTimes(1);

    service.clearVersionCache();

    // Cache cleared: the non-blocking read is null again and kicks a refetch.
    expect(service.readOpenclawVersion()).toBe(null);
    expect(execImpl).toHaveBeenCalledTimes(2);
    await flushAsync();
    expect(service.readOpenclawVersion()).toBe("1.3.0");
    expect(execImpl).toHaveBeenCalledTimes(2);
  });

  it("installs an exact version into a temp dir with the nested strategy", async () => {
    nodeRuntime.assertSupportedNodeVersion = () => {};
    const execMock = vi.fn((cmd, opts, callback) => callback(null, "added", ""));
    const { installOpenclawVersionToTempDir } = loadVersionModule();

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
      const { installOpenclawVersionToTempDir } = loadVersionModule();

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
    const { installOpenclawVersionToTempDir } = loadVersionModule();

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
    const { installOpenclawVersionToTempDir } = loadVersionModule();

    await expect(
      installOpenclawVersionToTempDir({ versionSpec: "1.0.0", execImpl: execMock }),
    ).rejects.toThrow("npm ERR! EACCES");
  });
});

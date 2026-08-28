const childProcess = require("child_process");

const modulePath = require.resolve("../../lib/server/openclaw-version");
const nodeRuntime = require("../../lib/node-runtime");
const originalExec = childProcess.exec;
const originalExecSync = childProcess.execSync;
const originalAssertSupportedNodeVersion = nodeRuntime.assertSupportedNodeVersion;

const loadVersionModule = ({ execMock, execSyncMock }) => {
  childProcess.exec = execMock;
  childProcess.execSync = execSyncMock;
  delete require.cache[modulePath];
  return require(modulePath);
};

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

describe("server/openclaw-version resolveNpmAllowScriptsFlag (1.4)", () => {
  const { resolveNpmAllowScriptsFlag } = require("../../lib/server/openclaw-version");

  it("emits the flag only for npm >= 11.16", () => {
    expect(
      resolveNpmAllowScriptsFlag({ getNpmVersion: () => "11.16.0" }),
    ).toBe(" --allow-scripts=openclaw");
    expect(
      resolveNpmAllowScriptsFlag({ getNpmVersion: () => "12.0.1" }),
    ).toBe(" --allow-scripts=openclaw");
    expect(resolveNpmAllowScriptsFlag({ getNpmVersion: () => "11.15.9" })).toBe("");
    expect(resolveNpmAllowScriptsFlag({ getNpmVersion: () => "10.9.0" })).toBe("");
    // Unknown npm → no flag (older npm rejects it).
    expect(
      resolveNpmAllowScriptsFlag({
        getNpmVersion: () => {
          throw new Error("npm missing");
        },
      }),
    ).toBe("");
  });
});

const createService = ({ isOnboarded = false } = {}) => {
  const execMock = vi.fn();
  const execSyncMock = vi.fn();
  const { createOpenclawVersionService } = loadVersionModule({
    execMock,
    execSyncMock,
  });
  const gatewayEnv = vi.fn(() => ({ OPENCLAW_GATEWAY_TOKEN: "token" }));
  const restartGateway = vi.fn();
  const service = createOpenclawVersionService({
    gatewayEnv,
    restartGateway,
    isOnboarded: () => isOnboarded,
  });
  return { service, gatewayEnv, restartGateway, execMock, execSyncMock };
};

describe("server/openclaw-version", () => {
  afterEach(() => {
    childProcess.exec = originalExec;
    childProcess.execSync = originalExecSync;
    nodeRuntime.assertSupportedNodeVersion = originalAssertSupportedNodeVersion;
    delete require.cache[modulePath];
  });

  it("reads current version and uses cache within TTL", () => {
    const { service, gatewayEnv, execSyncMock } = createService();
    execSyncMock.mockReturnValue("openclaw 1.2.3\n");

    const first = service.readOpenclawVersion();
    const second = service.readOpenclawVersion();

    expect(first).toBe("1.2.3");
    expect(second).toBe("1.2.3");
    expect(execSyncMock).toHaveBeenCalledTimes(1);
    expect(execSyncMock).toHaveBeenCalledWith("openclaw --version", {
      env: gatewayEnv(),
      timeout: 5000,
      encoding: "utf8",
    });
  });

  it("re-reads current version when refresh is requested", () => {
    const { service, execSyncMock } = createService();
    execSyncMock
      .mockReturnValueOnce("openclaw 1.2.3\n")
      .mockReturnValueOnce("openclaw 1.2.4\n");

    const first = service.readOpenclawVersion();
    const refreshed = service.readOpenclawVersion({ refresh: true });

    expect(first).toBe("1.2.3");
    expect(refreshed).toBe("1.2.4");
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it("returns update availability when latest version is newer", async () => {
    const { service, execSyncMock } = createService();
    execSyncMock.mockReturnValueOnce("openclaw 1.2.3").mockReturnValueOnce(
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
    const { service, execSyncMock } = createService();
    execSyncMock
      .mockReturnValueOnce("openclaw 1.2.3")
      .mockReturnValueOnce(
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
    const { service, execSyncMock } = createService();
    execSyncMock
      .mockReturnValueOnce("openclaw 1.2.3")
      .mockImplementationOnce(() => {
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

  it("clears the version cache on demand", () => {
    const { service, execSyncMock } = createService();
    execSyncMock.mockReturnValue("openclaw 1.2.3\n");

    expect(service.readOpenclawVersion()).toBe("1.2.3");
    expect(execSyncMock).toHaveBeenCalledTimes(1);

    service.clearVersionCache();
    execSyncMock.mockReturnValue("openclaw 1.3.0\n");
    expect(service.readOpenclawVersion()).toBe("1.3.0");
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it("returns the cached version when openclaw --version fails", () => {
    const { service, execSyncMock } = createService();
    execSyncMock.mockImplementationOnce(() => {
      throw new Error("spawn openclaw ENOENT");
    });

    expect(service.readOpenclawVersion()).toBe(null);

    execSyncMock.mockReturnValueOnce("openclaw 2.0.0");
    expect(service.readOpenclawVersion({ refresh: true })).toBe("2.0.0");

    execSyncMock.mockImplementationOnce(() => {
      throw new Error("still broken");
    });
    expect(service.readOpenclawVersion({ refresh: true })).toBe("2.0.0");
  });

  it("serves the update status from cache within the TTL", async () => {
    const { service, execSyncMock } = createService();
    execSyncMock.mockReturnValueOnce("openclaw 1.2.3").mockReturnValueOnce(
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
    expect(execSyncMock).toHaveBeenCalledTimes(2);
  });

  it("reports an error when update status output has no JSON", async () => {
    const { service, execSyncMock } = createService();
    execSyncMock
      .mockReturnValueOnce("openclaw 1.2.3")
      .mockReturnValueOnce("no json in this output");

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
      // The allow-scripts suffix is npm-version-conditional (>= 11.16); match
      // the base command with or without it.
      expect.stringMatching(
        /^npm install --omit=dev --prefer-online --package-lock=false --install-strategy=nested( --allow-scripts=openclaw)?$/,
      ),
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

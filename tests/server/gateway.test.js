const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const {
  ALPHACLAW_DIR,
  kDefaultGatewayPort,
  kOnboardingMarkerPath,
  OPENCLAW_DIR,
} = require("../../lib/server/constants");
const {
  kDefaultOpenclawCompileCacheDir,
} = require("../../lib/server/openclaw-runtime-env");

const kLegacyControlUiSkillPath = path.join(OPENCLAW_DIR, "skills", "control-ui", "SKILL.md");
const kAlphaclawConfigPath = path.join(OPENCLAW_DIR, "alphaclaw.json");

const modulePath = require.resolve("../../lib/server/gateway");
// execFile-style mocks for the async gateway CLI calls.
const execFileOk = (stdout = "") =>
  vi.fn((file, args, opts, cb) => cb(null, stdout, ""));
const execFileFail = (props = {}) =>
  vi.fn((file, args, opts, cb) => {
    const error = Object.assign(new Error(props.message || "exec failed"), props);
    cb(error, props.stdout || "", props.stderr || "");
  });

const originalSpawn = childProcess.spawn;
const originalExecSync = childProcess.execSync;
const originalExecFile = childProcess.execFile;
const originalExec = childProcess.exec;
const originalExistsSync = fs.existsSync;
const originalMkdirSync = fs.mkdirSync;
const originalReaddirSync = fs.readdirSync;
const originalReadFileSync = fs.readFileSync;
const originalRmSync = fs.rmSync;
const originalWriteFileSync = fs.writeFileSync;
const originalCreateConnection = net.createConnection;

const createSocket = (isRunning) => {
  const running =
    typeof isRunning === "function" ? isRunning() : isRunning;
  return {
    setTimeout: vi.fn(),
    destroy: vi.fn(),
    on(event, handler) {
      if (running && event === "connect") {
        setImmediate(handler);
      }
      if (!running && event === "error") {
        setImmediate(handler);
      }
      return this;
    },
  };
};

const createChild = () => ({
  pid: 1234,
  stdout: { on: vi.fn() },
  stderr: { on: vi.fn() },
  on: vi.fn(),
  kill: vi.fn(),
  exitCode: null,
  // Real Node semantics: a live child has signalCode null; a SIGNAL-killed
  // child sets signalCode and leaves exitCode null.
  signalCode: null,
  killed: false,
});

describe("server/gateway restart behavior", () => {
  afterEach(() => {
    childProcess.spawn = originalSpawn;
    childProcess.execSync = originalExecSync;
    childProcess.execFile = originalExecFile;
    childProcess.exec = originalExec;
    fs.existsSync = originalExistsSync;
    fs.mkdirSync = originalMkdirSync;
    fs.readdirSync = originalReaddirSync;
    fs.readFileSync = originalReadFileSync;
    fs.rmSync = originalRmSync;
    fs.writeFileSync = originalWriteFileSync;
    net.createConnection = originalCreateConnection;
    delete require.cache[modulePath];
  });

  it("always cold-starts when the gateway port is listening", async () => {
    const managedChild = createChild();
    const restartSupervisor = createChild();
    // Model the real port lifecycle BEFORE requiring the module (it binds
    // execFile/spawn at load): `stop` releases the port, `--force` reopens
    // it — the restart pipeline now waits for the release before launching.
    let gatewayPortOpen = false;
    const spawnMock = vi.fn((file, args) => {
      if (args?.[0] === "gateway" && args?.[1] === "--force") {
        queueMicrotask(() => {
          gatewayPortOpen = true;
        });
        return restartSupervisor;
      }
      return managedChild;
    });
    const execSyncMock = vi.fn(() => "");
    childProcess.spawn = spawnMock;
    childProcess.execSync = execSyncMock;
    fs.existsSync = vi.fn(() => true);
    net.createConnection = vi.fn(() => createSocket(() => gatewayPortOpen));
    childProcess.execFile = vi.fn((file, args, opts, cb) => {
      if (args?.[0] === "gateway" && args?.[1] === "stop") gatewayPortOpen = false;
      cb(null, "", "");
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn(() =>
      JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.1-codex",
            },
          },
        },
      }),
    );

    await gateway.startGateway();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    gatewayPortOpen = true;
    const reloadEnv = vi.fn();
    const restartResult = await gateway.restartGateway(reloadEnv);

    expect(reloadEnv).toHaveBeenCalledTimes(1);
    // Measured downtime (stop initiated → ready) rides on the result so the
    // route can surface it in the success line and the operation record.
    expect(restartResult.downtimeMs).toEqual(expect.any(Number));
    expect(restartResult.downtimeMs).toBeGreaterThanOrEqual(0);
    expect(execSyncMock).not.toHaveBeenCalledWith(
      "openclaw gateway restart",
      expect.anything(),
    );
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      "openclaw",
      ["gateway", "--force"],
      expect.objectContaining({ env: expect.any(Object) }),
    );
    expect(managedChild.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("exports the durable OpenClaw state dir in gateway env", () => {
    const previousCompileCache = process.env.NODE_COMPILE_CACHE;
    const previousNoRespawn = process.env.OPENCLAW_NO_RESPAWN;
    delete process.env.NODE_COMPILE_CACHE;
    delete process.env.OPENCLAW_NO_RESPAWN;
    try {
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(gateway.gatewayEnv()).toEqual(
        expect.objectContaining({
          HOME: expect.any(String),
          OPENCLAW_HOME: expect.any(String),
          OPENCLAW_CONFIG_PATH: `${OPENCLAW_DIR}/openclaw.json`,
          OPENCLAW_STATE_DIR: OPENCLAW_DIR,
          XDG_CONFIG_HOME: OPENCLAW_DIR,
          NODE_COMPILE_CACHE: kDefaultOpenclawCompileCacheDir,
          OPENCLAW_NO_RESPAWN: "1",
        }),
      );
      expect(gateway.gatewayEnv().HOME).toBe(gateway.gatewayEnv().OPENCLAW_HOME);
    } finally {
      if (previousCompileCache === undefined) {
        delete process.env.NODE_COMPILE_CACHE;
      } else {
        process.env.NODE_COMPILE_CACHE = previousCompileCache;
      }
      if (previousNoRespawn === undefined) {
        delete process.env.OPENCLAW_NO_RESPAWN;
      } else {
        process.env.OPENCLAW_NO_RESPAWN = previousNoRespawn;
      }
    }
  });

  it("pins OPENCLAW_NO_AUTO_UPDATE=1 in gateway env so builds never self-update", () => {
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    // Versions are managed by the release-channel system; the gateway (or the
    // agent inside it) must never self-update out from under the channel state.
    expect(gateway.gatewayEnv().OPENCLAW_NO_AUTO_UPDATE).toBe("1");
  });

  it("excludes both Claude Code launcher keys from the gateway child env", () => {
    const prevToken = process.env.CLAUDE_CODE_ROUTINE_TOKEN;
    const prevUrl = process.env.CLAUDE_CODE_ROUTINE_URL;
    process.env.CLAUDE_CODE_ROUTINE_TOKEN = "sk-ant-oat01-test-value";
    process.env.CLAUDE_CODE_ROUTINE_URL = "trig_test";
    try {
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      // The launcher config starts autonomous, billable Claude Code runs on
      // the operator's claude.ai account; the gateway/agent must never inherit
      // the token OR the routine URL it points at.
      const env = gateway.gatewayEnv();
      expect(env).not.toHaveProperty("CLAUDE_CODE_ROUTINE_TOKEN");
      expect(env).not.toHaveProperty("CLAUDE_CODE_ROUTINE_URL");
    } finally {
      if (prevToken === undefined) delete process.env.CLAUDE_CODE_ROUTINE_TOKEN;
      else process.env.CLAUDE_CODE_ROUTINE_TOKEN = prevToken;
      if (prevUrl === undefined) delete process.env.CLAUDE_CODE_ROUTINE_URL;
      else process.env.CLAUDE_CODE_ROUTINE_URL = prevUrl;
    }
  });

  it("defaults OPENCLAW_SUPERVISOR_MODE=external and honors the off|none escape hatch", () => {
    const previousMode = process.env.OPENCLAW_SUPERVISOR_MODE;
    const previousPolicy = process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
    try {
      delete process.env.OPENCLAW_SUPERVISOR_MODE;
      delete process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      // Default ON: harmless no-op on stable, load-bearing on 2026.8.1+ (the
      // gateway skips its internal supervisor and defers restarts to us).
      expect(gateway.gatewayEnv().OPENCLAW_SUPERVISOR_MODE).toBe("external");
      expect(gateway.gatewayEnv().OPENCLAW_SERVICE_REPAIR_POLICY).toBe("external");

      // Escape hatch: off|none neutralizes BOTH variables and the sentinel
      // itself never reaches the child env.
      process.env.OPENCLAW_SUPERVISOR_MODE = "off";
      expect(gateway.gatewayEnv().OPENCLAW_SUPERVISOR_MODE).toBeUndefined();
      expect(gateway.gatewayEnv().OPENCLAW_SERVICE_REPAIR_POLICY).toBeUndefined();
    } finally {
      if (previousMode === undefined) delete process.env.OPENCLAW_SUPERVISOR_MODE;
      else process.env.OPENCLAW_SUPERVISOR_MODE = previousMode;
      if (previousPolicy === undefined) {
        delete process.env.OPENCLAW_SERVICE_REPAIR_POLICY;
      } else {
        process.env.OPENCLAW_SERVICE_REPAIR_POLICY = previousPolicy;
      }
    }
  });

  it("exposes isSupervisorModeActive mirroring the supervisor-mode env resolution", () => {
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    // The watchdog's restart-handoff consume is gated on this getter: it
    // mirrors the exact supervisor-mode resolution the gateway child env gets
    // (default ON, off|none escape hatch) — an escape-hatched gateway writes
    // no handoff rows, so the consume CLI must never be spawned for it.
    expect(gateway.isSupervisorModeActive({})).toBe(true);
    expect(
      gateway.isSupervisorModeActive({ OPENCLAW_SUPERVISOR_MODE: "external" }),
    ).toBe(true);
    expect(
      gateway.isSupervisorModeActive({ OPENCLAW_SUPERVISOR_MODE: "off" }),
    ).toBe(false);
    expect(
      gateway.isSupervisorModeActive({ OPENCLAW_SUPERVISOR_MODE: "NONE" }),
    ).toBe(false);
  });

  it("applies ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE to the daemon launch env only (issue #24)", () => {
    const previousCap = process.env.ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    try {
      delete process.env.NODE_OPTIONS;
      process.env.ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE = "8192";
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      // The long-running daemon gets the operator's explicit cap…
      expect(gateway.gatewayLaunchEnv().NODE_OPTIONS).toBe(
        "--max-old-space-size=8192",
      );
      // …but plain gatewayEnv (every short-lived openclaw CLI child) does not.
      expect(gateway.gatewayEnv().NODE_OPTIONS).toBeUndefined();

      // The cap appends to surviving (non-memory) inherited flags.
      process.env.NODE_OPTIONS = "--enable-source-maps --max-old-space-size=768";
      expect(gateway.gatewayLaunchEnv().NODE_OPTIONS).toBe(
        "--enable-source-maps --max-old-space-size=8192",
      );

      // Invalid values are ignored — no flag, no crash.
      process.env.ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE = "lots";
      delete process.env.NODE_OPTIONS;
      expect(gateway.gatewayLaunchEnv().NODE_OPTIONS).toBeUndefined();
    } finally {
      if (previousCap === undefined) {
        delete process.env.ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE;
      } else {
        process.env.ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE = previousCap;
      }
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
  });

  it("warns once per distinct stripped memory-flag set, naming the dropped tokens", () => {
    const previousNodeOptions = process.env.NODE_OPTIONS;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.NODE_OPTIONS = "--max-old-space-size=8192 --enable-source-maps";
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      gateway.gatewayEnv();
      gateway.gatewayEnv();
      const stripWarnings = warnSpy.mock.calls.filter(([line]) =>
        String(line).includes("Stripped Node memory flag"),
      );
      // Once, not per call — gatewayEnv runs on every spawn/status path.
      expect(stripWarnings).toHaveLength(1);
      expect(stripWarnings[0][0]).toContain("--max-old-space-size=8192");
      expect(stripWarnings[0][0]).toContain("ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE");

      // A DIFFERENT stripped set warns again.
      process.env.NODE_OPTIONS = "--max-semi-space-size=64";
      gateway.gatewayEnv();
      expect(
        warnSpy.mock.calls.filter(([line]) =>
          String(line).includes("Stripped Node memory flag"),
        ),
      ).toHaveLength(2);
    } finally {
      warnSpy.mockRestore();
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
  });

  it("stopGatewayChild reaps a live managed gateway and is a safe no-op otherwise", async () => {
    // VPS restarts respawn detached + exit(0), skipping the SIGTERM handlers
    // that normally reap the managed child; server.js calls stopGatewayChild()
    // before restartProcess() so the OLD OpenClaw cannot stay alive on the port.
    const managedChild = createChild();
    const spawnMock = vi.fn().mockReturnValue(managedChild);
    childProcess.spawn = spawnMock;
    childProcess.execSync = vi.fn(() => "");
    fs.existsSync = vi.fn(() => true);
    net.createConnection = vi.fn(() => createSocket(false));
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    // No child launched yet: nothing to stop.
    expect(gateway.stopGatewayChild()).toBe(false);

    fs.readFileSync = vi.fn(() =>
      JSON.stringify({
        agents: { defaults: { model: { primary: "openai/gpt-5.1-codex" } } },
      }),
    );
    await gateway.startGateway();
    expect(spawnMock).toHaveBeenCalledTimes(1);

    expect(gateway.stopGatewayChild()).toBe(true);
    expect(managedChild.kill).toHaveBeenCalledWith("SIGTERM");

    // A child that already exited must not be signalled again.
    managedChild.exitCode = 0;
    managedChild.kill.mockClear();
    expect(gateway.stopGatewayChild()).toBe(false);
    expect(managedChild.kill).not.toHaveBeenCalled();

    // A kill() that throws (e.g. the pid is gone) is swallowed, not fatal.
    managedChild.exitCode = null;
    managedChild.kill = vi.fn(() => {
      throw new Error("ESRCH");
    });
    expect(gateway.stopGatewayChild()).toBe(false);
  });

  it("uses force cold start when the gateway port is not listening", async () => {
    const restartSupervisor = createChild();
    const spawnMock = vi.fn(() => restartSupervisor);
    const execSyncMock = vi.fn(() => "");
    childProcess.spawn = spawnMock;
    childProcess.execSync = execSyncMock;
    fs.existsSync = vi.fn(() => true);
    let gatewayPortOpen = false;
    net.createConnection = vi.fn(() => createSocket(() => gatewayPortOpen));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn(() =>
      JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.1-codex",
            },
          },
        },
      }),
    );

    spawnMock.mockImplementation((file, args) => {
      if (args?.[0] === "gateway" && args?.[1] === "--force") {
        queueMicrotask(() => {
          gatewayPortOpen = true;
        });
      }
      return restartSupervisor;
    });
    const reloadEnv = vi.fn();
    const restartPromise = gateway.restartGateway(reloadEnv);
    await restartPromise;

    expect(reloadEnv).toHaveBeenCalledTimes(1);
    expect(execSyncMock).not.toHaveBeenCalledWith(
      "openclaw gateway restart",
      expect.anything(),
    );
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock).toHaveBeenCalledWith(
      "openclaw",
      ["gateway", "--force"],
      expect.objectContaining({ env: expect.any(Object) }),
    );
    expect(execSyncMock).not.toHaveBeenCalledWith(
      "openclaw gateway --force",
      expect.anything(),
    );
  });

  it("retries channel plugin preflight after cleaning stale install stages", async () => {
    const firstError = new Error(
      "ENOTEMPTY: directory not empty, rmdir '/app/node_modules/openclaw/dist/extensions/telegram/.openclaw-install-stage/node_modules/typebox/build/type/engine'",
    );
    const execFileMock = vi
      .fn()
      .mockImplementationOnce((file, args, opts, cb) => cb(firstError, "", ""))
      .mockImplementationOnce((file, args, opts, cb) => cb(null, "{}", ""));
    childProcess.execFile = execFileMock;
    fs.existsSync = vi.fn((targetPath) => targetPath === `${OPENCLAW_DIR}/openclaw.json`);
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({
          channels: {
            telegram: { enabled: true },
          },
        });
      }
      return originalReadFileSync(targetPath, ...args);
    });
    let stagePresent = true;
    fs.readdirSync = vi.fn((targetPath) => {
      if (String(targetPath).endsWith("/dist/extensions")) {
        return [{ name: "telegram", isDirectory: () => true }];
      }
      if (String(targetPath).endsWith("/dist/extensions/telegram")) {
        return [
          ...(stagePresent
            ? [{ name: ".openclaw-install-stage", isDirectory: () => true }]
            : []),
          { name: "node_modules", isDirectory: () => true },
        ];
      }
      return [];
    });
    fs.rmSync = vi.fn(() => {
      stagePresent = false;
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    await gateway.prepareOpenclawChannelPlugins();

    expect(execFileMock).toHaveBeenCalledTimes(2);
    for (const call of [1, 2]) {
      expect(execFileMock).toHaveBeenNthCalledWith(
        call,
        "openclaw",
        ["plugins", "list", "--json"],
        {
          env: expect.any(Object),
          timeout: 120000,
          encoding: "utf8",
          // Shutdown cancellation rides on this signal (abortGatewayWaits).
          signal: expect.any(AbortSignal),
        },
        expect.any(Function),
      );
    }
    expect(fs.rmSync).toHaveBeenCalledWith(
      expect.stringContaining("/telegram/.openclaw-install-stage"),
      expect.objectContaining({ recursive: true, force: true }),
    );
  });

  it("memoizes only successful plugin preflights by desired plugin state", async () => {
    let configRaw = JSON.stringify({ channels: { telegram: { enabled: true } } });
    const execFileMock = vi
      .fn()
      // First preflight fails for a non-install-stage reason.
      .mockImplementationOnce((file, args, opts, cb) =>
        cb(new Error("EAI_AGAIN registry.npmjs.org"), "", ""),
      )
      .mockImplementation((file, args, opts, cb) => cb(null, "{}", ""));
    childProcess.execFile = execFileMock;
    fs.existsSync = vi.fn(
      (targetPath) => targetPath === `${OPENCLAW_DIR}/openclaw.json`,
    );
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) return configRaw;
      return originalReadFileSync(targetPath, ...args);
    });
    fs.readdirSync = vi.fn(() => []);
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // A FAILED preflight is reported and must NOT seed the success memo.
    expect(await gateway.prepareOpenclawChannelPlugins()).toEqual({
      skipped: false,
      failed: true,
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("OpenClaw plugin preflight failed"),
    );

    // Same desired state after a failure: the preflight re-runs (and succeeds).
    expect(await gateway.prepareOpenclawChannelPlugins()).toEqual({
      skipped: false,
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);

    // Unchanged desired state after a success: the hash memo skips the whole
    // CLI boot — the seconds-vs-minutes restart-downtime path.
    expect(await gateway.prepareOpenclawChannelPlugins()).toEqual({
      skipped: true,
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);

    // Changing the enabled-channel set invalidates the memo.
    configRaw = JSON.stringify({
      channels: { telegram: { enabled: true }, discord: { enabled: true } },
    });
    expect(await gateway.prepareOpenclawChannelPlugins()).toEqual({
      skipped: false,
    });
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("streams a warning (not done) for preparing_plugins when the preflight fails", async () => {
    const supervisor = createChild();
    let gatewayPortOpen = false;
    childProcess.spawn = vi.fn((file, args) => {
      if (args?.[0] === "gateway" && args?.[1] === "--force") {
        queueMicrotask(() => {
          gatewayPortOpen = true;
        });
      }
      return supervisor;
    });
    childProcess.execFile = vi.fn((file, args, opts, cb) => {
      if (args?.[0] === "plugins") {
        cb(new Error("EAI_AGAIN registry.npmjs.org"), "", "network down");
        return;
      }
      cb(null, "", "");
    });
    fs.existsSync = vi.fn(
      (targetPath) => targetPath === `${OPENCLAW_DIR}/openclaw.json`,
    );
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({ channels: { telegram: { enabled: true } } });
      }
      return originalReadFileSync(targetPath, ...args);
    });
    fs.readdirSync = vi.fn(() => []);
    net.createConnection = vi.fn(() => createSocket(() => gatewayPortOpen));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const onStep = vi.fn();

    const result = await gateway.restartGateway(vi.fn(), { onStep });

    // A failed preflight continues (the gateway may still boot) but must not
    // stream as a clean "done" — the client renders this status verbatim.
    const prepSteps = onStep.mock.calls
      .map(([step]) => step)
      .filter((step) => step.step === "preparing_plugins");
    expect(prepSteps).toEqual([
      { step: "preparing_plugins", status: "running" },
      { step: "preparing_plugins", status: "warning" },
    ]);
    // The restart still proceeds through stop + force launch to ready.
    expect(result.downtimeMs).toEqual(expect.any(Number));
    expect(childProcess.spawn).toHaveBeenCalledWith(
      "openclaw",
      ["gateway", "--force"],
      expect.objectContaining({ env: expect.any(Object) }),
    );
  });

  it("marks managed child exit as expected before force restart", async () => {
    const child = createChild();
    const spawnMock = vi.fn(() => child);
    const execSyncMock = vi.fn(() => "");
    const exitHandler = vi.fn();
    childProcess.spawn = spawnMock;
    childProcess.execSync = execSyncMock;
    fs.existsSync = vi.fn(() => true);
    let gatewayPortOpen = false;
    net.createConnection = vi.fn(() => createSocket(() => gatewayPortOpen));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    gateway.setGatewayExitHandler(exitHandler);
    fs.readFileSync = vi.fn(() =>
      JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.1-codex",
            },
          },
        },
      }),
    );

    await gateway.startGateway();
    spawnMock.mockImplementation((file, args) => {
      if (args?.[0] === "gateway" && args?.[1] === "--force") {
        queueMicrotask(() => {
          gatewayPortOpen = true;
        });
      }
      return child;
    });
    const restartPromise = gateway.restartGateway(vi.fn());
    await restartPromise;

    // Classification is registered on "close" (post-stdio-drain), never on
    // "exit" — the final stderr chunk must be in the tail before the watchdog
    // classifies.
    const closeRegistration = child.on.mock.calls.find((call) => call[0] === "close");
    expect(closeRegistration).toBeTruthy();

    const [, onClose] = closeRegistration;
    onClose(0, null);

    expect(exitHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 0,
        signal: null,
        expectedExit: true,
      }),
    );
  });

  it("does not treat auth-only openclaw config as onboarded", () => {
    fs.existsSync = vi.fn((targetPath) => targetPath === `${OPENCLAW_DIR}/openclaw.json`);
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn(() =>
      JSON.stringify({
        auth: {
          profiles: {
            "openai-codex:codex-cli": {
              provider: "openai-codex",
              mode: "oauth",
            },
          },
        },
      }),
    );

    expect(gateway.isOnboarded()).toBe(false);
  });

  it("treats onboarding marker as source of truth", () => {
    fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.isOnboarded()).toBe(true);
  });

  it("does not backfill onboarding marker from config with primary model", () => {
    fs.existsSync = vi.fn((targetPath) => targetPath === `${OPENCLAW_DIR}/openclaw.json`);
    fs.mkdirSync = vi.fn();
    fs.writeFileSync = vi.fn();
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn(() =>
      JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: "openai-codex/gpt-5.3-codex",
            },
          },
        },
      }),
    );

    expect(gateway.isOnboarded()).toBe(false);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("does not treat nested openclaw config as onboarded", () => {
    fs.existsSync = vi.fn(
      (targetPath) => targetPath === `${OPENCLAW_DIR}/.openclaw/openclaw.json`,
    );
    fs.mkdirSync = vi.fn();
    fs.writeFileSync = vi.fn();
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.isOnboarded()).toBe(false);
    expect(fs.mkdirSync).not.toHaveBeenCalled();
    expect(fs.writeFileSync).not.toHaveBeenCalled();
  });

  it("backfills onboarding marker from legacy onboarding artifact", () => {
    fs.existsSync = vi.fn((targetPath) => targetPath === kLegacyControlUiSkillPath);
    fs.mkdirSync = vi.fn();
    fs.writeFileSync = vi.fn();
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.isOnboarded()).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      kOnboardingMarkerPath,
      expect.stringContaining('"reason": "legacy_artifact_backfill"'),
    );
  });

  it("adds the setup origin to gateway control UI config", () => {
    let currentConfig = {
      gateway: {},
    };
    fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
    fs.writeFileSync = vi.fn((targetPath, contents) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        currentConfig = JSON.parse(contents);
      }
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn((targetPath) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify(currentConfig);
      }
      return "{}";
    });

    const changed = gateway.ensureGatewayProxyConfig("https://setup.example.com");

    expect(changed).toBe(true);
    expect(fs.writeFileSync).toHaveBeenCalledWith(
      `${OPENCLAW_DIR}/openclaw.json`,
      expect.any(String),
    );
    expect(currentConfig.gateway.trustedProxies).toEqual(["127.0.0.1"]);
    expect(currentConfig.gateway.controlUi.allowedOrigins).toEqual([
      "https://setup.example.com",
    ]);
    expect(currentConfig.gateway.http).toBeUndefined();
  });

  it("preserves existing allowed origins and remains idempotent", () => {
    let currentConfig = {
      gateway: {
        trustedProxies: ["127.0.0.1"],
        controlUi: {
          allowedOrigins: ["https://existing.example.com"],
        },
      },
    };
    fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
    fs.writeFileSync = vi.fn((targetPath, contents) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        currentConfig = JSON.parse(contents);
      }
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn((targetPath) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify(currentConfig);
      }
      return "{}";
    });

    const firstChanged = gateway.ensureGatewayProxyConfig("https://setup.example.com");
    const secondChanged = gateway.ensureGatewayProxyConfig("https://setup.example.com");

    expect(firstChanged).toBe(true);
    expect(secondChanged).toBe(false);
    expect(currentConfig.gateway.controlUi.allowedOrigins).toEqual([
      "https://existing.example.com",
      "https://setup.example.com",
    ]);
    expect(currentConfig.gateway.http).toBeUndefined();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
  });

  it("preserves existing gateway endpoint options while enabling opted-in public API endpoints", () => {
    let currentConfig = {
      gateway: {
        trustedProxies: ["127.0.0.1"],
        http: {
          endpoints: {
            chatCompletions: {
              maxBodyBytes: 12345,
            },
            responses: {
              maxBodyBytes: 67890,
            },
          },
        },
        controlUi: {
          allowedOrigins: ["https://setup.example.com"],
        },
      },
    };
    fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
    fs.writeFileSync = vi.fn((targetPath, contents) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        currentConfig = JSON.parse(contents);
      }
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn((targetPath) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify(currentConfig);
      }
      if (targetPath === kAlphaclawConfigPath) {
        return JSON.stringify({
          features: { openaiCompatApi: { enabled: true } },
        });
      }
      return "{}";
    });

    const changed = gateway.ensureGatewayProxyConfig("https://setup.example.com");

    expect(changed).toBe(true);
    expect(currentConfig.gateway.http.endpoints.chatCompletions).toEqual({
      enabled: true,
      maxBodyBytes: 12345,
    });
    expect(currentConfig.gateway.http.endpoints.responses).toEqual({
      enabled: true,
      maxBodyBytes: 67890,
    });
  });

  describe("Managed remote MCP server config", () => {
    const kRemoteMcpEnvKeys = [
      "REMOTE_MCP_URL",
      "REMOTE_MCP_API_TOKEN",
      "REMOTE_MCP_PROXY_URL",
      "REMOTE_MCP_NAME",
    ];

    const withEnv = (vars, fn) => {
      const prev = {};
      for (const key of kRemoteMcpEnvKeys) prev[key] = process.env[key];
      try {
        for (const [key, value] of Object.entries(vars)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        return fn();
      } finally {
        for (const key of kRemoteMcpEnvKeys) {
          if (prev[key] === undefined) delete process.env[key];
          else process.env[key] = prev[key];
        }
      }
    };

    const setupConfigIo = (initial) => {
      let currentConfig = initial;
      let lastRawContents = null;
      fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
      fs.writeFileSync = vi.fn((targetPath, contents) => {
        if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
          lastRawContents = contents;
          currentConfig = JSON.parse(contents);
        }
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      fs.readFileSync = vi.fn((targetPath) => {
        if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
          return JSON.stringify(currentConfig);
        }
        return "{}";
      });
      return {
        gateway,
        getConfig: () => currentConfig,
        getRawContents: () => lastRawContents,
      };
    };

    it("writes remote MCP server with placeholder when env vars are set", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote).toEqual({
            url: "https://sure.example.com/mcp",
            transport: "streamable-http",
            headers: { Authorization: "Bearer ${REMOTE_MCP_API_TOKEN}" },
            _alphaclawManaged: true,
          });
          expect(io.getRawContents()).not.toContain("sk-sure-secret-token");
          expect(io.getRawContents()).toContain("Bearer ${REMOTE_MCP_API_TOKEN}");
        },
      );
    });

    it("routes through REMOTE_MCP_PROXY_URL when set", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: "http://127.0.0.1:8889/mcp",
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote.url).toBe(
            "http://127.0.0.1:8889/mcp",
          );
          expect(io.getConfig().mcp.servers.remote.headers.Authorization).toBe(
            "Bearer ${REMOTE_MCP_API_TOKEN}",
          );
        },
      );
    });

    it("removes existing remote MCP server when env vars unset", () => {
      withEnv(
        {
          REMOTE_MCP_URL: undefined,
          REMOTE_MCP_API_TOKEN: undefined,
          REMOTE_MCP_PROXY_URL: undefined,
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                remote: {
                  url: "https://old.example.com/mcp",
                  transport: "streamable-http",
                  headers: { Authorization: "Bearer ${REMOTE_MCP_API_TOKEN}" },
                  _alphaclawManaged: true,
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp).toBeUndefined();
        },
      );
    });

    it("preserves an unmarked user remote MCP server when env vars are unset", () => {
      withEnv(
        {
          REMOTE_MCP_URL: undefined,
          REMOTE_MCP_API_TOKEN: undefined,
          REMOTE_MCP_PROXY_URL: undefined,
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                remote: {
                  url: "https://user.example.com/mcp",
                  transport: "sse",
                  headers: { Authorization: "Bearer user-token" },
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote).toEqual({
            url: "https://user.example.com/mcp",
            transport: "sse",
            headers: { Authorization: "Bearer user-token" },
          });
        },
      );
    });

    it("uses REMOTE_MCP_NAME as the server key when set", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
          REMOTE_MCP_NAME: "sure",
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.sure).toBeDefined();
          expect(io.getConfig().mcp.servers.remote).toBeUndefined();
          expect(io.getConfig().mcp.servers.sure.url).toBe(
            "https://sure.example.com/mcp",
          );
        },
      );
    });

    it("is idempotent when remote MCP server already matches", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: "http://127.0.0.1:8889/mcp",
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const firstChanged = io.gateway.ensureGatewayProxyConfig(undefined);
          const secondChanged = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(firstChanged).toBe(true);
          expect(secondChanged).toBe(false);
          expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
        },
      );
    });

    it("uses REMOTE_MCP_URL directly when REMOTE_MCP_PROXY_URL is unset", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote.url).toBe(
            "https://sure.example.com/mcp",
          );
        },
      );
    });

    it("scrubs an existing plaintext Authorization back to the placeholder reference", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
          PIPELOCK_ENABLED: undefined,
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                sure: {
                  url: "https://sure.example.com/mcp",
                  transport: "streamable-http",
                  headers: {
                    Authorization: "Bearer sk-sure-secret-token",
                  },
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote.headers.Authorization).toBe(
            "Bearer ${REMOTE_MCP_API_TOKEN}",
          );
          expect(io.getRawContents()).not.toContain("sk-sure-secret-token");
        },
      );
    });

    it("removes the prior managed entry when REMOTE_MCP_NAME changes", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
          REMOTE_MCP_NAME: "notion",
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                sure: {
                  url: "https://old.example.com/mcp",
                  transport: "streamable-http",
                  headers: { Authorization: "Bearer ${REMOTE_MCP_API_TOKEN}" },
                  _alphaclawManaged: true,
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.sure).toBeUndefined();
          expect(io.getConfig().mcp.servers.notion).toBeDefined();
          expect(io.getConfig().mcp.servers.notion._alphaclawManaged).toBe(true);
        },
      );
    });

    it("does not touch unmarked user entries when REMOTE_MCP_NAME differs", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
          REMOTE_MCP_NAME: "notion",
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                "user-server": {
                  url: "https://user.example.com/mcp",
                  transport: "sse",
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers["user-server"]).toEqual({
            url: "https://user.example.com/mcp",
            transport: "sse",
          });
          expect(io.getConfig().mcp.servers.notion._alphaclawManaged).toBe(true);
        },
      );
    });

    it.each([
      ["__proto__"],
      ["constructor"],
      ["prototype"],
      ["has spaces"],
      ["path/like"],
      ["dot.notation"],
      [""],
    ])("rejects invalid REMOTE_MCP_NAME %j and falls back to default", (badName) => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
          REMOTE_MCP_NAME: badName === "" ? undefined : badName,
        },
        () => {
          const io = setupConfigIo({ gateway: {} });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.remote).toBeDefined();
          expect(Object.keys(io.getConfig().mcp.servers)).not.toContain(badName);
          // Empty REMOTE_MCP_NAME is a normal default, not a warning.
          if (badName) {
            expect(warnSpy).toHaveBeenCalledWith(
              expect.stringContaining("REMOTE_MCP_NAME"),
            );
          }
        },
      );
      warnSpy.mockRestore();
    });

    it("preserves unrelated mcp.servers entries when the remote config changes", () => {
      withEnv(
        {
          REMOTE_MCP_URL: "https://sure.example.com/mcp",
          REMOTE_MCP_API_TOKEN: "sk-sure-secret-token",
          REMOTE_MCP_PROXY_URL: undefined,
        },
        () => {
          const io = setupConfigIo({
            gateway: {},
            mcp: {
              servers: {
                other: {
                  url: "https://other.example.com/mcp",
                  transport: "sse",
                },
              },
            },
          });

          const changed = io.gateway.ensureGatewayProxyConfig(undefined);

          expect(changed).toBe(true);
          expect(io.getConfig().mcp.servers.other).toEqual({
            url: "https://other.example.com/mcp",
            transport: "sse",
          });
          expect(io.getConfig().mcp.servers.remote.url).toBe(
            "https://sure.example.com/mcp",
          );
        },
      );
    });
  });

  it("reports an enabled external channel (signal) without any token; disabled stays hidden", () => {
    // #113: signal is configured out-of-band (signal-cli) — no env token, no
    // botToken. `external: true` skips the token gate, but the enabled gate
    // still applies: a present-but-disabled block must never show.
    fs.existsSync = vi.fn(() => true);
    fs.readdirSync = vi.fn(() => []);
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({
          channels: { signal: { enabled: true } },
        });
      }
      return originalReadFileSync(targetPath, ...args);
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.getChannelStatus()).toEqual({
      signal: {
        status: "configured",
        paired: 0,
        accounts: { default: { status: "configured", paired: 0 } },
      },
    });

    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({
          channels: { signal: { enabled: false } },
        });
      }
      return originalReadFileSync(targetPath, ...args);
    });
    delete require.cache[modulePath];
    const disabledGateway = require(modulePath);
    expect(disabledGateway.getChannelStatus()).toEqual({});
  });

  it("runs the plugin preflight on a signal-only box (no phantom plugin ids)", async () => {
    // Before #113 a signal-only config made hasEnabledChannelConfig() false,
    // so the runtime-deps preflight never ran before the gateway booted. The
    // preflight hashes channel NAMES only — no per-channel plugin ids exist.
    fs.existsSync = vi.fn(
      (targetPath) => targetPath === `${OPENCLAW_DIR}/openclaw.json`,
    );
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({ channels: { signal: { enabled: true } } });
      }
      return originalReadFileSync(targetPath, ...args);
    });
    fs.readdirSync = vi.fn(() => []);
    childProcess.execFile = execFileOk("{}");
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(await gateway.prepareOpenclawChannelPlugins()).toEqual({
      skipped: false,
    });
    expect(childProcess.execFile).toHaveBeenCalled();
  });

  it("reports channel status per account while preserving provider summary", () => {
    fs.existsSync = vi.fn(() => true);
    fs.readdirSync = vi.fn((targetPath) => {
      if (targetPath === `${OPENCLAW_DIR}/credentials`) {
        return ["telegram-default-allowFrom.json", "telegram-alerts-allowFrom.json"];
      }
      return [];
    });
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({
          channels: {
            telegram: {
              enabled: true,
              accounts: {
                default: { botToken: "${TELEGRAM_BOT_TOKEN}" },
                alerts: { botToken: "${TELEGRAM_BOT_TOKEN_ALERTS}" },
              },
            },
          },
        });
      }
      if (targetPath === `${OPENCLAW_DIR}/credentials/telegram-default-allowFrom.json`) {
        return JSON.stringify({ allowFrom: ["1001"] });
      }
      if (targetPath === `${OPENCLAW_DIR}/credentials/telegram-alerts-allowFrom.json`) {
        return JSON.stringify({ allowFrom: [] });
      }
      return originalReadFileSync(targetPath, ...args);
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.getChannelStatus()).toEqual({
      telegram: {
        status: "paired",
        paired: 1,
        accounts: {
          default: { status: "paired", paired: 1 },
          alerts: { status: "configured", paired: 0 },
        },
      },
    });
  });

  it("treats legacy single-account telegram config as default account status", () => {
    fs.existsSync = vi.fn(() => true);
    fs.readdirSync = vi.fn((targetPath) => {
      if (targetPath === `${OPENCLAW_DIR}/credentials`) {
        return ["telegram-allowFrom.json"];
      }
      return [];
    });
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({
          channels: {
            telegram: {
              enabled: true,
              botToken: "${TELEGRAM_BOT_TOKEN}",
              dmPolicy: "pairing",
            },
          },
        });
      }
      if (targetPath === `${OPENCLAW_DIR}/credentials/telegram-allowFrom.json`) {
        return JSON.stringify({ allowFrom: ["1001", "1002"] });
      }
      return originalReadFileSync(targetPath, ...args);
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.getChannelStatus()).toEqual({
      telegram: {
        status: "paired",
        paired: 2,
        accounts: {
          default: { status: "paired", paired: 2 },
        },
      },
    });
  });

  it("treats whatsapp owner-number self chat as paired when saved creds exist", () => {
    const previousOwnerNumber = process.env.WHATSAPP_OWNER_NUMBER;
    process.env.WHATSAPP_OWNER_NUMBER = "+15551234567";
    try {
    fs.existsSync = vi.fn(() => true);
    fs.readdirSync = vi.fn(() => []);
    fs.readFileSync = vi.fn((targetPath, ...args) => {
      if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
        return JSON.stringify({
          channels: {
            whatsapp: {
              enabled: true,
              accounts: {
                default: {
                  name: "WhatsApp",
                  dmPolicy: "pairing",
                },
              },
            },
          },
        });
      }
      if (targetPath === `${OPENCLAW_DIR}/credentials/whatsapp/default/creds.json`) {
        return "{}";
      }
      return originalReadFileSync(targetPath, ...args);
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    expect(gateway.getChannelStatus()).toEqual({
      whatsapp: {
        status: "paired",
        paired: 1,
        accounts: {
          default: { status: "paired", paired: 1 },
        },
      },
    });
    } finally {
      if (previousOwnerNumber === undefined) {
        delete process.env.WHATSAPP_OWNER_NUMBER;
      } else {
        process.env.WHATSAPP_OWNER_NUMBER = previousOwnerNumber;
      }
    }
  });

  it("keeps whatsapp configured when owner number exists but saved creds do not", () => {
    const previousOwnerNumber = process.env.WHATSAPP_OWNER_NUMBER;
    process.env.WHATSAPP_OWNER_NUMBER = "+15551234567";
    try {
      fs.existsSync = vi.fn(() => true);
      fs.readdirSync = vi.fn(() => []);
      fs.readFileSync = vi.fn((targetPath, ...args) => {
        if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
          return JSON.stringify({
            channels: {
              whatsapp: {
                enabled: true,
                accounts: {
                  default: {
                    name: "WhatsApp",
                    dmPolicy: "pairing",
                  },
                },
              },
            },
          });
        }
        return originalReadFileSync(targetPath, ...args);
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(gateway.getChannelStatus()).toEqual({
        whatsapp: {
          status: "configured",
          paired: 0,
          accounts: {
            default: { status: "configured", paired: 0 },
          },
        },
      });
    } finally {
      if (previousOwnerNumber === undefined) {
        delete process.env.WHATSAPP_OWNER_NUMBER;
      } else {
        process.env.WHATSAPP_OWNER_NUMBER = previousOwnerNumber;
      }
    }
  });

  it("does not treat whatsapp allowFrom owner placeholder as paired without saved creds", () => {
    const previousOwnerNumber = process.env.WHATSAPP_OWNER_NUMBER;
    process.env.WHATSAPP_OWNER_NUMBER = "+15551234567";
    try {
      fs.existsSync = vi.fn(() => true);
      fs.readdirSync = vi.fn(() => []);
      fs.readFileSync = vi.fn((targetPath, ...args) => {
        if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
          return JSON.stringify({
            channels: {
              whatsapp: {
                enabled: true,
                accounts: {
                  default: {
                    name: "WhatsApp",
                    allowFrom: ["${WHATSAPP_OWNER_NUMBER}"],
                    groupAllowFrom: ["${WHATSAPP_OWNER_NUMBER}"],
                    dmPolicy: "allowlist",
                    groupPolicy: "allowlist",
                    selfChatMode: true,
                  },
                },
              },
            },
          });
        }
        return originalReadFileSync(targetPath, ...args);
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(gateway.getChannelStatus()).toEqual({
        whatsapp: {
          status: "configured",
          paired: 0,
          accounts: {
            default: { status: "configured", paired: 0 },
          },
        },
      });
    } finally {
      if (previousOwnerNumber === undefined) {
        delete process.env.WHATSAPP_OWNER_NUMBER;
      } else {
        process.env.WHATSAPP_OWNER_NUMBER = previousOwnerNumber;
      }
    }
  });

  it("treats whatsapp allowFrom owner placeholder as paired when saved creds exist", () => {
    const previousOwnerNumber = process.env.WHATSAPP_OWNER_NUMBER;
    process.env.WHATSAPP_OWNER_NUMBER = "+15551234567";
    try {
      fs.existsSync = vi.fn(() => true);
      fs.readdirSync = vi.fn(() => []);
      fs.readFileSync = vi.fn((targetPath, ...args) => {
        if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
          return JSON.stringify({
            channels: {
              whatsapp: {
                enabled: true,
                accounts: {
                  default: {
                    name: "WhatsApp",
                    allowFrom: ["${WHATSAPP_OWNER_NUMBER}"],
                    groupAllowFrom: ["${WHATSAPP_OWNER_NUMBER}"],
                    dmPolicy: "allowlist",
                    groupPolicy: "allowlist",
                    selfChatMode: true,
                  },
                },
              },
            },
          });
        }
        if (targetPath === `${OPENCLAW_DIR}/credentials/whatsapp/default/creds.json`) {
          return "{}";
        }
        return originalReadFileSync(targetPath, ...args);
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(gateway.getChannelStatus()).toEqual({
        whatsapp: {
          status: "paired",
          paired: 1,
          accounts: {
            default: { status: "paired", paired: 1 },
          },
        },
      });
    } finally {
      if (previousOwnerNumber === undefined) {
        delete process.env.WHATSAPP_OWNER_NUMBER;
      } else {
        process.env.WHATSAPP_OWNER_NUMBER = previousOwnerNumber;
      }
    }
  });

  it("treats whatsapp as paired when selfChatMode is false, saved creds exist, and allowFrom is populated", () => {
    const previousOwnerNumber = process.env.WHATSAPP_OWNER_NUMBER;
    process.env.WHATSAPP_OWNER_NUMBER = "+15551234567";
    try {
      fs.existsSync = vi.fn(() => true);
      fs.readdirSync = vi.fn(() => []);
      fs.readFileSync = vi.fn((targetPath, ...args) => {
        if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
          return JSON.stringify({
            channels: {
              whatsapp: {
                enabled: true,
                accounts: {
                  default: {
                    name: "WhatsApp",
                    allowFrom: ["+15559876543"],
                    selfChatMode: false,
                  },
                },
              },
            },
          });
        }
        if (targetPath === `${OPENCLAW_DIR}/credentials/whatsapp/default/creds.json`) {
          return "{}";
        }
        return originalReadFileSync(targetPath, ...args);
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(gateway.getChannelStatus()).toEqual({
        whatsapp: {
          status: "paired",
          paired: 1,
          accounts: {
            default: { status: "paired", paired: 1 },
          },
        },
      });
    } finally {
      if (previousOwnerNumber === undefined) {
        delete process.env.WHATSAPP_OWNER_NUMBER;
      } else {
        process.env.WHATSAPP_OWNER_NUMBER = previousOwnerNumber;
      }
    }
  });

  it("treats whatsapp as configured when selfChatMode is false, saved creds exist, but allowFrom is empty", () => {
    const previousOwnerNumber = process.env.WHATSAPP_OWNER_NUMBER;
    process.env.WHATSAPP_OWNER_NUMBER = "+15551234567";
    try {
      fs.existsSync = vi.fn(() => true);
      fs.readdirSync = vi.fn(() => []);
      fs.readFileSync = vi.fn((targetPath, ...args) => {
        if (targetPath === `${OPENCLAW_DIR}/openclaw.json`) {
          return JSON.stringify({
            channels: {
              whatsapp: {
                enabled: true,
                accounts: {
                  default: {
                    name: "WhatsApp",
                    allowFrom: [],
                    selfChatMode: false,
                  },
                },
              },
            },
          });
        }
        if (targetPath === `${OPENCLAW_DIR}/credentials/whatsapp/default/creds.json`) {
          return "{}";
        }
        return originalReadFileSync(targetPath, ...args);
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(gateway.getChannelStatus()).toEqual({
        whatsapp: {
          status: "configured",
          paired: 0,
          accounts: {
            default: { status: "configured", paired: 0 },
          },
        },
      });
    } finally {
      if (previousOwnerNumber === undefined) {
        delete process.env.WHATSAPP_OWNER_NUMBER;
      } else {
        process.env.WHATSAPP_OWNER_NUMBER = previousOwnerNumber;
      }
    }
  });

  describe("gateway process lifecycle", () => {
    it("streams managed gateway output, signals launch, and reports exits", async () => {
      const child = createChild();
      childProcess.spawn = vi.fn(() => child);
      childProcess.execSync = vi.fn(() => "{}");
      fs.existsSync = vi.fn(() => false);
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const launchHandler = vi.fn(() => {
        throw new Error("launch-boom");
      });
      gateway.setGatewayLaunchHandler(launchHandler);
      const exitHandler = vi.fn(() => {
        throw new Error("exit-boom");
      });
      gateway.setGatewayExitHandler(exitHandler);

      const first = await gateway.launchGatewayProcess();
      expect(first).toBe(child);
      expect(await gateway.launchGatewayProcess()).toBe(child);
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);

      const onStdout = child.stdout.on.mock.calls.find((c) => c[0] === "data")[1];
      const onStderr = child.stderr.on.mock.calls.find((c) => c[0] === "data")[1];
      // Classification prefers "close" (fires after stdio drains) so the
      // final stderr chunk is captured; the "exit" listener only arms the
      // bounded drain fallback for a close a descendant holds open — it must
      // never classify while close can still deliver within the window.
      const onExit = child.on.mock.calls.find((c) => c[0] === "exit")[1];
      const onClose = child.on.mock.calls.find((c) => c[0] === "close")[1];

      onStdout("warming up\n");
      expect(launchHandler).not.toHaveBeenCalled();
      onStdout(Buffer.from("Gateway listening on ws://127.0.0.1:18789\n"));
      expect(launchHandler).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 1234 }),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Gateway launch handler error: launch-boom"),
      );
      onStdout(Buffer.from("still listening on the same port\n"));
      expect(launchHandler).toHaveBeenCalledTimes(1);

      onStderr(Buffer.from("first error\n\n"));
      // Newline-terminated: appendStderrTail holds a trailing partial line in
      // its carry buffer until the line completes.
      onStderr(Array.from({ length: 60 }, (_, i) => `line-${i}`).join("\n") + "\n");
      // The kernel exit lands first, then the final stderr flush arrives
      // between "exit" and "close" — the armed drain window must not
      // classify early, and classification on "close" must still see it.
      onExit(1, "SIGKILL");
      expect(exitHandler).not.toHaveBeenCalled();
      onStderr(Buffer.from("final-flush-after-exit\n"));

      onClose(1, "SIGKILL");
      expect(exitHandler).toHaveBeenCalledTimes(1);
      expect(exitHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 1,
          signal: "SIGKILL",
          expectedExit: false,
          // Watchdog exit classification inputs: the exited PID (restart-
          // handoff consume) and the spawn time (exit-78 step-aside window).
          pid: 1234,
          launchedAt: expect.any(Number),
        }),
      );
      expect(exitHandler.mock.calls[0][0].stderrTail).toHaveLength(50);
      expect(exitHandler.mock.calls[0][0].stderrTail).toContain("line-59");
      expect(exitHandler.mock.calls[0][0].stderrTail).toContain(
        "final-flush-after-exit",
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Gateway exit handler error: exit-boom"),
      );
      gateway.setGatewayLaunchHandler(null);
      gateway.setGatewayExitHandler(null);
    });

    it("classifies a late close from an old child against its own stderr tail", async () => {
      const firstChild = createChild();
      const secondChild = { ...createChild(), pid: 5678 };
      const children = [firstChild, secondChild];
      childProcess.spawn = vi.fn(() => children.shift());
      fs.existsSync = vi.fn(() => false);
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const exitHandler = vi.fn();
      gateway.setGatewayExitHandler(exitHandler);

      const first = await gateway.launchGatewayProcess();
      const firstStderr = firstChild.stderr.on.mock.calls.find(
        (c) => c[0] === "data",
      )[1];
      const firstClose = firstChild.on.mock.calls.find(
        (c) => c[0] === "close",
      )[1];
      firstStderr(Buffer.from("first-child fatal config error\n"));

      // The kernel exit lands (exitCode set) but 'close' is still pending —
      // e.g. a grandchild inherited the stdio fds and holds them open.
      firstChild.exitCode = 78;
      const second = await gateway.launchGatewayProcess();
      expect(second).not.toBe(first);
      const secondStderr = secondChild.stderr.on.mock.calls.find(
        (c) => c[0] === "data",
      )[1];
      secondStderr(Buffer.from("second-child boot noise\n"));

      // The old child's close arrives AFTER the successor launched: it must
      // be classified against the FIRST child's stderr — with the previous
      // module-global tail (reset per launch) this exit-78 would have carried
      // the successor's stderr instead.
      firstClose(78, null);
      expect(exitHandler).toHaveBeenCalledTimes(1);
      expect(exitHandler).toHaveBeenCalledWith(
        expect.objectContaining({ code: 78, pid: 1234 }),
      );
      const tail = exitHandler.mock.calls[0][0].stderrTail;
      expect(tail).toContain("first-child fatal config error");
      expect(tail).not.toContain("second-child boot noise");
      gateway.setGatewayExitHandler(null);
    });

    it("classifies an exit whose close never fires once the bounded drain window lapses", async () => {
      vi.useFakeTimers();
      try {
        const child = createChild();
        childProcess.spawn = vi.fn(() => child);
        fs.existsSync = vi.fn(() => false);
        delete require.cache[modulePath];
        const gateway = require(modulePath);
        vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const exitHandler = vi.fn();
        gateway.setGatewayExitHandler(exitHandler);

        await gateway.launchGatewayProcess();
        const onStderr = child.stderr.on.mock.calls.find(
          (c) => c[0] === "data",
        )[1];
        const onExit = child.on.mock.calls.find((c) => c[0] === "exit")[1];

        onStderr(Buffer.from("dying breath\n"));
        // A descendant inherited the stdio fds and outlives the gateway:
        // "exit" fires but "close" never does. Without the bounded drain the
        // watchdog would never see this exit — no restart-handoff consume,
        // no relaunch — until the descendant died.
        child.exitCode = 1;
        onExit(1, null);
        expect(exitHandler).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(450);
        expect(exitHandler).toHaveBeenCalledTimes(1);
        expect(exitHandler).toHaveBeenCalledWith(
          // Same (code, signal) the eventual close would have delivered, with
          // the stderr received so far as evidence.
          expect.objectContaining({ code: 1, signal: null, pid: 1234 }),
        );
        expect(exitHandler.mock.calls[0][0].stderrTail).toContain(
          "dying breath",
        );
        gateway.setGatewayExitHandler(null);
      } finally {
        vi.useRealTimers();
      }
    });

    it("ignores a late close after the drain timeout already classified the exit", async () => {
      vi.useFakeTimers();
      try {
        const child = createChild();
        childProcess.spawn = vi.fn(() => child);
        fs.existsSync = vi.fn(() => false);
        delete require.cache[modulePath];
        const gateway = require(modulePath);
        vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);
        const exitHandler = vi.fn();
        gateway.setGatewayExitHandler(exitHandler);

        await gateway.launchGatewayProcess();
        const onStderr = child.stderr.on.mock.calls.find(
          (c) => c[0] === "data",
        )[1];
        const onExit = child.on.mock.calls.find((c) => c[0] === "exit")[1];
        const onClose = child.on.mock.calls.find((c) => c[0] === "close")[1];

        child.exitCode = 78;
        onExit(78, null);
        await vi.advanceTimersByTimeAsync(450);
        expect(exitHandler).toHaveBeenCalledTimes(1);

        // The descendant finally dies and the stalled close delivers — hours
        // late. The settled flag makes it a no-op: never a double report.
        onStderr(Buffer.from("descendant flushed late\n"));
        onClose(78, null);
        expect(exitHandler).toHaveBeenCalledTimes(1);
        expect(exitHandler.mock.calls[0][0].stderrTail).not.toContain(
          "descendant flushed late",
        );
        gateway.setGatewayExitHandler(null);
      } finally {
        vi.useRealTimers();
      }
    });

    it("runs force restart via runGatewayCmd and logs supervisor output", async () => {
      const supervisor = createChild();
      childProcess.spawn = vi.fn(() => supervisor);
      childProcess.execSync = vi.fn(() => "");
      fs.existsSync = vi.fn(() => false);
      net.createConnection = vi.fn(() => createSocket(true));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const launchHandler = vi.fn();
      gateway.setGatewayLaunchHandler(launchHandler);

      await gateway.runGatewayCmd("--force");

      expect(childProcess.spawn).toHaveBeenCalledWith(
        "openclaw",
        ["gateway", "--force"],
        expect.objectContaining({ env: expect.any(Object) }),
      );
      expect(launchHandler).toHaveBeenCalledWith(
        expect.objectContaining({ pid: null }),
      );

      const onStdout = supervisor.stdout.on.mock.calls.find((c) => c[0] === "data")[1];
      const onStderr = supervisor.stderr.on.mock.calls.find((c) => c[0] === "data")[1];
      const onExit = supervisor.on.mock.calls.find((c) => c[0] === "exit")[1];
      onStdout(Buffer.from("supervisor out\n"));
      onStderr("supervisor err\n");
      onExit(0, null);
      onExit(null, "SIGTERM");
      gateway.setGatewayLaunchHandler(null);
    });

    it("logs execSync output and failures for short gateway commands", async () => {
      const behaviors = [
        (cb) => cb(null, "gateway stopped\n", ""),
        (cb) => {
          const error = new Error("exec failed");
          error.stdout = "some stdout";
          error.stderr = "some stderr";
          error.code = 7;
          cb(error, "some stdout", "some stderr");
        },
        (cb) => cb(new Error("plain failure"), "", ""),
      ];
      childProcess.execFile = vi.fn((file, args, opts, cb) =>
        behaviors.shift()(cb),
      );
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      await gateway.runGatewayCmd("stop");
      await gateway.runGatewayCmd("stop");
      await gateway.runGatewayCmd("stop");

      expect(logSpy).toHaveBeenCalledWith("[alphaclaw] gateway stopped");
      expect(logSpy).toHaveBeenCalledWith(
        "[alphaclaw] gateway stop stdout: some stdout",
      );
      expect(logSpy).toHaveBeenCalledWith(
        "[alphaclaw] gateway stop stderr: some stderr",
      );
      expect(logSpy).toHaveBeenCalledWith("[alphaclaw] gateway stop exit code: 7");
      expect(logSpy).toHaveBeenCalledWith(
        "[alphaclaw] gateway stop error: plain failure",
      );
    });

    it("attaches signal handlers that stop the gateway and exit", async () => {
      childProcess.execFile = execFileOk("");
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const onSpy = vi.spyOn(process, "on").mockImplementation(() => process);
      const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined);

      gateway.attachGatewaySignalHandlers();

      const sigterm = onSpy.mock.calls.find((c) => c[0] === "SIGTERM")[1];
      const sigint = onSpy.mock.calls.find((c) => c[0] === "SIGINT")[1];
      // Handlers stop the gateway asynchronously before exiting.
      await sigterm();
      await sigint();

      expect(exitSpy).toHaveBeenCalledTimes(2);
      expect(exitSpy).toHaveBeenCalledWith(0);
      expect(childProcess.execFile).toHaveBeenCalledWith(
        "openclaw",
        ["gateway", "stop"],
        expect.objectContaining({ encoding: "utf8" }),
        expect.any(Function),
      );
      onSpy.mockRestore();
      exitSpy.mockRestore();
    });

    it("stopGatewayForShutdown reaps the child and best-effort stops external gateways", async () => {
      // The lifecycle orchestrator awaits this during graceful shutdown
      // (instead of the plain SIGTERM/SIGINT handlers).
      childProcess.exec = vi.fn((cmd, opts, cb) => {
        cb(null, "", "");
        return {};
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      await gateway.stopGatewayForShutdown();

      expect(childProcess.exec).toHaveBeenCalledWith(
        "openclaw gateway stop",
        expect.objectContaining({ encoding: "utf8", timeout: 5000 }),
        expect.any(Function),
      );
    });

    it("stopGatewayForBackup marks the exit expected, swallows CLI stop failures, and reports the stop verdict", async () => {
      const child = createChild();
      child.kill = vi.fn((sig) => {
        child.killed = true;
        // Signal deaths set signalCode and leave exitCode null (real Node
        // semantics) so the reap wait settles without polling its budget.
        child.signalCode = sig;
        return true;
      });
      childProcess.spawn = vi.fn(() => child);
      let stopCalls = 0;
      childProcess.execFile = vi.fn((file, args, opts, cb) => {
        if (args?.[0] === "gateway" && args?.[1] === "stop") {
          stopCalls += 1;
          // The external best-effort stop fails — quiesce must proceed on
          // the port verdict, never throw.
          cb(Object.assign(new Error("stop timed out"), { code: 1 }), "", "");
          return;
        }
        cb(null, "", "");
      });
      fs.existsSync = vi.fn(() => false);
      net.createConnection = vi.fn(() => createSocket(false));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const exitHandler = vi.fn();
      gateway.setGatewayExitHandler(exitHandler);

      await gateway.launchGatewayProcess();
      const verdict = await gateway.stopGatewayForBackup();

      // The port released → waitForGatewayStopped's verdict rides through.
      expect(verdict).toBe(true);
      // The CLI stop ran once and its failure was swallowed (best-effort).
      expect(stopCalls).toBe(1);

      // The managed exit was marked expected BEFORE the kill: the watchdog
      // must not count the quiesce as a crash. The exit report finalizes on
      // 'close' (the bounded exit-vs-close stderr drain) — emit both, as real
      // Node does.
      const onExit = child.on.mock.calls.find((call) => call[0] === "exit")[1];
      const onClose = child.on.mock.calls.find(
        (call) => call[0] === "close",
      )[1];
      onExit(null, "SIGTERM");
      onClose(null, "SIGTERM");
      expect(exitHandler).toHaveBeenCalledWith(
        expect.objectContaining({ expectedExit: true }),
      );

      // Unlike stopGatewayForShutdown, the one-way abortGatewayWaits latch
      // did NOT flip: the relaunch that follows the backup still spawns.
      const relaunched = await gateway.launchGatewayProcess();
      expect(relaunched).toBeTruthy();
      expect(childProcess.spawn).toHaveBeenCalledTimes(2);
    });

    it("stopGatewayForBackup reports false when the port never releases", async () => {
      childProcess.execFile = execFileOk("");
      fs.existsSync = vi.fn(() => false);
      // The old gateway keeps the port for the whole (tiny) settle window.
      net.createConnection = vi.fn(() => createSocket(true));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      vi.spyOn(console, "log").mockImplementation(() => {});

      const verdict = await gateway.stopGatewayForBackup({ timeoutMs: 1 });

      expect(verdict).toBe(false);
    });

    it("escalates to SIGKILL when the gateway child ignores SIGTERM", async () => {
      // Node sets child.killed=true the moment a signal is SENT — the
      // escalation must not be gated on it, or a SIGTERM-ignoring gateway
      // survives every shutdown holding the port.
      const signals = [];
      const child = createChild();
      child.kill = vi.fn((sig) => {
        signals.push(sig);
        child.killed = true;
        // Signal deaths set signalCode and leave exitCode null (real Node
        // semantics — modeling exitCode here is exactly the mock error that
        // hid the reap-wait bug from the unit suite).
        if (sig === "SIGKILL") child.signalCode = "SIGKILL";
        return true;
      });
      childProcess.spawn = vi.fn(() => child);
      childProcess.execFile = execFileOk("");
      fs.existsSync = vi.fn(() => false);
      net.createConnection = vi.fn(() => createSocket(false));
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      await gateway.launchGatewayProcess();
      const reaped = await gateway.stopGatewayChildAndWait({ graceMs: 50 });

      expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
      expect(reaped).toBe(true);
    });

    it("uses lifecycle restart for light restarts while the gateway is up", async () => {
      const behaviors = [
        (cb) => cb(null, "restarted ok\n", ""),
        (cb) => {
          const error = new Error("restart failed");
          cb(error, "", "restart failed hard");
        },
      ];
      const execFileMock = vi.fn((file, args, opts, cb) =>
        behaviors.shift()(cb),
      );
      childProcess.execFile = execFileMock;
      net.createConnection = vi.fn(() => createSocket(true));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const reloadEnv = vi.fn();

      await gateway.restartGatewayLight(reloadEnv);
      await gateway.restartGatewayLight(reloadEnv);

      expect(reloadEnv).toHaveBeenCalledTimes(2);
      expect(execFileMock).toHaveBeenCalledWith(
        "openclaw",
        ["gateway", "restart"],
        expect.objectContaining({ timeout: 90000 }),
        expect.any(Function),
      );
      expect(logSpy).toHaveBeenCalledWith(
        "[alphaclaw] Gateway light restart complete",
      );
      expect(warnSpy).toHaveBeenCalledWith("[alphaclaw] Gateway light restart failed");
    });

    it("launches a managed process for light restarts when nothing is running", async () => {
      const child = createChild();
      childProcess.spawn = vi.fn(() => child);
      childProcess.execFile = execFileOk("");
      fs.existsSync = vi.fn(() => false);
      net.createConnection = vi.fn(() => createSocket(false));
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      await gateway.restartGatewayLight(vi.fn());
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);

      // The managed child is still active, so a second light restart is a no-op.
      await gateway.restartGatewayLight(vi.fn());
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    });

    it("stops the supervisor when a restart never becomes ready", async () => {
      vi.useFakeTimers();
      try {
        const supervisor = createChild();
        childProcess.spawn = vi.fn(() => supervisor);
        childProcess.execFile = execFileOk("");
        fs.existsSync = vi.fn(() => false);
        net.createConnection = vi.fn(() => ({
          setTimeout: vi.fn(),
          destroy: vi.fn(),
          on(event, handler) {
            if (event === "timeout") handler();
            return this;
          },
        }));
        delete require.cache[modulePath];
        const gateway = require(modulePath);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const pending = gateway.runGatewayCmd("--force");
        pending.catch(() => {});
        await vi.advanceTimersByTimeAsync(121000);
        // A restart that never becomes ready is now an explicit failure with
        // evidence attached (previously a silent success).
        await expect(pending).rejects.toMatchObject({
          name: "GatewayRestartError",
          evidence: expect.objectContaining({ timeoutMs: 120000 }),
        });

        expect(supervisor.kill).toHaveBeenCalledWith("SIGTERM");
        expect(childProcess.execFile).toHaveBeenCalledWith(
          "openclaw",
          ["gateway", "stop"],
          expect.anything(),
          expect.any(Function),
        );
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("did not become ready"),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("fails a restart fast with evidence when the supervisor cannot spawn", async () => {
      const supervisor = createChild();
      childProcess.spawn = vi.fn(() => supervisor);
      childProcess.execFile = execFileOk("");
      fs.existsSync = vi.fn(() => false);
      net.createConnection = vi.fn(() => ({
        setTimeout: vi.fn(),
        destroy: vi.fn(),
        on(event, handler) {
          if (event === "error") handler();
          return this;
        },
      }));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);

      const pending = gateway.runGatewayCmd("--force");
      pending.catch(() => {});
      // The openclaw binary is missing/non-executable (e.g. mid-apply): spawn
      // emits 'error'. Without a listener this is process death; with it the
      // restart fails within the poll cadence, not the 120s budget.
      const errorHandler = supervisor.on.mock.calls.find(
        (call) => call[0] === "error",
      )?.[1];
      expect(typeof errorHandler).toBe("function");
      errorHandler(new Error("spawn openclaw ENOENT"));

      const rejection = await pending.catch((err) => err);
      expect(rejection.name).toBe("GatewayRestartError");
      expect(rejection.evidence.stderrTail.join("\n")).toContain(
        "spawn openclaw ENOENT",
      );
    });

    it("abortGatewayWaits cancels an in-flight ready wait instead of burning the 120s budget", async () => {
      vi.useFakeTimers();
      try {
        const supervisor = createChild();
        childProcess.spawn = vi.fn(() => supervisor);
        childProcess.execFile = execFileOk("");
        fs.existsSync = vi.fn(() => false);
        // The port never comes up: without the abort, this wait runs 120s.
        net.createConnection = vi.fn(() => ({
          setTimeout: vi.fn(),
          destroy: vi.fn(),
          on(event, handler) {
            if (event === "error") handler();
            return this;
          },
        }));
        delete require.cache[modulePath];
        const gateway = require(modulePath);
        vi.spyOn(console, "warn").mockImplementation(() => {});

        const pending = gateway.runGatewayCmd("--force");
        pending.catch(() => {});
        // Let the wait park on its first poll interval, then shutdown flips
        // the module-level abort flag.
        await vi.advanceTimersByTimeAsync(600);
        gateway.abortGatewayWaits("shutdown");
        await vi.advanceTimersByTimeAsync(1000);

        // The wait ended within one poll interval, not the 120s ready budget,
        // and the operation failed loudly (never a silent success).
        const rejection = await pending.catch((err) => err);
        expect(rejection.name).toBe("GatewayRestartError");
        expect(rejection.message).toContain("shutdown");
        expect(rejection.evidence.aborted).toBe(true);
        // The orphaned supervisor was reaped rather than left holding the port.
        expect(supervisor.kill).toHaveBeenCalledWith("SIGTERM");
      } finally {
        vi.useRealTimers();
      }
    });

    it("resets the stderr evidence tail per restart attempt", async () => {
      vi.useFakeTimers();
      try {
        const firstSupervisor = createChild();
        const secondSupervisor = createChild();
        const supervisors = [firstSupervisor, secondSupervisor];
        childProcess.spawn = vi.fn(() => supervisors.shift());
        childProcess.execFile = execFileOk("");
        fs.existsSync = vi.fn(() => false);
        net.createConnection = vi.fn(() => ({
          setTimeout: vi.fn(),
          destroy: vi.fn(),
          on(event, handler) {
            if (event === "timeout") handler();
            return this;
          },
        }));
        delete require.cache[modulePath];
        const gateway = require(modulePath);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        const emitStderr = (child, text) => {
          const handler = child.stderr.on.mock.calls.find(
            (call) => call[0] === "data",
          )?.[1];
          handler?.(text);
        };

        const firstAttempt = gateway.runGatewayCmd("--force");
        firstAttempt.catch(() => {});
        emitStderr(firstSupervisor, "old-noise from a previous attempt\n");
        await vi.advanceTimersByTimeAsync(121000);
        await expect(firstAttempt).rejects.toMatchObject({
          name: "GatewayRestartError",
        });

        const secondAttempt = gateway.runGatewayCmd("--force");
        secondAttempt.catch(() => {});
        emitStderr(secondSupervisor, "fresh failure line\n");
        await vi.advanceTimersByTimeAsync(121000);
        const rejection = await secondAttempt.catch((err) => err);
        expect(rejection.name).toBe("GatewayRestartError");
        const tailText = rejection.evidence.stderrTail.join("\n");
        expect(tailText).toContain("fresh failure line");
        // Regression: the tail used to accumulate across attempts, so a
        // failure's evidence included stderr from previous launches.
        expect(tailText).not.toContain("old-noise");
      } finally {
        vi.useRealTimers();
      }
    });

    it("warns and still force-restarts when the old gateway never releases the port", async () => {
      vi.useFakeTimers();
      try {
        const supervisor = createChild();
        const spawnMock = vi.fn(() => supervisor);
        childProcess.spawn = spawnMock;
        childProcess.execFile = execFileOk("");
        fs.existsSync = vi.fn(() => false);
        // The port answers before AND after `stop`: a wedged old process.
        net.createConnection = vi.fn(() => ({
          setTimeout: vi.fn(),
          destroy: vi.fn(),
          on(event, handler) {
            if (event === "connect") handler();
            return this;
          },
        }));
        delete require.cache[modulePath];
        const gateway = require(modulePath);
        const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

        const pending = gateway.restartGateway(vi.fn());
        await vi.advanceTimersByTimeAsync(16000);
        const result = await pending;

        // The bounded stop-settle wait gave up loudly instead of declaring a
        // false instant success against the old process...
        expect(warnSpy).toHaveBeenCalledWith(
          expect.stringContaining("still holds the port"),
        );
        // ...and --force still ran to replace the wedged gateway.
        expect(spawnMock).toHaveBeenCalledWith(
          "openclaw",
          ["gateway", "--force"],
          expect.objectContaining({ env: expect.any(Object) }),
        );
        // Downtime measurement includes the full 15s stop-settle wait.
        expect(result.downtimeMs).toBeGreaterThanOrEqual(15000);
      } finally {
        vi.useRealTimers();
      }
    });

    it("joins a secret split across stderr chunk boundaries into one tail line", async () => {
      vi.useFakeTimers();
      try {
        const supervisor = createChild();
        childProcess.spawn = vi.fn(() => supervisor);
        childProcess.execFile = execFileOk("");
        fs.existsSync = vi.fn(() => false);
        net.createConnection = vi.fn(() => ({
          setTimeout: vi.fn(),
          destroy: vi.fn(),
          on(event, handler) {
            if (event === "timeout") handler();
            return this;
          },
        }));
        delete require.cache[modulePath];
        const gateway = require(modulePath);
        vi.spyOn(console, "warn").mockImplementation(() => {});
        vi.spyOn(process.stderr, "write").mockImplementation(() => true);

        const attempt = gateway.runGatewayCmd("--force");
        attempt.catch(() => {});
        const emitStderr = supervisor.stderr.on.mock.calls.find(
          (call) => call[0] === "data",
        )[1];
        // A secret value split across two data events must land in the tail
        // as ONE joined line — redaction matches whole values, and two
        // unmatchable halves would leak it through the mask.
        emitStderr("token super");
        emitStderr("secret123\n");
        await vi.advanceTimersByTimeAsync(121000);
        const rejection = await attempt.catch((err) => err);

        expect(rejection.name).toBe("GatewayRestartError");
        expect(rejection.evidence.stderrTail).toContain("token supersecret123");
        // Neither half appears as its own (unredactable) tail entry.
        expect(rejection.evidence.stderrTail).not.toContain("token super");
        expect(rejection.evidence.stderrTail).not.toContain("secret123");
      } finally {
        vi.useRealTimers();
      }
    });

    it("notifies the launch handler when the gateway is already running", async () => {
      const child = createChild();
      childProcess.spawn = vi.fn(() => child);
      childProcess.execSync = vi.fn(() => "");
      fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
      let running = false;
      net.createConnection = vi.fn(() => createSocket(() => running));
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      await gateway.startGateway();
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);

      running = true;
      const launchHandler = vi.fn();
      gateway.setGatewayLaunchHandler(launchHandler);
      await gateway.startGateway();
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
      expect(launchHandler).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 1234 }),
      );

      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      gateway.setGatewayLaunchHandler(() => {
        throw new Error("notify-boom");
      });
      await gateway.startGateway();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("Gateway launch handler error: notify-boom"),
      );
      gateway.setGatewayLaunchHandler(null);
    });

    it("skips the launch notification when the gateway flaps back down", async () => {
      const supervisor = createChild();
      childProcess.spawn = vi.fn(() => supervisor);
      childProcess.execSync = vi.fn(() => "");
      fs.existsSync = vi.fn(() => false);
      let connectionAttempts = 0;
      net.createConnection = vi.fn(() =>
        createSocket(() => {
          connectionAttempts += 1;
          return connectionAttempts === 1;
        }),
      );
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const launchHandler = vi.fn();
      gateway.setGatewayLaunchHandler(launchHandler);

      await gateway.runGatewayCmd("--force");

      expect(launchHandler).not.toHaveBeenCalled();
      gateway.setGatewayLaunchHandler(null);
    });

    it("skips gateway start when not onboarded", async () => {
      childProcess.spawn = vi.fn();
      fs.existsSync = vi.fn(() => false);
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      await gateway.startGateway();

      expect(childProcess.spawn).not.toHaveBeenCalled();
    });
  });

  describe("gateway config edge cases", () => {
    it("returns zero when the plugin extensions dir cannot be read", () => {
      fs.readdirSync = vi.fn(() => {
        throw new Error("EACCES");
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(
        gateway.cleanupOpenclawPluginInstallStages({ extensionsDir: "/tmp/ext" }),
      ).toBe(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("Could not clean OpenClaw plugin install stages"),
      );
    });

    it("returns zero when the openclaw package cannot be resolved", () => {
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      fs.readdirSync = vi.fn(() => {
        throw new Error("should not be called");
      });
      const Module = require("module");
      const originalResolve = Module._resolveFilename;
      Module._resolveFilename = function (request, ...rest) {
        if (request === "openclaw") {
          throw new Error("Cannot find module 'openclaw'");
        }
        return originalResolve.call(this, request, ...rest);
      };
      try {
        expect(gateway.cleanupOpenclawPluginInstallStages()).toBe(0);
        expect(fs.readdirSync).not.toHaveBeenCalled();
      } finally {
        Module._resolveFilename = originalResolve;
      }
    });

    it("skips plugin preflight when channel config is unreadable", () => {
      childProcess.execSync = vi.fn();
      fs.existsSync = vi.fn(() => true);
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      fs.readFileSync = vi.fn(() => "not json");

      gateway.prepareOpenclawChannelPlugins();

      expect(childProcess.execSync).not.toHaveBeenCalled();
    });

    it("warns when plugin preflight fails for non-install-stage reasons", async () => {
      childProcess.execFile = vi.fn((file, args, opts, cb) => {
        const error = new Error("EAI_AGAIN registry.npmjs.org");
        error.stderr = "network down";
        cb(error, "", "");
      });
      fs.existsSync = vi.fn(
        (targetPath) => targetPath === `${OPENCLAW_DIR}/openclaw.json`,
      );
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      fs.readFileSync = vi.fn(() =>
        JSON.stringify({ channels: { telegram: { enabled: true } } }),
      );
      fs.readdirSync = vi.fn(() => []);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await gateway.prepareOpenclawChannelPlugins();

      expect(childProcess.execFile).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("OpenClaw plugin preflight failed"),
      );
    });

    it("warns when the plugin preflight retry also fails", async () => {
      childProcess.execFile = vi.fn((file, args, opts, cb) =>
        cb(
          new Error(
            "ENOTEMPTY: directory not empty, rmdir '.openclaw-install-stage'",
          ),
          "",
          "",
        ),
      );
      fs.existsSync = vi.fn(
        (targetPath) => targetPath === `${OPENCLAW_DIR}/openclaw.json`,
      );
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      fs.readFileSync = vi.fn(() =>
        JSON.stringify({ channels: { telegram: { enabled: true } } }),
      );
      fs.readdirSync = vi.fn(() => []);
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      await gateway.prepareOpenclawChannelPlugins();

      expect(childProcess.execFile).toHaveBeenCalledTimes(2);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("OpenClaw plugin preflight retry failed"),
      );
    });

    it("falls back to the default gateway port when config is unreadable", () => {
      fs.existsSync = vi.fn(() => true);
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      // The parsed config is memoized keyed on the fs function identities, so
      // each variant installs a fresh mock to observe a re-read.
      fs.readFileSync = vi.fn(() => {
        throw new Error("EIO");
      });
      expect(gateway.getGatewayPort()).toBe(kDefaultGatewayPort);
      fs.readFileSync = vi.fn(() =>
        JSON.stringify({ gateway: { port: 23456 } }),
      );
      expect(gateway.getGatewayPort()).toBe(23456);
      fs.readFileSync = vi.fn(() => JSON.stringify({ gateway: {} }));
      expect(gateway.getGatewayPort()).toBe(kDefaultGatewayPort);
    });

    it("returns false when ensureGatewayProxyConfig cannot read the config", () => {
      fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      fs.readFileSync = vi.fn(() => {
        throw new Error("EIO");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      expect(gateway.ensureGatewayProxyConfig("https://x.example.com")).toBe(false);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("ensureGatewayProxyConfig error: EIO"),
      );
    });

    it("returns an empty channel status when the config is unreadable", () => {
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      fs.readFileSync = vi.fn(() => {
        throw new Error("EIO");
      });

      expect(gateway.getChannelStatus()).toEqual({});
    });
  });

  describe("syncChannelConfig", () => {
    const configPath = `${OPENCLAW_DIR}/openclaw.json`;

    const setupConfig = (initialRaw) => {
      const state = { raw: initialRaw };
      fs.readFileSync = vi.fn((targetPath, ...args) => {
        if (targetPath === configPath) return state.raw;
        return originalReadFileSync(targetPath, ...args);
      });
      fs.writeFileSync = vi.fn((targetPath, contents) => {
        if (targetPath === configPath) state.raw = contents;
      });
      return state;
    };

    it("adds a telegram channel and scrubs the token into an env placeholder", async () => {
      const state = setupConfig(JSON.stringify({ channels: {} }));
      childProcess.execFile = vi.fn((file, args, opts, cb) => {
        state.raw = JSON.stringify({
          channels: { telegram: { enabled: true, botToken: "tg-secret" } },
        });
        cb(null, "", "");
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      await gateway.syncChannelConfig(
        [
          { key: "TELEGRAM_BOT_TOKEN", value: "tg-secret" },
          { key: "EMPTY_VALUE", value: "" },
        ],
        "add",
      );

      expect(childProcess.execFile).toHaveBeenCalledWith(
        "openclaw",
        ["channels", "add", "--channel", "telegram", "--token", "tg-secret"],
        expect.objectContaining({ timeout: 15000, encoding: "utf8" }),
        expect.any(Function),
      );
      expect(state.raw).toContain("${TELEGRAM_BOT_TOKEN}");
      expect(state.raw).not.toContain("tg-secret");
    });

    it("adds a slack channel with both tokens and scrubs them", async () => {
      const state = setupConfig(JSON.stringify({ channels: {} }));
      childProcess.execFile = vi.fn((file, args, opts, cb) => {
        state.raw = JSON.stringify({
          channels: {
            slack: { enabled: true, botToken: "xoxb-bot", appToken: "xapp-app" },
          },
        });
        cb(null, "", "");
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      await gateway.syncChannelConfig(
        [
          { key: "SLACK_BOT_TOKEN", value: "xoxb-bot" },
          { key: "SLACK_APP_TOKEN", value: "xapp-app" },
        ],
        "all",
      );

      expect(childProcess.execFile).toHaveBeenCalledWith(
        "openclaw",
        [
          "channels",
          "add",
          "--channel",
          "slack",
          "--bot-token",
          "xoxb-bot",
          "--app-token",
          "xapp-app",
        ],
        expect.objectContaining({ timeout: 15000 }),
        expect.any(Function),
      );
      expect(state.raw).toContain("${SLACK_BOT_TOKEN}");
      expect(state.raw).toContain("${SLACK_APP_TOKEN}");
      expect(state.raw).not.toContain("xoxb-bot");
      expect(state.raw).not.toContain("xapp-app");
    });

    it("skips slack when the app token is missing", async () => {
      setupConfig(JSON.stringify({ channels: {} }));
      childProcess.execFile = execFileOk("");
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      await gateway.syncChannelConfig(
        [{ key: "SLACK_BOT_TOKEN", value: "xoxb-bot" }],
        "add",
      );

      expect(childProcess.execFile).not.toHaveBeenCalled();
    });

    it("scrubs secret argv values from a failing channels add error message before logging", async () => {
      setupConfig(JSON.stringify({ channels: {} }));
      // execFile failures embed the full argv in error.message — exactly the
      // shape Node produces for a non-zero exit.
      childProcess.execFile = vi.fn((file, args, opts, cb) => {
        cb(
          new Error(
            "Command failed: openclaw channels add --channel slack --bot-token xoxb-SECRET --app-token xapp-SECRET",
          ),
          "",
          "",
        );
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await gateway.syncChannelConfig(
        [
          { key: "SLACK_BOT_TOKEN", value: "xoxb-SECRET" },
          { key: "SLACK_APP_TOKEN", value: "xapp-SECRET" },
        ],
        "add",
      );

      const logged = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .find((line) => line.includes("channels add slack"));
      // The values following --bot-token/--app-token were redacted before the
      // message could reach process.log (served by /api/watchdog/logs).
      expect(logged).toContain("[redacted]");
      expect(logged).not.toContain("xoxb-SECRET");
      expect(logged).not.toContain("xapp-SECRET");
    });

    it("scrubs token values echoed on stderr before logging channel add failures", async () => {
      setupConfig(JSON.stringify({ channels: {} }));
      childProcess.execFile = vi.fn((file, args, opts, cb) => {
        cb(
          new Error("add failed"),
          "",
          "invalid token tg-secret-value rejected by API",
        );
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await gateway.syncChannelConfig(
        [{ key: "TELEGRAM_BOT_TOKEN", value: "tg-secret-value" }],
        "add",
      );

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          "channels add telegram: invalid token [redacted] rejected by API",
        ),
      );
      const allLogged = errorSpy.mock.calls
        .map((call) => String(call[0]))
        .join("\n");
      expect(allLogged).not.toContain("tg-secret-value");
    });

    it("logs channel add failures", async () => {
      setupConfig(JSON.stringify({ channels: {} }));
      childProcess.execFile = execFileFail({
        message: "add failed",
        stderr: "invalid token",
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await gateway.syncChannelConfig(
        [{ key: "TELEGRAM_BOT_TOKEN", value: "tg-secret" }],
        "add",
      );

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("channels add telegram: invalid token"),
      );
    });

    it("removes channels whose tokens were cleared", async () => {
      setupConfig(JSON.stringify({ channels: { telegram: { enabled: true } } }));
      childProcess.execFile = execFileOk("");
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      await gateway.syncChannelConfig([], "remove");

      expect(childProcess.execFile).toHaveBeenCalledWith(
        "openclaw",
        ["channels", "remove", "--channel", "telegram", "--delete"],
        expect.objectContaining({ timeout: 15000 }),
        expect.any(Function),
      );
    });

    it("never auto-removes an externally-configured channel (no envKey)", async () => {
      // Upstream #113 precondition: signal has no managed env token, so the
      // removal branch must skip it — on every boot AND env save — while
      // managed channels keep their remove-on-cleared-token behavior.
      setupConfig(
        JSON.stringify({
          channels: { signal: { enabled: true }, telegram: { enabled: true } },
        }),
      );
      childProcess.execFile = execFileOk("");
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      await gateway.syncChannelConfig([], "all");

      expect(childProcess.execFile).toHaveBeenCalledWith(
        "openclaw",
        ["channels", "remove", "--channel", "telegram", "--delete"],
        expect.objectContaining({ timeout: 15000 }),
        expect.any(Function),
      );
      const removedChannels = childProcess.execFile.mock.calls
        .map((call) => call[1])
        .filter((args) => args[0] === "channels" && args[1] === "remove")
        .map((args) => args[args.indexOf("--channel") + 1]);
      expect(removedChannels).toEqual(["telegram"]);
    });

    it("still removes whatsapp when its owner number is cleared (pinned behavior)", async () => {
      // whatsapp declares `sync: false` but the flag is deliberately NOT
      // honored this wave: its env-clear removal lifecycle must stay
      // byte-identical (see TODOS for the flag's fate).
      setupConfig(
        JSON.stringify({ channels: { whatsapp: { enabled: true } } }),
      );
      childProcess.execFile = execFileOk("");
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      await gateway.syncChannelConfig([], "remove");

      expect(childProcess.execFile).toHaveBeenCalledWith(
        "openclaw",
        ["channels", "remove", "--channel", "whatsapp", "--delete"],
        expect.objectContaining({ timeout: 15000 }),
        expect.any(Function),
      );
    });

    it("logs channel remove failures", async () => {
      setupConfig(JSON.stringify({ channels: { telegram: { enabled: true } } }));
      childProcess.execFile = execFileFail({ message: "remove failed" });
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      await gateway.syncChannelConfig([], "all");

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("channels remove telegram: remove failed"),
      );
    });

    it("logs a sync error when the config cannot be read", () => {
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      fs.readFileSync = vi.fn(() => {
        throw new Error("EIO");
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      gateway.syncChannelConfig([], "all");

      expect(errorSpy).toHaveBeenCalledWith(
        "[alphaclaw] syncChannelConfig error:",
        "EIO",
      );
    });
  });
});

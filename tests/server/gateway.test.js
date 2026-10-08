// Pin the ready budget to the drill-friendly 120s BEFORE any lib require:
// constants.js reads GATEWAY_RESTART_READY_TIMEOUT at module load, and the
// per-test `delete require.cache[gateway]` re-require does NOT re-evaluate
// the cached constants module. The 300s production default is asserted in
// its own vi.resetModules-based block below. NOTE for future drills: a
// deadline-boundary drill against the DEFAULT budget must advance ~600s+.
process.env.GATEWAY_RESTART_READY_TIMEOUT = "120";

const childProcess = require("child_process");
const fs = require("fs");
const net = require("net");
const os = require("os");
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
const originalFstatSync = fs.fstatSync;
const originalOpenSync = fs.openSync;
const originalFsyncSync = fs.fsyncSync;
const originalCloseSync = fs.closeSync;
const originalUnlinkSync = fs.unlinkSync;
const originalRenameSync = fs.renameSync;

// Fix wave F013: openclaw.json writers go through writeFileAtomic (temp file →
// fsync → rename). Tests that used to capture `fs.writeFileSync(configPath)`
// now capture the RENAME onto configPath; every other fs call delegates to the
// real module so the shared file lock keeps working. Returns the write spy.
const kAtomicMockFd = 987654321;
const mockAtomicConfigWrites = (onWrite = () => {}) => {
  const pending = new Map();
  const configWrite = vi.fn(onWrite);
  // The real shared file lock opens `<OPENCLAW_DIR>/openclaw.json.lock` on
  // disk, and mkdirSync is a no-op below — so the directory must exist
  // before the mock (it used to be created as a side effect of earlier
  // restart tests; a fresh checkout without ~/.alphaclaw failed here).
  originalMkdirSync(OPENCLAW_DIR, { recursive: true });
  fs.mkdirSync = vi.fn();
  fs.writeFileSync = vi.fn((targetPath, contents) => {
    pending.set(String(targetPath), contents);
  });
  fs.openSync = vi.fn((targetPath, ...rest) =>
    pending.has(String(targetPath)) ? kAtomicMockFd : originalOpenSync(targetPath, ...rest),
  );
  fs.fsyncSync = vi.fn((fd) => (fd === kAtomicMockFd ? undefined : originalFsyncSync(fd)));
  fs.closeSync = vi.fn((fd) => (fd === kAtomicMockFd ? undefined : originalCloseSync(fd)));
  fs.unlinkSync = vi.fn((targetPath) => {
    if (pending.delete(String(targetPath))) return undefined;
    return originalUnlinkSync(targetPath);
  });
  fs.renameSync = vi.fn((from, to) => {
    if (!pending.has(String(from))) return originalRenameSync(from, to);
    const contents = pending.get(String(from));
    pending.delete(String(from));
    return configWrite(String(to), contents);
  });
  return configWrite;
};
const originalCreateConnection = net.createConnection;
const originalPrelaunchHookEnv = process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK;
// Namespace-required by gateway.js so the live-process scan can be pinned.
const lockContention = require("../../lib/server/openclaw-lock-contention");
// The REAL /proc scan, captured before any suite spies on it (v0.9.81 fixture
// test below drives listGatewayPids through it over a fake /proc).
const realListLiveOpenclawProcesses = lockContention.listLiveOpenclawProcesses;
const { kOpenclawArgvFixtures } = require("./fixtures/openclaw-argv-fixtures");
const autotune = require("../../lib/server/autotune");
// The capabilities factory lazy-requires this on first probe; warm the module
// cache so a test's fs.readFileSync mock never serves it as module source.
require("../../lib/server/doctor/classify-doctor-cli");

// `openclaw gateway stop --help` contract pins (tarball-verified): --force
// ("Allow stop from a non-interactive shell") exists on 2026.8.2 and
// 2026.9.1-beta.1 and is ABSENT on the 2026.7.1-2 pin.
const kStopHelpWithForce =
  "Usage: openclaw gateway stop [options]\n\nOptions:\n  --force     Allow stop from a non-interactive shell\n  -h, --help  display help for command\n";
const kStopHelpWithoutForce =
  "Usage: openclaw gateway stop [options]\n\nOptions:\n  -h, --help  display help for command\n";
// The CLI's NON_INTERACTIVE guard text (exit 1) when --force is missing.
const kStopRefusal =
  "This stops the operator's running gateway service. Use an isolated dev gateway (openclaw gateway run --dev, or --profile <name> with a free port) for testing, or re-run with --force\n";
const isStopHelpProbe = (args) =>
  Array.isArray(args) && args[0] === "gateway" && args.includes("--help");
const refusedStopError = () =>
  Object.assign(new Error("Command failed: openclaw gateway stop"), {
    code: 1,
    stdout: "",
    stderr: kStopRefusal,
  });

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
  beforeEach(() => {
    // Hermetic by default: the incumbent verdict scans the REAL /proc for
    // openclaw processes; a developer's own gateway must never leak into a
    // drill's pid evidence. Tests that need pids override this spy.
    vi.spyOn(lockContention, "listLiveOpenclawProcesses").mockReturnValue([]);
    // Hermetic by default (C13): a managed launch fires the `gateway stop
    // --help` capability probe through execFile; gateway.js binds execFile at
    // require time, so a fresh require in a test that never installed its own
    // mock would run the REAL pinned openclaw CLI, unawaited, outliving the
    // test. Tests that need a specific probe answer install their own mock
    // before their require (afterEach restores the real one).
    childProcess.execFile = execFileOk("");
  });

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
    fs.fstatSync = originalFstatSync;
    fs.openSync = originalOpenSync;
    fs.fsyncSync = originalFsyncSync;
    fs.closeSync = originalCloseSync;
    fs.unlinkSync = originalUnlinkSync;
    fs.renameSync = originalRenameSync;
    net.createConnection = originalCreateConnection;
    if (originalPrelaunchHookEnv === undefined) {
      delete process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK;
    } else {
      process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK = originalPrelaunchHookEnv;
    }
    delete require.cache[modulePath];
  });

  it("returns the boot child before it listens so supervision can track startup", async () => {
    const child = createChild();
    childProcess.spawn = vi.fn(() => child);
    childProcess.execSync = vi.fn(() => "");
    fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
    net.createConnection = vi.fn(() => createSocket(() => false));
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    const launchHandler = vi.fn();
    gateway.setGatewayLaunchHandler(launchHandler);

    expect(await gateway.startGateway()).toBe(child);
    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    expect(launchHandler).not.toHaveBeenCalled();
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
        }),
      );
      // Under the external supervisor the gateway's own restart must exit 0
      // for AlphaClaw to relaunch it (restart handoff) — no in-process pin.
      expect("OPENCLAW_NO_RESPAWN" in gateway.gatewayEnv()).toBe(false);
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
    const { stripTelemetryNodeOptions } = require("../../lib/server/gateway-memory/telemetry-bootstrap");
    const previousCap = process.env.ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    try {
      delete process.env.NODE_OPTIONS;
      process.env.ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE = "8192";
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      // The long-running daemon gets the operator's explicit cap…
      expect(stripTelemetryNodeOptions(gateway.gatewayLaunchEnv().NODE_OPTIONS)).toBe(
        "--max-old-space-size=8192",
      );
      // …but plain gatewayEnv (every short-lived openclaw CLI child) does not.
      expect(stripTelemetryNodeOptions(gateway.gatewayEnv().NODE_OPTIONS)).toBe("");

      // The cap appends to surviving (non-memory) inherited flags.
      process.env.NODE_OPTIONS = "--enable-source-maps --max-old-space-size=768";
      expect(stripTelemetryNodeOptions(gateway.gatewayLaunchEnv().NODE_OPTIONS)).toBe(
        "--enable-source-maps --max-old-space-size=8192",
      );

      // Invalid values are ignored — no flag, no crash.
      process.env.ALPHACLAW_GATEWAY_MAX_OLD_SPACE_SIZE = "lots";
      delete process.env.NODE_OPTIONS;
      expect(stripTelemetryNodeOptions(gateway.gatewayLaunchEnv().NODE_OPTIONS)).toBe("");
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
    const configWrite = mockAtomicConfigWrites((targetPath, contents) => {
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
    expect(configWrite).toHaveBeenCalledWith(
      `${OPENCLAW_DIR}/openclaw.json`,
      expect.any(String),
    );
    expect(currentConfig.gateway.trustedProxies).toEqual(["127.0.0.1"]);
    expect(currentConfig.gateway.controlUi.allowedOrigins).toEqual([
      "https://setup.example.com",
    ]);
    // Control UI mount contract: the writer pins the base path the gateway
    // stamps into index.html (control-ui-mount.js).
    expect(currentConfig.gateway.controlUi.basePath).toBe("/openclaw");
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
    const configWrite = mockAtomicConfigWrites((targetPath, contents) => {
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
    expect(currentConfig.gateway.controlUi.basePath).toBe("/openclaw");
    expect(currentConfig.gateway.http).toBeUndefined();
    expect(configWrite).toHaveBeenCalledTimes(1);
  });

  // ── Control UI mount contract (control-ui-mount.js) ──────────────────────
  // ensureGatewayProxyConfig owns gateway.controlUi.basePath: the gateway
  // stamps that path into index.html and the UI resolves fonts, themes,
  // sw.js and its bootstrap config from it, so the writer must converge on
  // the ONE canonical spelling the proxy and dashboard links are pinned to.
  const kOpenclawConfigPath = `${OPENCLAW_DIR}/openclaw.json`;
  const kSetupOrigin = "https://setup.example.com";
  const kControlUiMountModulePath = require.resolve("../../lib/server/control-ui-mount");
  const setupControlUiConfigIo = (initial) => {
    let currentConfig = initial;
    // Node's CJS loader reads module source through the PUBLIC fs.readFileSync,
    // so a re-require while a previous call's mock is live would evaluate
    // gateway.js as "{}". Restore it before the require (the legacy drill
    // below builds several IO contexts inside one test).
    fs.readFileSync = originalReadFileSync;
    fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
    const configWrite = mockAtomicConfigWrites((targetPath, contents) => {
      if (targetPath === kOpenclawConfigPath) currentConfig = JSON.parse(contents);
    });
    delete require.cache[modulePath];
    const gateway = require(modulePath);
    fs.readFileSync = vi.fn((targetPath) =>
      targetPath === kOpenclawConfigPath ? JSON.stringify(currentConfig) : "{}",
    );
    return { gateway, configWrite, getConfig: () => currentConfig };
  };
  // kControlUiMount is resolved ONCE at module load, so a mode drill sets the
  // env and re-requires BOTH the leaf module and gateway.js; the finally
  // block evicts both again so later cases load the default mode afresh.
  const withControlUiMountEnv = (value, fn) => {
    const saved = process.env.ALPHACLAW_CONTROL_UI_MOUNT;
    process.env.ALPHACLAW_CONTROL_UI_MOUNT = value;
    delete require.cache[kControlUiMountModulePath];
    delete require.cache[modulePath];
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.ALPHACLAW_CONTROL_UI_MOUNT;
      else process.env.ALPHACLAW_CONTROL_UI_MOUNT = saved;
      delete require.cache[kControlUiMountModulePath];
      delete require.cache[modulePath];
    }
  };
  const withLogSpy = (fn) => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      return fn(() => logSpy.mock.calls.map((call) => String(call[0])));
    } finally {
      logSpy.mockRestore();
    }
  };
  // A config every other managed key already satisfies, so `changed` below
  // is decided by controlUi.basePath alone.
  const convergedConfig = (controlUi) => ({
    gateway: {
      trustedProxies: ["127.0.0.1"],
      controlUi: { allowedOrigins: [kSetupOrigin], ...controlUi },
    },
  });

  it("leaves an already-canonical controlUi.basePath alone: no change, no write", () => {
    const io = setupControlUiConfigIo(convergedConfig({ basePath: "/openclaw" }));

    const changed = io.gateway.ensureGatewayProxyConfig(kSetupOrigin);

    expect(changed).toBe(false);
    expect(io.configWrite).not.toHaveBeenCalled();
    expect(io.getConfig().gateway.controlUi.basePath).toBe("/openclaw");
  });

  it.each(["/dash", "openclaw/", "/openclaw/"])(
    "rewrites a non-canonical controlUi.basePath %j to /openclaw and logs the replacement",
    (stored) => {
      withLogSpy((logLines) => {
        const io = setupControlUiConfigIo(convergedConfig({ basePath: stored }));

        const changed = io.gateway.ensureGatewayProxyConfig(kSetupOrigin);

        expect(changed).toBe(true);
        expect(io.configWrite).toHaveBeenCalledTimes(1);
        expect(io.getConfig().gateway.controlUi.basePath).toBe("/openclaw");
        // The other controlUi keys survive the rewrite.
        expect(io.getConfig().gateway.controlUi.allowedOrigins).toEqual([kSetupOrigin]);
        const lines = logLines();
        expect(
          lines.some(
            (line) =>
              line.includes("Replaced gateway.controlUi.basePath") && line.includes(stored),
          ),
        ).toBe(true);
        // The boot log names the effective mode once per call.
        expect(lines).toContain("[alphaclaw] control_ui_mount=basepath basePath=/openclaw");
      });
    },
  );

  it("writes controlUi.basePath even when no origin is given (boot and restore-repair callers)", () => {
    const io = setupControlUiConfigIo({ gateway: { trustedProxies: ["127.0.0.1"] } });

    const changed = io.gateway.ensureGatewayProxyConfig(undefined);

    expect(changed).toBe(true);
    expect(io.configWrite).toHaveBeenCalledTimes(1);
    // No origin → no allowedOrigins is invented; only the mount key lands.
    expect(io.getConfig().gateway.controlUi).toEqual({ basePath: "/openclaw" });
  });

  it("replaces a non-object gateway.controlUi with an object carrying basePath", () => {
    withLogSpy((logLines) => {
      const io = setupControlUiConfigIo({
        gateway: { trustedProxies: ["127.0.0.1"], controlUi: "bogus" },
      });

      const changed = io.gateway.ensureGatewayProxyConfig(kSetupOrigin);

      expect(changed).toBe(true);
      expect(io.configWrite).toHaveBeenCalledTimes(1);
      expect(io.getConfig().gateway.controlUi).toEqual({
        basePath: "/openclaw",
        allowedOrigins: [kSetupOrigin],
      });
      expect(
        logLines().some(
          (line) =>
            line.includes("gateway.controlUi was bogus") && line.includes("not an object"),
        ),
      ).toBe(true);
    });
  });

  it("legacy mount mode removes AlphaClaw's basePath (either spelling), keeps a hand-set path, and logs the mode", () => {
    withControlUiMountEnv("legacy", () => {
      withLogSpy((logLines) => {
        for (const stored of ["/openclaw", "/openclaw/"]) {
          const io = setupControlUiConfigIo(convergedConfig({ basePath: stored }));

          const changed = io.gateway.ensureGatewayProxyConfig(kSetupOrigin);

          expect(changed).toBe(true);
          expect(io.configWrite).toHaveBeenCalledTimes(1);
          expect(io.getConfig().gateway.controlUi).toEqual({ allowedOrigins: [kSetupOrigin] });
          expect("basePath" in io.getConfig().gateway.controlUi).toBe(false);
        }

        // A path the operator chose is not ours to remove.
        const handSet = setupControlUiConfigIo(convergedConfig({ basePath: "/dash" }));
        expect(handSet.gateway.ensureGatewayProxyConfig(kSetupOrigin)).toBe(false);
        expect(handSet.configWrite).not.toHaveBeenCalled();
        expect(handSet.getConfig().gateway.controlUi.basePath).toBe("/dash");

        const lines = logLines();
        expect(lines).toContain("[alphaclaw] control_ui_mount=legacy basePath=(removed)");
        expect(lines.some((line) => line.includes("control_ui_mount=basepath"))).toBe(false);
      });
    });
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
    const configWrite = mockAtomicConfigWrites((targetPath, contents) => {
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
      const configWrite = mockAtomicConfigWrites((targetPath, contents) => {
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
        configWrite,
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
          expect(io.configWrite).toHaveBeenCalledTimes(1);
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

    // Real execFile with an ALREADY-aborted AbortSignal never spawns: it
    // rejects at once with AbortError (no `killed`, empty output). The mocks
    // below reproduce that so a probe still riding the module abort signal
    // reads "unknown" — exactly the pre-fix failure.
    const execFileHonoringAbort = (impl) =>
      vi.fn((file, args, opts, cb) => {
        if (opts?.signal?.aborted) {
          const error = Object.assign(new Error("The operation was aborted"), {
            name: "AbortError",
            code: "ABORT_ERR",
          });
          return cb(error, "", "");
        }
        return impl(file, args, opts, cb);
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

    it.each([false, true])("fences backup relaunch when ownership changes during the port probe (running=%s)", async (running) => {
      let expired = false;
      childProcess.spawn = vi.fn(() => createChild());
      fs.existsSync = vi.fn((targetPath) => targetPath === kOnboardingMarkerPath);
      net.createConnection = vi.fn(() => {
        expired = true;
        return createSocket(running);
      });
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const launchHandler = vi.fn();
      gateway.setGatewayLaunchHandler(launchHandler);

      await gateway.startGateway({ shouldAbort: () => expired });

      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(launchHandler).not.toHaveBeenCalled();
      gateway.setGatewayLaunchHandler(null);
    });

    it("passes the caller fence through the compatibility launch wrapper", async () => {
      childProcess.spawn = vi.fn(() => createChild());
      fs.existsSync = vi.fn(() => false);
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(await gateway.launchGatewayProcess({ shouldAbort: () => true })).toBeNull();
      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    it.each(["expired lease", "successor child"])("does not escalate the delayed kill after %s", async (boundary) => {
      const child = createChild();
      const successor = createChild();
      successor.pid = 5678;
      child.kill = vi.fn(() => { child.killed = true; return true; });
      childProcess.spawn = vi.fn().mockReturnValueOnce(child).mockReturnValueOnce(successor);
      fs.existsSync = vi.fn(() => false);
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      await gateway.launchGatewayProcess();
      vi.useFakeTimers();
      try {
        let expired = false;
        const pending = gateway.stopGatewayChildAndWait({ graceMs: 100, shouldAbort: () => expired });
        if (boundary === "expired lease") expired = true;
        else expect(await gateway.launchGatewayProcess()).toBe(successor);
        await vi.advanceTimersByTimeAsync(1200);

        expect(await pending).toBe(false);
        expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
        expect(successor.kill).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
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

  describe("requestGatewayLaunch outcomes + serving identity (v0.9.75)", () => {
    // Fake /proc for the identity walk: `procs` = [{ pid, ppid, argv, comm,
    // startTicks }]. The live-process scan spy honours `match` like the real
    // one; /proc/<pid>/stat feeds readProcStartTicks/readProcParentPid and
    // /proc/<pid>/status + readdirSync("/proc") feed resolveFirstChildPid.
    // Every other path falls through to the real fs.
    const installFakeProc = (procs) => {
      const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
      lockContention.listLiveOpenclawProcesses.mockImplementation(({ match = null } = {}) =>
        procs
          .filter((proc) => typeof match !== "function" || match(proc.argv))
          .map((proc) => ({ pid: proc.pid, cmdline: proc.argv.join(" ") })),
      );
      fs.readdirSync = vi.fn((target, ...rest) =>
        String(target) === "/proc"
          ? procs.map((proc) => String(proc.pid))
          : originalReaddirSync(target, ...rest),
      );
      fs.readFileSync = vi.fn((target, ...rest) => {
        const match = /^\/proc\/(\d+)\/(stat|status)$/.exec(String(target));
        if (!match) return originalReadFileSync(target, ...rest);
        const proc = byPid.get(Number(match[1]));
        if (!proc) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        if (match[2] === "status") {
          return `Name:\t${proc.comm}\nState:\tS (sleeping)\nPPid:\t${proc.ppid}\n`;
        }
        return `${proc.pid} (${proc.comm}) S ${proc.ppid} 1 1 0 -1 4194304 1 0 0 0 0 0 0 0 20 0 1 0 ${proc.startTicks} 1 1 0\n`;
      });
    };
    const kEntry = "/app/node_modules/openclaw/dist/entry.js";
    // One serving tree (launcher root 700 → worker 701) plus an operator's
    // one-shot `gateway status` (702) that must never be mistaken for it.
    const kIncumbentTree = [
      { pid: 700, ppid: 1, argv: ["openclaw", "gateway", "--force"], comm: "openclaw", startTicks: 123456 },
      { pid: 701, ppid: 700, argv: ["node", kEntry, "gateway", "run"], comm: "openclaw-gatewa", startTicks: 123460 },
      { pid: 702, ppid: 1, argv: ["openclaw", "gateway", "status"], comm: "openclaw", startTicks: 200000 },
    ];
    const kTwoRoots = [
      { pid: 700, ppid: 1, argv: ["openclaw", "gateway", "run"], comm: "openclaw", startTicks: 1 },
      { pid: 800, ppid: 1, argv: ["node", kEntry, "gateway", "run"], comm: "node", startTicks: 2 },
    ];
    const kOutcomeShape = {
      outcome: expect.any(String),
      child: null,
      pid: null,
      generation: null,
      serving: null,
      error: null,
      detail: null,
    };
    const closeChild = (child, code = 1) => {
      child.exitCode = code;
      child.on.mock.calls.find((c) => c[0] === "close")[1](code, null);
    };
    let quiet = [];
    beforeEach(() => {
      quiet = [
        vi.spyOn(console, "log").mockImplementation(() => {}),
        vi.spyOn(console, "warn").mockImplementation(() => {}),
        vi.spyOn(process.stdout, "write").mockImplementation(() => true),
        vi.spyOn(process.stderr, "write").mockImplementation(() => true),
      ];
    });
    afterEach(() => {
      for (const spy of quiet) spy.mockRestore();
    });

    // Acceptance a (gateway half): the boot path around an incumbent.
    it("startGateway around a running incumbent spawns nothing and notifies an ADOPTED identity (servingPid, rootPid, startTicks)", async () => {
      installFakeProc(kIncumbentTree);
      childProcess.spawn = vi.fn(() => createChild());
      fs.existsSync = vi.fn((target) => target === kOnboardingMarkerPath);
      net.createConnection = vi.fn(() => createSocket(true));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const launchHandler = vi.fn();
      gateway.setGatewayLaunchHandler(launchHandler);

      await gateway.startGateway();

      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(launchHandler).toHaveBeenCalledTimes(1);
      expect(launchHandler).toHaveBeenCalledWith({
        startedAt: expect.any(Number),
        // `pid` keeps meaning "the child AlphaClaw spawned" — none here.
        pid: null,
        servingPid: 701,
        rootPid: 700,
        startTicks: 123456,
        generation: null,
        supervision: "adopted",
      });
      gateway.setGatewayLaunchHandler(null);
    });

    it("an ambiguous scan (two serving roots) notifies DETACHED with a null identity — never a guess", async () => {
      installFakeProc(kTwoRoots);
      childProcess.spawn = vi.fn(() => createChild());
      fs.existsSync = vi.fn((target) => target === kOnboardingMarkerPath);
      net.createConnection = vi.fn(() => createSocket(true));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const launchHandler = vi.fn();
      gateway.setGatewayLaunchHandler(launchHandler);

      await gateway.startGateway();

      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(launchHandler).toHaveBeenCalledWith({
        startedAt: expect.any(Number),
        pid: null,
        servingPid: null,
        rootPid: null,
        startTicks: null,
        generation: null,
        supervision: "detached",
      });
      gateway.setGatewayLaunchHandler(null);
    });

    it("a throwing /proc scan degrades the boot notification to DETACHED instead of failing startGateway", async () => {
      lockContention.listLiveOpenclawProcesses.mockImplementation(() => {
        throw new Error("proc-boom");
      });
      childProcess.spawn = vi.fn(() => createChild());
      fs.existsSync = vi.fn((target) => target === kOnboardingMarkerPath);
      net.createConnection = vi.fn(() => createSocket(true));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const launchHandler = vi.fn();
      gateway.setGatewayLaunchHandler(launchHandler);

      await expect(gateway.startGateway()).resolves.toBeUndefined();

      expect(launchHandler).toHaveBeenCalledWith(
        expect.objectContaining({ pid: null, servingPid: null, supervision: "detached" }),
      );
      gateway.setGatewayLaunchHandler(null);
    });

    // Codex 5A: the identity filter.
    it("resolveServingIdentity picks the serving tree root, resolves its worker, excludes CLI verbs, and fails safe on ambiguity", () => {
      installFakeProc(kIncumbentTree);
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      expect(gateway.resolveServingIdentity()).toEqual({
        rootPid: 700,
        workerPid: 701,
        startTicks: 123456,
        pids: [700, 701],
      });
      // The EVIDENCE snapshot (restart verdicts) still lists the CLI verb —
      // the two patterns are deliberately different.
      expect(gateway.listGatewayPids()).toEqual([700, 701, 702]);

      // Two independent roots: ambiguous → null.
      installFakeProc(kTwoRoots);
      expect(gateway.resolveServingIdentity()).toBeNull();
      // A lone CLI verb is not a serving gateway.
      installFakeProc([kIncumbentTree[2]]);
      expect(gateway.resolveServingIdentity()).toBeNull();
      expect(gateway.listGatewayPids()).toEqual([702]);
      // Nothing gateway-ish at all.
      installFakeProc([]);
      expect(gateway.resolveServingIdentity()).toBeNull();
    });

    it("launch_requested stamps increasing generations; a live child is child_retained; the exit payload carries the generation", async () => {
      const first = createChild();
      const second = { ...createChild(), pid: 5678 };
      const children = [first, second];
      childProcess.spawn = vi.fn(() => children.shift());
      fs.existsSync = vi.fn(() => false);
      net.createConnection = vi.fn(() => createSocket(false));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const exitHandler = vi.fn();
      gateway.setGatewayExitHandler(exitHandler);

      expect(gateway.kGatewayLaunchOutcomes).toEqual({
        INCUMBENT_PRESENT: "incumbent_present",
        CHILD_RETAINED: "child_retained",
        LAUNCH_REQUESTED: "launch_requested",
        LAUNCH_ABORTED: "launch_aborted",
        LAUNCH_FAILED: "launch_failed",
      });
      expect(gateway.getLaunchGeneration()).toBe(0);

      const requested = await gateway.requestGatewayLaunch({ site: "repair" });
      expect(requested).toMatchObject({
        ...kOutcomeShape,
        outcome: "launch_requested",
        child: first,
        pid: 1234,
        generation: 1,
        // The cold restart reads these (deferred autotune stamp, ready-wait
        // evidence); the identity slot is filled once the gateway listens.
        identity: { workerPid: null },
        stderrTail: expect.any(Object),
        childEnv: expect.any(Object),
      });
      expect(gateway.getLaunchGeneration()).toBe(1);
      expect(childProcess.spawn).toHaveBeenCalledWith(
        "openclaw",
        ["gateway", "run"],
        expect.objectContaining({ env: expect.any(Object) }),
      );

      // The same live child again: retained, no second spawn, same generation.
      const retained = await gateway.requestGatewayLaunch();
      expect(retained).toEqual({
        ...kOutcomeShape,
        outcome: "child_retained",
        child: first,
        pid: 1234,
        generation: 1,
      });
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
      expect(gateway.getLaunchGeneration()).toBe(1);

      closeChild(first, 1);
      expect(exitHandler).toHaveBeenCalledTimes(1);
      expect(exitHandler).toHaveBeenCalledWith(
        expect.objectContaining({ pid: 1234, code: 1, generation: 1 }),
      );

      const relaunched = await gateway.requestGatewayLaunch();
      expect(relaunched).toMatchObject({
        outcome: "launch_requested",
        child: second,
        pid: 5678,
        generation: 2,
      });
      expect(gateway.getLaunchGeneration()).toBe(2);
      gateway.setGatewayExitHandler(null);
    });

    it("the stdout 'listening on' sniff notifies servingPid/rootPid/startTicks/generation for a MANAGED child", async () => {
      installFakeProc([
        { pid: 1234, ppid: process.pid, argv: ["openclaw", "gateway", "run"], comm: "openclaw", startTicks: 4242 },
      ]);
      const child = createChild();
      childProcess.spawn = vi.fn(() => child);
      fs.existsSync = vi.fn(() => false);
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const launchHandler = vi.fn();
      gateway.setGatewayLaunchHandler(launchHandler);

      await gateway.requestGatewayLaunch({ reconcileIncumbent: false });
      const onStdout = child.stdout.on.mock.calls.find((c) => c[0] === "data")[1];
      onStdout(Buffer.from("Gateway listening on ws://127.0.0.1:18789\n"));

      expect(launchHandler).toHaveBeenCalledWith({
        startedAt: expect.any(Number),
        pid: 1234,
        servingPid: 1234,
        rootPid: 1234,
        startTicks: 4242,
        generation: 1,
        supervision: "managed",
      });
      gateway.setGatewayLaunchHandler(null);
    });

    it("a port that answers with no live child is incumbent_present: identity returned, nothing spawned, NO launch handler", async () => {
      installFakeProc(kIncumbentTree);
      const child = createChild();
      childProcess.spawn = vi.fn(() => child);
      fs.existsSync = vi.fn(() => false);
      net.createConnection = vi.fn(() => createSocket(true));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const launchHandler = vi.fn();
      gateway.setGatewayLaunchHandler(launchHandler);

      const incumbent = await gateway.requestGatewayLaunch({ site: "crash restart" });
      expect(incumbent).toEqual({
        ...kOutcomeShape,
        outcome: "incumbent_present",
        pid: 700,
        serving: { rootPid: 700, workerPid: 701, startTicks: 123456, pids: [700, 701] },
      });
      expect(childProcess.spawn).not.toHaveBeenCalled();
      // The watchdog owns intent (adopt vs replace) — gateway.js does not
      // decide for it by firing the handler.
      expect(launchHandler).not.toHaveBeenCalled();
      expect(gateway.getLaunchGeneration()).toBe(0);

      // Ambiguous identity still reports the incumbent, with serving null.
      installFakeProc(kTwoRoots);
      expect(await gateway.requestGatewayLaunch()).toMatchObject({
        outcome: "incumbent_present",
        pid: null,
        serving: null,
      });
      expect(childProcess.spawn).not.toHaveBeenCalled();

      // The compat wrapper does NOT reconcile (its callers probed the port
      // themselves): it spawns exactly as before.
      expect(await gateway.launchGatewayProcess()).toBe(child);
      expect(childProcess.spawn).toHaveBeenCalledTimes(1);
      expect(launchHandler).not.toHaveBeenCalled();
      gateway.setGatewayLaunchHandler(null);
    });

    it("re-checks the port AFTER the preflight awaits: an incumbent that appeared meanwhile is incumbent_present, not a duplicate spawn", async () => {
      installFakeProc(kIncumbentTree);
      childProcess.spawn = vi.fn(() => createChild());
      fs.existsSync = vi.fn(() => false);
      let probes = 0;
      // Port closed on the first probe (before the preflight), answering on
      // every later one.
      net.createConnection = vi.fn(() => createSocket(() => ++probes > 1));
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      const result = await gateway.requestGatewayLaunch();

      expect(probes).toBe(2);
      expect(result).toMatchObject({ outcome: "incumbent_present", pid: 700 });
      expect(childProcess.spawn).not.toHaveBeenCalled();
    });

    // Codex point 5: the spawn fence.
    it("shouldAbort true immediately before the spawn is launch_aborted {lease_expired} — nothing spawned, no handler", async () => {
      childProcess.spawn = vi.fn(() => createChild());
      fs.existsSync = vi.fn(() => false);
      net.createConnection = vi.fn(() => createSocket(false));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      const launchHandler = vi.fn();
      gateway.setGatewayLaunchHandler(launchHandler);
      const shouldAbort = vi.fn(() => true);

      const result = await gateway.requestGatewayLaunch({ shouldAbort });

      expect(result).toEqual({
        ...kOutcomeShape,
        outcome: "launch_aborted",
        detail: "lease_expired",
      });
      expect(shouldAbort).toHaveBeenCalled();
      expect(childProcess.spawn).not.toHaveBeenCalled();
      expect(launchHandler).not.toHaveBeenCalled();
      expect(gateway.getLaunchGeneration()).toBe(0);

      // A predicate that stays false lets the spawn through.
      expect(await gateway.requestGatewayLaunch({ shouldAbort: () => false })).toMatchObject({
        outcome: "launch_requested",
        generation: 1,
      });
      gateway.setGatewayLaunchHandler(null);
    });

    it("a shutdown abort during the preflight is launch_aborted {shutdown}", async () => {
      childProcess.spawn = vi.fn(() => createChild());
      fs.existsSync = vi.fn(() => false);
      net.createConnection = vi.fn(() => createSocket(false));
      delete require.cache[modulePath];
      const gateway = require(modulePath);
      gateway.abortGatewayWaits("shutdown");

      expect(await gateway.requestGatewayLaunch()).toEqual({
        ...kOutcomeShape,
        outcome: "launch_aborted",
        detail: "shutdown",
      });
      expect(childProcess.spawn).not.toHaveBeenCalled();
      // Compat: the wrapper still answers null for an aborted launch.
      expect(await gateway.launchGatewayProcess()).toBeNull();
    });

    it("a refused prelaunch hook is launch_aborted {prelaunch_hook} (the hook handler was already told)", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-hook-"));
      const hookFile = path.join(dir, "pre-gateway-launch");
      fs.writeFileSync(hookFile, "#!/bin/sh\necho hook-ran\n", { mode: 0o755 });
      process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK = hookFile;
      try {
        // Not root-owned → refused (uid pinned so the verdict never depends
        // on whether the suite runs as root).
        fs.fstatSync = vi.fn((fd) => Object.assign(originalFstatSync(fd), { uid: 1000 }));
        childProcess.spawn = vi.fn(() => createChild());
        fs.existsSync = vi.fn(() => false);
        net.createConnection = vi.fn(() => createSocket(false));
        delete require.cache[modulePath];
        const gateway = require(modulePath);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const hookHandler = vi.fn();
        gateway.setGatewayPrelaunchHookHandler(hookHandler);

        const result = await gateway.requestGatewayLaunch({ site: "medic relaunch" });

        expect(result).toEqual({
          ...kOutcomeShape,
          outcome: "launch_aborted",
          detail: "prelaunch_hook",
        });
        expect(childProcess.spawn).not.toHaveBeenCalled();
        expect(hookHandler).toHaveBeenCalledWith(
          expect.objectContaining({ status: "refused", site: "medic relaunch" }),
        );
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("gateway medic relaunch aborted"),
        );
        gateway.setGatewayPrelaunchHookHandler(null);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it("a throwing spawn is launch_failed {error} — RETURNED to the outcome caller, re-THROWN by the compat wrapper", async () => {
      const boom = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
      childProcess.spawn = vi.fn(() => {
        throw boom;
      });
      fs.existsSync = vi.fn(() => false);
      net.createConnection = vi.fn(() => createSocket(false));
      delete require.cache[modulePath];
      const gateway = require(modulePath);

      const result = await gateway.requestGatewayLaunch();
      expect(result).toEqual({
        ...kOutcomeShape,
        outcome: "launch_failed",
        error: boom,
        detail: "spawn ENOENT",
      });
      // A failed spawn never consumes a generation.
      expect(gateway.getLaunchGeneration()).toBe(0);
      await expect(gateway.launchGatewayProcess()).rejects.toBe(boom);
    });

  });

  describe("prelaunch hook — ALPHACLAW_GATEWAY_PRELAUNCH_HOOK (WI-5.3, absorbs #4)", () => {
    const kHookPath = "/opt/alphaclaw/hooks/pre-gateway-launch";
    const rootStat = (overrides = {}) => ({
      isFile: () => true,
      uid: 0,
      mode: 0o100755,
      ino: 7,
      dev: 9,
      ...overrides,
    });
    const hookDeps = (overrides = {}) => ({
      hookPath: kHookPath,
      realpathSync: vi.fn((target) => target),
      lstatSync: vi.fn(() => ({ isSymbolicLink: () => false })),
      openSync: vi.fn(() => 42),
      fstatSync: vi.fn(() => rootStat()),
      statSync: vi.fn(() => rootStat()),
      closeSync: vi.fn(),
      execFile: vi.fn((file, args, opts, cb) => cb(null, "hook ok\n", "")),
      platform: "linux",
      pid: 4321,
      ...overrides,
    });
    const hookError = (deps) =>
      require(modulePath)
        .runGatewayPrelaunchHook(deps)
        .then(
          () => {
            throw new Error("expected the hook to be refused");
          },
          (error) => error,
        );

    it("is skipped (returns false, one debug line, no handler event) when the env key is unset", async () => {
      delete process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK;
      const gateway = require(modulePath);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handler = vi.fn();
      gateway.setGatewayPrelaunchHookHandler(handler);

      expect(await gateway.runGatewayPrelaunchHook()).toBe(false);
      expect(await gateway.runGatewayPrelaunchHook()).toBe(false);

      expect(
        logSpy.mock.calls.filter(([line]) =>
          String(line).includes("ALPHACLAW_GATEWAY_PRELAUNCH_HOOK unset"),
        ),
      ).toHaveLength(1);
      expect(handler).not.toHaveBeenCalled();
      expect(gateway.getLastGatewayPrelaunchHookOutcome()).toBeNull();
      gateway.setGatewayPrelaunchHookHandler(null);
    });

    it("kills the hook's whole process group and fails the launch closed when the hook outlives its budget (hard deadline)", async () => {
      const gateway = require(modulePath);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const killProcess = vi.fn();
      const deps = hookDeps();
      // A hostile hook: it traps the signal, or leaves a descendant holding its
      // stdout — execFile's own timeout never yields a callback.
      deps.execFile = vi.fn(() => ({ pid: 777 }));

      const error = await gateway
        .runGatewayPrelaunchHook({ ...deps, timeoutMs: 20, graceMs: 30, killProcess })
        .then(
          () => {
            throw new Error("expected the hook to fail");
          },
          (thrown) => thrown,
        );

      expect(error).toBeInstanceOf(gateway.GatewayPrelaunchHookError);
      expect(error.code).toBe("timeout");
      expect(error.message).toMatch(/timed out/);
      // The group (negative pid) first, then the child itself as a backstop.
      expect(killProcess).toHaveBeenCalledWith(-777, "SIGKILL");
      expect(killProcess).toHaveBeenCalledWith(777, "SIGKILL");
      expect(deps.execFile.mock.calls[0][2]).toEqual(
        expect.objectContaining({ timeout: 20, killSignal: "SIGKILL", detached: true }),
      );
      expect(deps.closeSync).toHaveBeenCalledWith(42);
    });

    it("redacts secret-shaped values in the hook's stdout/stderr before they reach the platform log", async () => {
      // Hooks read state/config and often run with shell tracing (`set -x`),
      // so a provider key or bearer token echoes straight into the log line.
      // redactSecretShapes is shape-based and substitutes `***`.
      const rawKey = "sk-abcdefghijklmnopqrstuvwxyz123456";
      const rawBearer = "Bearer eyJabcdefghijklmnop.qrstuvwxyz0123456789.ABCDEFGHIJKLMNOP";
      const rawSlack = "xoxb-SECRET-abcdefghijklmnop";
      const gateway = require(modulePath);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const deps = hookDeps({
        execFile: vi.fn((file, args, opts, cb) =>
          cb(
            null,
            `+ curl -H "Authorization: ${rawBearer}"\nOPENAI_API_KEY=${rawKey}\n`,
            `warning: token ${rawSlack} still in env\n`,
          ),
        ),
      });

      expect(await gateway.runGatewayPrelaunchHook(deps)).toBe(true);

      const lines = logSpy.mock.calls.map(([text]) => String(text));
      const stdoutLine = lines.find((text) => text.includes("prelaunch hook stdout:"));
      const stderrLine = lines.find((text) => text.includes("prelaunch hook stderr:"));
      expect(stdoutLine).toContain("***");
      expect(stdoutLine).not.toContain(rawKey);
      expect(stdoutLine).not.toContain(rawBearer);
      expect(stdoutLine).toContain("OPENAI_API_KEY=***");
      expect(stderrLine).toContain("***");
      expect(stderrLine).not.toContain(rawSlack);
      expect(stderrLine).toContain("warning: token *** still in env");
    });

    it("runs an executable persistent prelaunch hook with the gateway environment", async () => {
      // Ported from #4 — the env is now the MINIMAL projection, never
      // gatewayEnv(): a secret in the process env must not reach the hook.
      const previousToken = process.env.OPENCLAW_GATEWAY_TOKEN;
      process.env.OPENCLAW_GATEWAY_TOKEN = "hook-must-not-see-this";
      try {
        const gateway = require(modulePath);
        vi.spyOn(console, "log").mockImplementation(() => {});
        const deps = hookDeps();

        expect(await gateway.runGatewayPrelaunchHook(deps)).toBe(true);

        expect(deps.openSync).toHaveBeenCalledWith(
          kHookPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        expect(deps.fstatSync).toHaveBeenCalledWith(42);
        // Exec by fd (the inspected inode), through the PARENT's /proc entry.
        expect(deps.execFile).toHaveBeenCalledWith(
          "/proc/4321/fd/42",
          [],
          expect.objectContaining({ timeout: 120_000, encoding: "utf8" }),
          expect.any(Function),
        );
        const env = deps.execFile.mock.calls[0][2].env;
        expect(env).toEqual({
          // A fixed system PATH (sudo secure_path style), never the process's
          // own: a writable dir on the inherited PATH would let a planted
          // interpreter run under `#!/usr/bin/env …` on every launch.
          PATH: gateway.kGatewayPrelaunchHookPath,
          HOME: ALPHACLAW_DIR,
          OPENCLAW_STATE_DIR: OPENCLAW_DIR,
          OPENCLAW_CONFIG_PATH: `${OPENCLAW_DIR}/openclaw.json`,
          ALPHACLAW_ROOT_DIR: ALPHACLAW_DIR,
        });
        expect(env).not.toHaveProperty("OPENCLAW_GATEWAY_TOKEN");
        expect(gateway.minimalHookEnv()).toEqual(env);
        // The fd stays open until the hook has exited (scripts reopen the
        // /proc path through their interpreter), then is released.
        expect(deps.closeSync).toHaveBeenCalledWith(42);
        expect(deps.closeSync.mock.invocationCallOrder[0]).toBeGreaterThan(
          deps.execFile.mock.invocationCallOrder[0],
        );
      } finally {
        if (previousToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN;
        else process.env.OPENCLAW_GATEWAY_TOKEN = previousToken;
      }
    });

    it("refuses a non-executable prelaunch hook", async () => {
      const deps = hookDeps({ fstatSync: vi.fn(() => rootStat({ mode: 0o100644 })) });
      const error = await hookError(deps);
      expect(error.message).toContain("must be an executable regular file");
      expect(error).toMatchObject({
        name: "GatewayPrelaunchHookError",
        code: "not_executable",
        status: "refused",
        hookPath: kHookPath,
      });
      expect(deps.execFile).not.toHaveBeenCalled();
      expect(deps.closeSync).toHaveBeenCalledWith(42);
    });

    it("refuses a symlinked configured path BEFORE resolving or opening it (lstat), and a path with a symlinked component", async () => {
      const gateway = require(modulePath);
      vi.spyOn(console, "log").mockImplementation(() => {});
      // The link itself: realpath would happily resolve it to a valid target.
      const linked = hookDeps({
        lstatSync: vi.fn(() => ({ isSymbolicLink: () => true })),
        realpathSync: vi.fn(() => "/usr/bin/true"),
      });
      const error = await hookError(linked);
      expect(error).toBeInstanceOf(gateway.GatewayPrelaunchHookError);
      expect(error.code).toBe("symlink");
      expect(error.message).toContain("must not be a symlink");
      expect(linked.realpathSync).not.toHaveBeenCalled();
      expect(linked.openSync).not.toHaveBeenCalled();
      expect(linked.execFile).not.toHaveBeenCalled();
      // A symlinked directory component: lstat sees a regular file, realpath
      // moves it — the path must be canonical.
      // Argument-aware: the roots canonicalize to themselves, only the hook moves.
      const component = hookDeps({
        realpathSync: vi.fn((target) =>
          target === kHookPath ? "/usr/local/lib/alphaclaw-hooks/pre-launch" : target,
        ),
      });
      const componentError = await hookError(component);
      expect(componentError.code).toBe("symlink");
      expect(componentError.message).toContain("canonical");
      expect(component.openSync).not.toHaveBeenCalled();
    });

    it("refuses a symlink (O_NOFOLLOW → ELOOP) without ever executing", async () => {
      const deps = hookDeps({
        openSync: vi.fn(() => {
          throw Object.assign(new Error("ELOOP: too many symbolic links"), {
            code: "ELOOP",
          });
        }),
      });
      const error = await hookError(deps);
      expect(error).toMatchObject({
        name: "GatewayPrelaunchHookError",
        code: "symlink",
        status: "refused",
      });
      expect(error.message).toContain("must not be a symlink");
      expect(deps.execFile).not.toHaveBeenCalled();
      expect(deps.closeSync).not.toHaveBeenCalled();
    });

    it("refuses a hook not owned by root (the deployed agent shares AlphaClaw's uid)", async () => {
      const error = await hookError(
        hookDeps({ fstatSync: vi.fn(() => rootStat({ uid: 1000 })) }),
      );
      expect(error).toMatchObject({ code: "not_root_owned", status: "refused" });
      expect(error.message).toContain("must be owned by root (uid 0), found uid 1000");
    });

    it("refuses a group- or world-writable hook", async () => {
      const groupWritable = await hookError(
        hookDeps({ fstatSync: vi.fn(() => rootStat({ mode: 0o100775 })) }),
      );
      expect(groupWritable).toMatchObject({ code: "writable_by_others" });
      expect(groupWritable.message).toContain("mode 775");
      const worldWritable = await hookError(
        hookDeps({ fstatSync: vi.fn(() => rootStat({ mode: 0o100757 })) }),
      );
      expect(worldWritable).toMatchObject({ code: "writable_by_others" });
    });

    it("refuses a non-regular file, a relative path, and a missing path", async () => {
      expect(
        await hookError(
          hookDeps({ fstatSync: vi.fn(() => rootStat({ isFile: () => false })) }),
        ),
      ).toMatchObject({ code: "not_regular_file" });
      expect(
        await hookError(hookDeps({ hookPath: "hooks/pre-gateway-launch" })),
      ).toMatchObject({ code: "not_absolute" });
      const missing = await hookError(
        hookDeps({
          realpathSync: vi.fn(() => {
            throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
          }),
        }),
      );
      expect(missing).toMatchObject({ code: "not_found" });
      expect(missing.message).toContain("ENOENT");
    });

    it("refuses a hook whose realpath lies inside the AlphaClaw root or the OpenClaw state dir", async () => {
      const inRoot = await hookError(
        hookDeps({
          hookPath: path.join(ALPHACLAW_DIR, "hooks", "pre-gateway-launch"),
        }),
      );
      expect(inRoot).toMatchObject({ code: "in_tree" });
      expect(inRoot.message).toContain("the AlphaClaw root");
      // A path OUTSIDE the tree whose realpath resolves INSIDE it is judged
      // by the realpath (OPENCLAW_DIR sits under the root, so the root label
      // is the one that fires here).
      const viaRealpath = await hookError(
        hookDeps({
          hookPath: "/opt/alphaclaw/hooks/pre-gateway-launch",
          realpathSync: vi.fn(() => path.join(OPENCLAW_DIR, "pre-gateway-launch")),
        }),
      );
      expect(viaRealpath).toMatchObject({ code: "in_tree" });
      expect(viaRealpath.message).toContain("must live outside");
      // A state dir configured OUTSIDE the root is checked on its own.
      const viaStateDir = await hookError(
        hookDeps({
          hookPath: "/srv/openclaw-state/hooks/pre-gateway-launch",
          openclawDir: "/srv/openclaw-state",
        }),
      );
      expect(viaStateDir).toMatchObject({ code: "in_tree" });
      expect(viaStateDir.message).toContain("the OpenClaw state dir");
    });

    it("reports a non-zero exit as a FAILED hook with the exit code, releasing the fd", async () => {
      const deps = hookDeps({
        execFile: vi.fn((file, args, opts, cb) =>
          cb(Object.assign(new Error("Command failed"), { code: 3 }), "", "patch missing\n"),
        ),
      });
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = await hookError(deps);
      expect(error).toMatchObject({
        name: "GatewayPrelaunchHookError",
        status: "failed",
        code: "nonzero_exit",
        exitCode: 3,
        signal: null,
      });
      expect(error.message).toContain("exited with code 3");
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("prelaunch hook stderr: patch missing"),
      );
      expect(deps.closeSync).toHaveBeenCalledWith(42);
    });

    it("reports a timeout (killed by the 120s budget) and a spawn failure distinctly", async () => {
      const timedOut = await hookError(
        hookDeps({
          execFile: vi.fn((file, args, opts, cb) =>
            cb(
              Object.assign(new Error("killed"), { killed: true, signal: "SIGTERM", code: null }),
              "",
              "",
            ),
          ),
        }),
      );
      expect(timedOut).toMatchObject({ status: "failed", code: "timeout", signal: "SIGTERM" });
      expect(timedOut.message).toContain("timed out after 120s");
      const spawnFailed = await hookError(
        hookDeps({
          execFile: vi.fn((file, args, opts, cb) =>
            cb(Object.assign(new Error("spawn EACCES"), { code: "EACCES" }), "", ""),
          ),
        }),
      );
      expect(spawnFailed).toMatchObject({ status: "failed", code: "exec_failed", exitCode: null });
      expect(spawnFailed.message).toContain("could not be executed (EACCES)");
    });

    it("off Linux, re-stats the path and executes the realpath only when the inode is unchanged", async () => {
      const same = hookDeps({ platform: "darwin" });
      expect(await require(modulePath).runGatewayPrelaunchHook(same)).toBe(true);
      expect(same.execFile).toHaveBeenCalledWith(
        kHookPath,
        [],
        expect.anything(),
        expect.any(Function),
      );
      const swapped = hookDeps({
        platform: "darwin",
        statSync: vi.fn(() => rootStat({ ino: 8 })),
      });
      const error = await hookError(swapped);
      expect(error).toMatchObject({ code: "changed_during_check", status: "refused" });
      expect(swapped.execFile).not.toHaveBeenCalled();
    });

    describe("launch paths (env-driven, real realpath/open, fstat pinned)", () => {
      let hookFile = null;
      beforeEach(() => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-hook-"));
        hookFile = path.join(dir, "pre-gateway-launch");
        fs.writeFileSync(hookFile, "#!/bin/sh\necho hook-ran\n", { mode: 0o755 });
        process.env.ALPHACLAW_GATEWAY_PRELAUNCH_HOOK = hookFile;
      });
      afterEach(() => {
        try {
          fs.rmSync(path.dirname(hookFile), { recursive: true, force: true });
        } catch {}
      });
      // uid is pinned explicitly so the verdict never depends on whether the
      // suite happens to run as root.
      const pinFstatUid = (uid) => {
        fs.fstatSync = vi.fn((fd) => Object.assign(originalFstatSync(fd), { uid }));
      };
      const isHookExec = (file) => String(file).startsWith("/proc/");

      it("launchGatewayProcess aborts (returns null, no spawn) and reports the refusal when the hook is not root-owned", async () => {
        pinFstatUid(1000);
        childProcess.spawn = vi.fn(() => createChild());
        childProcess.execFile = vi.fn((file, args, opts, cb) => cb(null, "", ""));
        fs.existsSync = vi.fn(() => false);
        delete require.cache[modulePath];
        const gateway = require(modulePath);
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
        const handler = vi.fn();
        gateway.setGatewayPrelaunchHookHandler(handler);

        expect(await gateway.launchGatewayProcess()).toBeNull();

        expect(childProcess.spawn).not.toHaveBeenCalled();
        expect(childProcess.execFile).not.toHaveBeenCalled();
        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler).toHaveBeenCalledWith({
          status: "refused",
          code: "not_root_owned",
          hookPath: hookFile,
          message: expect.stringContaining("must be owned by root"),
          site: "managed launch",
          durationMs: expect.any(Number),
          exitCode: null,
          signal: null,
        });
        expect(gateway.getLastGatewayPrelaunchHookOutcome()).toEqual(
          handler.mock.calls[0][0],
        );
        expect(errorSpy).toHaveBeenCalledWith(
          expect.stringContaining("gateway managed launch aborted"),
        );
        gateway.setGatewayPrelaunchHookHandler(null);
      });

      it("launchGatewayProcess AWAITS the hook (by fd, minimal env) before spawning and reports ran", async () => {
        pinFstatUid(0);
        const child = createChild();
        childProcess.spawn = vi.fn(() => child);
        let releaseHook = null;
        childProcess.execFile = vi.fn((file, args, opts, cb) => {
          if (isHookExec(file)) {
            releaseHook = () => cb(null, "hook-ran\n", "");
            return;
          }
          cb(null, "", "");
        });
        fs.existsSync = vi.fn(() => false);
        delete require.cache[modulePath];
        const gateway = require(modulePath);
        vi.spyOn(console, "log").mockImplementation(() => {});
        const handler = vi.fn();
        gateway.setGatewayPrelaunchHookHandler(handler);

        const pending = gateway.launchGatewayProcess();
        await new Promise((resolve) => setImmediate(resolve));
        // The hook is in flight: nothing has been spawned yet.
        expect(typeof releaseHook).toBe("function");
        expect(childProcess.spawn).not.toHaveBeenCalled();
        const [execPath, execArgs, execOpts] = childProcess.execFile.mock.calls.find(
          ([file]) => isHookExec(file),
        );
        expect(execPath).toMatch(new RegExp(`^/proc/${process.pid}/fd/\\d+$`));
        expect(execArgs).toEqual([]);
        expect(execOpts.env).toEqual(gateway.minimalHookEnv());
        expect(execOpts.timeout).toBe(120_000);

        releaseHook();
        expect(await pending).toBe(child);
        expect(childProcess.spawn).toHaveBeenCalledWith(
          "openclaw",
          ["gateway", "run"],
          expect.anything(),
        );
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            status: "ran",
            code: null,
            hookPath: hookFile,
            site: "managed launch",
            exitCode: 0,
          }),
        );
        gateway.setGatewayPrelaunchHookHandler(null);
      });

      it("a cold restart aborts BEFORE stopping anything when the hook exits non-zero (named error surfaces to the caller)", async () => {
        pinFstatUid(0);
        childProcess.spawn = vi.fn(() => createChild());
        childProcess.execFile = vi.fn((file, args, opts, cb) => {
          if (isHookExec(file)) {
            return cb(Object.assign(new Error("Command failed"), { code: 2 }), "", "no patch\n");
          }
          return cb(null, "", "");
        });
        fs.existsSync = vi.fn(() => false);
        net.createConnection = vi.fn(() => createSocket(true));
        delete require.cache[modulePath];
        const gateway = require(modulePath);
        vi.spyOn(console, "log").mockImplementation(() => {});
        vi.spyOn(console, "error").mockImplementation(() => {});
        const handler = vi.fn();
        gateway.setGatewayPrelaunchHookHandler(handler);
        const onStep = vi.fn();

        await expect(gateway.restartGateway(vi.fn(), { onStep })).rejects.toMatchObject({
          name: "GatewayPrelaunchHookError",
          status: "failed",
          code: "nonzero_exit",
          exitCode: 2,
        });

        // Nothing was stopped or launched: the running gateway keeps serving.
        expect(
          childProcess.execFile.mock.calls.filter(([file]) => file === "openclaw"),
        ).toEqual([]);
        expect(childProcess.spawn).not.toHaveBeenCalled();
        expect(onStep).not.toHaveBeenCalled();
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({ status: "failed", code: "nonzero_exit", site: "restart" }),
        );
        gateway.setGatewayPrelaunchHookHandler(null);
      });

      it.skipIf(process.platform !== "linux")(
        "REAL exec: a `#!/bin/sh` hook runs through /proc/<pid>/fd/<fd> with the minimal env",
        async () => {
          // Real realpath/open/fstat/execFile — only the owner uid is pinned
          // (a non-root test user cannot create a root-owned file). The
          // describe-level hermetic execFile mock is undone here on purpose:
          // this pin exists to run the real binary.
          pinFstatUid(0);
          childProcess.execFile = originalExecFile;
          fs.writeFileSync(
            hookFile,
            '#!/bin/sh\necho "hook-ran home=$HOME keys=$(env | wc -l)"\nexit 0\n',
            { mode: 0o755 },
          );
          delete require.cache[modulePath];
          const gateway = require(modulePath);
          const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

          expect(await gateway.runGatewayPrelaunchHook()).toBe(true);

          const line = logSpy.mock.calls
            .map(([text]) => String(text))
            .find((text) => text.includes("prelaunch hook stdout:"));
          expect(line).toContain(`hook-ran home=${ALPHACLAW_DIR}`);
          // Exactly the five projected keys reached the hook (sh adds PWD,
          // SHLVL and _ of its own, so the bound is small, not zero).
          const keys = Number(line.match(/keys=(\d+)/)[1]);
          expect(keys).toBeGreaterThanOrEqual(5);
          expect(keys).toBeLessThanOrEqual(8);
        },
      );
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
      mockAtomicConfigWrites((targetPath, contents) => {
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

// v0.9.81 (review amendment D3 / cross-model D16): the shared argv truth table
// drives the gateway pid snapshot through the REAL process matcher. Every
// `gateway: true` row must be a gateway pid; no other row may be — the tail
// follower that refused production backups must be invisible here too.
describe("listGatewayPids over the shared OpenClaw argv fixtures", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves exactly the gateway: true rows through the real matcher", () => {
    const table = {};
    kOpenclawArgvFixtures.forEach((row, index) => {
      table[String(2000 + index)] = row.argv.map((arg) => `${arg}\0`).join("");
    });
    vi.spyOn(lockContention, "listLiveOpenclawProcesses").mockImplementation((opts = {}) =>
      realListLiveOpenclawProcesses({
        ...opts,
        fsModule: { readdirSync: (p) => (p === "/proc" ? [...Object.keys(table), "self"] : []) },
        readCmdline: (pid) => table[String(pid)] ?? null,
        isZombie: () => false,
        selfPid: 1,
      }),
    );
    delete require.cache[modulePath];
    const gateway = require(modulePath);

    const expected = kOpenclawArgvFixtures
      .map((row, index) => (row.gateway ? 2000 + index : null))
      .filter((pid) => pid !== null);
    expect(expected.length).toBeGreaterThan(5);
    expect([...gateway.listGatewayPids()].sort((a, b) => a - b)).toEqual(expected);
    // The evidence pattern (default) is a superset of the serving pattern:
    // every serving pid is in the evidence list.
    const serving = gateway.listGatewayPids({
      pattern: lockContention.kGatewayServingCmdlinePattern,
    });
    for (const pid of serving) expect(expected).toContain(pid);
    expect(serving.length).toBeGreaterThan(0);
  });
});

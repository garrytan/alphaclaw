const fs = require("fs");
const os = require("os");
const path = require("path");

// Point the constants-derived default paths at a temp root BEFORE any module
// under test is required (same idiom as restart-required-state.test.js): the
// REAL gateway module probes `${OPENCLAW_DIR}/openclaw.json` for channel
// config and the gateway port, and both must resolve inside a temp dir — no
// openclaw.json there means the plugin preflight deterministically skips and
// the default gateway port is used, and nothing touches ~/.alphaclaw.
const kTempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "alphaclaw-restart-drill-"),
);
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;
// Pin the ready budget to 120s before any lib require (constants reads the
// env at module load): the drills' fake-timer advancement loops and frame
// assertions are calibrated to a 120s budget. NOTE: a drill against the
// production default (300s ready / 600s+ operation budget) must advance
// ~600s+ per attempt.
process.env.GATEWAY_RESTART_READY_TIMEOUT = "120";

const { EventEmitter } = require("events");
const childProcess = require("child_process");
const net = require("net");

const express = require("express");
const request = require("supertest");

const {
  kDefaultGatewayPort,
  GATEWAY_HOST,
  kGatewayRestartReadyTimeoutMs,
  kOnboardingMarkerPath,
} = require("../../lib/server/constants");
// The REAL watchdog for the repair drills below (wired like lib/server.js
// against the drill's fresh gateway instance and its real lifecycle lock).
const { createWatchdog } = require("../../lib/server/watchdog");
// routes/system.js binds gateway.js's GatewayIncumbentRestartError at ITS
// load time (the class the restart route catches by instanceof). Each drill
// fresh-requires gateway.js, so the routes module is fresh-required against
// the same instance (createFakeGateway/createApp) — production has one of each.
const kSystemRoutesModulePath = require.resolve("../../lib/server/routes/system");
const { registerAgentRoutes } = require("../../lib/server/routes/agents");
const {
  createOperationEventsService,
} = require("../../lib/server/operation-events");
const {
  createGatewayLifecycleLock,
} = require("../../lib/server/gateway-lifecycle-lock");
const {
  createRestartRequiredState,
} = require("../../lib/server/restart-required-state");

// End-to-end restart drills: the REAL restart route wired (exactly like
// lib/server.js) to the REAL gateway module, operation-events service,
// lifecycle lock, and restart-required-state store over real temp-dir
// persistence. Only the process/exec/TCP boundary is faked: a controllable
// fake gateway supplies spawn/execFile behavior and the gateway-port TCP
// probe (following the gateway.test.js execFile/socket idioms).
//
// The repair drills (v0.9.74) add the REAL watchdog on top: its `replace`
// relaunch runs the same cold-restart pipeline under the real lifecycle lock,
// with only /health + /readyz (global.fetch) faked alongside the process
// boundary.

const kGatewayModulePath = require.resolve("../../lib/server/gateway");
// Namespace-required by gateway.js: the incumbent verdict's live-pid scan is
// pinned per drill (never the real /proc).
const lockContention = require("../../lib/server/openclaw-lock-contention");

// `openclaw gateway stop --help` contract pins (tarball-verified): --force is
// present on 2026.8.2 / 2026.9.1-beta.1 and absent on the 2026.7.1-2 pin.
const kStopHelpWithForce =
  "Usage: openclaw gateway stop [options]\n\nOptions:\n  --force     Allow stop from a non-interactive shell\n  -h, --help  display help for command\n";
const kStopHelpWithoutForce =
  "Usage: openclaw gateway stop [options]\n\nOptions:\n  -h, --help  display help for command\n";
const kStopRefusal =
  "This stops the operator's running gateway service. Use an isolated dev gateway (openclaw gateway run --dev, or --profile <name> with a free port) for testing, or re-run with --force\n";

const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
const originalCreateConnection = net.createConnection;
const kOriginalFetch = global.fetch;
const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;

const kSilentLogger = { log() {}, warn() {}, error() {} };

// The fake `gateway --force` supervisor's pid (every spawn), and the pid of a
// gateway AlphaClaw did not start (the incumbent the repair drills replace).
const kFakeSupervisorPid = 4242;
const kIncumbentPid = 31337;
const kIncumbentCmdline =
  "node /app/node_modules/openclaw/dist/entry.js gateway run";
const kSupervisorCmdline =
  "node /app/node_modules/openclaw/dist/entry.js gateway --force";

const kTempDirs = [];
const mkStateDir = () => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), "alphaclaw-restart-drill-state-"),
  );
  kTempDirs.push(dir);
  return dir;
};

const nullFlagStore = () => ({
  read: vi.fn(() => null),
  write: vi.fn(),
  clear: vi.fn(),
});

const flushMicrotasks = async () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

// Real-timer polling helper for the drills that let the restart run under
// real timers (everything settles via microtasks, so a few ms suffice).
const waitUntil = async (predicate, { timeoutMs = 5000, stepMs = 5 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) {
      throw new Error("waitUntil: condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
};

// Controllable fake gateway at the process/exec/TCP boundary. Installs the
// child_process + net mocks, then fresh-requires the REAL gateway module so
// its load-time execFile/spawn bindings capture the fakes (the gateway.test.js
// pattern). `portOpen` drives the ready probe; `holdStop` parks the restart
// inside `openclaw gateway stop` until `releaseStop()` is called.
const createFakeGateway = ({
  portOpen = true,
  // Whether the fake CLI's `gateway stop --help` advertises --force.
  forceSupported = false,
  // The CLI's NON_INTERACTIVE guard: exit 1 + refusal text, port kept.
  stopRefused = false,
  // Live openclaw processes the incumbent verdict sees (pre AND post stop).
  livePids = [],
  // The /proc view once `gateway --force` (or `gateway run`) was spawned: a
  // successfully stopped incumbent is gone and the new supervisor tree is
  // visible. null = unchanged (the stop-refused incumbent keeps its pid).
  livePidsAfterLaunch = null,
  // Issue #56 launcher shape: the `--force` supervisor stays alive as the
  // gateway's process-tree root, so the cold restart adopts it as the managed
  // child and the launch notification carries its pid + generation. Default
  // off = the older daemonizing CLI (supervisor gone before the port answers).
  supervisorLingers = false,
} = {}) => {
  const fake = {
    portOpen,
    holdStop: false,
    releaseStop: null,
    stderrLines: [],
    spawnCalls: [],
    stopCalls: [],
    supervisors: [],
    livePids,
  };
  vi.spyOn(lockContention, "listLiveOpenclawProcesses").mockImplementation(
    () => fake.livePids,
  );

  childProcess.execFile = vi.fn((file, args, opts, cb) => {
    if (args?.[0] === "gateway" && args?.[1] === "stop" && args.includes("--help")) {
      // The one-time --force capability probe.
      cb(null, forceSupported ? kStopHelpWithForce : kStopHelpWithoutForce, "");
      return;
    }
    if (args?.[0] === "gateway" && args?.[1] === "stop") {
      fake.stopCalls.push(args);
      if (stopRefused) {
        cb(
          Object.assign(new Error("Command failed: openclaw gateway stop"), {
            code: 1,
            stdout: "",
            stderr: kStopRefusal,
          }),
          "",
          kStopRefusal,
        );
        return;
      }
      // A real `openclaw gateway stop` releases the port; the restart
      // pipeline now waits for that release before launching.
      if (fake.holdStop) {
        fake.releaseStop = () => {
          fake.portOpen = false;
          cb(null, "", "");
        };
        return;
      }
      fake.portOpen = false;
      cb(null, "", "");
      return;
    }
    cb(null, "", "");
  });

  childProcess.spawn = vi.fn((file, args) => {
    const child = new EventEmitter();
    child.pid = kFakeSupervisorPid;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    // The adoption check reads `signalCode === null`; a child without the
    // field reads as an already-exited supervisor (the pre-#56 shape).
    if (supervisorLingers) child.signalCode = null;
    child.killed = false;
    child.kill = vi.fn();
    fake.spawnCalls.push({ file, args });
    fake.supervisors.push(child);
    // `gateway --force` brings the port back up unless the drill is
    // simulating a gateway that never becomes ready.
    if (args?.[0] === "gateway" && !fake.neverReady) {
      queueMicrotask(() => {
        fake.portOpen = true;
      });
    }
    if (args?.[0] === "gateway" && livePidsAfterLaunch) {
      fake.livePids = livePidsAfterLaunch;
    }
    if (fake.stderrLines.length) {
      // The restart supervisor attaches its stderr handler synchronously right
      // after spawn(), so a microtask emission is always observed (and stays
      // independent of faked timers).
      const payload = `${fake.stderrLines.join("\n")}\n`;
      queueMicrotask(() => child.stderr.emit("data", payload));
    }
    return child;
  });

  // Only the gateway port probe is faked; supertest's own HTTP client also
  // resolves net.createConnection dynamically and must keep the real one.
  // Handlers dispatch synchronously so the probe behaves identically under
  // real and fake timers (mirrors the never-ready socket in gateway.test.js).
  net.createConnection = vi.fn((port, host, ...rest) => {
    if (port === kDefaultGatewayPort && host === GATEWAY_HOST) {
      return {
        setTimeout: vi.fn(),
        destroy: vi.fn(),
        on(event, handler) {
          if (fake.portOpen && event === "connect") handler();
          if (!fake.portOpen && event === "error") handler();
          return this;
        },
      };
    }
    return originalCreateConnection(port, host, ...rest);
  });

  delete require.cache[kGatewayModulePath];
  fake.gateway = require(kGatewayModulePath);
  // Re-bind the routes module to THIS gateway instance (see the header note).
  delete require.cache[kSystemRoutesModulePath];
  return fake;
};

// Same dependency surface as createSystemDeps in routes-system.test.js, with
// the restart-path collaborators swapped for REAL instances (store, lock,
// operation events, gateway module) and the exec/TCP boundary faked.
const createDrillHarness = ({
  fake = null,
  restartRequiredState = null,
  envFileVars = [],
} = {}) => {
  const store =
    restartRequiredState ||
    createRestartRequiredState({
      isGatewayRunning: async () => (fake ? fake.portOpen : true),
      flagStore: nullFlagStore(),
      stateDir: mkStateDir(),
    });
  const operationEvents = createOperationEventsService();
  const gatewayLifecycleLock = createGatewayLifecycleLock({
    logger: kSilentLogger,
  });
  const reloadEnv = vi.fn(() => true);
  let applyInProgress = false;

  const deps = {
    fs: {
      existsSync: vi.fn(() => true),
      readFileSync: vi.fn(() => {
        throw new Error("no config");
      }),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
      rmSync: vi.fn(),
    },
    readEnvFile: vi.fn(() => envFileVars),
    writeEnvFile: vi.fn(),
    reloadEnv,
    kKnownVars: [],
    kKnownKeys: new Set(),
    kSystemVars: new Set(["PORT", "SETUP_PASSWORD"]),
    syncChannelConfig: vi.fn(),
    isGatewayRunning: vi.fn(async () => (fake ? fake.portOpen : true)),
    isOnboarded: vi.fn(() => true),
    getChannelStatus: vi.fn(() => ({})),
    openclawVersionService: {
      readOpenclawVersion: vi.fn(() => "1.2.3"),
      getVersionStatus: vi.fn(async () => ({ ok: true, current: "1.2.3" })),
      updateOpenclaw: vi.fn(async () => ({ status: 200, body: { ok: true } })),
    },
    alphaclawVersionService: {},
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "" })),
    // lib/server.js binds reloadEnv the same way before handing the route its
    // single-argument restartGateway({ onStep }).
    restartGateway: fake
      ? (options) => fake.gateway.restartGateway(reloadEnv, options)
      : vi.fn(async () => ({ durationMs: 0, downtimeMs: 0 })),
    restartRequiredState: store,
    topicRegistry: { getGroup: vi.fn(() => null) },
    authProfiles: {
      listApiKeyProviders: vi.fn(() => []),
      getEnvVarForApiKeyProvider: vi.fn(() => ""),
      upsertApiKeyProfileForEnvVar: vi.fn(),
      removeApiKeyProfileForEnvVar: vi.fn(),
    },
    OPENCLAW_DIR: "/tmp/openclaw",
    ensureGatewayProxyConfig: vi.fn(() => false),
    getBaseUrl: vi.fn(() => "https://setup.example.com"),
    kAlphaclawGithubReleasesBaseUrl:
      "https://api.github.com/repos/garrytan/alphaclaw/releases",
    watchdog: {
      getStatus: vi.fn(() => ({ lifecycle: "running" })),
      onExpectedRestart: vi.fn(),
      recordOperationEvent: vi.fn(),
    },
    openclawChannelService: {
      getChannelInfo: vi.fn(() => null),
      isApplyInProgress: vi.fn(() => applyInProgress),
    },
    gatewayLifecycleLock,
    operationEvents,
  };

  return {
    deps,
    operationEvents,
    gatewayLifecycleLock,
    restartRequiredState: store,
    setApplyInProgress: (value) => {
      applyInProgress = value;
    },
  };
};

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  // Resolved at call time: after createFakeGateway this is the routes module
  // loaded against the drill's gateway instance.
  const { registerSystemRoutes } = require(kSystemRoutesModulePath);
  registerSystemRoutes({ app, ...deps });
  return app;
};

// Captures the REAL /api/operations/:operationId/events handler (the agents
// route the dashboard subscribes through), following the captureRoutes idiom
// in routes-system.test.js, so long-lived SSE streams can be driven with
// hand-rolled req/res doubles.
const captureOperationsSseHandler = (operationEvents) => {
  const routes = new Map();
  const register = (method) => (routePath, handler) =>
    routes.set(`${method} ${routePath}`, handler);
  registerAgentRoutes({
    app: {
      get: register("GET"),
      post: register("POST"),
      put: register("PUT"),
      delete: register("DELETE"),
    },
    agentsService: {},
    operationEvents,
  });
  return routes.get("GET /api/operations/:operationId/events");
};

const parseSseEvents = (raw) =>
  raw
    .split("\n\n")
    .map((frame) => frame.trim())
    .filter((frame) => frame && !frame.startsWith(":"))
    .map((frame) => {
      const parsed = { id: null, event: "message", data: null };
      const dataLines = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("id: ")) parsed.id = line.slice(4);
        else if (line.startsWith("event: ")) parsed.event = line.slice(7);
        else if (line.startsWith("data: ")) dataLines.push(line.slice(6));
      }
      parsed.data = dataLines.length ? JSON.parse(dataLines.join("\n")) : null;
      return parsed;
    });

const openSseClient = (handler, operationId) => {
  const req = new EventEmitter();
  req.params = { operationId };
  const chunks = [];
  const res = {
    headers: {},
    statusCode: 0,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
    flushHeaders: vi.fn(),
    json: vi.fn(),
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
  };
  handler(req, res);
  return {
    res,
    events: () => parseSseEvents(chunks.join("")),
    close: () => req.emit("close"),
  };
};

const stepTuple = (event) => [
  event.event,
  event.data?.label ?? null,
  event.data?.status ?? null,
];

// ── Watchdog repair drills: helpers ─────────────────────────────────────────

// /health + /readyz seam for the REAL watchdog (global.fetch): /readyz always
// reads ready; /health answers `{ ok, status: "live" }` while `isHealthy()`
// holds and otherwise fails the way a wedged gateway does (TCP accepts, the
// HTTP answer never comes — the probe's own timeout).
const createGatewayHealthFetch =
  ({ isHealthy }) =>
  async (url) => {
    const json = (body) => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
    });
    if (String(url).includes("/readyz")) {
      return json({ ready: true, failing: [], eventLoop: { degraded: false } });
    }
    if (!isHealthy()) throw new Error("gateway health timed out after 5000ms");
    return json({ ok: true, status: "live" });
  };

// The REAL watchdog wired exactly like lib/server.js against the drill's
// gateway instance and the harness's real lifecycle lock: the outcome-shaped
// relaunch primitive, the serving-identity scan, the launch-generation
// counter, and the cold restart (`(options) => restartGateway(options)`,
// observed here for the lock kind it runs under). Auto-repair on.
const createDrillWatchdog = ({ fake, harness, isHealthy }) => {
  process.env.WATCHDOG_AUTO_REPAIR = "true";
  global.fetch = vi.fn(createGatewayHealthFetch({ isHealthy }));
  const insertWatchdogEvent = vi.fn();
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const clawCmd = vi.fn(async (command) =>
    command === "doctor --fix --yes"
      ? { ok: true, stdout: "fixed" }
      : { ok: true, stdout: JSON.stringify({ ok: true }) },
  );
  const coldRestartHolds = [];
  const watchdog = createWatchdog({
    clawCmd,
    launchGatewayProcess: fake.gateway.launchGatewayProcess,
    probeGatewayTcp: fake.gateway.probeGatewayTcp,
    gatewayLifecycleLock: harness.gatewayLifecycleLock,
    insertWatchdogEvent,
    notifier,
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "https://setup.example.com",
    resolveGatewayHealthUrl: () => `${fake.gateway.getGatewayUrl()}/health`,
    resolveGatewayReadyzUrl: () => `${fake.gateway.getGatewayUrl()}/readyz`,
    sleepImpl: () => Promise.resolve(),
    supervisorModeActive: () => false,
    restartGatewayColdStart: (options) => {
      coldRestartHolds.push(
        harness.gatewayLifecycleLock.getActiveOperation()?.kind ?? null,
      );
      return harness.deps.restartGateway(options);
    },
    requestGatewayLaunch: fake.gateway.requestGatewayLaunch,
    discoverServingIdentity: fake.gateway.resolveServingIdentity,
    getLaunchGeneration: fake.gateway.getLaunchGeneration,
    getLastGatewayPrelaunchHookOutcome:
      fake.gateway.getLastGatewayPrelaunchHookOutcome,
    classifyOwnershipConflict: lockContention.classifyOwnershipConflict,
    // The fake's pids are not OS processes: liveness follows the fake's /proc
    // view and start ticks are unreadable. The production defaults
    // (process.kill(pid, 0), /proc/<pid>/stat) would read the alive-but-wedged
    // incumbent as DEAD and take the probe-death fast path instead of the
    // sustained ladder → repair → replace path these drills exercise.
    pidAlive: (pid) => fake.livePids.some((proc) => proc.pid === pid),
    readProcStartTicks: () => null,
  });
  fake.gateway.setGatewayExitHandler((payload) => watchdog.onGatewayExit(payload));
  fake.gateway.setGatewayLaunchHandler((payload) => watchdog.onGatewayLaunch(payload));
  return { watchdog, insertWatchdogEvent, clawCmd, notifier, coldRestartHolds };
};

// Boot around an already-running gateway through the REAL path: with the
// onboarding marker present, startGateway() finds the port answering, skips
// the launch and notifies the discovered (adopted) identity — the fake's
// /proc view, walked by the real resolveServingIdentity().
const bootAroundIncumbent = async (fake) => {
  fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ drill: true }));
  await fake.gateway.startGateway();
};

const ledgerRows = (insertWatchdogEvent) =>
  insertWatchdogEvent.mock.calls.map(([row]) => row);
const restartRows = (insertWatchdogEvent, { source = null, status = null } = {}) =>
  ledgerRows(insertWatchdogEvent).filter(
    (row) =>
      row.eventType === "restart" &&
      (source == null || row.source === source) &&
      (status == null || row.status === status),
  );
const repairSkipReasons = (insertWatchdogEvent) =>
  ledgerRows(insertWatchdogEvent)
    .filter((row) => row.eventType === "repair" && row.status === "skipped")
    .map((row) => row.details);
const operationRows = (insertWatchdogEvent) =>
  ledgerRows(insertWatchdogEvent).filter(
    (row) => row.eventType === "operation" && row.source === "gateway_restart",
  );
const doctorFixCalls = (clawCmd) =>
  clawCmd.mock.calls.filter(([command]) => command === "doctor --fix --yes").length;
const noticesIncluding = (notifier, text) =>
  notifier.notify.mock.calls
    .map((call) => String(call?.[0] || ""))
    .filter((message) => message.includes(text));

// Under fake timers: flush microtasks and due timers a few turns.
const settleFakeTimers = async (turns = 4) => {
  for (let i = 0; i < turns; i += 1) await vi.advanceTimersByTimeAsync(0);
};

// Drives the wedged incumbent to the sustained-failure gate: the fake's
// /health stops answering and the health timer fires twice — degraded, two
// awaiting_sustained_failure skips, no Doctor, nothing stopped. The third
// probe (the caller's) is the one that repairs.
const wedgeIncumbentToTheGate = async ({ incumbent, watchdog, insertWatchdogEvent, clawCmd, fake }) => {
  incumbent.healthy = false;
  await watchdog.runHealthCheck({ source: "health_timer" });
  await watchdog.runHealthCheck({ source: "health_timer" });
  expect(watchdog.getStatus().health).toBe("degraded");
  expect(repairSkipReasons(insertWatchdogEvent)).toEqual([
    expect.objectContaining({ reason: "awaiting_sustained_failure", failures: 1, threshold: 3 }),
    expect.objectContaining({ reason: "awaiting_sustained_failure", failures: 2, threshold: 3 }),
  ]);
  expect(doctorFixCalls(clawCmd)).toBe(0);
  expect(fake.stopCalls).toEqual([]);
  expect(fake.spawnCalls).toEqual([]);
};

describe("server/gateway restart drills (e2e)", () => {
  afterEach(() => {
    childProcess.spawn = originalSpawn;
    childProcess.execFile = originalExecFile;
    net.createConnection = originalCreateConnection;
    delete require.cache[kGatewayModulePath];
    delete require.cache[kSystemRoutesModulePath];
    vi.useRealTimers();
    // Repair-drill seams: the /health fetch, the auto-repair env the watchdog
    // reads at construction, and the onboarding marker the boot path checks.
    if (kOriginalFetch == null) delete global.fetch;
    else global.fetch = kOriginalFetch;
    if (kOriginalAutoRepair == null) delete process.env.WATCHDOG_AUTO_REPAIR;
    else process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
    fs.rmSync(kOnboardingMarkerPath, { force: true });
  });

  afterAll(() => {
    for (const dir of [kTempRoot, ...kTempDirs]) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("streams ordered human-labeled steps and records success metrics (SUCCESS DRILL)", async () => {
    const fake = createFakeGateway({ portOpen: true });
    const harness = createDrillHarness({ fake });
    harness.restartRequiredState.markRequired("env_vars_changed");
    const app = createApp(harness.deps);
    const sseHandler = captureOperationsSseHandler(harness.operationEvents);

    const res = await request(app).post("/api/gateway/restart?async=1");
    expect(res.status).toBe(202);
    expect(res.body.ok).toBe(true);
    const { operationId } = res.body;
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);

    const client = openSseClient(sseHandler, operationId);
    try {
      await waitUntil(() =>
        client.events().some((event) => event.event === "done"),
      );

      const events = client.events();
      // Full step timeline, in publish order, with the public labels the UI
      // renders (internal ids never surface as labels). preparing_plugins is
      // skipped: no enabled channels means no plugin preflight.
      expect(events.filter((e) => e.event === "step").map(stepTuple)).toEqual([
        ["step", "Checking plugins", "running"],
        ["step", "Checking plugins", "skipped"],
        ["step", "Stopping gateway", "running"],
        ["step", "Stopping gateway", "done"],
        ["step", "Starting gateway", "running"],
        ["step", "Waiting for health check", "running"],
        ["step", "Ready", "done"],
      ]);
      const waiting = events.find((e) => e.data?.name === "waiting_ready");
      expect(waiting.data.budgetMs).toBe(120000);
      // Event ids are the service's own monotonically increasing sequence.
      expect(events.map((e) => Number(e.id))).toEqual(
        events.map((_, index) => index + 1),
      );

      const terminal = events[events.length - 1];
      expect(terminal.event).toBe("done");
      expect(terminal.data.ok).toBe(true);
      expect(terminal.data.durationMs).toEqual(expect.any(Number));
      expect(terminal.data.downtimeMs).toBeGreaterThanOrEqual(0);
      expect(events.some((e) => e.event === "error")).toBe(false);

      const status = await request(app).get("/api/restart-status");
      expect(status.status).toBe(200);
      expect(status.body.lastOperation).toMatchObject({
        operationId,
        status: "succeeded",
        durationMs: expect.any(Number),
        downtimeMs: expect.any(Number),
        errorSummary: null,
      });
      // The reasons snapshot captured at begin was cleared by the success.
      expect(status.body.restartRequired).toBe(false);
      expect(status.body.reasons).toEqual([]);
      expect(status.body.restartInProgress).toBe(false);
      expect(status.body.activeOperation).toBeNull();

      // Exactly one restart execution reached the process boundary, and the
      // stop ran WITHOUT --force: this fake CLI (the pin) does not have it.
      expect(fake.spawnCalls.map((call) => call.args)).toEqual([
        ["gateway", "--force"],
      ]);
      expect(fake.stopCalls).toEqual([["gateway", "stop"]]);
    } finally {
      client.close();
    }
  });

  it("passes --force to the stop when the installed CLI advertises it (FORCE-CAPABLE DRILL)", async () => {
    const fake = createFakeGateway({ portOpen: true, forceSupported: true });
    const harness = createDrillHarness({ fake });
    const app = createApp(harness.deps);

    const res = await request(app).post("/api/gateway/restart");

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(fake.stopCalls).toEqual([["gateway", "stop", "--force"]]);
    expect(fake.spawnCalls.map((call) => call.args)).toEqual([
      ["gateway", "--force"],
    ]);
    expect(harness.deps.watchdog.recordOperationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "gateway_restart", status: "ok" }),
    );
  });

  it("refuses to report success when the CLI refuses the stop and the incumbent keeps the port (INCUMBENT DRILL)", async () => {
    // The #54 recovery-restart shape: the pin's CLI has no --force, so the
    // non-interactive stop is refused (exit 1); the old gateway keeps the
    // port and its pid through the whole "restart"; --force's supervisor
    // then finds the port answering. Before WI-5.2 this recorded
    // "succeeded" and cleared the restart-required banner.
    const fake = createFakeGateway({
      portOpen: true,
      stopRefused: true,
      livePids: [
        {
          pid: 31337,
          cmdline: "node /app/node_modules/openclaw/dist/entry.js gateway run",
        },
      ],
    });
    const harness = createDrillHarness({ fake });
    harness.deps.notify = vi.fn(async () => ({ ok: true }));
    harness.restartRequiredState.markRequired("env_vars_changed");
    const app = createApp(harness.deps);
    const sseHandler = captureOperationsSseHandler(harness.operationEvents);

    // Fake timers step the 15s stop-settle window.
    vi.useFakeTimers();
    let client = null;
    try {
      const res = await request(app).post("/api/gateway/restart?async=1");
      expect(res.status).toBe(202);
      const { operationId } = res.body;
      client = openSseClient(sseHandler, operationId);

      for (let i = 0; i < 20; i += 1) {
        if (
          harness.operationEvents.getOperation(operationId)?.status ===
          "failed"
        ) {
          break;
        }
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(harness.operationEvents.getOperation(operationId)?.status).toBe(
        "failed",
      );
      vi.useRealTimers();

      const events = client.events();
      expect(events.filter((e) => e.event === "step").map(stepTuple)).toEqual([
        ["step", "Checking plugins", "running"],
        ["step", "Checking plugins", "skipped"],
        ["step", "Stopping gateway", "running"],
        ["step", "Stopping gateway", "warning"],
        ["step", "Starting gateway", "running"],
        ["step", "Waiting for health check", "running"],
        ["step", "Waiting for health check", "warning"],
        ["step", "Ready", "warning"],
      ]);
      const stoppingWarning = events.find(
        (e) => e.data?.name === "stopping" && e.data?.status === "warning",
      );
      expect(stoppingWarning.data.detail).toContain(
        "was refused by the CLI (non-interactive guard)",
      );
      const readyWarning = events.find(
        (e) => e.data?.name === "ready" && e.data?.status === "warning",
      );
      expect(readyWarning.data.detail).toContain(
        "the previous gateway is still running",
      );
      const terminal = events[events.length - 1];
      expect(terminal.event).toBe("error");
      expect(terminal.data).toMatchObject({ code: "restart_incumbent" });
      expect(terminal.data.error).toContain("Gateway restart did not take effect");
      expect(terminal.data.error).toContain("port never released");
      expect(terminal.data.hint).toContain("still running");
      expect(events.some((e) => e.event === "done")).toBe(false);

      // The stop went out WITHOUT --force (the probe said the pin lacks it),
      // and --force's supervisor still ran.
      expect(fake.stopCalls).toEqual([["gateway", "stop"]]);
      expect(fake.spawnCalls.map((call) => call.args)).toEqual([
        ["gateway", "--force"],
      ]);

      const status = await request(app).get("/api/restart-status");
      expect(status.status).toBe(200);
      // No success clearing: the restart-required reasons survive, because
      // nothing new is running.
      expect(status.body.restartRequired).toBe(true);
      expect(status.body.reasons.map((r) => r.code)).toContain(
        "env_vars_changed",
      );
      expect(status.body.restartInProgress).toBe(false);
      expect(status.body.lastOperation).toMatchObject({
        operationId,
        status: "failed",
      });
      expect(status.body.lastOperation.errorSummary).toContain(
        "the previous gateway is still running",
      );
      // The pid/port verdict is persisted with the record's evidence.
      expect(status.body.lastOperation.evidence).toContain(
        "incumbent evidence:",
      );
      expect(status.body.lastOperation.evidence).toContain('"survivingPids":[31337]');
      expect(status.body.lastOperation.evidence).toContain('"cliRefused":true');

      // Ledger: the generic failed restart carries the reason, and the
      // dedicated restart_incumbent event carries the evidence.
      expect(harness.deps.watchdog.recordOperationEvent).toHaveBeenCalledWith({
        kind: "gateway_restart",
        status: "failed",
        details: expect.objectContaining({
          operationId,
          trigger: "manual",
          reason: "incumbent_gateway_still_running",
        }),
      });
      expect(harness.deps.watchdog.recordOperationEvent).toHaveBeenCalledWith({
        kind: "restart_incumbent",
        status: "failed",
        details: {
          operationId,
          trigger: "manual",
          reason: "incumbent_gateway_still_running",
          evidence: expect.objectContaining({
            wasRunningBefore: true,
            stopConfirmed: false,
            cliRefused: true,
            cliExitCode: 1,
            preStopPids: [31337],
            postReadyPids: [31337],
            newPids: [],
            survivingPids: [31337],
            supervisorPid: 4242,
          }),
        },
      });
      // Important-class notification (never verbose), outbox-deduped by op.
      expect(harness.deps.notify).toHaveBeenCalledTimes(1);
      const [message, opts] = harness.deps.notify.mock.calls[0];
      expect(message).toContain("🐺 *AlphaClaw Watchdog*");
      expect(message).toContain("🔴 Gateway restart did not take effect");
      expect(message).toContain("[View logs](https://setup.example.com/#/watchdog)");
      expect(message).toContain("Reason: `incumbent_gateway_still_running`");
      expect(message).toContain("refused the non-interactive `gateway stop`");
      expect(opts).toEqual({
        eventType: "restart_incumbent",
        id: `restart-incumbent-${operationId}`,
        operationId,
      });
    } finally {
      client?.close();
      vi.useRealTimers();
    }
  });

  it("fails with restart_failed + hint and serves redacted evidence when the gateway never becomes ready (NEVER-READY DRILL)", async () => {
    const kSecret = "supersecrettoken123";
    const fake = createFakeGateway({ portOpen: false });
    fake.neverReady = true;
    fake.stderrLines = [
      `gateway boot: auth failed for token ${kSecret}`,
      // X9 production-path check: an ANSI escape INSIDE the secret must not
      // defeat value-matching (controls are stripped BEFORE redaction).
      `retry auth with token super\x1b[31msecrettoken123`,
      "bind: address already in use",
    ];
    const harness = createDrillHarness({
      fake,
      envFileVars: [{ key: "GATEWAY_TEST_SECRET", value: kSecret }],
    });
    harness.restartRequiredState.markRequired("env_vars_changed");
    const app = createApp(harness.deps);
    const sseHandler = captureOperationsSseHandler(harness.operationEvents);

    // Fake timers step the 120s ready budget (same pattern as the
    // never-becomes-ready test in gateway.test.js).
    vi.useFakeTimers();
    let client = null;
    try {
      const res = await request(app).post("/api/gateway/restart?async=1");
      expect(res.status).toBe(202);
      const { operationId } = res.body;
      client = openSseClient(sseHandler, operationId);

      for (let i = 0; i < 20; i += 1) {
        if (
          harness.operationEvents.getOperation(operationId)?.status ===
          "failed"
        ) {
          break;
        }
        await vi.advanceTimersByTimeAsync(10_000);
      }
      expect(harness.operationEvents.getOperation(operationId)?.status).toBe(
        "failed",
      );
      vi.useRealTimers();

      const events = client.events();
      const terminal = events[events.length - 1];
      expect(terminal.event).toBe("error");
      // The summary now names the blocking CAUSE (last error-shaped line of
      // the redacted gateway output), not just the timeout symptom.
      expect(terminal.data).toMatchObject({
        code: "restart_failed",
        hint: "Retry, run Repair, or check the gateway logs.",
      });
      expect(terminal.data.error).toContain(
        "Gateway did not become ready within 120s",
      );
      expect(terminal.data.error).toContain(
        "last gateway error: bind: address already in use",
      );
      expect(events.some((e) => e.event === "done")).toBe(false);
      expect(events.some((e) => e.data?.name === "ready")).toBe(false);
      // Evidence rides by reference on /api/restart-status, never on frames —
      // and the secret must not leak through the stream either way.
      expect(JSON.stringify(events)).not.toContain(kSecret);

      const status = await request(app).get("/api/restart-status");
      expect(status.status).toBe(200);
      // Failure performs NO success clearing: the reasons survive.
      expect(status.body.restartRequired).toBe(true);
      expect(status.body.reasons.map((r) => r.code)).toContain(
        "env_vars_changed",
      );
      expect(status.body.restartInProgress).toBe(false);
      expect(status.body.lastOperation).toMatchObject({
        operationId,
        status: "failed",
      });
      expect(status.body.lastOperation.errorSummary).toContain(
        "Gateway did not become ready within 120s",
      );
      expect(status.body.lastOperation.errorSummary).toContain(
        "last gateway error: bind: address already in use",
      );
      // The raw persisted field never leaks into the response — `evidence`
      // is the single contract the UI reads.
      expect(status.body.lastOperation).not.toHaveProperty("evidenceTail");
      // The planted env-file secret in the stderr tail is masked to "***" and
      // never appears in cleartext anywhere in the response body.
      expect(status.body.lastOperation.evidence).toContain(
        "auth failed for token ***",
      );
      expect(status.body.lastOperation.evidence).toContain(
        "address already in use",
      );
      expect(JSON.stringify(status.body)).not.toContain(kSecret);
      // The ANSI-poisoned copy is normalized-then-masked through the REAL
      // route pipeline — no fragment of the secret survives.
      expect(JSON.stringify(status.body)).not.toContain("secrettoken123");

      // Evidence precedence guard: a NEWER operation must never serve the
      // failed operation's in-memory evidence. Complete a fresh operation
      // directly on the store; the route now reports THAT operation with
      // null evidence — not operation A's tail.
      const { operationId: opB } =
        harness.restartRequiredState.beginRestart();
      harness.restartRequiredState.completeRestart({
        operationId: opB,
        ok: true,
      });
      const statusB = await request(app).get("/api/restart-status");
      expect(statusB.body.lastOperation.operationId).toBe(opB);
      expect(statusB.body.lastOperation.evidence).toBeNull();
    } finally {
      client?.close();
      vi.useRealTimers();
    }
  });

  it("attaches concurrent restarts, 409s during a channel apply, and skips watchdog tryAcquire (MUTEX DRILL)", async () => {
    const fake = createFakeGateway({ portOpen: true });
    fake.holdStop = true;
    const harness = createDrillHarness({ fake });
    const app = createApp(harness.deps);

    const first = await request(app).post("/api/gateway/restart?async=1");
    expect(first.status).toBe(202);
    const { operationId } = first.body;

    // The restart is now parked inside `openclaw gateway stop`, holding the
    // lifecycle lock.
    await waitUntil(() => typeof fake.releaseStop === "function");

    // A second POST attaches to the running operation instead of starting a
    // competing restart.
    const second = await request(app).post("/api/gateway/restart?async=1");
    expect(second.status).toBe(202);
    expect(second.body).toEqual({ ok: true, attached: true, operationId });

    // A watchdog-style timer path must SKIP while the restart holds the
    // shared lifecycle lock — never queue behind it.
    expect(harness.gatewayLifecycleLock.getActiveOperation()).toMatchObject({
      kind: "restart",
    });
    expect(harness.gatewayLifecycleLock.tryAcquire("repair")).toBeNull();

    // A channel apply starting mid-restart must not shadow attach semantics:
    // joining the already-running restart stays coherent.
    harness.setApplyInProgress(true);
    const attachedDuringApply = await request(app).post(
      "/api/gateway/restart?async=1",
    );
    expect(attachedDuringApply.status).toBe(202);
    expect(attachedDuringApply.body).toEqual({
      ok: true,
      attached: true,
      operationId,
    });
    harness.setApplyInProgress(false);

    // Mid-restart status shows the single active operation.
    const midStatus = await request(app).get("/api/restart-status");
    expect(midStatus.status).toBe(200);
    expect(midStatus.body.restartInProgress).toBe(true);
    expect(midStatus.body.activeOperation).toMatchObject({
      operationId,
      status: "running",
    });

    fake.releaseStop();
    await waitUntil(
      () =>
        harness.operationEvents.getOperation(operationId)?.status ===
        "completed",
    );
    await flushMicrotasks();

    // One restart execution total, despite three POSTs.
    expect(fake.spawnCalls.map((call) => call.args)).toEqual([
      ["gateway", "--force"],
    ]);
    // The lock is free again once the operation completes.
    const release = harness.gatewayLifecycleLock.tryAcquire("repair");
    expect(typeof release).toBe("function");
    release();

    // With no restart to attach to, a channel apply in progress gates a NEW
    // restart with a typed 409.
    harness.setApplyInProgress(true);
    const blocked = await request(app).post("/api/gateway/restart?async=1");
    expect(blocked.status).toBe(409);
    expect(blocked.body.ok).toBe(false);
    expect(blocked.body.code).toBe("apply_in_progress");
    harness.setApplyInProgress(false);
  });

  it("reconciles a restart interrupted by an AlphaClaw death into a terminal answer on boot (KILL-MID-RESTART DRILL)", async () => {
    const stateDir = mkStateDir();
    const dyingStore = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      getBootId: () => "boot-before-crash",
    });
    dyingStore.markRequired("env_vars_changed");
    const { operationId } = dyingStore.beginRestart();
    // AlphaClaw dies here: completeRestart never runs, so the "running"
    // operation record is left behind on disk.

    const rebootedStore = createRestartRequiredState({
      isGatewayRunning: async () => true,
      flagStore: nullFlagStore(),
      stateDir,
      getBootId: () => "boot-after-crash",
    });
    rebootedStore.reconcileOnBoot();

    const harness = createDrillHarness({
      restartRequiredState: rebootedStore,
    });
    const app = createApp(harness.deps);

    const status = await request(app).get("/api/restart-status");
    expect(status.status).toBe(200);
    // The stale record is closed as a terminal "interrupted" the UI can
    // render — never a phantom in-progress restart.
    expect(status.body.activeOperation).toBeNull();
    expect(status.body.restartInProgress).toBe(false);
    expect(status.body.lastOperation).toMatchObject({
      operationId,
      status: "interrupted",
      errorSummary: "AlphaClaw restarted before the operation finished",
      evidence: null,
    });
    expect(status.body.lastOperation.completedAt).toEqual(expect.any(Number));
    // The interrupted restart never cleared its reasons: still required.
    expect(status.body.restartRequired).toBe(true);
    expect(status.body.reasons.map((r) => r.code)).toContain(
      "env_vars_changed",
    );
    expect(status.body.lastOperation.reasonsSnapshot).toEqual([
      "env_vars_changed",
    ]);
  });

  it("replays already-published events in order before live ones on a late SSE subscribe (REPLAY DRILL)", async () => {
    const fake = createFakeGateway({ portOpen: true });
    fake.holdStop = true;
    const harness = createDrillHarness({ fake });
    const app = createApp(harness.deps);
    const sseHandler = captureOperationsSseHandler(harness.operationEvents);

    const res = await request(app).post("/api/gateway/restart?async=1");
    expect(res.status).toBe(202);
    const { operationId } = res.body;

    // Let the restart publish its first steps, then park it inside the held
    // `openclaw gateway stop`.
    await waitUntil(() => typeof fake.releaseStop === "function");

    // Subscribe AFTER three step events were published: they replay first.
    const client = openSseClient(sseHandler, operationId);
    try {
      expect(client.res.headers["Content-Type"]).toBe("text/event-stream");
      const replayed = client.events();
      expect(replayed.map(stepTuple)).toEqual([
        ["step", "Checking plugins", "running"],
        ["step", "Checking plugins", "skipped"],
        ["step", "Stopping gateway", "running"],
      ]);
      expect(replayed.map((e) => e.id)).toEqual(["1", "2", "3"]);

      fake.releaseStop();
      await waitUntil(() =>
        client.events().some((event) => event.event === "done"),
      );

      const events = client.events();
      // The replayed prefix is untouched, and live events continue the same
      // monotonically increasing id sequence in publish order.
      expect(events.slice(0, 3)).toEqual(replayed);
      expect(events.map((e) => Number(e.id))).toEqual(
        events.map((_, index) => index + 1),
      );
      expect(events.slice(3).map(stepTuple)).toEqual([
        ["step", "Stopping gateway", "done"],
        ["step", "Starting gateway", "running"],
        ["step", "Waiting for health check", "running"],
        ["step", "Ready", "done"],
        ["done", null, null],
      ]);
    } finally {
      client.close();
    }
  });

  it("queued behind a long lifecycle hold: the queue keepalive keeps the record alive and the restart completes with its real outcome (never interrupted)", async () => {
    const fake = createFakeGateway({ portOpen: true });
    const harness = createDrillHarness({ fake });
    const app = createApp(harness.deps);
    const {
      kGatewayRestartOperationBudgetMs,
    } = require("../../lib/server/constants");
    vi.useFakeTimers();
    try {
      const acquireSpy = vi.spyOn(harness.gatewayLifecycleLock, "acquire");
      // An alien long hold (a channel apply) parks the restart in the queue
      // for LONGER than the record's initial lifetime.
      const releaseHold = await harness.gatewayLifecycleLock.acquire("apply", {
        leaseMs: 60 * 60_000,
      });
      const res = await request(app).post("/api/gateway/restart?async=1");
      expect(res.status).toBe(202);
      const { operationId } = res.body;

      // Past the initial budget while still queued: without the 60s queue
      // keepalive every /api/restart-status poll would reap the record as
      // "interrupted" and the eventual outcome + evidence would be dropped.
      await vi.advanceTimersByTimeAsync(kGatewayRestartOperationBudgetMs + 61_000);
      expect(
        harness.restartRequiredState.getActiveRestartOperation(),
      ).toMatchObject({ operationId, status: "running" });

      // Release the hold: the restart acquires with the restart-class BUDGET
      // lease (not the fixed default) and completes with its real outcome.
      releaseHold();
      await vi.advanceTimersByTimeAsync(30_000);
      // v0.9.73: the acquire also carries the lock-owned queue callback that
      // drives the waiting_for_lock step — the lease is what this drill pins.
      expect(acquireSpy).toHaveBeenCalledWith(
        "restart",
        expect.objectContaining({
          leaseMs: kGatewayRestartOperationBudgetMs,
          onQueued: expect.any(Function),
        }),
      );
      expect(
        harness.restartRequiredState.getLastRestartOperation(),
      ).toMatchObject({ operationId, status: "succeeded" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("failure evidence survives an AlphaClaw supervisor restart (persisted record, fresh app)", async () => {
    // Session 1: a failed operation persists the redacted evidence tail into
    // the operation record (this is what the in-memory copy can NOT do).
    const stateDir = mkStateDir();
    const storeA = createRestartRequiredState({
      isGatewayRunning: async () => false,
      flagStore: nullFlagStore(),
      stateDir,
    });
    const { operationId } = storeA.beginRestart();
    storeA.completeRestart({
      operationId,
      ok: false,
      errorSummary:
        "Gateway did not become ready within 120s — last gateway error: ERROR another OpenClaw process owns state-lifecycle",
      evidenceTail:
        "loading plugins...\nERROR another OpenClaw process owns state-lifecycle: /tmp/openclaw-state-locks-0",
      durationMs: 121_000,
    });

    // Session 2: a brand-new store over the same dir (simulated AlphaClaw
    // restart) and a brand-new app — the route's in-memory evidence is gone;
    // the persisted record is the only carrier.
    const storeB = createRestartRequiredState({
      isGatewayRunning: async () => false,
      flagStore: nullFlagStore(),
      stateDir,
    });
    storeB.reconcileOnBoot();
    const harness = createDrillHarness({ restartRequiredState: storeB });
    const app = createApp(harness.deps);

    const status = await request(app).get("/api/restart-status");
    expect(status.status).toBe(200);
    expect(status.body.lastOperation).toMatchObject({
      operationId,
      status: "failed",
      durationMs: 121_000,
    });
    expect(status.body.lastOperation.evidence).toContain(
      "owns state-lifecycle",
    );
    expect(status.body.lastOperation).not.toHaveProperty("evidenceTail");
    expect(status.body.lastOperation.errorSummary).toContain(
      "last gateway error:",
    );
  });

  // ── Watchdog repair `replace` through the real cold restart (v0.9.74) ─────
  //
  //   boot around incumbent (adopted) ─▶ /health wedges ─▶ probe ✗ ✗ ✗ (sustained gate)
  //     ─▶ runRepair: doctor --fix ─▶ requestGatewayLaunch → incumbent_present
  //     ─▶ replace: `gateway stop` → `gateway --force` → ready → #59 verdict
  //          ├ new tree answers ─▶ requested {replace} … ok {verified: true}   (REPLACE DRILL)
  //          └ incumbent survives ─▶ failed {incumbent_gateway_still_running}  (REPLACE-INCUMBENT)
  //   lock lease expires mid ready-wait ─▶ aborted_by_caller, poll ends       (LEASE-FENCE DRILL)
  describe("watchdog repair `replace` through the real cold restart", () => {
    it("replaces a wedged incumbent after three failed probes: doctor once, `gateway stop` + `gateway --force` on the fake, restart/repair/requested {intent: replace} then ok {verified: true} once the new supervisor's tree answers (REPLACE DRILL)", async () => {
      const fake = createFakeGateway({
        portOpen: true,
        supervisorLingers: true,
        livePids: [{ pid: kIncumbentPid, cmdline: kIncumbentCmdline }],
        livePidsAfterLaunch: [{ pid: kFakeSupervisorPid, cmdline: kSupervisorCmdline }],
      });
      const harness = createDrillHarness({ fake });
      const incumbent = { healthy: true };
      const { watchdog, insertWatchdogEvent, clawCmd, notifier, coldRestartHolds } =
        createDrillWatchdog({
          fake,
          harness,
          // The replacement answers as soon as its tree is what /proc shows;
          // before that the port belongs to the incumbent.
          isHealthy: () =>
            fake.livePids.some((proc) => proc.pid === kFakeSupervisorPid) ||
            incumbent.healthy,
        });
      try {
        await bootAroundIncumbent(fake);
        expect(fake.spawnCalls).toEqual([]);
        // Liveness lands before the readiness await inside the same probe:
        // wait for the whole bootstrap verdict, not just the green /health.
        await waitUntil(() => watchdog.getStatus().readiness === "ready");
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "running",
          supervisionMode: "adopted",
          servingPid: kIncumbentPid,
          servingRootPid: kIncumbentPid,
          gatewayPid: null,
          readiness: "ready",
        });

        await wedgeIncumbentToTheGate({ incumbent, watchdog, insertWatchdogEvent, clawCmd, fake });

        // Third consecutive failure: repair in-tick, intent replace.
        await watchdog.runHealthCheck({ source: "health_timer" });
        await waitUntil(
          () => restartRows(insertWatchdogEvent, { source: "repair", status: "ok" }).length > 0,
        );

        expect(doctorFixCalls(clawCmd)).toBe(1);
        // The pin's CLI has no --force on stop; the relaunch is the cold
        // restart's `gateway --force` — never a `gateway run` alongside.
        expect(fake.stopCalls).toEqual([["gateway", "stop"]]);
        expect(fake.spawnCalls.map((call) => [call.file, ...call.args])).toEqual([
          ["openclaw", "gateway", "--force"],
        ]);
        expect(coldRestartHolds).toEqual(["repair"]);

        const repairRows = restartRows(insertWatchdogEvent, { source: "repair" });
        expect(repairRows.map((row) => row.status)).toEqual(["requested", "ok"]);
        expect(repairRows[0].details).toMatchObject({
          intent: "replace",
          coldRestart: true,
          incumbent: "incumbent_present",
          incumbentPid: kIncumbentPid,
        });
        expect(repairRows[1].details).toEqual({
          pid: kFakeSupervisorPid,
          servingPid: kFakeSupervisorPid,
          generation: 1,
          intent: "replace",
          verified: true,
        });
        expect(repairRows[0].correlationId).toBe(repairRows[1].correlationId);
        // Under `replace` the incumbent is never adopted.
        expect(
          ledgerRows(insertWatchdogEvent).some(
            (row) => row.details?.reason === "incumbent_adopted",
          ),
        ).toBe(false);
        expect(operationRows(insertWatchdogEvent).map((row) => row.status)).toEqual([
          "started",
          "ok",
        ]);
        expect(operationRows(insertWatchdogEvent)[0].details).toMatchObject({
          trigger: "repair",
          source: "repair",
        });

        // The adopted supervisor IS the new managed gateway (issue #56 shape).
        expect(fake.gateway.isManagedGatewayChildSupervisor()).toBe(true);
        expect(fake.gateway.getLaunchGeneration()).toBe(1);
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "running",
          health: "healthy",
          readiness: "ready",
          supervisionMode: "managed",
          servingRootPid: kFakeSupervisorPid,
          servingPid: kFakeSupervisorPid,
          gatewayPid: kFakeSupervisorPid,
          lastRepairVerdict: "replacement_ready",
          replacementPending: null,
        });
        expect(noticesIncluding(notifier, "Auto-repair complete, gateway healthy")).toHaveLength(1);
        expect(noticesIncluding(notifier, "Auto-repair failed")).toHaveLength(0);
        expect(harness.gatewayLifecycleLock.getActiveOperation()).toBeNull();
      } finally {
        watchdog.stop();
      }
    });

    it("an incumbent that refuses the stop and keeps the port is a FAILED replacement: restart/repair/failed {incumbent_gateway_still_running}, no ok row, identity untouched (REPLACE-INCUMBENT DRILL)", async () => {
      const fake = createFakeGateway({
        portOpen: true,
        stopRefused: true,
        livePids: [{ pid: kIncumbentPid, cmdline: kIncumbentCmdline }],
      });
      const harness = createDrillHarness({ fake });
      const incumbent = { healthy: true };
      const { watchdog, insertWatchdogEvent, clawCmd, notifier, coldRestartHolds } =
        createDrillWatchdog({ fake, harness, isHealthy: () => incumbent.healthy });
      // Fake timers step the 15s stop-settle window the refused stop burns.
      vi.useFakeTimers();
      try {
        await bootAroundIncumbent(fake);
        await settleFakeTimers();
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          supervisionMode: "adopted",
          servingRootPid: kIncumbentPid,
        });

        await wedgeIncumbentToTheGate({ incumbent, watchdog, insertWatchdogEvent, clawCmd, fake });

        const third = watchdog.runHealthCheck({ source: "health_timer" });
        for (let i = 0; i < 40; i += 1) {
          if (restartRows(insertWatchdogEvent, { source: "repair", status: "failed" }).length) {
            break;
          }
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await third;
        await settleFakeTimers();

        expect(doctorFixCalls(clawCmd)).toBe(1);
        expect(fake.stopCalls).toEqual([["gateway", "stop"]]);
        expect(fake.spawnCalls.map((call) => call.args)).toEqual([["gateway", "--force"]]);
        expect(coldRestartHolds).toEqual(["repair"]);

        const repairRows = restartRows(insertWatchdogEvent, { source: "repair" });
        expect(repairRows.map((row) => row.status)).toEqual(["requested", "failed"]);
        expect(repairRows[0].details).toMatchObject({ intent: "replace", coldRestart: true });
        expect(repairRows[1].details).toMatchObject({
          reason: "incumbent_gateway_still_running",
          intent: "replace",
        });
        expect(repairRows[1].details.error).toContain("port never released");
        expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(0);
        expect(operationRows(insertWatchdogEvent).map((row) => row.status)).toEqual([
          "started",
          "failed",
        ]);
        expect(operationRows(insertWatchdogEvent)[1].details).toMatchObject({
          trigger: "repair",
          reason: "incumbent_gateway_still_running",
        });

        // Nothing new is running: no adoption, no generation-bearing launch
        // notice, the incumbent's identity is what the watchdog still tracks.
        expect(fake.gateway.isManagedGatewayChildSupervisor()).toBe(false);
        expect(fake.gateway.getManagedGatewayWorkerPid()).toBeNull();
        const status = watchdog.getStatus();
        expect(status.health).not.toBe("healthy");
        expect(status).toMatchObject({
          supervisionMode: "adopted",
          servingRootPid: kIncumbentPid,
          lastRepairVerdict: "replacement_failed",
          replacementPending: null,
        });
        expect(noticesIncluding(notifier, "Auto-repair failed")).toHaveLength(1);
        expect(noticesIncluding(notifier, "Auto-repair complete")).toHaveLength(0);
        expect(harness.gatewayLifecycleLock.getActiveOperation()).toBeNull();
      } finally {
        watchdog.stop();
        vi.useRealTimers();
      }
    });

    it("a cold restart under a lifecycle hold whose lease expires mid ready-wait stops polling through the hold's isValid() fence — aborted_by_caller within a poll tick, never the 120s budget (LEASE-FENCE DRILL)", async () => {
      const fake = createFakeGateway({ portOpen: true });
      fake.neverReady = true;
      const harness = createDrillHarness({ fake });
      const launchHandler = vi.fn();
      fake.gateway.setGatewayLaunchHandler(launchHandler);
      vi.useFakeTimers();
      try {
        const kLeaseMs = 5_000;
        const hold = harness.gatewayLifecycleLock.tryAcquire("repair", { leaseMs: kLeaseMs });
        expect(hold.isValid()).toBe(true);
        const startedAt = Date.now();
        let outcome;
        // The watchdog's fence, verbatim: `() => !hold.isValid()`.
        const run = harness.deps
          .restartGateway({ shouldAbort: () => !hold.isValid() })
          .then(
            () => {
              outcome = { ok: true };
            },
            (error) => {
              outcome = { error };
            },
          );

        // Stop settles at once (port released), `--force` is spawned, and the
        // ready wait polls a port that never answers — while the lease holds.
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fake.stopCalls).toEqual([["gateway", "stop"]]);
        expect(fake.spawnCalls.map((call) => call.args)).toEqual([["gateway", "--force"]]);
        expect(hold.isValid()).toBe(true);
        expect(outcome).toBeUndefined();

        for (let i = 0; i < 10 && outcome === undefined; i += 1) {
          await vi.advanceTimersByTimeAsync(1_000);
        }
        await run;
        const elapsedMs = Date.now() - startedAt;
        expect(hold.isExpired()).toBe(true);
        expect(hold.isValid()).toBe(false);
        expect(harness.gatewayLifecycleLock.getActiveOperation()).toBeNull();
        // Ended one poll tick after the lease fired — not at the ready budget.
        expect(elapsedMs).toBeLessThan(kLeaseMs + 2_000);
        expect(elapsedMs).toBeLessThan(kGatewayRestartReadyTimeoutMs);
        expect(outcome.error).toBeInstanceOf(fake.gateway.GatewayRestartError);
        expect(outcome.error).not.toBeInstanceOf(fake.gateway.GatewayIncumbentRestartError);
        expect(outcome.error.message).toContain("aborted by caller");
        expect(outcome.error.evidence).toMatchObject({
          aborted: true,
          reason: "aborted_by_caller",
        });
        // Nothing claimed success: one spawn, no launch notice, and the
        // generation counter records the one spawn that happened.
        expect(fake.spawnCalls).toHaveLength(1);
        expect(launchHandler).not.toHaveBeenCalled();
        expect(fake.gateway.getLaunchGeneration()).toBe(1);
      } finally {
        fake.gateway.setGatewayLaunchHandler(null);
        vi.useRealTimers();
      }
    });
  });
});

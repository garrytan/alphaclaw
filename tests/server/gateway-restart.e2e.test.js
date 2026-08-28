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

const { EventEmitter } = require("events");
const childProcess = require("child_process");
const net = require("net");

const express = require("express");
const request = require("supertest");

const {
  kDefaultGatewayPort,
  GATEWAY_HOST,
} = require("../../lib/server/constants");
const { registerSystemRoutes } = require("../../lib/server/routes/system");
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

const kGatewayModulePath = require.resolve("../../lib/server/gateway");

const originalSpawn = childProcess.spawn;
const originalExecFile = childProcess.execFile;
const originalCreateConnection = net.createConnection;

const kSilentLogger = { log() {}, warn() {}, error() {} };

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
const createFakeGateway = ({ portOpen = true } = {}) => {
  const fake = {
    portOpen,
    holdStop: false,
    releaseStop: null,
    stderrLines: [],
    spawnCalls: [],
    supervisors: [],
  };

  childProcess.execFile = vi.fn((file, args, opts, cb) => {
    if (fake.holdStop && args?.[0] === "gateway" && args?.[1] === "stop") {
      fake.releaseStop = () => cb(null, "", "");
      return;
    }
    cb(null, "", "");
  });

  childProcess.spawn = vi.fn((file, args) => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.kill = vi.fn();
    fake.spawnCalls.push({ file, args });
    fake.supervisors.push(child);
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

describe("server/gateway restart drills (e2e)", () => {
  afterEach(() => {
    childProcess.spawn = originalSpawn;
    childProcess.execFile = originalExecFile;
    net.createConnection = originalCreateConnection;
    delete require.cache[kGatewayModulePath];
    vi.useRealTimers();
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

      // Exactly one restart execution reached the process boundary.
      expect(fake.spawnCalls.map((call) => call.args)).toEqual([
        ["gateway", "--force"],
      ]);
    } finally {
      client.close();
    }
  });

  it("fails with restart_failed + hint and serves redacted evidence when the gateway never becomes ready (NEVER-READY DRILL)", async () => {
    const kSecret = "supersecrettoken123";
    const fake = createFakeGateway({ portOpen: false });
    fake.stderrLines = [
      `gateway boot: auth failed for token ${kSecret}`,
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
      expect(terminal.data).toEqual({
        error: "Gateway did not become ready within 120s",
        code: "restart_failed",
        hint: "Retry, run Repair, or check the gateway logs.",
      });
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
        errorSummary: "Gateway did not become ready within 120s",
      });
      // The planted env-file secret in the stderr tail is masked to "***" and
      // never appears in cleartext anywhere in the response body.
      expect(status.body.lastOperation.evidence).toContain(
        "auth failed for token ***",
      );
      expect(status.body.lastOperation.evidence).toContain(
        "address already in use",
      );
      expect(JSON.stringify(status.body)).not.toContain(kSecret);
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
});

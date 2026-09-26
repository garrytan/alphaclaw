const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const request = require("supertest");
const { registerOpenclawChannelRoutes } = require("../../lib/server/routes/openclaw-channel");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createRunStream } = require("../../lib/server/openclaw-run-stream");

const kUrl = "/api/openclaw/reconcile/retry";
const roots = [];
const pending = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const flush = () => new Promise((resolve) => setImmediate(resolve));
const createHarness = ({ leaseMs, reconcile } = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reconcile-retry-cleanup-"));
  roots.push(root);
  const lock = createGatewayLifecycleLock({ logger: { warn() {} } });
  const shutdown = new AbortController();
  const state = { applying: false, running: false };
  const actions = {
    signal: shutdown.signal,
    acquireLock: vi.fn((kind, options) => lock.acquire(kind, { ...options, ...(leaseMs ? { leaseMs } : {}) })),
    clearLatch: vi.fn(),
    startGateway: vi.fn(async () => {}),
    isGatewayRunning: vi.fn(async () => state.running),
    readGatewayHold: vi.fn(() => ({ reason: "config_migration_failed" })),
  };
  const service = { reconcileBootConfig: vi.fn(reconcile || (async () => ({ status: "ok", warnings: [] }))),
    isApplyInProgress: vi.fn(() => state.applying) };
  const app = express(); app.use(express.json());
  registerOpenclawChannelRoutes({ app, fs, OPENCLAW_DIR: root, isOnboarded: () => true,
    openclawChannelService: service, gatewayHoldActions: actions });
  return { root, lock, shutdown, state, actions, service, app };
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("retry migration owned cleanup", () => {
  it("wires the shutdown signal and launch cancellation options through the production retry bundle", () => {
    const source = fs.readFileSync(path.join(__dirname, "../../lib/server/init/register-server-routes.js"), "utf8");
    const start = source.indexOf("gatewayHoldActions: {");
    expect(start).toBeGreaterThan(-1);
    const bundle = source.slice(start, source.indexOf("getActiveOperation:", start));
    expect(bundle).toContain("signal: bootSignal");
    expect(bundle).toMatch(/startGateway:\s*\(options\)\s*=>\s*startGateway\(options\)/);
  });

  it("passes one owned repair operation through reconciliation and relaunch", async () => {
    const cell = createHarness();
    let captured;
    cell.service.reconcileBootConfig.mockImplementation(async (options) => {
      captured = options;
      expect(cell.lock.owns(options.hold)).toBe(true);
      expect(options.hold.kind).toBe("reconcile_retry");
      expect(options.operation.signal.aborted).toBe(false);
      expect(cell.actions.acquireLock.mock.calls[0][1].cleanup).toBe(options.operation.cleanup);
      expect(options.operation.remainingMs()).toBeGreaterThan(30 * 60_000);
      return { status: "ok", warnings: [] };
    });
    cell.actions.startGateway.mockImplementation(async (options) => {
      expect(options.shouldAbort()).toBe(false);
      expect(cell.lock.owns(captured.hold)).toBe(true);
    });
    const response = await request(cell.app).post(kUrl).send({ stripBlamedKeys: true });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, outcome: { status: "ok", warnings: [] } });
    expect(captured.stripBlamedKeys).toBe(true);
    expect(cell.actions.clearLatch).toHaveBeenCalledOnce();
    expect(cell.actions.startGateway).toHaveBeenCalledOnce();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("refuses shutdown before acquiring a retry lease or dispatching reconciliation", async () => {
    const cell = createHarness(); cell.shutdown.abort("shutdown");
    const response = await request(cell.app).post(kUrl).send({});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("operation_cancelled");
    expect(cell.actions.acquireLock).not.toHaveBeenCalled();
    expect(cell.service.reconcileBootConfig).not.toHaveBeenCalled();
    expect(cell.actions.clearLatch).not.toHaveBeenCalled();
    expect(cell.actions.startGateway).not.toHaveBeenCalled();
  });

  it("a queued retry cannot start after shutdown's one-time cleanup cancellation", async () => {
    const cell = createHarness();
    const predecessor = cell.lock.tryAcquire("boot");
    const responsePromise = request(cell.app).post(kUrl).send({}).then((response) => response);
    await vi.waitFor(() => expect(cell.actions.acquireLock).toHaveBeenCalledOnce());
    cell.shutdown.abort("shutdown");
    await cell.lock.cancelActiveCleanup("shutdown");
    await predecessor();
    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("operation_cancelled");
    expect(cell.service.reconcileBootConfig).not.toHaveBeenCalled();
    expect(cell.actions.clearLatch).not.toHaveBeenCalled();
    expect(cell.actions.startGateway).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("ignores a late gateway-state read after shutdown without acquiring a new lease", async () => {
    const read = pending();
    const cell = createHarness();
    cell.actions.isGatewayRunning.mockImplementation(() => read.promise);
    const responsePromise = request(cell.app).post(kUrl).send({}).then((response) => response);
    await vi.waitFor(() => expect(cell.actions.isGatewayRunning).toHaveBeenCalledOnce());
    cell.shutdown.abort("shutdown");
    const response = await responsePromise;
    read.resolve(false); await flush();
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("operation_cancelled");
    expect(cell.actions.acquireLock).not.toHaveBeenCalled();
    expect(cell.service.reconcileBootConfig).not.toHaveBeenCalled();
    expect(cell.actions.clearLatch).not.toHaveBeenCalled();
    expect(cell.actions.startGateway).not.toHaveBeenCalled();
  });

  it.each(["shutdown", "lease expiry"])("%s retains the retry lease until the Doctor and restore guard finish", async (cancellation) => {
    const entered = pending(); const child = pending(); const guard = pending();
    const order = [];
    let operation;
    const cell = createHarness({ leaseMs: cancellation === "lease expiry" ? 40 : undefined,
      reconcile: async (options) => {
        operation = options.operation;
        entered.resolve();
        await child.promise; order.push("child finished");
        await guard.promise; order.push("restore guard finished");
        return { status: "ok" };
      } });
    let responded = false;
    const responsePromise = request(cell.app).post(kUrl).send({}).then((response) => { responded = true; return response; });
    await entered.promise;
    let successor;
    const queued = cell.lock.acquire("restart").then((hold) => { successor = hold; order.push("successor acquired"); return hold; });
    let draining;
    if (cancellation === "shutdown") {
      cell.shutdown.abort("shutdown");
      draining = cell.lock.cancelActiveCleanup("shutdown");
    }
    await vi.waitFor(() => expect(operation.signal.aborted).toBe(true));
    expect(cell.lock.getActiveOperation()).toMatchObject({ kind: "reconcile_retry", phase: "cleanup" });
    expect(responded).toBe(false);
    expect(successor).toBeUndefined();
    child.resolve(); await flush();
    expect(order).toEqual(["child finished"]);
    expect(successor).toBeUndefined();
    guard.resolve();
    const response = await responsePromise;
    await draining;
    await queued;
    try {
      expect(response.status).toBe(409);
      expect(response.body.code).toBe(cancellation === "shutdown" ? "operation_cancelled" : "lease_expired");
      expect(order).toEqual(["child finished", "restore guard finished", "successor acquired"]);
      expect(cell.actions.clearLatch).not.toHaveBeenCalled();
      expect(cell.actions.startGateway).not.toHaveBeenCalled();
      expect(cell.lock.owns(successor)).toBe(true);
    } finally { await successor?.(); }
  });

  it("rechecks ownership between clearing the latch and starting the gateway", async () => {
    const cell = createHarness();
    cell.actions.clearLatch.mockImplementation(() => cell.shutdown.abort("shutdown"));
    const response = await request(cell.app).post(kUrl).send({});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("operation_cancelled");
    expect(cell.service.reconcileBootConfig).toHaveBeenCalledOnce();
    expect(cell.actions.clearLatch).toHaveBeenCalledOnce();
    expect(cell.actions.startGateway).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("passes a live cancellation predicate through an asynchronous gateway start", async () => {
    const starting = pending(); const finish = pending();
    const cell = createHarness();
    cell.actions.startGateway.mockImplementation(async ({ shouldAbort }) => {
      expect(shouldAbort()).toBe(false); starting.resolve();
      await finish.promise;
      expect(shouldAbort()).toBe(true);
    });
    const responsePromise = request(cell.app).post(kUrl).send({}).then((response) => response);
    await starting.promise;
    cell.shutdown.abort("shutdown");
    const draining = cell.lock.cancelActiveCleanup("shutdown");
    await flush();
    expect(cell.lock.getActiveOperation()).toMatchObject({ kind: "reconcile_retry", phase: "cleanup" });
    finish.resolve();
    const response = await responsePromise;
    await draining;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("operation_cancelled");
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it.each(["applying", "running"])("rechecks %s after waiting for the lifecycle lock", async (field) => {
    const cell = createHarness(); const predecessor = cell.lock.tryAcquire("operator");
    const responsePromise = request(cell.app).post(kUrl).send({}).then((response) => response);
    await vi.waitFor(() => expect(cell.actions.acquireLock).toHaveBeenCalledOnce());
    cell.state[field] = true; await predecessor();
    const response = await responsePromise;
    expect(response.status).toBe(409);
    expect(response.body.code).toBe(field === "applying" ? "apply_in_progress" : "gateway_running");
    expect(cell.service.reconcileBootConfig).not.toHaveBeenCalled();
    expect(cell.actions.clearLatch).not.toHaveBeenCalled();
    expect(cell.actions.startGateway).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("keeps an ordinary reconciliation exception distinct from cancellation", async () => {
    const cell = createHarness({ reconcile: async () => { throw new Error("reconciliation write failed"); } });
    const response = await request(cell.app).post(kUrl).send({});
    expect(response.status).toBe(500);
    expect(response.body.code).toBe("channel_state_write_failed");
    expect(cell.actions.clearLatch).not.toHaveBeenCalled();
    expect(cell.actions.startGateway).not.toHaveBeenCalled();
    expect(cell.lock.getActiveOperation()).toBeNull();
  });

  it("holds a real child process and delayed restore guard ahead of a queued successor", async () => {
    const guard = pending();
    const cell = createHarness();
    const script = path.join(cell.root, "synthetic-doctor.cjs");
    const started = path.join(cell.root, "started");
    const childDone = path.join(cell.root, "child-done");
    const restored = path.join(cell.root, "restored");
    fs.writeFileSync(script, `const fs=require("node:fs");
      fs.writeFileSync(${JSON.stringify(started)}, "running");
      process.on("SIGTERM", () => setTimeout(() => {
        fs.writeFileSync(${JSON.stringify(childDone)}, "drained"); process.exit(0);
      }, 35)); setInterval(() => {}, 100);
    `);
    const runner = createRunStream();
    cell.service.reconcileBootConfig.mockImplementation(async ({ operation }) => {
      await operation.runWriter(() => runner.runStreamed({ command: process.execPath, args: [script],
        signal: operation.signal, deadlineAt: operation.deadlineAt, killGraceMs: 1000, onProcess: operation.noteProcess }));
      await guard.promise;
      fs.writeFileSync(restored, "restored safely");
      return { status: "ok" };
    });
    const responsePromise = request(cell.app).post(kUrl).send({}).then((response) => response);
    await vi.waitFor(() => expect(fs.existsSync(started)).toBe(true));
    let successor;
    const queued = cell.lock.acquire("restart").then((hold) => { successor = hold; return hold; });
    cell.shutdown.abort("shutdown");
    const draining = cell.lock.cancelActiveCleanup("shutdown");
    await vi.waitFor(() => expect(fs.existsSync(childDone)).toBe(true));
    expect(successor).toBeUndefined();
    expect(fs.existsSync(restored)).toBe(false);
    expect(cell.lock.getActiveOperation()).toMatchObject({ kind: "reconcile_retry", phase: "cleanup" });
    guard.resolve();
    const response = await responsePromise;
    await draining; await queued;
    try {
      expect(response.status).toBe(409);
      expect(response.body.code).toBe("operation_cancelled");
      expect(fs.readFileSync(restored, "utf8")).toBe("restored safely");
      expect(cell.actions.clearLatch).not.toHaveBeenCalled();
      expect(cell.actions.startGateway).not.toHaveBeenCalled();
      expect(cell.lock.owns(successor)).toBe(true);
    } finally { await successor?.(); }
  });
});

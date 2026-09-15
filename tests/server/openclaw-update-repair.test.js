const { createOpenclawUpdateRepair } = require("../../lib/server/openclaw-update-repair");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createGatewayMutationPolicy } = require("../../lib/server/gateway-mutation-policy");

const kOperationId = "11111111-1111-4111-8111-111111111111";
const makeHarness = () => {
  let busy = false;
  const state = { channel: { releaseChannel: "dev" }, onboarded: true, selfUpdating: false };
  const lock = createGatewayLifecycleLock({ logger: { warn() {} } });
  const mutationPolicy = createGatewayMutationPolicy({
    lock, getChannelInfo: () => state.channel, isApplyInProgress: () => busy,
  });
  const sink = { writeLine: vi.fn(), close: vi.fn(async () => {}) };
  const ledger = {
    createRun: vi.fn(), completeRun: vi.fn(), createLogSink: vi.fn(() => sink),
  };
  const recorder = { steps: [], emit: vi.fn() };
  const output = Object.assign(vi.fn(), { flush: vi.fn() });
  const options = {
    getChannelInfo: () => state.channel,
    isOnboarded: () => state.onboarded,
    isSelfUpdateInProgress: () => state.selfUpdating,
    isApplyInProgress: () => busy,
    setApplyInProgress: (value) => { busy = value; },
    getActiveGatewayOperation: lock.getActiveOperation,
    acquireLifecycleLock: lock.acquire,
    mutationPolicy, ledger,
    runner: { runStreamed: vi.fn(async () => ({ ok: true })) },
    devUpdateEnv: () => ({ OPENCLAW_SUPERVISOR_MODE: "external" }),
    stepRecorder: vi.fn(() => recorder),
    makeOutputPublisher: () => output,
    setActiveSink: vi.fn(),
    operationEvents: { complete: vi.fn(), fail: vi.fn() },
    watchdogManagedOperation: { begin: vi.fn(), end: vi.fn() },
    channelError: (code, message, hint, docsUrl, extra) => ({
      ok: false, code, message, hint, docsUrl, ...extra,
    }),
    rootDir: "/unused", log: vi.fn(), budgetMs: 100,
  };
  return { state, lock, sink, ledger, recorder, options, isBusy: () => busy,
    run: () => createOpenclawUpdateRepair(options)({ operationId: kOperationId }) };
};

afterEach(() => vi.useRealTimers());

describe("dev repair ownership", () => {
  it.each([
    ["not_onboarded", (h) => { h.state.onboarded = false; }],
    ["self_update_in_progress", (h) => { h.state.selfUpdating = true; }],
    ["gateway_operation_in_progress", (h) => h.lock.tryAcquire("env_sync")],
    ["gateway_held", (h) => { h.state.channel.gatewayHold = { reason: "version_mismatch" }; }],
    ["gateway_hold_unreadable", (h) => { h.state.channel.stateCorrupted = true; }],
  ])("refuses %s before creating a run or starting a writer", async (code, configure) => {
    const h = makeHarness();
    const release = configure(h);
    try {
      expect(await h.run()).toMatchObject({ status: 409, body: { code } });
      expect(h.ledger.createRun).not.toHaveBeenCalled();
      expect(h.options.runner.runStreamed).not.toHaveBeenCalled();
      expect(h.isBusy()).toBe(false);
    } finally { if (typeof release === "function") await release(); }
  });

  it.each(["gateway_held", "self_update_in_progress", "not_onboarded"])(
    "rechecks %s after the queued acquisition", async (code) => {
      const h = makeHarness();
      h.options.acquireLifecycleLock = async (...args) => {
        const hold = await h.lock.acquire(...args);
        if (code === "gateway_held") h.state.channel.gatewayHold = { reason: "version_mismatch" };
        if (code === "self_update_in_progress") h.state.selfUpdating = true;
        if (code === "not_onboarded") h.state.onboarded = false;
        return hold;
      };
      expect(await h.run()).toMatchObject({ status: 409, body: { code } });
      expect(h.ledger.createRun).not.toHaveBeenCalled();
      expect(h.options.runner.runStreamed).not.toHaveBeenCalled();
      expect(h.lock.getActiveOperation()).toBeNull();
      expect(h.isBusy()).toBe(false);
    },
  );

  it("rechecks a hold that appears while recording the initial step", async () => {
    const h = makeHarness();
    h.recorder.emit.mockImplementation(() => {
      h.state.channel.gatewayHold = { reason: "config_migration_failed" };
    });
    expect(await h.run()).toMatchObject({ status: 409, body: { code: "gateway_held" } });
    expect(h.ledger.createRun).toHaveBeenCalledOnce();
    expect(h.ledger.completeRun).toHaveBeenCalledWith(kOperationId,
      expect.objectContaining({ state: "failed", result: expect.objectContaining({ code: "gateway_held" }) }));
    expect(h.options.runner.runStreamed).not.toHaveBeenCalled();
  });

  it("fails closed when the durable run cannot be created", async () => {
    const h = makeHarness();
    h.ledger.createRun.mockImplementation(() => { throw new Error("ENOSPC"); });
    expect(await h.run()).toMatchObject({ status: 503, body: { code: "run_ledger_unavailable" } });
    expect(h.options.runner.runStreamed).not.toHaveBeenCalled();
    expect(h.ledger.createLogSink).not.toHaveBeenCalled();
    expect(h.ledger.completeRun).not.toHaveBeenCalled();
    expect(h.lock.getActiveOperation()).toBeNull();
    expect(h.isBusy()).toBe(false);
  });

  it("retains mutation ownership until a cancelled writer has finished cleanup", async () => {
    vi.useFakeTimers();
    const h = makeHarness();
    let finishWriter;
    let signal;
    const writer = new Promise((resolve) => { finishWriter = resolve; });
    h.options.runner.runStreamed.mockImplementation(async (options) => {
      signal = options.signal;
      await writer;
      return { ok: true };
    });
    const running = h.run();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    expect(signal.aborted).toBe(true);
    expect(h.lock.getActiveOperation()).toMatchObject({ kind: "update_repair" });
    expect(h.isBusy()).toBe(true);
    expect(await h.run()).toMatchObject({ status: 409, body: { code: "operation_in_progress" } });
    expect(h.ledger.completeRun).not.toHaveBeenCalled();
    finishWriter();
    expect(await running).toMatchObject({ body: { code: "operation_timed_out" } });
    expect(h.lock.getActiveOperation()).toBeNull();
    expect(h.isBusy()).toBe(false);
    expect(h.options.operationEvents.complete).not.toHaveBeenCalled();
  });

  it("starts only after the durable record and completes in place after closing the sink", async () => {
    const h = makeHarness();
    h.options.runner.runStreamed.mockImplementation(async (options) => {
      expect(h.ledger.createRun).toHaveBeenCalledWith({
        operationId: kOperationId, target: { channel: "dev", repair: true },
      });
      expect(h.lock.getActiveOperation()).toMatchObject({ kind: "update_repair" });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(options.deadlineAt).toBeGreaterThan(Date.now());
      expect(options.env.OPENCLAW_SUPERVISOR_MODE).toBe("external");
      return { ok: true };
    });
    h.ledger.completeRun.mockImplementation(() => {
      expect(h.sink.close).toHaveBeenCalledOnce();
    });
    expect(await h.run()).toMatchObject({ status: 200, body: { ok: true } });
    expect(h.options.stepRecorder).toHaveBeenCalledWith(kOperationId, h.sink,
      { mirrorLastUpdateRun: false });
    expect(h.ledger.completeRun).toHaveBeenCalledWith(kOperationId,
      expect.objectContaining({ state: "completed", ok: true }));
  });
});

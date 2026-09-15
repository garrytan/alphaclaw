const { createWatchdog } = require("../../lib/server/watchdog");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");

describe("watchdog retained crash recovery", () => {
  let watchdog;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("WATCHDOG_AUTO_REPAIR", "false");
    vi.stubEnv("WATCHDOG_NOTIFICATIONS_DISABLED", "true");
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("gateway down"); }));
  });
  afterEach(() => {
    watchdog?.stop();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  const setup = (options = {}) => {
    const lock = createGatewayLifecycleLock();
    const launch = vi.fn(() => ({ pid: 4242 }));
    const events = vi.fn();
    watchdog = createWatchdog({
      gatewayLifecycleLock: lock,
      launchGatewayProcess: launch,
      clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
      insertWatchdogEvent: events,
      notifier: { notify: vi.fn(async () => ({ ok: true })) },
      readEnvFile: () => [], writeEnvFile: () => {}, reloadEnv: () => {},
      resolveSetupUrl: () => "https://setup.example.com",
      resolveGatewayHealthUrl: () => "http://127.0.0.1:18789/health",
      resolveGatewayReadyzUrl: () => "",
      supervisorModeActive: () => false,
      ...options,
    });
    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, generation: 1 });
    return { lock, launch, events };
  };
  const crash = () => watchdog.onGatewayExit({
    code: 1, expectedExit: false, pid: 100, generation: 1,
  });

  it("retains one relaunch through env_sync with Doctor auto-repair disabled", async () => {
    const { lock, launch, events } = setup();
    const release = lock.tryAcquire("env_sync");
    crash();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(launch).not.toHaveBeenCalled();
    expect(watchdog.getStatus()).toMatchObject({ autoRepair: false,
      recoveryPending: { source: "exit_event", reason: "lifecycle_operation_in_progress", retryCount: 5 } });
    const blocked = events.mock.calls.filter(([row]) => row.eventType === "restart" &&
      row.details?.reason === "lifecycle_operation_in_progress");
    expect(blocked).toHaveLength(1);
    release();
    await vi.advanceTimersByTimeAsync(16_000);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(watchdog.getStatus().recoveryPending).toBeNull();
  });

  it("maintenance begin/end without a launch does not supersede a crash", async () => {
    const { lock, launch } = setup();
    const release = lock.tryAcquire("env_sync");
    crash();
    await vi.advanceTimersByTimeAsync(0);
    watchdog.beginManagedOperation();
    watchdog.endManagedOperation();
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("managed crashes retain the ten-second relaunch when maintenance ends early", async () => {
    const { launch } = setup();
    watchdog.beginManagedOperation();
    crash();
    watchdog.endManagedOperation();
    await vi.advanceTimersByTimeAsync(9999);
    expect(launch).not.toHaveBeenCalled();
    expect(watchdog.getStatus().crashCountInWindow).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(watchdog.getStatus().crashCountInWindow).toBe(0);
  });

  it("a concurrent repair that fails without launching leaves crash recovery armed", async () => {
    let finishRepair;
    const repairRunner = vi.fn(() => new Promise((resolve) => { finishRepair = resolve; }));
    const { launch } = setup({ repairRunner });
    const repair = watchdog.triggerRepair();
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus().operationInProgress).toBe(true);
    crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus().recoveryPending.reason).toBe("operation_in_progress");
    finishRepair({ ok: false });
    await repair;
    await vi.advanceTimersByTimeAsync(1000);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("a failed expected restart defers recovery and its stopped status does not cancel it", async () => {
    const { lock, launch } = setup();
    const release = lock.tryAcquire("env_sync");
    crash();
    await vi.advanceTimersByTimeAsync(0);
    watchdog.onExpectedRestart();
    await vi.advanceTimersByTimeAsync(1000);
    expect(watchdog.getStatus().recoveryPending.reason).toBe("expected_restart");
    watchdog.onExpectedRestartSettled();
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus().lifecycle).toBe("stopped");
    release();
    await vi.advanceTimersByTimeAsync(2000);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it.each(["warming successor", "adopted successor", "explicit stop"])(
    "%s cancels a delayed relaunch", async (outcome) => {
      const { lock, launch } = setup();
      const release = lock.tryAcquire("env_sync");
      crash();
      await vi.advanceTimersByTimeAsync(0);
      if (outcome === "explicit stop") watchdog.stop();
      else watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 200, rootPid: 200,
        generation: outcome === "adopted successor" ? null : 2,
        supervision: outcome === "adopted successor" ? "adopted" : "managed" });
      release();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(launch).not.toHaveBeenCalled();
      expect(watchdog.getStatus().recoveryPending).toBeNull();
    },
  );

  it("a successor observed during prelaunch discovery prevents the stale spawn", async () => {
    let finishRead;
    const readStateDbVersions = vi.fn(() => new Promise((resolve) => { finishRead = resolve; }));
    const { launch } = setup({ readStateDbVersions });
    crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(readStateDbVersions).toHaveBeenCalledTimes(1);
    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 200, generation: 2 });
    finishRead(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(launch).not.toHaveBeenCalled();
    expect(watchdog.getStatus().recoveryPending).toBeNull();
  });

  it("a stale launch result cannot reset the successor's established readiness", async () => {
    let finishLaunch;
    const requestGatewayLaunch = vi.fn(() => new Promise((resolve) => { finishLaunch = resolve; }));
    setup({ requestGatewayLaunch });
    crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestGatewayLaunch).toHaveBeenCalledTimes(1);
    global.fetch.mockResolvedValue({ ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, status: "live" }) });
    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 200, generation: 2 });
    await vi.advanceTimersByTimeAsync(0);
    const readiness = watchdog.getStatus().readiness;
    finishLaunch({ outcome: "launch_requested", pid: 4242, generation: 1 });
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus()).toMatchObject({ servingRootPid: 200, readiness,
      recoveryPending: null });
  });

  it("conflict admission skips never consume the real-launch budget", async () => {
    const { lock, launch } = setup();
    const release = lock.tryAcquire("env_sync");
    watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1,
      launchedAt: Date.now() - 2000,
      stderrTail: ["state directory is locked by agent-embedded (pid 4321)"] });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 6; i += 1) {
      await watchdog.runHealthCheck({ source: "health_timer" });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(launch).not.toHaveBeenCalled();
    expect(watchdog.getStatus().lifecycle).not.toBe("crash_loop");
    release();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(watchdog.getStatus().crashCountInWindow).toBe(0);
  });
});

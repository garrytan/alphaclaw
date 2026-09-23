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
    const lock = options.gatewayLifecycleLock || createGatewayLifecycleLock();
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

  it("keeps backup transition suppression through launch and lets only its current owner settle it", async () => {
    setup({ resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz" });
    const first = watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000, retainUntilReady: true });
    watchdog.onGatewayLaunch({ pid: 200, generation: 2 });
    expect(watchdog.getStatus().expectedRestartUntil).not.toBeNull();
    const probe = vi.fn(async () => ({ status: 200, text: async () => JSON.stringify({ ok: true }) }));
    vi.stubGlobal("fetch", probe);
    await watchdog.runHealthCheck();
    expect(watchdog.getStatus().expectedRestartUntil).not.toBeNull();
    expect(probe.mock.calls.every(([url]) => !String(url).includes("readyz"))).toBe(true);
    const successor = watchdog.onExpectedRestart({ expiresAt: Date.now() + 90_000, retainUntilReady: true });
    const expected = watchdog.getStatus().expectedRestartUntil;
    watchdog.onExpectedRestartSettled();
    expect(watchdog.getStatus().expectedRestartUntil).toBe(expected);
    watchdog.onExpectedRestartSettled(first);
    expect(watchdog.getStatus().expectedRestartUntil).toBe(expected);
    watchdog.onExpectedRestartSettled(successor);
    expect(watchdog.getStatus().expectedRestartUntil).toBeNull();
  });

  it.each(["owned restart", "legacy restart", "new launch"])("a delayed settlement probe cannot demote a newer %s", async (successor) => {
    setup();
    await vi.advanceTimersByTimeAsync(0);
    const first = watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000, retainUntilReady: true });
    await vi.advanceTimersByTimeAsync(0);
    let rejectHealth;
    const fetch = vi.fn(() => new Promise((_, reject) => { rejectHealth = reject; }));
    vi.stubGlobal("fetch", fetch);
    watchdog.onExpectedRestartSettled(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    if (successor === "new launch") watchdog.onGatewayLaunch({ pid: 200, generation: 2 });
    else watchdog.onExpectedRestart({ expiresAt: Date.now() + 90_000, retainUntilReady: successor === "owned restart" });
    const before = watchdog.getStatus();

    rejectHealth(new Error("predecessor gateway down"));
    await vi.advanceTimersByTimeAsync(0);

    const after = watchdog.getStatus();
    expect(after.lifecycle).toBe(successor === "new launch" ? "running" : "restarting");
    expect(after.expectedRestartUntil).toBe(before.expectedRestartUntil);
    if (successor === "new launch") expect(after.health).toBe("unknown");
  });

  it("a stale settlement result cannot overwrite a newer completed health probe", async () => {
    setup();
    await vi.advanceTimersByTimeAsync(0);
    const owner = watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000, retainUntilReady: true });
    await vi.advanceTimersByTimeAsync(0);
    let rejectHealth;
    vi.stubGlobal("fetch", vi.fn()
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectHealth = reject; }))
      .mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) }));
    watchdog.onExpectedRestartSettled(owner);
    await watchdog.runHealthCheck();
    rejectHealth(new Error("older health result"));
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus()).toMatchObject({ lifecycle: "running", health: "healthy" });
  });

  it("reports a genuine replacement crash while a backup owns its expected transition", async () => {
    const { lock, launch } = setup();
    const hold = lock.tryAcquire("backup_quiesce");
    watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000, retainUntilReady: true });
    watchdog.onGatewayLaunch({ pid: 200, generation: 2 });
    watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 200, generation: 2 });
    expect(watchdog.getStatus().expectedRestartUntil).toBeNull();
    expect(watchdog.getStatus().crashCountInWindow).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(launch).not.toHaveBeenCalled();
    hold();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(launch).toHaveBeenCalledTimes(1);
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

  it.each([
    ["launch_failed", { outcome: "launch_failed", detail: "temporary spawn failure" }],
    ["launch_aborted", { outcome: "launch_aborted" }],
    ["prelaunch hook refusal", { outcome: "launch_aborted", detail: "prelaunch_hook" }],
    ["child_retained", { outcome: "child_retained", pid: 100 }],
    ["incumbent_unhealthy", { outcome: "incumbent_present", serving: { rootPid: 300 } }],
  ])("%s retains recovery until a later attempt actually launches", async (reason, first) => {
    const requestGatewayLaunch = vi.fn()
      .mockImplementationOnce(async () => {
        if (first.detail === "prelaunch_hook") watchdog.onPrelaunchHook({
          status: "refused", code: "hook_refused", site: "launch",
        });
        return first;
      })
      .mockResolvedValue({ outcome: "launch_requested", pid: 4242, generation: 2 });
    setup({ requestGatewayLaunch });
    crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(requestGatewayLaunch).toHaveBeenCalledTimes(1);
    expect(watchdog.getStatus().recoveryPending).toMatchObject({ retryCount: 1 });
    expect(watchdog.getStatus().crashCountInWindow).toBe(1);
    if (first.detail === "prelaunch_hook") {
      expect(watchdog.getStatus().prelaunchHook).toMatchObject({ status: "refused", code: "hook_refused" });
      expect(watchdog.getStatus().lifecycle).not.toBe("configuration_error");
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(requestGatewayLaunch).toHaveBeenCalledTimes(2);
    expect(watchdog.getStatus().recoveryPending).toBeNull();
    expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });
  });

  it("shutdown joins a timed-out writer that already entered retained cleanup", async () => {
    let finishWriter;
    const repairRunner = vi.fn(() => new Promise((resolve) => { finishWriter = resolve; }));
    const { lock, launch } = setup({ repairRunner });
    const repair = watchdog.triggerRepair();
    await vi.advanceTimersByTimeAsync(0);
    expect(repairRunner).toHaveBeenCalledTimes(1);
    try {
      await vi.advanceTimersByTimeAsync(10 * 60_000 + 15_001);
      expect(lock.getActiveOperation()).toMatchObject({ kind: "repair", phase: "cleanup_blocked" });
      let drained = false;
      const drain = watchdog.stop().then(() => { drained = true; });
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).toBe(false);
      finishWriter({ ok: true });
      await repair;
      await drain;
      expect(drained).toBe(true);
      expect(lock.getActiveOperation()).toBeNull();
      expect(launch).not.toHaveBeenCalled();
    } finally {
      finishWriter({ ok: true });
      await repair;
    }
  });

  it("verified recovery of a retained gateway cancels its pending relaunch", async () => {
    const requestGatewayLaunch = vi.fn(async () => ({ outcome: "child_retained", pid: 100 }));
    setup({ requestGatewayLaunch });
    crash();
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus().recoveryPending).toMatchObject({ reason: "child_retained" });
    global.fetch.mockResolvedValue({ ok: true, status: 200,
      text: async () => JSON.stringify({ ok: true, status: "live" }) });
    await watchdog.runHealthCheck({ source: "health_timer" });
    expect(watchdog.getStatus()).toMatchObject({ health: "healthy", recoveryPending: null });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(requestGatewayLaunch).toHaveBeenCalledTimes(1);
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
      // These are synthetic process identities. The adopted probe must not
      // consult whichever real process happens to own PID 200 on this host.
      const { lock, launch } = setup({ pidAlive: () => true, readProcStartTicks: () => null });
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

  it("a subsequently dead adopted successor creates a new recovery obligation", async () => {
    let successorAlive = true;
    const { lock, launch, events } = setup({
      pidAlive: () => successorAlive,
      readProcStartTicks: () => null,
    });
    const release = lock.tryAcquire("env_sync");
    crash();
    await vi.advanceTimersByTimeAsync(0);
    const previous = watchdog.getStatus().recoveryPending;
    expect(previous).toMatchObject({ source: "exit_event" });
    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 200, rootPid: 200,
      generation: null, supervision: "adopted" });
    expect(watchdog.getStatus().recoveryPending).toBeNull();
    release();

    successorAlive = false;
    await vi.advanceTimersByTimeAsync(31_000);
    const next = watchdog.getStatus().recoveryPending;
    expect(next).toMatchObject({ source: "probe_death" });
    expect(next.correlationId).not.toBe(previous.correlationId);
    expect(launch).not.toHaveBeenCalled();
    expect(events).toHaveBeenCalledWith(expect.objectContaining({ eventType: "crash",
      source: "probe_death", details: expect.objectContaining({ pid: 200, reason: "process_gone" }) }));
    await vi.advanceTimersByTimeAsync(3000);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(watchdog.getStatus().recoveryPending).toBeNull();
  });

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

  it.each(["readStateDbVersions", "assessLaunchCompatibility"])(
    "a hung %s read cannot pin crash admission forever", async (seam) => {
      let finishRead;
      const read = vi.fn()
        .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }))
        .mockResolvedValue(null);
      const { launch } = setup({ [seam]: read });
      crash();
      await vi.advanceTimersByTimeAsync(0);
      expect(read).toHaveBeenCalledTimes(1);
      try {
        // A local discovery read is bounded independently of the much longer
        // restart lease; its ignored abort must release dispatch admission.
        await vi.advanceTimersByTimeAsync(61_000);
        expect(launch).toHaveBeenCalledTimes(1);
        expect(watchdog.getStatus().recoveryPending).toBeNull();
        expect(watchdog.getStatus().operationInProgress).toBe(false);
      } finally {
        finishRead(null);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(launch).toHaveBeenCalledTimes(1);
    },
  );

  it("a discovery read cannot outlive a shorter lifecycle lease", async () => {
    let finishRead;
    const readStateDbVersions = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishRead = resolve; }))
      .mockResolvedValue(null);
    const lock = createGatewayLifecycleLock({ leaseMs: 50, logger: { warn() {} } });
    const { launch } = setup({ readStateDbVersions, gatewayLifecycleLock: lock });
    crash();
    await vi.advanceTimersByTimeAsync(0);
    try {
      await vi.advanceTimersByTimeAsync(51);
      expect(watchdog.getStatus().recoveryPending).toMatchObject({ reason: "lease_expired", retryCount: 1 });
      expect(watchdog.getStatus().operationInProgress).toBe(false);
      expect(lock.getActiveOperation()).toBeNull();
      await vi.advanceTimersByTimeAsync(1000);
      expect(launch).toHaveBeenCalledTimes(1);
    } finally {
      finishRead(null);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "successor"])("%s immediately detaches ignored-abort discovery", async (action) => {
    let finishRead;
    const readStateDbVersions = vi.fn(() => new Promise((resolve) => { finishRead = resolve; }));
    const { lock, launch } = setup({ readStateDbVersions });
    crash();
    await vi.advanceTimersByTimeAsync(0);
    try {
      if (action === "stop") await watchdog.stop();
      else watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 200, generation: 2 });
      await vi.advanceTimersByTimeAsync(0);
      expect(watchdog.getStatus().recoveryPending).toBeNull();
      expect(watchdog.getStatus().operationInProgress).toBe(false);
      expect(lock.getActiveOperation()).toBeNull();
      expect(launch).not.toHaveBeenCalled();
    } finally {
      finishRead(null);
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(launch).not.toHaveBeenCalled();
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

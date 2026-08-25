const { createWatchdog } = require("../../lib/server/watchdog");
const {
  kOpenclawDegradedRollbackMs,
} = require("../../lib/server/constants");

const flushMicrotasks = async () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
const kOriginalNotificationsDisabled = process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
const kOriginalFetch = global.fetch;

const createReleaseChannelHooks = ({
  isPin = false,
  inStabilizationWindow = true,
} = {}) => ({
  getInfo: vi.fn(() => ({ isPin, inStabilizationWindow })),
  requestRollback: vi.fn(() => ({ ok: true })),
  onHealthy: vi.fn(),
  onUnhealthy: vi.fn(),
});

const createHarness = ({
  autoRepair = true,
  notificationsDisabled = false,
  clawCmdImpl,
  resolveSetupUrl = () => "https://setup.example.com",
  resolveGatewayHealthUrl = () => "http://127.0.0.1:18789/health",
  resolveGatewayReadyzUrl = () => "",
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, status: "live" }),
  }),
  releaseChannelHooks = undefined,
} = {}) => {
  process.env.WATCHDOG_AUTO_REPAIR = autoRepair ? "true" : "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = notificationsDisabled ? "true" : "false";

  const insertWatchdogEvent = vi.fn();
  const clawCmd = vi.fn(
    clawCmdImpl ||
      (async () => ({
        ok: true,
        stdout: JSON.stringify({ ok: true }),
      })),
  );
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const launchGatewayProcess = vi.fn(() => ({ pid: 4242 }));
  const readEnvFile = vi.fn(() => []);
  const writeEnvFile = vi.fn();
  const reloadEnv = vi.fn();
  global.fetch = vi.fn(fetchImpl);

  const watchdog = createWatchdog({
    clawCmd,
    launchGatewayProcess,
    insertWatchdogEvent,
    notifier,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    resolveSetupUrl,
    resolveGatewayHealthUrl,
    resolveGatewayReadyzUrl,
    ...(releaseChannelHooks !== undefined ? { releaseChannelHooks } : {}),
  });

  return {
    watchdog,
    insertWatchdogEvent,
    clawCmd,
    notifier,
    launchGatewayProcess,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    releaseChannelHooks,
  };
};

const crashLoopNotices = (notifier) =>
  notifier.notify.mock.calls.filter((call) =>
    String(call?.[0] || "").includes("Crash loop detected"),
  );

describe("server/watchdog release-channel rollback hooks", () => {
  afterEach(() => {
    if (kOriginalAutoRepair == null) {
      delete process.env.WATCHDOG_AUTO_REPAIR;
    } else {
      process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
    }
    if (kOriginalNotificationsDisabled == null) {
      delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    } else {
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED = kOriginalNotificationsDisabled;
    }
    if (kOriginalFetch == null) {
      delete global.fetch;
    } else {
      global.fetch = kOriginalFetch;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("requests a channel rollback once for a crash loop inside the stabilization window", async () => {
    const hooks = createReleaseChannelHooks({
      isPin: false,
      inStabilizationWindow: true,
    });
    const { watchdog, notifier } = createHarness({
      autoRepair: false,
      releaseChannelHooks: hooks,
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(hooks.requestRollback).toHaveBeenCalledTimes(1);
    expect(hooks.requestRollback).toHaveBeenCalledWith({
      reason: "crash_loop",
      exitCode: 1,
    });
    expect(crashLoopNotices(notifier)).toHaveLength(0);
  });

  it("keeps legacy crash-loop behavior outside the stabilization window", async () => {
    const hooks = createReleaseChannelHooks({
      isPin: false,
      inStabilizationWindow: false,
    });
    const { watchdog, notifier, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      releaseChannelHooks: hooks,
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(hooks.requestRollback).not.toHaveBeenCalled();
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "crash_loop",
        health: "unhealthy",
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "crash_loop",
        source: "exit_event",
        status: "failed",
      }),
    );
    const notices = crashLoopNotices(notifier);
    expect(notices).toHaveLength(1);
    expect(String(notices[0][0])).toContain(
      "Auto-restart paused; manual action required.",
    );
  });

  it("routes exit-78 to rollback in-window on non-pin, otherwise latches [REG]", async () => {
    // In-window, non-pin: rollback instead of latching.
    const inWindowHooks = createReleaseChannelHooks({
      isPin: false,
      inStabilizationWindow: true,
    });
    const inWindow = createHarness({
      autoRepair: false,
      releaseChannelHooks: inWindowHooks,
    });
    inWindow.watchdog.onGatewayExit({ code: 78, expectedExit: false });
    await flushMicrotasks();
    expect(inWindowHooks.requestRollback).toHaveBeenCalledWith({
      reason: "config_error",
      exitCode: 78,
    });
    // configurationErrorActive stays false: lifecycle is "crashed", not latched.
    expect(inWindow.watchdog.getStatus()).toEqual(
      expect.objectContaining({ lifecycle: "crashed", health: "unhealthy" }),
    );

    // Out of window: legacy configuration_error latch, no rollback.
    const outHooks = createReleaseChannelHooks({
      isPin: false,
      inStabilizationWindow: false,
    });
    const out = createHarness({
      autoRepair: false,
      releaseChannelHooks: outHooks,
    });
    out.watchdog.onGatewayExit({ code: 78, expectedExit: false });
    await flushMicrotasks();
    expect(outHooks.requestRollback).not.toHaveBeenCalled();
    expect(out.watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "configuration_error",
        health: "unhealthy",
      }),
    );
    expect(out.insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config_error",
        source: "exit_event",
        status: "failed",
        details: expect.objectContaining({ code: 78 }),
      }),
    );
    expect(
      out.notifier.notify.mock.calls.some((call) =>
        String(call?.[0] || "").includes("Gateway configuration invalid"),
      ),
    ).toBe(true);

    // Pin builds always latch, even inside the stabilization window.
    const pinHooks = createReleaseChannelHooks({
      isPin: true,
      inStabilizationWindow: true,
    });
    const pin = createHarness({
      autoRepair: false,
      releaseChannelHooks: pinHooks,
    });
    pin.watchdog.onGatewayExit({ code: 78, expectedExit: false });
    await flushMicrotasks();
    expect(pinHooks.requestRollback).not.toHaveBeenCalled();
    expect(pin.watchdog.getStatus().lifecycle).toBe("configuration_error");
  });

  it("suspends crash accounting during a managed operation", async () => {
    const hooks = createReleaseChannelHooks({
      isPin: false,
      inStabilizationWindow: true,
    });
    const { watchdog } = createHarness({
      autoRepair: false,
      releaseChannelHooks: hooks,
    });

    watchdog.beginManagedOperation();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(watchdog.getStatus().crashCountInWindow).toBe(0);
    expect(watchdog.getStatus().lifecycle).toBe("restarting");
    expect(hooks.requestRollback).not.toHaveBeenCalled();

    watchdog.endManagedOperation();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(watchdog.getStatus().crashCountInWindow).toBe(1);
    expect(watchdog.getStatus().lifecycle).toBe("crashed");
  });

  it("escalates a long degraded state to rollback and suppresses auto-repair in-window [REG]", async () => {
    vi.useFakeTimers();
    const hooks = createReleaseChannelHooks({
      isPin: false,
      inStabilizationWindow: true,
    });
    const { watchdog, clawCmd } = createHarness({
      autoRepair: true,
      releaseChannelHooks: hooks,
      fetchImpl: async () => {
        throw new Error("gateway down");
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    // Three consecutive startup failures (t=0/5s/10s) flip health to degraded.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watchdog.getStatus().health).toBe("degraded");
    expect(hooks.requestRollback).not.toHaveBeenCalled();

    // Below the escalation threshold: still no rollback and no doctor run.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hooks.requestRollback).not.toHaveBeenCalled();
    expect(clawCmd).not.toHaveBeenCalledWith("doctor --fix --yes", {
      quiet: true,
    });

    await vi.advanceTimersByTimeAsync(kOpenclawDegradedRollbackMs);
    expect(hooks.requestRollback).toHaveBeenCalledWith({
      reason: "degraded",
      exitCode: null,
    });
    // Even with auto-repair enabled, an in-window non-pin build must never get
    // an unattended `doctor --fix`.
    expect(clawCmd).not.toHaveBeenCalledWith("doctor --fix --yes", {
      quiet: true,
    });
    watchdog.stop();
  });

  it("requests a degraded rollback exactly once across subsequent failing health ticks", async () => {
    vi.useFakeTimers();
    const hooks = createReleaseChannelHooks({
      isPin: false,
      inStabilizationWindow: true,
    });
    const { watchdog } = createHarness({
      autoRepair: false,
      releaseChannelHooks: hooks,
      fetchImpl: async () => {
        throw new Error("gateway down");
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watchdog.getStatus().health).toBe("degraded");

    await vi.advanceTimersByTimeAsync(kOpenclawDegradedRollbackMs);
    expect(hooks.requestRollback).toHaveBeenCalledTimes(1);
    expect(hooks.requestRollback).toHaveBeenCalledWith({
      reason: "degraded",
      exitCode: null,
    });

    // Health keeps failing every degraded tick, but the one-shot latch must
    // not re-request (duplicate markers + notifications) while the 1s-delayed
    // restart is landing.
    await vi.advanceTimersByTimeAsync(3 * kOpenclawDegradedRollbackMs);
    expect(hooks.requestRollback).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it("falls through to the legacy EX_CONFIG latch when rollback reports nothing to roll back", async () => {
    const hooks = createReleaseChannelHooks({
      isPin: false,
      inStabilizationWindow: true,
    });
    // A state race (e.g. already back on the pin) is a non-ok result that is
    // NOT rollback_marker_write_failed: the watchdog must not leave the
    // gateway "crashed" with nothing scheduled.
    hooks.requestRollback = vi.fn(() => ({
      ok: false,
      code: "nothing_to_roll_back",
    }));
    const { watchdog, insertWatchdogEvent, notifier } = createHarness({
      autoRepair: false,
      releaseChannelHooks: hooks,
    });

    watchdog.onGatewayExit({ code: 78, expectedExit: false });
    await flushMicrotasks();

    expect(hooks.requestRollback).toHaveBeenCalledWith({
      reason: "config_error",
      exitCode: 78,
    });
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "configuration_error",
        health: "unhealthy",
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config_error",
        source: "exit_event",
        status: "failed",
        details: expect.objectContaining({ code: 78 }),
      }),
    );
    expect(
      notifier.notify.mock.calls.some((call) =>
        String(call?.[0] || "").includes("Gateway configuration invalid"),
      ),
    ).toBe(true);
  });

  it("keeps legacy degraded auto-repair when out of the stabilization window [REG]", async () => {
    vi.useFakeTimers();
    const hooks = createReleaseChannelHooks({
      isPin: false,
      inStabilizationWindow: false,
    });
    const { watchdog, clawCmd } = createHarness({
      autoRepair: true,
      releaseChannelHooks: hooks,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") return { ok: true, stdout: "fixed" };
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("gateway down");
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(clawCmd).toHaveBeenCalledWith("doctor --fix --yes", { quiet: true });
    expect(hooks.requestRollback).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("latchManualIntervention pauses health-check recovery", async () => {
    vi.useFakeTimers();
    const hooks = createReleaseChannelHooks();
    const { watchdog } = createHarness({
      autoRepair: false,
      releaseChannelHooks: hooks,
    });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus().health).toBe("healthy");

    watchdog.latchManualIntervention();
    expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
    expect(watchdog.getStatus().health).toBe("unhealthy");

    // Health checks short-circuit while latched: even a healthy gateway probe
    // must not clear the latch.
    await vi.advanceTimersByTimeAsync(240_000);
    expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
    expect(watchdog.getStatus().health).toBe("unhealthy");
    watchdog.stop();
  });

  it("[REG] triggers auto-repair in crash-loop mode when hooks are omitted", async () => {
    const { watchdog, clawCmd } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") return { ok: true, stdout: "fixed" };
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("still unhealthy");
      },
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(clawCmd).toHaveBeenCalledWith("doctor --fix --yes", { quiet: true });
  });

  it("[REG] treats exit code 78 as a fatal config error when hooks are omitted", async () => {
    const { watchdog, insertWatchdogEvent, notifier, launchGatewayProcess, clawCmd } =
      createHarness({
        autoRepair: false,
        fetchImpl: async () => {
          throw new Error("gateway unavailable");
        },
      });

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: ["invalid config"] });
    watchdog.onGatewayExit({ code: 78, expectedExit: false });
    watchdog.onGatewayExit({ code: 78, expectedExit: false });
    await flushMicrotasks();

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "configuration_error",
        health: "unhealthy",
        crashCountInWindow: 0,
      }),
    );
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    expect(clawCmd).not.toHaveBeenCalledWith("doctor --fix --yes", { quiet: true });
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config_error",
        source: "exit_event",
        status: "failed",
        details: expect.objectContaining({ code: 78 }),
      }),
    );
    expect(
      notifier.notify.mock.calls.some(
        (call) =>
          String(call?.[0] || "").includes("Gateway configuration invalid") &&
          String(call?.[0] || "").includes("automatic restart is paused"),
      ),
    ).toBe(true);
  });
});

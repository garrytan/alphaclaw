const { createWatchdog } = require("../../lib/server/watchdog");
const {
  kGatewayTcpWatchIntervalMs,
  kWatchdogConnectedHealthCadenceMs,
  kGatewayTcpTransitionDebounceMs,
} = require("../../lib/server/constants");

const flushMicrotasks = async () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
const kOriginalNotificationsDisabled = process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
const kOriginalFetch = global.fetch;

// Exact stderr the beta step-aside path emits (openclaw@2026.8.1-beta.3
// dist, SupervisedGatewayLockError propagated through "Gateway failed to
// start: ..." — see isHealthyIncumbentStepAsideExit in lib/server/watchdog.js).
const kStepAsideStderrTail = [
  "Gateway failed to start: gateway already running under systemd; existing gateway is healthy, exiting with code 78 to prevent a systemd Restart=always loop",
  "If the gateway is supervised, stop it with: openclaw gateway stop",
];

const createHarness = ({
  autoRepair = true,
  notificationsDisabled = false,
  gatewayLifecycleLock = null,
  probeGatewayTcp = null,
  clawCmdImpl,
  resolveSetupUrl = () => "https://setup.example.com",
  resolveGatewayHealthUrl = () => "http://127.0.0.1:18789/health",
  resolveGatewayReadyzUrl = () => "",
  fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, status: "live" }),
  }),
  supervisorModeActive,
  consumeRestartHandoffImpl,
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
    probeGatewayTcp,
    gatewayLifecycleLock,
    insertWatchdogEvent,
    notifier,
    readEnvFile,
    writeEnvFile,
    reloadEnv,
    resolveSetupUrl,
    resolveGatewayHealthUrl,
    resolveGatewayReadyzUrl,
    // Crash-restart backoff resolves instantly in tests; backoff timing has
    // its own dedicated fake-timer coverage.
    sleepImpl: () => Promise.resolve(),
    // Handoff gate: the REAL default (gateway.isSupervisorModeActive) is now
    // OPEN unless escape-hatched (supervisor mode defaults on), which would
    // route every unexpected clean exit in this suite through the consume
    // path. Keep the hermetic default CLOSED; handoff tests inject their own
    // gate, and the default-gate resolution is unit-tested in gateway.test.js.
    supervisorModeActive: supervisorModeActive ?? (() => false),
    ...(consumeRestartHandoffImpl ? { consumeRestartHandoffImpl } : {}),
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
  };
};

describe("server/watchdog", () => {
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

  it("logs startup-grace health failures as skipped ok events", async () => {
    const { watchdog, insertWatchdogEvent } = createHarness({
      clawCmdImpl: async (command) => {
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("gateway unavailable");
      },
    });

    watchdog.start();
    await flushMicrotasks();

    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "ok",
        details: expect.objectContaining({
          skipped: true,
          startupGraceActive: true,
        }),
      }),
    );
    watchdog.stop();
  });

  it("retries startup health checks before marking degraded", async () => {
    vi.useFakeTimers();
    let healthChecks = 0;
    const { watchdog, clawCmd, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      clawCmdImpl: async (command) => {
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        healthChecks += 1;
        if (healthChecks === 1) {
          throw new Error("gateway unavailable");
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus().health).toBe("unknown");

    await vi.advanceTimersByTimeAsync(5_000);

    expect(clawCmd).not.toHaveBeenCalledWith(
      "doctor --fix --yes",
      expect.objectContaining({ quiet: true }),
    );
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "healthy",
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "ok",
        details: expect.objectContaining({
          skipped: true,
          startupFailureRetryActive: true,
          startupConsecutiveFailures: 1,
          startupFailureThreshold: 3,
        }),
      }),
    );
    watchdog.stop();
  });

  it("uses 5s degraded retries to recover before regular interval", async () => {
    vi.useFakeTimers();
    let healthChecks = 0;
    const { watchdog } = createHarness({
      autoRepair: false,
      clawCmdImpl: async () => {
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        healthChecks += 1;
        if (healthChecks <= 3) {
          throw new Error("temporarily unavailable");
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(watchdog.getStatus().health).toBe("degraded");
    expect(healthChecks).toBe(3);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(healthChecks).toBe(4);
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "healthy",
      }),
    );
    watchdog.stop();
  });

  it("triggers auto-repair in crash-loop mode when enabled", async () => {
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
    // Real crash exits arrive on separate event-loop turns; crash 1's async
    // relaunch must settle (releasing operationInProgress) before the later
    // crashes, or the crash-loop repair would be skipped as "in progress".
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(clawCmd).toHaveBeenCalledWith(
      "doctor --fix --yes",
      expect.objectContaining({ quiet: true, timeoutMs: 600000 }),
    );
  });

  it("retries a crash-loop repair skipped by an in-flight relaunch until the operation settles", async () => {
    vi.useFakeTimers();
    let releaseLaunch;
    const launchGate = new Promise((resolve) => {
      releaseLaunch = resolve;
    });
    const { watchdog, clawCmd, launchGatewayProcess } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") return { ok: true, stdout: "fixed" };
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("still unhealthy");
      },
    });
    try {
      // Crash 1's relaunch parks on this gate, holding operationInProgress.
      launchGatewayProcess.mockImplementation(() => launchGate);

      watchdog.onGatewayExit({ code: 1, expectedExit: false });
      await vi.advanceTimersByTimeAsync(0); // relaunch reaches the launch await
      watchdog.onGatewayExit({ code: 1, expectedExit: false });
      watchdog.onGatewayExit({ code: 1, expectedExit: false }); // crash loop
      await vi.advanceTimersByTimeAsync(0);

      // Initial crash-loop repair was skipped (operation_in_progress) and the
      // retry cadence is running; still skipped while the relaunch is parked.
      const doctorCalls = () =>
        clawCmd.mock.calls.filter((call) => call[0] === "doctor --fix --yes").length;
      await vi.advanceTimersByTimeAsync(2000);
      expect(doctorCalls()).toBe(0);

      // Relaunch settles → operationInProgress releases → next retry repairs.
      releaseLaunch({ pid: 4242 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(doctorCalls()).toBe(1);
    } finally {
      watchdog.stop();
      vi.useRealTimers();
    }
  });

  it("stops crash-loop repair retries after the bounded attempt count", async () => {
    vi.useFakeTimers();
    const launchGate = new Promise(() => {}); // never settles
    const { watchdog, clawCmd, launchGatewayProcess } = createHarness({
      autoRepair: true,
      fetchImpl: async () => {
        throw new Error("still unhealthy");
      },
    });
    try {
      launchGatewayProcess.mockImplementation(() => launchGate);

      watchdog.onGatewayExit({ code: 1, expectedExit: false });
      await vi.advanceTimersByTimeAsync(0);
      watchdog.onGatewayExit({ code: 1, expectedExit: false });
      watchdog.onGatewayExit({ code: 1, expectedExit: false });
      await vi.advanceTimersByTimeAsync(0);

      // 5 bounded retries all skip while the operation never settles; the
      // chain must then STOP — no repair attempts fire on later ticks even
      // though the doctor command would now be reachable.
      const doctorCalls = () =>
        clawCmd.mock.calls.filter((call) => call[0] === "doctor --fix --yes").length;
      for (let i = 0; i < 7; i += 1) {
        await vi.advanceTimersByTimeAsync(2000);
      }
      expect(doctorCalls()).toBe(0);
      await vi.advanceTimersByTimeAsync(20000);
      expect(doctorCalls()).toBe(0);
    } finally {
      watchdog.stop();
      vi.useRealTimers();
    }
  });

  it("clears crash-loop lifecycle after a healthy check recovery", async () => {
    vi.useFakeTimers();
    let healthChecks = 0;
    const { watchdog, insertWatchdogEvent, notifier } = createHarness({
      autoRepair: false,
      clawCmdImpl: async (command) => {
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        healthChecks += 1;
        if (healthChecks === 1) {
          throw new Error("gateway unavailable");
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.advanceTimersByTimeAsync(0);
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.advanceTimersByTimeAsync(0);
    watchdog.onGatewayExit({ code: 1, expectedExit: false });

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "crash_loop",
        health: "unhealthy",
      }),
    );

    await vi.advanceTimersByTimeAsync(120_000);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "healthy",
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "recovery",
        source: "health_timer",
        status: "ok",
        details: expect.objectContaining({
          previousLifecycle: "crash_loop",
          health: "healthy",
        }),
      }),
    );
    expect(
      notifier.notify.mock.calls.some((call) =>
        String(call?.[0] || "").includes("🟢 Gateway running again"),
      ),
    ).toBe(true);
    watchdog.stop();
  });

  it("suppresses notifier sends when notifications are disabled", async () => {
    const { watchdog, notifier } = createHarness({
      notificationsDisabled: true,
      autoRepair: false,
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(notifier.notify).not.toHaveBeenCalled();
  });

  it("suppresses failed health checks during expected restart window", async () => {
    const { watchdog, clawCmd, insertWatchdogEvent } = createHarness({
      autoRepair: true,
      clawCmdImpl: async () => {
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("gateway restarting");
      },
    });

    watchdog.onExpectedRestart();
    await flushMicrotasks();

    expect(clawCmd).not.toHaveBeenCalledWith(
      "doctor --fix --yes",
      expect.objectContaining({ quiet: true }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "ok",
        details: expect.objectContaining({
          skipped: true,
          expectedRestartActive: true,
        }),
      }),
    );
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "restarting",
        health: "unknown",
      }),
    );
  });

  it("treats non-zero expected exits as crashes", () => {
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
    });

    watchdog.onGatewayExit({
      code: 1,
      signal: null,
      expectedExit: true,
      stderrTail: ["gateway failed"],
    });

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "crashed",
        health: "unhealthy",
        crashCountInWindow: 1,
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "crash",
        source: "exit_event",
        status: "failed",
        details: expect.objectContaining({
          code: 1,
          signal: null,
          stderrTail: ["gateway failed"],
        }),
      }),
    );
  });

  it("ignores duplicate-launch port-in-use exits", () => {
    const { watchdog, insertWatchdogEvent, launchGatewayProcess } = createHarness({
      autoRepair: true,
    });

    watchdog.onGatewayExit({
      code: 1,
      signal: null,
      expectedExit: false,
      stderrTail: [
        "Gateway failed to start: another gateway instance is already listening on ws://127.0.0.1:18789",
        "Port 18789 is already in use.",
      ],
    });

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "unknown",
        crashCountInWindow: 0,
      }),
    );
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "exit_event",
        status: "ok",
        details: expect.objectContaining({
          duplicateLaunch: true,
          code: 1,
        }),
      }),
    );
  });

  it("stops suppressing failures after the expected restart timeout", async () => {
    vi.useFakeTimers();
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      clawCmdImpl: async () => {
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("gateway restarting");
      },
    });

    watchdog.onExpectedRestart();
    // Advance past the expected-restart suppression window (widened to 50s for the
    // beta control-plane restart cooldown).
    await vi.advanceTimersByTimeAsync(55_000);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        health: "degraded",
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "failed",
        details: expect.objectContaining({
          reason: "gateway restarting",
        }),
      }),
    );
  });

  it("sends gateway healthy again after deferred auto-repair recovery", async () => {
    let healthChecks = 0;
    const { watchdog, notifier } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") return { ok: true, stdout: "fixed" };
        return { ok: true, stdout: "" };
      },
      // Probe order: crash-1 resync (#1), crash-2 resync (#2), the repair's
      // own verify (#3) and its operation-end resync (#4) — all while the
      // gateway is still coming up. Only the launch-triggered probe (#5)
      // finds it healthy, which is what makes the recovery "deferred".
      fetchImpl: async () => {
        healthChecks += 1;
        if (healthChecks <= 4) {
          throw new Error("not healthy yet");
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    // Space crash 1 from the rest: its async relaunch must release
    // operationInProgress before the crash loop opens, as real exits do.
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();

    watchdog.onGatewayLaunch({ startedAt: Date.now() });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(
      notifier.notify.mock.calls.some((call) =>
        String(call?.[0] || "").includes("🟢 Gateway running again"),
      ),
    ).toBe(true);
    // Recovery copy names the resolving action so the alert thread closes.
    expect(
      notifier.notify.mock.calls.some((call) =>
        String(call?.[0] || "").includes("Recovered after automatic repair."),
      ),
    ).toBe(true);
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "healthy",
      }),
    );
  });

  it("does not repeat auto-repair or notifications while recovery is still pending", async () => {
    vi.useFakeTimers();
    let healthChecks = 0;
    const { watchdog, clawCmd, notifier } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") {
          return { ok: true, stdout: "fixed" };
        }
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        healthChecks += 1;
        throw new Error("still unhealthy");
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(clawCmd).toHaveBeenCalledTimes(1);
    expect(clawCmd).toHaveBeenCalledWith(
      "doctor --fix --yes",
      expect.objectContaining({ quiet: true, timeoutMs: 600000 }),
    );
    expect(
      notifier.notify.mock.calls.filter((call) =>
        String(call?.[0] || "").includes("awaiting health check"),
      ),
    ).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(120_000);

    expect(healthChecks).toBeGreaterThan(3);
    expect(clawCmd).toHaveBeenCalledTimes(1);
    expect(
      notifier.notify.mock.calls.filter((call) =>
        String(call?.[0] || "").includes("awaiting health check"),
      ),
    ).toHaveLength(1);
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        health: "degraded",
      }),
    );
  });

  it("does not set uptimeStartedAt on start — waits for onGatewayLaunch", () => {
    const { watchdog } = createHarness();

    watchdog.start();

    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBe(0);
    watchdog.stop();
  });

  it("sets uptimeStartedAt when onGatewayLaunch fires", () => {
    const { watchdog } = createHarness();

    watchdog.start();
    const before = Date.now();
    watchdog.onGatewayLaunch({ startedAt: before, pid: 1234 });

    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBeGreaterThanOrEqual(0);
    watchdog.stop();
  });

  it("clears uptimeStartedAt on gateway crash", () => {
    const { watchdog } = createHarness({ autoRepair: false });

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();

    watchdog.onGatewayExit({ code: 1, expectedExit: false });

    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBe(0);
  });

  it("pauses recovery when OpenClaw exits with EX_CONFIG", async () => {
    const { watchdog, clawCmd, launchGatewayProcess, notifier } = createHarness({
      autoRepair: true,
    });

    watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: ["Invalid config"],
    });
    await flushMicrotasks();

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "configuration_error",
        health: "unhealthy",
        crashCountInWindow: 0,
      }),
    );
    expect(clawCmd).not.toHaveBeenCalled();
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    expect(
      notifier.notify.mock.calls.some((call) =>
        String(call?.[0] || "").includes("Gateway configuration error"),
      ),
    ).toBe(true);
  });

  it("latches EX_CONFIG across in-flight and periodic health checks", async () => {
    vi.useFakeTimers();
    let resolveHealthCheck;
    const healthCheck = new Promise((resolve) => {
      resolveHealthCheck = resolve;
    });
    const { watchdog, clawCmd, launchGatewayProcess } = createHarness({
      autoRepair: true,
      fetchImpl: async () => healthCheck,
    });

    watchdog.onGatewayLaunch({
      startedAt: Date.now() - 60_000,
      pid: 1234,
    });
    await vi.advanceTimersByTimeAsync(0);

    watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: ["Invalid config"],
    });
    resolveHealthCheck({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, status: "live" }),
    });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "configuration_error",
        health: "unhealthy",
      }),
    );
    expect(clawCmd).not.toHaveBeenCalled();
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("clears uptimeStartedAt on expected restart", () => {
    const { watchdog } = createHarness();

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();

    watchdog.onExpectedRestart();

    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBe(0);
  });

  it("clears uptimeStartedAt on expected exit", () => {
    const { watchdog } = createHarness();

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();

    watchdog.onGatewayExit({ code: 0, expectedExit: true });

    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBe(0);
  });

  it("preserves uptimeStartedAt on duplicate-launch exit", () => {
    const { watchdog } = createHarness();

    const startedAt = Date.now() - 5000;
    watchdog.onGatewayLaunch({ startedAt, pid: 1234 });

    watchdog.onGatewayExit({
      code: 1,
      signal: null,
      expectedExit: false,
      stderrTail: ["another gateway instance is already listening"],
    });

    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBeGreaterThan(0);
  });

  it("clears uptimeStartedAt on stop", () => {
    const { watchdog } = createHarness();

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();

    watchdog.stop();

    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBe(0);
  });

  it("restores uptimeStartedAt after crash recovery via onGatewayLaunch", async () => {
    const { watchdog } = createHarness({ autoRepair: false });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 10_000, pid: 1234 });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    expect(watchdog.getStatus().uptimeStartedAt).toBeNull();

    const newStart = Date.now();
    watchdog.onGatewayLaunch({ startedAt: newStart, pid: 5678 });

    expect(watchdog.getStatus().uptimeStartedAt).not.toBeNull();
    expect(watchdog.getStatus().uptimeMs).toBeGreaterThanOrEqual(0);
    watchdog.stop();
  });

  it("writes settings changes to env and updates in-memory status", () => {
    const { watchdog, readEnvFile, writeEnvFile, reloadEnv } = createHarness({
      autoRepair: false,
      notificationsDisabled: false,
    });
    readEnvFile.mockReturnValue([{ key: "OPENAI_API_KEY", value: "x" }]);
    reloadEnv.mockImplementation(() => {
      process.env.WATCHDOG_AUTO_REPAIR = "true";
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "true";
    });

    const settings = watchdog.updateSettings({
      autoRepair: true,
      notificationsEnabled: false,
    });

    expect(writeEnvFile).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ key: "WATCHDOG_AUTO_REPAIR", value: "true" }),
        expect.objectContaining({
          key: "WATCHDOG_NOTIFICATIONS_DISABLED",
          value: "true",
        }),
      ]),
    );
    expect(reloadEnv).toHaveBeenCalledTimes(1);
    expect(settings).toEqual({
      autoRepair: true,
      notificationsEnabled: false,
    });
  });

  it("treats exit code 78 as a fatal config error without crash-loop restarts", async () => {
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
    expect(clawCmd).not.toHaveBeenCalledWith(
      "doctor --fix --yes",
      expect.objectContaining({ quiet: true }),
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
      notifier.notify.mock.calls.some(
        (call) =>
          String(call?.[0] || "").includes("Gateway configuration error") &&
          String(call?.[0] || "").includes("automatic gateway restart is paused"),
      ),
    ).toBe(true);
  });

  it("does not auto-repair on configuration errors; forced repair clears the latch", async () => {
    const doctorCalls = [];
    const { watchdog, launchGatewayProcess } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") {
          doctorCalls.push(command);
          return { ok: true, stdout: "fixed" };
        }
        return { ok: true, stdout: "" };
      },
    });

    watchdog.onGatewayExit({ code: 78, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();

    // Even with auto-repair enabled, EX_CONFIG must not trigger doctor runs.
    expect(doctorCalls).toHaveLength(0);
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    expect(watchdog.getStatus().lifecycle).toBe("configuration_error");

    // A manual (forced) repair is the operator's escape hatch.
    const result = await watchdog.triggerRepair();
    expect(result.ok).toBe(true);
    expect(doctorCalls).toHaveLength(1);
    expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
    expect(watchdog.getStatus().lifecycle).toBe("running");
  });

  const buildSafeModeFetch = (gatewayState) => async (url) => {
    if (String(url).includes("/readyz")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ready: true,
            failing: [],
            ...(gatewayState.suppressed.length > 0
              ? { suppressed: gatewayState.suppressed }
              : {}),
          }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, status: "live" }),
    };
  };

  it("detects gateway safe mode from readyz and notifies once", async () => {
    vi.useFakeTimers();
    const gatewayState = { suppressed: ["telegram", "discord"] };
    const { watchdog, insertWatchdogEvent, notifier } = createHarness({
      autoRepair: false,
      resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
      fetchImpl: buildSafeModeFetch(gatewayState),
    });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(10);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "healthy",
        safeMode: true,
        suppressedChannels: ["telegram", "discord"],
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "safe_mode",
        status: "failed",
        details: expect.objectContaining({
          suppressed: ["telegram", "discord"],
        }),
      }),
    );
    const safeModeNotices = () =>
      notifier.notify.mock.calls.filter((call) =>
        String(call?.[0] || "").includes("channels paused"),
      );
    expect(safeModeNotices()).toHaveLength(1);

    // Subsequent checks with unchanged suppression must not re-notify.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(safeModeNotices()).toHaveLength(1);
    watchdog.stop();
  });

  it("clears safe mode and notifies recovery when suppression ends", async () => {
    vi.useFakeTimers();
    const gatewayState = { suppressed: ["telegram"] };
    const { watchdog, insertWatchdogEvent, notifier } = createHarness({
      autoRepair: false,
      resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
      fetchImpl: buildSafeModeFetch(gatewayState),
    });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(watchdog.getStatus().safeMode).toBe(true);

    gatewayState.suppressed = [];
    await vi.advanceTimersByTimeAsync(120_000);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({ safeMode: false, suppressedChannels: [] }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "safe_mode",
        status: "ok",
        details: expect.objectContaining({ recovered: true }),
      }),
    );
    expect(
      notifier.notify.mock.calls.some((call) =>
        String(call?.[0] || "").includes("channels resumed"),
      ),
    ).toBe(true);
    watchdog.stop();
  });

  it("resumeChannels issues channels.start for each suppressed channel", async () => {
    vi.useFakeTimers();
    const gatewayState = { suppressed: ["telegram", "discord"] };
    const startCalls = [];
    const { watchdog } = createHarness({
      autoRepair: false,
      resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
      fetchImpl: buildSafeModeFetch(gatewayState),
      clawCmdImpl: async (command) => {
        if (command.startsWith("gateway call channels.start")) {
          startCalls.push(command);
          return { ok: true, stdout: "{}" };
        }
        return { ok: true, stdout: "" };
      },
    });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(watchdog.getStatus().safeMode).toBe(true);

    gatewayState.suppressed = [];
    const resultPromise = watchdog.resumeChannels();
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(startCalls).toEqual([
      `gateway call channels.start --params '{"channel":"telegram"}'`,
      `gateway call channels.start --params '{"channel":"discord"}'`,
    ]);
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({ safeMode: false, suppressedChannels: [] }),
    );
    watchdog.stop();
  });

  it("resumeChannels skips when no channels are suppressed", async () => {
    const { watchdog, clawCmd } = createHarness({ autoRepair: false });

    const result = await watchdog.resumeChannels();

    expect(result).toEqual({
      ok: false,
      skipped: true,
      reason: "no_suppressed_channels",
    });
    expect(clawCmd).not.toHaveBeenCalled();
  });

  it("clears safe-mode status when the gateway exits", async () => {
    vi.useFakeTimers();
    const gatewayState = { suppressed: ["telegram"] };
    const { watchdog } = createHarness({
      autoRepair: false,
      resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
      fetchImpl: buildSafeModeFetch(gatewayState),
    });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(watchdog.getStatus().safeMode).toBe(true);

    watchdog.onGatewayExit({ code: 1, expectedExit: false });

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({ safeMode: false, suppressedChannels: [] }),
    );
    watchdog.stop();
  });

  it("handles missing URL resolvers and a missing notifier gracefully", async () => {
    process.env.WATCHDOG_AUTO_REPAIR = "false";
    process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
    const insertWatchdogEvent = vi.fn();
    const watchdog = createWatchdog({
      clawCmd: vi.fn(async () => ({ ok: true, stdout: "" })),
      launchGatewayProcess: vi.fn(() => ({ pid: 1 })),
      insertWatchdogEvent,
      notifier: null,
      readEnvFile: vi.fn(() => []),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      // resolveSetupUrl / health / readyz resolvers intentionally omitted.
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await flushMicrotasks();

    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        details: expect.objectContaining({
          reason: "gateway health URL unavailable",
        }),
      }),
    );

    // Crash-loop notifications degrade to no-ops without a notifier, and the
    // watchdog link falls back to localhost when no setup URL resolver exists.
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    expect(watchdog.getStatus().lifecycle).toBe("crash_loop");
    expect(insertWatchdogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "notification" }),
    );
    watchdog.stop();
  });

  it("skips readiness probing when no readyz resolver is provided", async () => {
    process.env.WATCHDOG_AUTO_REPAIR = "false";
    process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, status: "live" }),
    }));
    const watchdog = createWatchdog({
      clawCmd: vi.fn(async () => ({ ok: true, stdout: "" })),
      launchGatewayProcess: vi.fn(() => ({ pid: 1 })),
      insertWatchdogEvent: vi.fn(),
      notifier: { notify: vi.fn(async () => ({ ok: true })) },
      readEnvFile: vi.fn(() => []),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      resolveSetupUrl: () => "https://setup.example.com",
      resolveGatewayHealthUrl: () => "http://127.0.0.1:18789/health",
      // resolveGatewayReadyzUrl intentionally omitted: default returns "".
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await flushMicrotasks();

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        health: "healthy",
        safeMode: false,
        suppressedChannels: [],
      }),
    );
    // Only the health endpoint was probed.
    expect(global.fetch).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it("omits the view-logs link when resolveSetupUrl throws", async () => {
    const { watchdog, notifier } = createHarness({
      autoRepair: false,
      resolveSetupUrl: () => {
        throw new Error("setup URL resolution failed");
      },
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    const crashLoopNotice = notifier.notify.mock.calls
      .map((call) => String(call?.[0] || ""))
      .find((message) => message.includes("crash loop detected"));
    expect(crashLoopNotice).toBeTruthy();
    expect(crashLoopNotice).not.toContain("View logs");
  });

  it("notifies a crash loop only once per incident", async () => {
    const { watchdog, notifier, insertWatchdogEvent } = createHarness({
      autoRepair: false,
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    const crashLoopNotices = notifier.notify.mock.calls.filter((call) =>
      String(call?.[0] || "").includes("crash loop detected"),
    );
    expect(crashLoopNotices).toHaveLength(1);
    const crashLoopEvents = insertWatchdogEvent.mock.calls.filter(
      (call) => call?.[0]?.eventType === "crash_loop",
    );
    expect(crashLoopEvents).toHaveLength(2);
  });

  it("logs event-insert failures to the console without crashing", () => {
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
    });
    insertWatchdogEvent.mockImplementation(() => {
      throw new Error("db locked");
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    watchdog.onGatewayExit({ code: 0, expectedExit: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to log event"),
    );
  });

  it("aborts hung health probes after the timeout", async () => {
    vi.useFakeTimers();
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      fetchImpl: (url, opts) =>
        new Promise((resolve, reject) => {
          opts.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        details: expect.objectContaining({
          reason: "gateway health timed out after 5000ms",
        }),
      }),
    );
    watchdog.stop();
  });

  it("aborts hung readyz probes without disturbing a healthy gateway", async () => {
    vi.useFakeTimers();
    const { watchdog } = createHarness({
      autoRepair: false,
      resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
      fetchImpl: (url, opts) => {
        if (String(url).includes("/readyz")) {
          return new Promise((resolve, reject) => {
            opts.signal.addEventListener("abort", () =>
              reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
            );
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        });
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(5_000);

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        health: "healthy",
        safeMode: false,
        suppressedChannels: [],
      }),
    );
    watchdog.stop();
  });

  it("ignores readyz HTTP failures and readyz fetch errors", async () => {
    let readyzMode = "http-error";
    const { watchdog } = createHarness({
      autoRepair: false,
      resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
      fetchImpl: async (url) => {
        if (String(url).includes("/readyz")) {
          if (readyzMode === "http-error") {
            return { ok: false, status: 503, text: async () => "oops" };
          }
          throw new Error("readyz socket hangup");
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await flushMicrotasks();
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({ health: "healthy", safeMode: false }),
    );

    readyzMode = "throw";
    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await flushMicrotasks();
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({ health: "healthy", safeMode: false }),
    );
    watchdog.stop();
  });

  it("reports HTTP and body-level health failure reasons", async () => {
    vi.useFakeTimers();
    const responses = [
      {
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ error: "upstream exploded" }),
      },
      { ok: false, status: 500, text: async () => "not json" },
      {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: false, error: "draining" }),
      },
      { ok: true, status: 200, text: async () => JSON.stringify({ ok: false }) },
    ];
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      fetchImpl: async () => {
        const next = responses.shift();
        if (!next) throw new Error("still down");
        return next;
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    // Bootstrap checks at t=0/5s/10s consume the first three responses; the
    // degraded 5s retry at t=15s consumes the fourth, then keeps rescheduling
    // until the regular 120s interval overlaps with a pending retry timer.
    await vi.advanceTimersByTimeAsync(130_000);

    const reasons = insertWatchdogEvent.mock.calls
      .filter((call) => call?.[0]?.eventType === "health_check")
      .map((call) => call?.[0]?.details?.reason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "upstream exploded",
        "gateway health returned HTTP 500",
        "draining",
        "gateway unhealthy",
        "still down",
      ]),
    );
    expect(watchdog.getStatus().health).toBe("degraded");
    watchdog.stop();
  });

  it("skips stale degraded retries after a forced repair resets health", async () => {
    vi.useFakeTimers();
    const gatewayState = { healthy: true };
    const { watchdog } = createHarness({
      autoRepair: false,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") return { ok: true, stdout: "fixed" };
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        if (!gatewayState.healthy) throw new Error("gateway down");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus().health).toBe("healthy");

    // A previously-healthy gateway degrades on the first failed interval check.
    gatewayState.healthy = false;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(watchdog.getStatus().health).toBe("degraded");

    const repairPromise = watchdog.triggerRepair();
    await vi.advanceTimersByTimeAsync(0);
    const repairResult = await repairPromise;
    expect(repairResult.ok).toBe(true);
    expect(watchdog.getStatus().health).toBe("unknown");

    // The degraded retry scheduled before the repair fires and must no-op.
    const fetchCallsBeforeRetry = global.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(global.fetch.mock.calls.length).toBe(fetchCallsBeforeRetry);
    expect(watchdog.getStatus().health).toBe("unknown");
    watchdog.stop();
  });

  it("skips auto-repair while a configuration error is latched", async () => {
    const { watchdog, clawCmd } = createHarness({
      autoRepair: true,
      fetchImpl: async () => {
        throw new Error("gateway down");
      },
    });

    watchdog.onGatewayExit({ code: 78, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(clawCmd).not.toHaveBeenCalledWith(
      "doctor --fix --yes",
      expect.objectContaining({ quiet: true }),
    );
  });

  it("skips crash-loop auto-repair while awaiting recovery from a prior repair", async () => {
    vi.useFakeTimers();
    const doctorCalls = [];
    const { watchdog } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") {
          doctorCalls.push(command);
          return { ok: true, stdout: "fixed" };
        }
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("still unhealthy");
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(doctorCalls).toHaveLength(1);

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.advanceTimersByTimeAsync(0);
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.advanceTimersByTimeAsync(0);
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(doctorCalls).toHaveLength(1);
    watchdog.stop();
  });

  it("rejects overlapping repairs and skips crash restarts mid-repair", async () => {
    let resolveDoctor;
    const { watchdog, launchGatewayProcess } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") {
          return new Promise((resolve) => {
            resolveDoctor = resolve;
          });
        }
        return { ok: true, stdout: "" };
      },
    });

    const firstRepair = watchdog.triggerRepair();
    await flushMicrotasks();

    const secondRepair = await watchdog.triggerRepair();
    expect(secondRepair).toEqual({
      ok: false,
      skipped: true,
      reason: "operation_in_progress",
    });

    // A crash while the repair is running must not double-launch the gateway.
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    expect(launchGatewayProcess).not.toHaveBeenCalled();

    resolveDoctor({ ok: true, stdout: "fixed" });
    const firstResult = await firstRepair;
    expect(firstResult.ok).toBe(true);
    expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
  });

  it("abandons an in-flight repair when EX_CONFIG lands mid-doctor", async () => {
    let resolveDoctor;
    const { watchdog, launchGatewayProcess } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") {
          return new Promise((resolve) => {
            resolveDoctor = resolve;
          });
        }
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("gateway down");
      },
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    // Crash exits arrive on separate event-loop turns; let crash 1's relaunch
    // settle before crashes 2 and 3 land.
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    // Crash 1 relaunched immediately. Crash 2 entered the exponential backoff
    // (instant sleepImpl in this harness) and, with the gateway still down at
    // the re-check (the operation-end resync probe marked it degraded),
    // legitimately relaunched. Crash 3 opened the crash loop and started an
    // auto-repair whose doctor run is still in flight — no further relaunch.
    expect(launchGatewayProcess).toHaveBeenCalledTimes(2);

    watchdog.onGatewayExit({ code: 78, expectedExit: false });
    await flushMicrotasks();

    resolveDoctor({ ok: true, stdout: "fixed" });
    await flushMicrotasks();
    await flushMicrotasks();

    // The completed doctor run must not relaunch a misconfigured gateway.
    expect(launchGatewayProcess).toHaveBeenCalledTimes(2);
    expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
  });

  it("logs when a repair cannot relaunch the gateway", async () => {
    const { watchdog, launchGatewayProcess, insertWatchdogEvent } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") return { ok: true, stdout: "fixed" };
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("gateway down");
      },
    });

    launchGatewayProcess.mockReturnValue(null);
    const noChildResult = await watchdog.triggerRepair();
    expect(noChildResult.ok).toBe(true);
    expect(noChildResult.launchedGateway).toBe(false);
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "repair",
        status: "failed",
        details: { reason: "launchGatewayProcess returned no child" },
      }),
    );

    launchGatewayProcess.mockImplementation(() => {
      throw new Error("spawn failure");
    });
    const throwResult = await watchdog.triggerRepair();
    expect(throwResult.ok).toBe(true);
    expect(throwResult.launchedGateway).toBe(false);
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "repair",
        status: "failed",
        details: { error: "spawn failure" },
      }),
    );
  });

  it("keeps the expected-restart window through mid-restart healthy probes and expected exits", async () => {
    vi.useFakeTimers();
    let gatewayUp = true;
    let doctorCalls = 0;
    const { watchdog, launchGatewayProcess } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") {
          doctorCalls += 1;
          return { ok: true, stdout: "fixed" };
        }
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        if (!gatewayUp) throw new Error("gateway down");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(10);

    // A route restart opens a lease-length window; prepare-before-stop means
    // the OLD gateway still answers probes at this point.
    watchdog.onExpectedRestart({ expiresAt: Date.now() + 10 * 60 * 1000 });
    await vi.advanceTimersByTimeAsync(6_000);
    // The mid-restart healthy probe must not clear the window or flip the
    // lifecycle back to running.
    expect(watchdog.getStatus().lifecycle).toBe("restarting");

    // The stop lands: the expected exit's 15s default must not SHRINK the
    // lease-length window.
    gatewayUp = false;
    watchdog.onGatewayExit({ code: 0, expectedExit: true });
    // 20s into the restart — inside the 120s ready budget, past the old 15s
    // window — failing probes stay suppressed: no degradation, no doctor
    // repair, no competing launch under the live restart.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(doctorCalls).toBe(0);
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    expect(watchdog.getStatus().lifecycle).toBe("restarting");
    watchdog.stop();
  });

  it("skips background recovery while another lifecycle operation holds the lock", async () => {
    const {
      createGatewayLifecycleLock,
    } = require("../../lib/server/gateway-lifecycle-lock");
    const lock = createGatewayLifecycleLock();
    const { watchdog, launchGatewayProcess, insertWatchdogEvent } = createHarness({
      autoRepair: true,
      gatewayLifecycleLock: lock,
      fetchImpl: async () => {
        throw new Error("gateway down");
      },
    });

    const release = await lock.acquire("restart");
    const result = await watchdog.triggerRepair();
    expect(result).toEqual({
      ok: false,
      skipped: true,
      reason: "operation_in_progress",
    });
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "repair",
        status: "skipped",
        details: expect.objectContaining({
          reason: "lifecycle_operation_in_progress",
        }),
      }),
    );

    // A crash exit during the held lock must not relaunch a competing gateway.
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    expect(launchGatewayProcess).not.toHaveBeenCalled();

    release();
    // With the lock free again, recovery proceeds.
    const repaired = await watchdog.triggerRepair();
    expect(repaired.ok).toBe(true);
  });

  it("settling an expected restart closes the suppression window and resyncs immediately", async () => {
    vi.useFakeTimers();
    const { watchdog } = createHarness({
      autoRepair: false,
      fetchImpl: async () => {
        throw new Error("gateway down");
      },
    });
    watchdog.start();
    await vi.advanceTimersByTimeAsync(10);

    // A route restart opens a lease-length window (worst case 10 minutes).
    watchdog.onExpectedRestart({ expiresAt: Date.now() + 10 * 60 * 1000 });
    expect(watchdog.getStatus().lifecycle).toBe("restarting");

    // While the window is open, failing checks are suppressed as expected.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(watchdog.getStatus().health).not.toBe("degraded");
    expect(watchdog.getStatus().health).not.toBe("unhealthy");

    // The operation settles (failed — the gateway never came up). Detection
    // must resume NOW, not at lease expiry.
    watchdog.onExpectedRestartSettled();
    await vi.advanceTimersByTimeAsync(10);
    const health = watchdog.getStatus().health;
    expect(["degraded", "unhealthy"]).toContain(health);
    watchdog.stop();
  });

  it("demotes a stuck 'restarting' lifecycle when the settle probe fails", async () => {
    const { watchdog } = createHarness({
      autoRepair: false,
      fetchImpl: async () => {
        throw new Error("gateway down");
      },
    });

    // Route restart begins; the gateway never comes back.
    watchdog.onExpectedRestart({ expiresAt: Date.now() + 10 * 60 * 1000 });
    expect(watchdog.getStatus().lifecycle).toBe("restarting");

    watchdog.onExpectedRestartSettled();
    await flushMicrotasks();
    await flushMicrotasks();

    // Left as "restarting" the reducer would report launch-in-progress
    // ("Starting", no Retry) forever over a dead gateway.
    expect(watchdog.getStatus().lifecycle).toBe("stopped");
  });

  it("records external operation events in the incident ledger", () => {
    const { watchdog, insertWatchdogEvent } = createHarness({});

    watchdog.recordOperationEvent({
      kind: "gateway_restart",
      status: "ok",
      details: { operationId: "op-1", trigger: "manual", downtimeMs: 4200 },
    });

    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "operation",
        source: "gateway_restart",
        status: "ok",
        details: expect.objectContaining({
          operationId: "op-1",
          downtimeMs: 4200,
        }),
        correlationId: expect.any(String),
      }),
    );
  });

  it("pauses manual repair after repeated doctor failures", async () => {
    const { watchdog, notifier, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") {
          return { ok: false, stderr: "doctor exploded" };
        }
        return { ok: true, stdout: "" };
      },
      // The gateway stays down throughout — otherwise the operation-end
      // resync probe would (correctly) see a healthy gateway and reset the
      // repair-attempt counter between the two failed repairs.
      fetchImpl: async () => {
        throw new Error("gateway down");
      },
    });

    const firstResult = await watchdog.triggerRepair();
    expect(firstResult.ok).toBe(false);
    // The repair marks health unhealthy; the operation-end resync probe then
    // fails against the down gateway and records its own first-failure
    // "degraded" observation. Either way: not healthy, attempts preserved.
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({ repairAttempts: 1, health: "degraded" }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "repair",
        source: "manual",
        status: "failed",
      }),
    );

    const secondResult = await watchdog.triggerRepair();
    expect(secondResult.ok).toBe(false);
    expect(watchdog.getStatus().repairAttempts).toBe(2);
    expect(
      notifier.notify.mock.calls.some((call) =>
        String(call?.[0] || "").includes("Auto-repair failed repeatedly"),
      ),
    ).toBe(true);
  });

  it("notifies auto-repair failures with attempt counts in crash loops", async () => {
    const { watchdog, notifier } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) => {
        if (command === "doctor --fix --yes") {
          return { ok: false, stderr: "doctor exploded" };
        }
        return { ok: true, stdout: "" };
      },
      fetchImpl: async () => {
        throw new Error("gateway down");
      },
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    // Space crash 1 from the rest so its relaunch releases the operation lock
    // before the crash loop opens (real exits never share a tick).
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();

    const failureNotice = notifier.notify.mock.calls
      .map((call) => String(call?.[0] || ""))
      .find((message) => message.includes("🔴 Auto-repair failed"));
    expect(failureNotice).toBeTruthy();
    expect(failureNotice).toContain("Attempt count: 1");
    expect(failureNotice).toContain("Trigger: `crash_loop`");
  });

  it("logs crash restarts that cannot relaunch the gateway", async () => {
    const { watchdog, launchGatewayProcess, insertWatchdogEvent } = createHarness({
      autoRepair: false,
    });

    launchGatewayProcess.mockReturnValue(null);
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "exit_event",
        status: "failed",
        details: { reason: "launchGatewayProcess returned no child" },
      }),
    );

    launchGatewayProcess.mockImplementation(() => {
      throw new Error("no exec");
    });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "exit_event",
        status: "failed",
        details: { error: "no exec" },
      }),
    );
  });

  it("rejects settings updates without any boolean fields", () => {
    const { watchdog, writeEnvFile } = createHarness({ autoRepair: false });

    expect(() => watchdog.updateSettings({})).toThrow(
      "Expected autoRepair and/or notificationsEnabled boolean",
    );
    expect(() => watchdog.updateSettings()).toThrow(
      "Expected autoRepair and/or notificationsEnabled boolean",
    );
    expect(writeEnvFile).not.toHaveBeenCalled();
  });

  it("overwrites existing watchdog env entries when updating settings", () => {
    const { watchdog, readEnvFile, writeEnvFile } = createHarness({
      autoRepair: true,
      notificationsDisabled: true,
    });
    readEnvFile.mockReturnValue([
      { key: "WATCHDOG_AUTO_REPAIR", value: "true" },
      { key: "WATCHDOG_NOTIFICATIONS_DISABLED", value: "true" },
    ]);

    watchdog.updateSettings({ autoRepair: false, notificationsEnabled: true });

    expect(writeEnvFile).toHaveBeenCalledWith([
      { key: "WATCHDOG_AUTO_REPAIR", value: "false" },
      { key: "WATCHDOG_NOTIFICATIONS_DISABLED", value: "false" },
    ]);
  });

  it("guards start and bootstrap scheduling against double-registration", async () => {
    vi.useFakeTimers();
    const gatewayState = { healthy: false };
    const { watchdog } = createHarness({
      autoRepair: false,
      fetchImpl: async () => {
        if (!gatewayState.healthy) throw new Error("booting");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(0);
    // Both re-entries are no-ops while a bootstrap retry timer is pending.
    watchdog.start();
    watchdog.onGatewayLaunch({ startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(0);

    gatewayState.healthy = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(watchdog.getStatus().health).toBe("healthy");

    // With regular checks running, a new launch bootstraps once and then
    // declines to start a second regular interval.
    watchdog.onGatewayLaunch({ startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus().health).toBe("healthy");
    watchdog.start();

    const fetchCalls = global.fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(global.fetch.mock.calls.length).toBe(fetchCalls);
    watchdog.stop();
  });

  it("classifies exit-78 as a benign step-aside when all three signals hold", async () => {
    const { watchdog, insertWatchdogEvent, notifier, launchGatewayProcess } =
      createHarness({ autoRepair: false });

    watchdog.onGatewayExit({
      code: 78,
      signal: null,
      expectedExit: false,
      stderrTail: kStepAsideStderrTail,
      launchedAt: Date.now() - 2_000,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    // Signature + startup window + healthy incumbent probe: the incumbent
    // keeps the port — no latch, no rollback, no notification, no relaunch.
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        crashCountInWindow: 0,
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "exit_event",
        status: "ok",
        details: expect.objectContaining({ stepAside: true, code: 78 }),
      }),
    );
    expect(insertWatchdogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "config_error" }),
    );
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("latches when the step-aside probe finds no healthy incumbent", async () => {
    const { watchdog, insertWatchdogEvent, notifier } = createHarness({
      autoRepair: false,
      fetchImpl: async () => {
        throw new Error("no incumbent listening");
      },
    });

    watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: kStepAsideStderrTail,
      launchedAt: Date.now(),
    });
    await flushMicrotasks();
    await flushMicrotasks();

    // Fail-safe: two failed probe attempts fall through to the EXISTING
    // config-error flow unchanged.
    expect(global.fetch).toHaveBeenCalledTimes(2);
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
        String(call?.[0] || "").includes("Gateway configuration error"),
      ),
    ).toBe(true);
  });

  it("latches when the step-aside probe machinery itself throws", async () => {
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      resolveGatewayHealthUrl: () => {
        throw new Error("resolver exploded");
      },
    });

    watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: kStepAsideStderrTail,
      launchedAt: Date.now(),
    });
    await flushMicrotasks();

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "configuration_error",
        health: "unhealthy",
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "config_error",
        details: expect.objectContaining({ code: 78 }),
      }),
    );
  });

  it("keeps exit-78 synchronous and never probes without the step-aside signature", () => {
    const { watchdog } = createHarness({ autoRepair: false });

    watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: ["fatal configuration error: invalid channels config"],
      launchedAt: Date.now(),
    });

    // No flush: the plain config-error path must classify synchronously.
    expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps exit-78 synchronous when the step-aside signature lands outside the startup window", () => {
    const { watchdog } = createHarness({ autoRepair: false });

    watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: kStepAsideStderrTail,
      launchedAt: Date.now() - 61_000,
    });

    // A healthy probe alone can be another process or a stale incumbent;
    // outside the boot window the exit latches without probing.
    expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps exit-78 synchronous when only one of the two signature phrases matches", () => {
    const { watchdog } = createHarness({ autoRepair: false });

    // "exiting with code 78" present, but the healthy-incumbent phrase absent
    // — the sibling probe-timeout error uses this shape and must keep
    // latching (both phrases are required).
    watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: [
        "Gateway failed to start: incumbent did not become healthy, exiting with code 78 to prevent a systemd Restart=always loop",
      ],
      launchedAt: Date.now(),
    });

    // No flush: the plain config-error path must classify synchronously.
    expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("keeps exit-78 synchronous when no launch reference exists for the startup window", () => {
    const { watchdog } = createHarness({ autoRepair: false });

    // Full signature, but launchedAt is null and no gateway launch was ever
    // recorded: with no startup-window reference the window check fails
    // (fail-safe toward the config-error flow) and no probe is spawned.
    watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: kStepAsideStderrTail,
      launchedAt: null,
    });

    expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("discards a stale step-aside probe superseded by a newer launch", async () => {
    let resolveFirstFetch;
    let fetchCalls = 0;
    const healthyResponse = () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, status: "live" }),
    });
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      fetchImpl: () => {
        fetchCalls += 1;
        if (fetchCalls === 1) {
          return new Promise((resolve) => {
            resolveFirstFetch = resolve;
          });
        }
        return Promise.resolve(healthyResponse());
      },
    });

    watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: kStepAsideStderrTail,
      launchedAt: Date.now(),
    });
    await flushMicrotasks();
    // A newer launch lands while the probe is still in flight.
    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 999 });
    await flushMicrotasks();

    resolveFirstFetch(healthyResponse());
    await flushMicrotasks();

    // The healthy probe result belongs to a superseded exit: discarded — the
    // launch owns state, and neither a stepAside event nor a latch may land.
    expect(insertWatchdogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        details: expect.objectContaining({ stepAside: true }),
      }),
    );
    expect(insertWatchdogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "config_error" }),
    );
    expect(watchdog.getStatus().lifecycle).toBe("running");
    watchdog.stop();
  });

  it("treats an accepted restart handoff as an expected restart with a prompt relaunch", async () => {
    const consumeRestartHandoffImpl = vi.fn(async () => ({
      status: "accepted",
      reason: null,
      handoff: {
        pid: 4242,
        source: "config-apply",
        reason: "config changed",
        restartKind: "gateway",
      },
    }));
    const { watchdog, insertWatchdogEvent, launchGatewayProcess } =
      createHarness({
        autoRepair: false,
        supervisorModeActive: () => true,
        consumeRestartHandoffImpl,
        fetchImpl: async () => {
          throw new Error("gateway restarting");
        },
      });

    watchdog.onGatewayLaunch({ startedAt: Date.now() - 5_000, pid: 4242 });
    watchdog.onGatewayExit({
      code: 0,
      signal: null,
      expectedExit: false,
      pid: 4242,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(consumeRestartHandoffImpl).toHaveBeenCalledTimes(1);
    expect(consumeRestartHandoffImpl).toHaveBeenCalledWith(
      expect.objectContaining({ pid: 4242 }),
    );
    // Expected-restart handling: no crash accounting, no backoff, and the
    // relaunch fires promptly (the gateway deferred its OWN restart to us).
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "restarting",
        crashCountInWindow: 0,
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "handoff",
        status: "ok",
        details: expect.objectContaining({
          source: "config-apply",
          reason: "config changed",
          restartKind: "gateway",
          pid: 4242,
        }),
      }),
    );
    expect(insertWatchdogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "crash" }),
    );
    expect(insertWatchdogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ status: "backoff" }),
    );
    expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
    watchdog.stop();
  });

  it("keeps the existing classification for none and error handoff results with no incumbent", async () => {
    for (const status of ["none", "error"]) {
      const consumeRestartHandoffImpl = vi.fn(async () => ({
        status,
        reason: null,
        handoff: null,
      }));
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } =
        createHarness({
          autoRepair: false,
          supervisorModeActive: () => true,
          consumeRestartHandoffImpl,
          // No healthy incumbent answers the disambiguation probe: this is a
          // genuine clean-exit crash and must classify as one.
          fetchImpl: async () => {
            throw new Error("no incumbent listening");
          },
        });

      // Hold the relaunch open: upstream's operation-end resync fires another
      // health probe once the relaunch settles, which would blur the exact
      // two-attempt disambiguation-probe count asserted below.
      launchGatewayProcess.mockImplementation(() => new Promise(() => {}));

      watchdog.onGatewayExit({
        code: 0,
        expectedExit: false,
        pid: 4242,
      });
      await flushMicrotasks();
      await flushMicrotasks();

      expect(consumeRestartHandoffImpl).toHaveBeenCalledTimes(1);
      // The incumbent probe ran (both attempts) before crash classification.
      expect(global.fetch).toHaveBeenCalledTimes(2);
      expect(insertWatchdogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "crash",
          source: "exit_event",
          status: "failed",
          details: expect.objectContaining({ code: 0 }),
        }),
      );
      expect(watchdog.getStatus().crashCountInWindow).toBe(1);
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
    }
  });

  it("logs rejected handoffs at info level and classifies the exit normally", async () => {
    const consumeRestartHandoffImpl = vi.fn(async () => ({
      status: "rejected",
      reason: "pid-mismatch",
      handoff: null,
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      supervisorModeActive: () => true,
      consumeRestartHandoffImpl,
      fetchImpl: async () => {
        throw new Error("no incumbent listening");
      },
    });

    watchdog.onGatewayExit({ code: 0, expectedExit: false, pid: 4242 });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("restart handoff rejected (pid-mismatch)"),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "crash" }),
    );
    expect(watchdog.getStatus().crashCountInWindow).toBe(1);
  });

  it("never consults the handoff consume when the supervisorMode gate is closed", async () => {
    // Gate closed (harness default — production reaches this state via the
    // OPENCLAW_SUPERVISOR_MODE=off|none escape hatch, unit-tested in
    // gateway.test.js): the consume CLI is never spawned.
    const { watchdog, clawCmd } = createHarness({ autoRepair: false });

    watchdog.onGatewayExit({ code: 0, expectedExit: false, pid: 4242 });

    // No flush: with the gate closed the classification stays synchronous.
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "crashed",
        crashCountInWindow: 1,
      }),
    );
    expect(clawCmd).not.toHaveBeenCalled();
    await flushMicrotasks();
    expect(clawCmd).not.toHaveBeenCalled();
  });

  it("discards a handoff verdict superseded by a newer launch", async () => {
    let resolveConsume;
    const consumeRestartHandoffImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveConsume = resolve;
        }),
    );
    const { watchdog, insertWatchdogEvent, launchGatewayProcess } =
      createHarness({
        autoRepair: false,
        supervisorModeActive: () => true,
        consumeRestartHandoffImpl,
      });

    watchdog.onGatewayExit({ code: 0, expectedExit: false, pid: 1111 });
    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 2222 });
    await flushMicrotasks();

    resolveConsume({
      status: "accepted",
      reason: null,
      handoff: { pid: 1111, source: "config-apply" },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    // The consume settled after a newer launch: neither the handoff restart
    // handling nor the crash fallback may land — the launch owns state.
    expect(insertWatchdogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ source: "handoff" }),
    );
    expect(insertWatchdogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "crash" }),
    );
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    expect(watchdog.getStatus().lifecycle).toBe("running");
    watchdog.stop();
  });

  it("reclassifies a handoff-less clean exit as a step-aside when a healthy incumbent answers", async () => {
    // Beta line without systemd hints: a newcomer that finds a healthy
    // incumbent logs "leaving it in control" on STDOUT and exits 0 without
    // writing a handoff row — consume says "none", but this is not a crash.
    const consumeRestartHandoffImpl = vi.fn(async () => ({
      status: "none",
      reason: "missing",
      handoff: null,
    }));
    const { watchdog, insertWatchdogEvent, notifier, launchGatewayProcess } =
      createHarness({
        autoRepair: false,
        supervisorModeActive: () => true,
        consumeRestartHandoffImpl,
      });

    watchdog.onGatewayExit({
      code: 0,
      signal: null,
      expectedExit: false,
      pid: 4242,
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        crashCountInWindow: 0,
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "exit_event",
        status: "ok",
        details: expect.objectContaining({ stepAside: true, code: 0 }),
      }),
    );
    expect(insertWatchdogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "crash" }),
    );
    expect(notifier.notify).not.toHaveBeenCalled();
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    watchdog.stop();
  });

  it("exposes pendingExitClassification and blocks dispatch while an exit classification is in flight", async () => {
    let resolveConsume;
    const consumeRestartHandoffImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveConsume = resolve;
        }),
    );
    const { watchdog } = createHarness({
      autoRepair: false,
      supervisorModeActive: () => true,
      consumeRestartHandoffImpl,
      fetchImpl: async () => {
        throw new Error("gateway restarting");
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
    await flushMicrotasks();
    expect(watchdog.getStatus().pendingExitClassification).toBe(false);

    watchdog.onGatewayExit({ code: 0, expectedExit: false, pid: 4242 });

    // While the consume is pending, lifecycle still reads pre-exit "running"
    // — the flag is what keeps dispatch gates honest against a dead gateway.
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        pendingExitClassification: true,
      }),
    );
    expect(watchdog.isReadyForDispatch()).toEqual({
      ok: false,
      reason: "a gateway exit is being classified",
    });

    resolveConsume({
      status: "accepted",
      reason: null,
      handoff: { pid: 4242, source: "config-apply" },
    });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "restarting",
        pendingExitClassification: false,
      }),
    );
    expect(watchdog.isReadyForDispatch()).toEqual({
      ok: false,
      reason: "gateway lifecycle is restarting",
    });
    watchdog.stop();
  });

  it("isReadyForDispatch reflects lifecycle, managed operations, and recovery", async () => {
    const gatewayState = { up: true };
    const { watchdog } = createHarness({
      autoRepair: false,
      fetchImpl: async () => {
        if (!gatewayState.up) throw new Error("gateway down");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    // Never started: nothing to dispatch against.
    expect(watchdog.isReadyForDispatch()).toEqual({
      ok: false,
      reason: "gateway lifecycle is stopped",
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    await flushMicrotasks();
    expect(watchdog.getStatus().health).toBe("healthy");
    expect(watchdog.isReadyForDispatch()).toEqual({ ok: true, reason: "" });

    // Managed updates block dispatch for their whole duration — not just
    // while a transient lifecycle operation is in flight.
    watchdog.beginManagedOperation();
    expect(watchdog.isReadyForDispatch()).toEqual({
      ok: false,
      reason: "an OpenClaw update operation is in progress",
    });

    // The managed bounce leaves lifecycle "restarting": still not ready
    // after the operation ends, until the relaunch reports in.
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    watchdog.endManagedOperation();
    expect(watchdog.isReadyForDispatch()).toEqual({
      ok: false,
      reason: "gateway lifecycle is restarting",
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1235 });
    await flushMicrotasks();
    expect(watchdog.isReadyForDispatch()).toEqual({ ok: true, reason: "" });

    // Crashes block via lifecycle. Drop the gateway first: the relaunch's
    // operation-end resync would otherwise read the healthy mock and clear
    // the crash before the assertion.
    gatewayState.up = false;
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    expect(watchdog.isReadyForDispatch()).toEqual({
      ok: false,
      reason: "gateway lifecycle is crashed",
    });
    watchdog.stop();
  });

  it("isReadyForDispatch blocks safe mode", async () => {
    vi.useFakeTimers();
    const gatewayState = { suppressed: ["telegram"] };
    const { watchdog } = createHarness({
      autoRepair: false,
      resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
      fetchImpl: buildSafeModeFetch(gatewayState),
    });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(watchdog.getStatus().safeMode).toBe(true);
    expect(watchdog.isReadyForDispatch()).toEqual({
      ok: false,
      reason: "gateway is in safe mode",
    });
    watchdog.stop();
  });

  it("marks health degraded on green /health + degraded /readyz, with one advisory doctor (1.8)", async () => {
    vi.useFakeTimers();
    const readyzState = { degraded: true };
    const clawCmdImpl = vi.fn(async (cmd) => ({
      ok: true,
      stdout: cmd.startsWith("doctor")
        ? JSON.stringify({
            ok: false,
            findings: [{ checkId: "secrets.runtime", detail: "secret load failed" }],
          })
        : JSON.stringify({ ok: true }),
    }));
    const { watchdog, insertWatchdogEvent } = createHarness({
      clawCmdImpl,
      resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
      fetchImpl: async (url) => ({
        ok: true,
        status: 200,
        text: async () =>
          String(url).includes("readyz")
            ? JSON.stringify({
                ready: !readyzState.degraded,
                failing: readyzState.degraded ? ["secrets"] : [],
                eventLoop: { degraded: readyzState.degraded },
              })
            : JSON.stringify({ ok: true, status: "live" }),
      }),
    });

    watchdog.start();
    watchdog.onGatewayLaunch({ startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);

    // /health is green but readiness is degraded — never show a plain green dot.
    const status = watchdog.getStatus();
    expect(status.health).toBe("degraded");
    expect(status.eventLoopDegraded).toBe(true);
    expect(status.readyzFailing).toEqual(["secrets"]);
    // The transition logged once and ran ONE advisory doctor --json (warn-only).
    const doctorCalls = clawCmdImpl.mock.calls.filter(([cmd]) =>
      cmd.startsWith("doctor --json"),
    );
    expect(doctorCalls).toHaveLength(1);
    expect(
      insertWatchdogEvent.mock.calls.some(
        ([event]) => event.eventType === "readiness_degraded",
      ),
    ).toBe(true);
    // No restart/repair was driven by readiness degradation.
    expect(status.repairAttempts).toBe(0);

    // A second tick with the SAME degradation does not re-run the doctor.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(
      clawCmdImpl.mock.calls.filter(([cmd]) => cmd.startsWith("doctor --json")),
    ).toHaveLength(1);

    // Recovery: readiness clears → health returns to healthy on the next check.
    readyzState.degraded = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watchdog.getStatus().health).toBe("healthy");
    expect(watchdog.getStatus().eventLoopDegraded).toBe(false);
    watchdog.stop();
    vi.useRealTimers();
  });

  describe("readyz degraded surfaces (OpenClaw 2026.8)", () => {
    it("parses eventLoop.degraded and failing[] from /readyz", async () => {
      const { watchdog } = createHarness({
        resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ready: true,
              failing: ["telegram"],
              eventLoop: { degraded: true },
            }),
        }),
      });
      const readiness = await watchdog.probeGatewayReadiness();
      expect(readiness.ok).toBe(true);
      expect(readiness.eventLoopDegraded).toBe(true);
      expect(readiness.failing).toEqual(["telegram"]);
    });

    it("defaults eventLoopDegraded to false on gateways without the block", async () => {
      const { watchdog } = createHarness({
        resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ready: true }),
        }),
      });
      const readiness = await watchdog.probeGatewayReadiness();
      expect(readiness.eventLoopDegraded).toBe(false);
    });

    it("exposes the degraded fields in getStatus with safe defaults", () => {
      const { watchdog } = createHarness();
      expect(watchdog.getStatus()).toEqual(
        expect.objectContaining({
          eventLoopDegraded: false,
          readyzFailing: [],
        }),
      );
    });
  });

  it("runs the TCP liveness watcher on the 10s interval and stop() clears it", async () => {
    vi.useFakeTimers();
    const probeGatewayTcp = vi.fn(async () => {});
    const { watchdog } = createHarness({ autoRepair: false, probeGatewayTcp });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(0);
    // The watcher is an interval, not an immediate probe.
    expect(probeGatewayTcp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(kGatewayTcpWatchIntervalMs);
    expect(probeGatewayTcp).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * kGatewayTcpWatchIntervalMs);
    expect(probeGatewayTcp).toHaveBeenCalledTimes(3);

    watchdog.stop();
    await vi.advanceTimersByTimeAsync(3 * kGatewayTcpWatchIntervalMs);
    expect(probeGatewayTcp).toHaveBeenCalledTimes(3);
  });

  it("tightens health cadence to ~30s only while status clients are connected", async () => {
    vi.useFakeTimers();
    const probeGatewayTcp = vi.fn(async () => {});
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      probeGatewayTcp,
    });
    const fastCadenceChecks = () =>
      insertWatchdogEvent.mock.calls.filter(
        (call) =>
          call?.[0]?.eventType === "health_check" &&
          call?.[0]?.source === "fast_cadence",
      );

    watchdog.start();
    await vi.advanceTimersByTimeAsync(0); // bootstrap check at t=0 stamps lastHealthCheckAtMs

    // Disconnected: three watcher ticks pass the 30s staleness mark with no
    // fast-cadence check.
    await vi.advanceTimersByTimeAsync(kWatchdogConnectedHealthCadenceMs);
    expect(fastCadenceChecks()).toHaveLength(0);

    watchdog.setStatusClientsConnected(true);
    // t=40s: last check is 40s old (>= 30s) → one fast-cadence check.
    await vi.advanceTimersByTimeAsync(kGatewayTcpWatchIntervalMs);
    expect(fastCadenceChecks()).toHaveLength(1);
    // t=50s/60s: last check only 10s/20s old → never more often than 30s.
    await vi.advanceTimersByTimeAsync(2 * kGatewayTcpWatchIntervalMs);
    expect(fastCadenceChecks()).toHaveLength(1);
    // t=70s: 30s elapsed again → second fast-cadence check.
    await vi.advanceTimersByTimeAsync(kGatewayTcpWatchIntervalMs);
    expect(fastCadenceChecks()).toHaveLength(2);
    watchdog.stop();
  });

  it("coalesces TCP transitions inside the debounce into one health check", async () => {
    vi.useFakeTimers();
    const { watchdog, insertWatchdogEvent } = createHarness({ autoRepair: false });

    watchdog.onGatewayTcpTransition();
    await vi.advanceTimersByTimeAsync(400);
    watchdog.onGatewayTcpTransition();
    watchdog.onGatewayTcpTransition();
    expect(global.fetch).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(kGatewayTcpTransitionDebounceMs);

    const transitionChecks = insertWatchdogEvent.mock.calls.filter(
      (call) =>
        call?.[0]?.eventType === "health_check" &&
        call?.[0]?.source === "tcp_transition",
    );
    expect(transitionChecks).toHaveLength(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("degrades on failures inside the boot grace once this launch confirmed healthy", async () => {
    vi.useFakeTimers();
    let healthChecks = 0;
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      fetchImpl: async () => {
        healthChecks += 1;
        if (healthChecks === 1) {
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ok: true, status: "live" }),
          };
        }
        throw new Error("gateway went away");
      },
    });

    // Cold launch: the 30s startup grace window is open.
    watchdog.onGatewayLaunch({ startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus().health).toBe("healthy");

    // A TCP transition re-probes ~1s later — still well inside the grace
    // window, but this launch has provably booted, so the failure is real.
    watchdog.onGatewayTcpTransition();
    await vi.advanceTimersByTimeAsync(kGatewayTcpTransitionDebounceMs);

    expect(watchdog.getStatus().health).toBe("degraded");
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "health_check",
        status: "failed",
        details: expect.objectContaining({ reason: "gateway went away" }),
      }),
    );
    const graceSkips = insertWatchdogEvent.mock.calls.filter(
      (call) => call?.[0]?.details?.startupGraceActive,
    );
    expect(graceSkips).toHaveLength(0);
    watchdog.stop();
  });
});

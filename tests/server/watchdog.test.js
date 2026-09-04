const { createWatchdog } = require("../../lib/server/watchdog");
const {
  kGatewayTcpWatchIntervalMs,
  kWatchdogConnectedHealthCadenceMs,
  kGatewayTcpTransitionDebounceMs,
  kWatchdogDegradedCheckIntervalMs,
  kWatchdogDegradedCheckMaxIntervalMs,
} = require("../../lib/server/constants");

const flushMicrotasks = async () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
const kOriginalNotificationsDisabled =
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
const kOriginalNotificationsQuiet = process.env.WATCHDOG_NOTIFICATIONS_QUIET;
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
  updateEnvFile = null,
  getRescueSessionLine,
  collectAdvisoryDoctorJson = null,
  releaseChannelHooks = null,
} = {}) => {
  process.env.WATCHDOG_AUTO_REPAIR = autoRepair ? "true" : "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = notificationsDisabled
    ? "true"
    : "false";
  // Pin the verbose toggle to its default for every harness run — an ambient
  // WATCHDOG_NOTIFICATIONS_QUIET on the host must not flip assertions
  // (isVerboseEnabled reads live process.env). afterEach restores it.
  delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;

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
    ...(collectAdvisoryDoctorJson ? { collectAdvisoryDoctorJson } : {}),
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
    ...(updateEnvFile ? { updateEnvFile } : {}),
    ...(getRescueSessionLine ? { getRescueSessionLine } : {}),
    ...(releaseChannelHooks ? { releaseChannelHooks } : {}),
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
      delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
    } else {
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED =
        kOriginalNotificationsDisabled;
      if (kOriginalNotificationsQuiet === undefined) {
        delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
      } else {
        process.env.WATCHDOG_NOTIFICATIONS_QUIET = kOriginalNotificationsQuiet;
      }
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

  it("first degraded retry still fires 5s after the failed probe (regression pin)", async () => {
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
        if (command === "doctor --fix --yes")
          return { ok: true, stdout: "fixed" };
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
        if (command === "doctor --fix --yes")
          return { ok: true, stdout: "fixed" };
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
        clawCmd.mock.calls.filter((call) => call[0] === "doctor --fix --yes")
          .length;
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
        clawCmd.mock.calls.filter((call) => call[0] === "doctor --fix --yes")
          .length;
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
    const recoveryCall = notifier.notify.mock.calls.find((call) =>
      String(call?.[0] || "").includes("🟢 Gateway running again"),
    );
    expect(recoveryCall).toBeTruthy();
    // "Back online" is an informational notice: classified verbose so
    // Important-only mode suppresses it (plan Phase-3 pin list).
    expect(recoveryCall[1]).toEqual(
      expect.objectContaining({ eventType: "recovery", verbose: true }),
    );
    watchdog.stop();
  });

  it("logs a skipped (not failed) notification event when the notifier suppresses", async () => {
    const { watchdog, notifier, insertWatchdogEvent } = createHarness({
      autoRepair: false,
    });
    // The central gate suppressed downstream (e.g. quiet mode): the event log
    // must record `skipped`, never a spurious `failed` (D5).
    notifier.notify.mockResolvedValue({
      ok: false,
      skipped: true,
      reason: "verbose_notifications_disabled",
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();

    const notificationRows = insertWatchdogEvent.mock.calls
      .map(([row]) => row)
      .filter((row) => row.eventType === "notification");
    expect(notificationRows.length).toBeGreaterThan(0);
    for (const row of notificationRows) {
      expect(row.status).toBe("skipped");
    }
    watchdog.stop();
  });

  it("notifies once per incident when the gateway goes down, with exit-shape copy", async () => {
    // Health stays down for the whole test: both crashes belong to ONE
    // incident (a healthy probe between them would close it — and a second
    // incident correctly gets its own notice).
    const { watchdog, notifier } = createHarness({
      autoRepair: false,
      fetchImpl: async () => {
        throw new Error("gateway unavailable");
      },
    });

    // Expected exits never notify.
    watchdog.onGatewayExit({ code: 0, expectedExit: true });
    await flushMicrotasks();
    expect(notifier.notify).not.toHaveBeenCalled();

    // First unexpected exit: one down notice, non-committal copy, exit code.
    watchdog.onGatewayExit({ code: 137, expectedExit: false });
    await flushMicrotasks();
    const downCalls = () =>
      notifier.notify.mock.calls.filter((call) =>
        String(call?.[0] || "").includes("🔴 Gateway went down"),
      );
    expect(downCalls().length).toBe(1);
    expect(downCalls()[0][0]).toContain("exit 137");
    expect(downCalls()[0][0]).toContain("AlphaClaw will retry automatically");
    expect(downCalls()[0][1]).toEqual(
      expect.objectContaining({ eventType: "crash" }),
    );
    // Down notices are important (no verbose tag): quiet mode still gets them.
    expect(downCalls()[0][1].verbose).toBe(false);

    // A second crash in the same incident stays silent (once-per-incident).
    watchdog.onGatewayExit({ code: 137, expectedExit: false });
    await flushMicrotasks();
    expect(downCalls().length).toBe(1);
    watchdog.stop();
  });

  it("re-fires the down notice for a NEW incident after recovery closes the first", async () => {
    let healthy = false;
    const { watchdog, notifier } = createHarness({
      autoRepair: false,
      fetchImpl: async () => {
        if (!healthy) throw new Error("gateway unavailable");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      },
    });

    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    const downs = () =>
      notifier.notify.mock.calls.filter(([message]) =>
        String(message).includes("🔴 Gateway went down"),
      );
    expect(downs().length).toBe(1);

    // Recovery closes the incident (and clears the once-per-incident keys)…
    healthy = true;
    await watchdog.runHealthCheck({ source: "test" });
    // …so the NEXT unexpected exit is a new incident with its own notice.
    healthy = false;
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    expect(downs().length).toBe(2);
    watchdog.stop();
  });

  it("formats signal-only and shapeless exits in the down notice", async () => {
    const { watchdog, notifier } = createHarness({ autoRepair: false });
    watchdog.onGatewayExit({ signal: "SIGKILL", expectedExit: false });
    await flushMicrotasks();
    const first = notifier.notify.mock.calls.find((call) =>
      String(call?.[0] || "").includes("🔴 Gateway went down"),
    );
    expect(first[0]).toContain("signal SIGKILL");
    watchdog.stop();

    const shapeless = createHarness({ autoRepair: false });
    shapeless.watchdog.onGatewayExit({ expectedExit: false });
    await flushMicrotasks();
    const call = shapeless.notifier.notify.mock.calls.find((c) =>
      String(c?.[0] || "").includes("🔴 Gateway went down"),
    );
    expect(call[0]).toContain("went down (unexpectedly)");
    shapeless.watchdog.stop();
  });

  it("appends the rescue-session line to incident-class notifications only", async () => {
    vi.useFakeTimers();
    const kRescueLine =
      "🛟 Rescue session: https://box.example/rescue/feedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedfacefeedface";
    let healthChecks = 0;
    const { watchdog, notifier } = createHarness({
      autoRepair: false,
      getRescueSessionLine: () => kRescueLine,
      fetchImpl: async () => {
        healthChecks += 1;
        if (healthChecks === 1) throw new Error("gateway unavailable");
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
    await vi.advanceTimersByTimeAsync(120_000);

    const messages = notifier.notify.mock.calls.map((call) =>
      String(call?.[0] || ""),
    );
    const incidentMessages = messages.filter((message) =>
      message.includes("crash"),
    );
    expect(incidentMessages.length).toBeGreaterThan(0);
    expect(messages.some((message) => message.includes(kRescueLine))).toBe(
      true,
    );
    // Non-incident notifications (the recovery green) stay clean: the line is
    // an incident affordance, not a signature on every message.
    const recovery = messages.find((message) =>
      message.includes("🟢 Gateway running again"),
    );
    expect(recovery).toBeTruthy();
    expect(recovery).not.toContain(kRescueLine);
    watchdog.stop();
  });

  it("never lets a throwing rescue-line consult break a notification", async () => {
    vi.useFakeTimers();
    const { watchdog, notifier } = createHarness({
      autoRepair: false,
      getRescueSessionLine: () => {
        throw new Error("rescue consult boom");
      },
      fetchImpl: async () => {
        throw new Error("gateway unavailable");
      },
    });
    watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.advanceTimersByTimeAsync(0);
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.advanceTimersByTimeAsync(0);
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(notifier.notify).toHaveBeenCalled();
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

  describe("expected-restart window health_check dedupe (WI-6.4)", () => {
    // The skipped rows the window writes: first-of-run rows and summaries.
    const windowRows = (insertWatchdogEvent) =>
      insertWatchdogEvent.mock.calls
        .map(([row]) => row)
        .filter(
          (row) =>
            row.eventType === "health_check" &&
            row.details?.skipped === true &&
            row.details?.expectedRestartActive === true,
        );
    // Bootstrap cadence while health is unknown (kBootstrapHealthCheckMs).
    const kBootstrapProbeMs = 5_000;

    it("logs the FIRST failing probe of the window, counts identical repeats in memory, and writes ONE summary row when the window closes", async () => {
      vi.useFakeTimers();
      try {
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl: async () => {
            throw new Error("connect ECONNREFUSED 127.0.0.1:18789");
          },
        });
        watchdog.onExpectedRestart({ expiresAt: Date.now() + 120_000 });
        await vi.advanceTimersByTimeAsync(10);
        expect(windowRows(insertWatchdogEvent)).toHaveLength(1);
        expect(windowRows(insertWatchdogEvent)[0]).toMatchObject({
          status: "ok",
          details: {
            skipped: true,
            expectedRestartActive: true,
            reason: "connect ECONNREFUSED 127.0.0.1:18789",
          },
        });
        // Four more identical 5s probes: zero new rows (used to be one each).
        await vi.advanceTimersByTimeAsync(4 * kBootstrapProbeMs);
        expect(windowRows(insertWatchdogEvent)).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "restarting",
          health: "unknown",
        });

        // The operation settles → the window closes → one summary row.
        watchdog.onExpectedRestartSettled();
        const rows = windowRows(insertWatchdogEvent);
        expect(rows).toHaveLength(2);
        expect(rows[1]).toMatchObject({
          status: "ok",
          details: {
            skipped: true,
            expectedRestartActive: true,
            reason: "connect ECONNREFUSED 127.0.0.1:18789",
            repeatedProbes: 4,
          },
        });
        expect(Date.parse(rows[1].details.firstAt)).not.toBeNaN();
        expect(Date.parse(rows[1].details.lastAt)).toBeGreaterThanOrEqual(
          Date.parse(rows[1].details.firstAt),
        );
        await vi.advanceTimersByTimeAsync(10);
        watchdog.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a changed probe reason inside the window flushes the previous run's summary and logs the new reason's first row; a run of one writes no summary", async () => {
      vi.useFakeTimers();
      try {
        let reason = "gateway health request failed: a";
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl: async () => {
            throw new Error(reason);
          },
        });
        watchdog.onExpectedRestart({ expiresAt: Date.now() + 120_000 });
        await vi.advanceTimersByTimeAsync(10);
        await vi.advanceTimersByTimeAsync(2 * kBootstrapProbeMs);
        expect(windowRows(insertWatchdogEvent)).toHaveLength(1);

        reason = "gateway health request failed: b";
        await vi.advanceTimersByTimeAsync(kBootstrapProbeMs);
        const afterSwitch = windowRows(insertWatchdogEvent);
        expect(afterSwitch.map((row) => row.details.reason)).toEqual([
          "gateway health request failed: a",
          "gateway health request failed: a",
          "gateway health request failed: b",
        ]);
        // Summary for "a" (first + 2 repeats), then the first row for "b".
        expect(afterSwitch[1].details.repeatedProbes).toBe(2);
        expect(afterSwitch[2].details.repeatedProbes).toBeUndefined();

        // "b" was probed exactly once: closing the window adds no summary.
        watchdog.onExpectedRestartSettled();
        expect(windowRows(insertWatchdogEvent)).toHaveLength(3);
        await vi.advanceTimersByTimeAsync(10);
        watchdog.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a launch inside the window (onGatewayLaunch) closes the run with its summary and later windows start a fresh count", async () => {
      vi.useFakeTimers();
      try {
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl: async () => {
            throw new Error("down");
          },
        });
        watchdog.onExpectedRestart({ expiresAt: Date.now() + 120_000 });
        await vi.advanceTimersByTimeAsync(10);
        await vi.advanceTimersByTimeAsync(3 * kBootstrapProbeMs);
        expect(windowRows(insertWatchdogEvent)).toHaveLength(1);

        // The relaunch lands: the window clears and the run is summarized.
        watchdog.onGatewayLaunch({ pid: 77, startedAt: Date.now() });
        expect(windowRows(insertWatchdogEvent)).toHaveLength(2);
        expect(windowRows(insertWatchdogEvent)[1].details.repeatedProbes).toBe(3);

        // A second window counts from zero again (the post-launch bootstrap
        // cadence is already armed, so probes land on its 5s ticks): two
        // probes → one first row + a summary of exactly one repeat.
        watchdog.onExpectedRestart({ expiresAt: Date.now() + 120_000 });
        await vi.advanceTimersByTimeAsync(10);
        await vi.advanceTimersByTimeAsync(2 * kBootstrapProbeMs);
        watchdog.onExpectedRestartSettled();
        const rows = windowRows(insertWatchdogEvent);
        expect(rows).toHaveLength(4);
        expect(rows[2].details.repeatedProbes).toBeUndefined();
        expect(rows[3].details.repeatedProbes).toBe(1);
        await vi.advanceTimersByTimeAsync(10);
        watchdog.stop();
      } finally {
        vi.useRealTimers();
      }
    });
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
    const { watchdog, insertWatchdogEvent, launchGatewayProcess } =
      createHarness({
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
        if (command === "doctor --fix --yes")
          return { ok: true, stdout: "fixed" };
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
    const { watchdog, clawCmd, launchGatewayProcess, notifier } = createHarness(
      {
        autoRepair: true,
      },
    );

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

  it.each([130, 143])(
    "treats an expected exit with the beta's forwarded-signal code %i as clean, not a crash",
    (code) => {
      // openclaw >= 2026.9.1-beta.1 exits 130 (SIGINT) / 143 (SIGTERM) on
      // forwarded signals instead of dying by the signal — an
      // alphaclaw-initiated stop/restart must enter the expected-restart
      // window, never crash accounting.
      const { watchdog } = createHarness();
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });

      watchdog.onGatewayExit({ code, signal: null, expectedExit: true });

      const status = watchdog.getStatus();
      expect(status.lifecycle).toBe("restarting");
      expect(status.lastExit).toBeNull();
      expect(status.crashCount ?? 0).toBe(0);
    },
  );

  it("still books an UNEXPECTED 143 as a crash (external kill)", () => {
    const { watchdog } = createHarness();
    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });

    watchdog.onGatewayExit({ code: 143, signal: null, expectedExit: false });

    expect(watchdog.getStatus().lastExit).toEqual(
      expect.objectContaining({ code: 143 }),
    );
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
      // QUIET untouched (absent) → verbose stays at its default ON.
      notificationsVerbose: true,
    });
  });

  it("writes the QUIET env flag inverted for notificationsVerbose and reads it back", () => {
    const { watchdog, readEnvFile, writeEnvFile, reloadEnv } = createHarness({
      autoRepair: false,
      notificationsDisabled: false,
    });
    readEnvFile.mockReturnValue([]);
    reloadEnv.mockImplementation(() => {
      process.env.WATCHDOG_NOTIFICATIONS_QUIET = "true";
    });

    const settings = watchdog.updateSettings({ notificationsVerbose: false });

    expect(writeEnvFile).toHaveBeenCalledWith([
      { key: "WATCHDOG_NOTIFICATIONS_QUIET", value: "true" },
    ]);
    expect(settings.notificationsVerbose).toBe(false);
    // Siblings untouched by a narrowed per-field PUT.
    expect(settings.autoRepair).toBe(false);
    expect(settings.notificationsEnabled).toBe(true);

    reloadEnv.mockImplementation(() => {
      process.env.WATCHDOG_NOTIFICATIONS_QUIET = "false";
    });
    const restored = watchdog.updateSettings({ notificationsVerbose: true });
    expect(writeEnvFile).toHaveBeenLastCalledWith([
      { key: "WATCHDOG_NOTIFICATIONS_QUIET", value: "false" },
    ]);
    expect(restored.notificationsVerbose).toBe(true);
  });

  it("uses the injected locked updateEnvFile for the read-modify-write when provided", () => {
    const writes = [];
    const updateEnvFile = vi.fn((mutator) => {
      const next = mutator([{ key: "OPENAI_API_KEY", value: "x" }]);
      writes.push(next);
      return next;
    });
    const { watchdog, readEnvFile, writeEnvFile } = createHarness({
      autoRepair: false,
      notificationsDisabled: false,
      updateEnvFile,
    });

    watchdog.updateSettings({ notificationsVerbose: false });

    // The locked helper owns the whole read-modify-write; the unlocked pair
    // is never touched (two concurrent per-field PUTs can't lose an update).
    expect(updateEnvFile).toHaveBeenCalledTimes(1);
    expect(readEnvFile).not.toHaveBeenCalled();
    expect(writeEnvFile).not.toHaveBeenCalled();
    expect(writes[0]).toEqual([
      { key: "OPENAI_API_KEY", value: "x" },
      { key: "WATCHDOG_NOTIFICATIONS_QUIET", value: "true" },
    ]);
  });

  it("rejects non-boolean coercion for every settings field", () => {
    const { watchdog, writeEnvFile } = createHarness({ autoRepair: false });
    // A string "false" must 400 at the route via this throw — never coerce a
    // truthy string into a suppression.
    expect(() =>
      watchdog.updateSettings({ notificationsVerbose: "false" }),
    ).toThrow(
      "Expected autoRepair, notificationsEnabled, and/or notificationsVerbose boolean",
    );
    // A mistyped field must 400 even when a sibling field is valid — never
    // silently drop it from a mixed payload (pre-landing review).
    expect(() =>
      watchdog.updateSettings({
        autoRepair: true,
        notificationsVerbose: "true",
      }),
    ).toThrow(
      "Expected autoRepair, notificationsEnabled, and/or notificationsVerbose boolean",
    );
    expect(() => watchdog.updateSettings({ autoRepair: "true" })).toThrow();
    expect(() =>
      watchdog.updateSettings({ notificationsEnabled: 1 }),
    ).toThrow();
    expect(writeEnvFile).not.toHaveBeenCalled();
  });

  it("treats exit code 78 as a fatal config error without crash-loop restarts", async () => {
    const {
      watchdog,
      insertWatchdogEvent,
      notifier,
      launchGatewayProcess,
      clawCmd,
    } = createHarness({
      autoRepair: false,
      fetchImpl: async () => {
        throw new Error("gateway unavailable");
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: ["invalid config"],
    });
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
          String(call?.[0] || "").includes(
            "automatic gateway restart is paused",
          ),
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

  it("a manual repair refuses under a reconciler gateway hold — no doctor run, no launch (issue #20 fail-closed)", async () => {
    const clawCalls = [];
    const { watchdog, launchGatewayProcess } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (cmd) => {
        clawCalls.push(String(cmd));
        return { ok: true, stdout: JSON.stringify({ ok: true }) };
      },
      releaseChannelHooks: {
        getInfo: () => ({
          gatewayHold: { reason: "settings migration failed", blamedKeys: ["mystery"] },
        }),
      },
    });

    // Forced (manual) repair is normally the operator's escape hatch — but a
    // hold means doctor --fix would rewrite the very config the hold protects.
    const result = await watchdog.triggerRepair();
    expect(result).toEqual({ ok: false, skipped: true, reason: "gateway_held" });
    expect(clawCalls.some((cmd) => cmd.includes("doctor"))).toBe(false);
    expect(launchGatewayProcess).not.toHaveBeenCalled();
  });

  it("start() preserves a latched configuration_error instead of clobbering it to running", async () => {
    const { watchdog } = createHarness({ autoRepair: false });

    // Boot order under a reconcile hold: latchManualIntervention() first,
    // then startup.js calls watchdog.start() unconditionally. The latch must
    // survive — "running" here reads as down-with-Retry and steers the
    // operator into restarting onto the rejected config.
    watchdog.latchManualIntervention();
    watchdog.start();
    await flushMicrotasks();

    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "configuration_error",
        health: "unhealthy",
      }),
    );

    // Clearing the latch (reconcile-retry flow) restores the normal
    // transition out of the latched state.
    watchdog.clearManualInterventionLatch();
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({ lifecycle: "stopped", health: "unknown" }),
    );
    watchdog.stop();
  });

  it("clearManualInterventionLatch resets the latch and restores normal exit handling", async () => {
    const { watchdog, launchGatewayProcess } = createHarness({
      autoRepair: false,
    });

    watchdog.latchManualIntervention();
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "configuration_error",
        health: "unhealthy",
      }),
    );

    watchdog.clearManualInterventionLatch();
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({ lifecycle: "stopped", health: "unknown" }),
    );

    // With the latch cleared, a gateway exit gets the normal crash-restart
    // handling again instead of the latched skip.
    watchdog.onGatewayExit({ code: 1, expectedExit: false });
    await flushMicrotasks();
    await flushMicrotasks();
    expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({ lifecycle: "running", health: "healthy" }),
    );

    // Idempotent when no latch is active: a running lifecycle is untouched.
    watchdog.clearManualInterventionLatch();
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
    const resumedCall = notifier.notify.mock.calls.find((call) =>
      String(call?.[0] || "").includes("channels resumed"),
    );
    expect(resumedCall).toBeTruthy();
    // "Resumed — pause cleared" is informational: Important-only mode
    // suppresses it (plan Phase-3 pin list).
    expect(resumedCall[1]).toEqual(
      expect.objectContaining({ eventType: "recovery", verbose: true }),
    );
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
              reject(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              ),
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
      {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: false }),
      },
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
    // first degraded retry at t=15s consumes the fourth, then the backoff loop
    // keeps re-arming (5s → 10s → 20s → 30s, holding at the 30s cap) until
    // the regular 120s interval overlaps with a pending retry timer.
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
        if (command === "doctor --fix --yes")
          return { ok: true, stdout: "fixed" };
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
    const { watchdog, launchGatewayProcess, insertWatchdogEvent } =
      createHarness({
        autoRepair: true,
        clawCmdImpl: async (command) => {
          if (command === "doctor --fix --yes")
            return { ok: true, stdout: "fixed" };
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
    const { watchdog, launchGatewayProcess, insertWatchdogEvent } =
      createHarness({
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

  it("rescue-link audit events are incident-neutral: eventType operation, no notification fired", () => {
    // Pins an existing by-construction property (recordOperationEvent logs
    // eventType "operation", outside the incident allowlist) — the rescue
    // route's redeemed/probe events must never open, close, or stamp an
    // incident, and must never fan out a notification.
    const { watchdog, notifier, insertWatchdogEvent } = createHarness({});
    for (const kind of ["rescue_link_redeemed", "rescue_link_probe_failed"]) {
      watchdog.recordOperationEvent({
        kind,
        status: "ok",
        details: { ip: "203.0.113.9", userAgent: "phone", tokenId: "deadbeef" },
      });
      expect(insertWatchdogEvent).toHaveBeenCalledWith(
        expect.objectContaining({ eventType: "operation", source: kind }),
      );
    }
    expect(notifier.notify).not.toHaveBeenCalled();
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
    const { watchdog, launchGatewayProcess, insertWatchdogEvent } =
      createHarness({
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
      "Expected autoRepair, notificationsEnabled, and/or notificationsVerbose boolean",
    );
    expect(() => watchdog.updateSettings()).toThrow(
      "Expected autoRepair, notificationsEnabled, and/or notificationsVerbose boolean",
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

  it("brakes an accepted-handoff relaunch loop after the window cap and falls through to the crash flow", async () => {
    // 2026.8.1 failure mode: a gateway stuck in a restart-request loop writes
    // a handoff row and exits 0 on EVERY boot. Each accepted consume skips
    // crash accounting, so without a brake the crash-loop breaker never
    // engages and the relaunch loop runs forever with no notification.
    const consumeRestartHandoffImpl = vi.fn(async () => ({
      status: "accepted",
      reason: null,
      handoff: { pid: 4242, source: "config-apply", restartKind: "gateway" },
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

    // First 5 accepted-handoff exits within the window: expected-restart
    // handling each time — prompt relaunch, zero crash accounting.
    for (let i = 0; i < 5; i += 1) {
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
      watchdog.onGatewayExit({ code: 0, expectedExit: false, pid: 4242 });
      await flushMicrotasks();
      await flushMicrotasks();
    }
    expect(launchGatewayProcess).toHaveBeenCalledTimes(5);
    expect(insertWatchdogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "crash" }),
    );
    expect(watchdog.getStatus().crashCountInWindow).toBe(0);

    // The 6th accepted exit inside the window trips the brake: the handoff
    // fast path is skipped and the exit takes the normal crash flow, so
    // crash accounting (and, on repeats, backoff + the crash-loop breaker)
    // engages. onGatewayLaunch between iterations must NOT have reset the
    // rolling window — each loop pass is a real launch.
    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
    watchdog.onGatewayExit({ code: 0, expectedExit: false, pid: 4242 });
    await flushMicrotasks();
    await flushMicrotasks();

    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "handoff",
        status: "skipped",
        details: expect.objectContaining({
          reason: "rate_limited",
          relaunchesInWindow: 5,
        }),
      }),
    );
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "crash",
        source: "exit_event",
        status: "failed",
        details: expect.objectContaining({ code: 0 }),
      }),
    );
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "crashed",
        crashCountInWindow: 1,
      }),
    );
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

  it("gates health ticks to a no-op while an exit classification is pending", async () => {
    vi.useFakeTimers();
    let resolveConsume;
    const consumeRestartHandoffImpl = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveConsume = resolve;
        }),
    );
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
      supervisorModeActive: () => true,
      consumeRestartHandoffImpl,
      fetchImpl: async () => {
        throw new Error("gateway restarting");
      },
    });

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
    await vi.advanceTimersByTimeAsync(0);
    const probesBeforeExit = global.fetch.mock.calls.length;

    watchdog.onGatewayExit({ code: 0, expectedExit: false, pid: 4242 });
    expect(watchdog.getStatus().pendingExitClassification).toBe(true);
    const eventsBeforeTicks = insertWatchdogEvent.mock.calls.length;

    // Armed health timers keep firing while the resolver runs (5s bootstrap
    // cadence): every tick must be a no-op — no probe, no logged check, no
    // degraded marking or repair/rollback dispatch racing the resolver.
    await vi.advanceTimersByTimeAsync(20_000);

    expect(global.fetch.mock.calls.length).toBe(probesBeforeExit);
    expect(insertWatchdogEvent.mock.calls.length).toBe(eventsBeforeTicks);
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "unknown",
        pendingExitClassification: true,
      }),
    );

    resolveConsume({
      status: "accepted",
      reason: null,
      handoff: { pid: 4242, source: "config-apply" },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(watchdog.getStatus()).toEqual(
      expect.objectContaining({
        lifecycle: "restarting",
        pendingExitClassification: false,
      }),
    );
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

  it("isReadyForDispatch blocks degraded health but allows the unknown post-launch window", async () => {
    vi.useFakeTimers();
    const readyzState = { degraded: true };
    const { watchdog } = createHarness({
      autoRepair: false,
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
    // Post-launch window: health is still "unknown" until the first probe
    // lands — dispatch stays allowed rather than blocking every fresh boot.
    expect(watchdog.getStatus().health).toBe("unknown");
    expect(watchdog.isReadyForDispatch()).toEqual({ ok: true, reason: "" });

    // Green /health + degraded /readyz marks health degraded while lifecycle
    // stays "running" — an LLM doctor run against a degraded gateway would
    // burn its timeout for nothing, so dispatch must block here too.
    await vi.advanceTimersByTimeAsync(5_000);
    const status = watchdog.getStatus();
    expect(status.lifecycle).toBe("running");
    expect(status.health).toBe("degraded");
    expect(watchdog.isReadyForDispatch()).toEqual({
      ok: false,
      reason: "gateway health is degraded (failing health probes)",
    });

    // Recovery: readiness clears → health returns and dispatch reopens.
    readyzState.degraded = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watchdog.getStatus().health).toBe("healthy");
    expect(watchdog.isReadyForDispatch()).toEqual({ ok: true, reason: "" });
    watchdog.stop();
    vi.useRealTimers();
  });

  it("advisory doctor via the injected collector: null hides nothing behind noise; secret-y output still hints; health stays probe-driven", async () => {
    vi.useFakeTimers();
    const makeReadyzHarness = (collectAdvisoryDoctorJson) => {
      const clawCmdImpl = vi.fn(async () => ({
        ok: true,
        stdout: JSON.stringify({ ok: true }),
      }));
      const harness = createHarness({
        clawCmdImpl,
        collectAdvisoryDoctorJson,
        resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
        fetchImpl: async (url) => ({
          ok: true,
          status: 200,
          text: async () =>
            String(url).includes("readyz")
              ? JSON.stringify({
                  ready: false,
                  failing: ["secrets"],
                  eventLoop: { degraded: true },
                })
              : JSON.stringify({ ok: true, status: "live" }),
        }),
      });
      return { ...harness, clawCmdImpl };
    };

    // Broken doctor CLI: the collector yields null — no crash noise enters
    // the event log, no hint event, and NO raw clawCmd doctor spawn.
    const collectorNull = vi.fn(async () => null);
    const broken = makeReadyzHarness(collectorNull);
    broken.watchdog.start();
    broken.watchdog.onGatewayLaunch({ startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(collectorNull).toHaveBeenCalledTimes(1);
    expect(
      broken.clawCmdImpl.mock.calls.some(([cmd]) => cmd.startsWith("doctor")),
    ).toBe(false);
    expect(
      broken.insertWatchdogEvent.mock.calls.some(
        ([event]) =>
          event.eventType === "readiness_degraded" &&
          event.details?.hint === "doctor reports secret-runtime degradation",
      ),
    ).toBe(false);
    // Health classification is untouched by the broken doctor tool.
    expect(broken.watchdog.getStatus().health).toBe("degraded");
    broken.watchdog.stop?.();

    // Usable doctor output naming a secret failure still produces the hint.
    const collectorSecrets = vi.fn(async () =>
      JSON.stringify({
        ok: false,
        findings: [{ checkId: "secrets.runtime", detail: "secret load failed" }],
      }),
    );
    const hinted = makeReadyzHarness(collectorSecrets);
    hinted.watchdog.start();
    hinted.watchdog.onGatewayLaunch({ startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(collectorSecrets).toHaveBeenCalledTimes(1);
    expect(
      hinted.insertWatchdogEvent.mock.calls.some(
        ([event]) =>
          event.eventType === "readiness_degraded" &&
          event.details?.hint === "doctor reports secret-runtime degradation",
      ),
    ).toBe(true);
    hinted.watchdog.stop?.();
    vi.useRealTimers();
  });

  it("marks health degraded on green /health + degraded /readyz, with one advisory doctor (1.8)", async () => {
    vi.useFakeTimers();
    const readyzState = { degraded: true };
    const clawCmdImpl = vi.fn(async (cmd) => ({
      ok: true,
      stdout: cmd.startsWith("doctor")
        ? JSON.stringify({
            ok: false,
            findings: [
              { checkId: "secrets.runtime", detail: "secret load failed" },
            ],
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
    const { watchdog, insertWatchdogEvent } = createHarness({
      autoRepair: false,
    });

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

  describe("degraded retry backoff", () => {
    // The literal offsets below spell out the documented default schedule
    // (5s → 10s → 20s → 30s cap); pin the defaults so the literals stay honest.
    it("defaults are 5s initial / 30s cap (the literals below assume this)", () => {
      expect(kWatchdogDegradedCheckIntervalMs).toBe(5_000);
      expect(kWatchdogDegradedCheckMaxIntervalMs).toBe(30_000);
    });

    const wait = (ms) =>
      new Promise((resolve) => {
        setTimeout(resolve, ms);
      });

    // Per-URL fetch fake driven by a mutable control object so a test can
    // flip the gateway between up / down / slow / hung mid-timeline. The fake
    // ignores the abort signal on purpose: slow modes stand in for whatever
    // makes a real tick long, so tick duration is fully test-controlled.
    const createFetchControl = () => {
      const control = {
        healthOk: false,
        healthDelayMs: 0,
        healthHang: false,
        pending: [],
        readyzFailing: [],
      };
      const fetchImpl = async (url) => {
        if (String(url).includes("readyz")) {
          return {
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                ready: control.readyzFailing.length === 0,
                failing: control.readyzFailing,
                eventLoop: { degraded: false },
              }),
          };
        }
        if (control.healthHang) {
          return new Promise((resolve, reject) => {
            control.pending.push({ resolve, reject });
          });
        }
        if (control.healthDelayMs > 0) await wait(control.healthDelayMs);
        if (!control.healthOk) throw new Error("gateway down");
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      };
      return { control, fetchImpl };
    };

    const healthChecksFrom = (insertWatchdogEvent, source) =>
      insertWatchdogEvent.mock.calls
        .map((call) => call?.[0])
        .filter(
          (event) =>
            event?.eventType === "health_check" && event?.source === source,
        );

    const failedRetryDetails = (insertWatchdogEvent) =>
      healthChecksFrom(insertWatchdogEvent, "degraded_retry")
        .filter((event) => event.status === "failed")
        .map((event) => event.details?.degradedRetry);

    const advanceUntil = async (predicate, { stepMs = 1_000, maxMs } = {}) => {
      for (let elapsed = 0; elapsed < maxMs; elapsed += stepMs) {
        if (predicate()) return;
        await vi.advanceTimersByTimeAsync(stepMs);
      }
      expect(predicate()).toBe(true);
    };

    // Dead gateway, closed startup grace: the bootstrap probes at t=0/5/10s
    // hit the startup-failure threshold and mark degraded on the third.
    const degradeViaBootstrap = async (watchdog) => {
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
      await advanceUntil(() => watchdog.getStatus().health === "degraded", {
        maxMs: 30_000,
      });
    };

    // Walk one episode to the 30s plateau: +5s → +10s → +20s → +30s.
    const advanceToPlateau = async (watchdog, insertWatchdogEvent) => {
      const before = healthChecksFrom(insertWatchdogEvent, "degraded_retry")
        .length;
      for (const delayMs of [5_000, 10_000, 20_000, 30_000]) {
        await vi.advanceTimersByTimeAsync(delayMs);
      }
      expect(
        healthChecksFrom(insertWatchdogEvent, "degraded_retry"),
      ).toHaveLength(before + 4);
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 4,
        nextDelayMs: 30_000,
        inFlight: false,
      });
    };

    // The next retry lands exactly `delayMs` out — not a tick earlier.
    const expectNextRetryAt = async (watchdog, insertWatchdogEvent, delayMs) => {
      const before = healthChecksFrom(insertWatchdogEvent, "degraded_retry")
        .length;
      await vi.advanceTimersByTimeAsync(delayMs - 1);
      expect(
        healthChecksFrom(insertWatchdogEvent, "degraded_retry"),
      ).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(
        healthChecksFrom(insertWatchdogEvent, "degraded_retry"),
      ).toHaveLength(before + 1);
    };

    it("backs off 5s → 10s → 20s → 30s cap and reports the schedule in status and event details", async () => {
      vi.useFakeTimers();
      const { control, fetchImpl } = createFetchControl();
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
      });

      expect(watchdog.getStatus().degradedRetry).toBeNull();
      await degradeViaBootstrap(watchdog);
      expect(watchdog.getStatus().degradedRetry).toEqual({
        attempt: 0,
        nextDelayMs: 5_000,
        dueAt: new Date(Date.now() + 5_000).toISOString(),
        inFlight: false,
      });
      // The degrade-site row names the retry it just armed.
      const degradeRow = insertWatchdogEvent.mock.calls
        .map((call) => call[0])
        .find(
          (event) =>
            event.eventType === "health_check" && event.status === "failed",
        );
      expect(degradeRow.details.degradedRetry).toEqual({
        attempt: 0,
        nextDelayMs: 5_000,
      });

      // [delay until this retry fires, delay the loop arms after it].
      const schedule = [
        [5_000, 10_000],
        [10_000, 20_000],
        [20_000, 30_000],
        [30_000, 30_000],
        [30_000, 30_000],
      ];
      let fired = 0;
      for (const [delayMs, nextDelayMs] of schedule) {
        await expectNextRetryAt(watchdog, insertWatchdogEvent, delayMs);
        fired += 1;
        expect(watchdog.getStatus().degradedRetry).toEqual({
          attempt: fired,
          nextDelayMs,
          dueAt: new Date(Date.now() + nextDelayMs).toISOString(),
          inFlight: false,
        });
      }
      expect(failedRetryDetails(insertWatchdogEvent)).toEqual([
        { attempt: 1, nextDelayMs: 10_000 },
        { attempt: 2, nextDelayMs: 20_000 },
        { attempt: 3, nextDelayMs: 30_000 },
        { attempt: 4, nextDelayMs: 30_000 },
        { attempt: 5, nextDelayMs: 30_000 },
      ]);

      control.healthOk = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(watchdog.getStatus().health).toBe("healthy");
      expect(watchdog.getStatus().degradedRetry).toBeNull();
      watchdog.stop();
    });

    it("resets the backoff after a real recovery so the next episode starts at 5s", async () => {
      vi.useFakeTimers();
      const { control, fetchImpl } = createFetchControl();
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
      });

      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);

      control.healthOk = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(watchdog.getStatus().health).toBe("healthy");
      expect(watchdog.getStatus().degradedRetry).toBeNull();

      // The regular 120s probe finds the gateway down again: a fresh episode.
      control.healthOk = false;
      await advanceUntil(() => watchdog.getStatus().health === "degraded", {
        maxMs: 130_000,
      });
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 0,
        nextDelayMs: 5_000,
      });
      await expectNextRetryAt(watchdog, insertWatchdogEvent, 5_000);
      watchdog.stop();
    });

    it("starts a fresh 5s episode after an expected restart + relaunch", async () => {
      // Coverage note: onExpectedRestart's own clear is defensive — every
      // route from "restarting" back to an armed loop passes through another
      // resetting clear (onGatewayLaunch below, or the ok path's post-readiness
      // reset), so this pins the end-to-end behavior, not that one line.
      vi.useFakeTimers();
      const { fetchImpl } = createFetchControl();
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
      });

      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);

      watchdog.onExpectedRestart();
      expect(watchdog.getStatus().degradedRetry).toBeNull();
      await vi.advanceTimersByTimeAsync(0);
      // The relaunched gateway reports in (what the launcher does in
      // production) and never answers a probe.
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
      await advanceUntil(() => watchdog.getStatus().health === "degraded", {
        maxMs: 30_000,
      });
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 0,
        nextDelayMs: 5_000,
      });
      await expectNextRetryAt(watchdog, insertWatchdogEvent, 5_000);
      watchdog.stop();
    });

    it("resets the backoff when a successful repair relaunches the gateway", async () => {
      vi.useFakeTimers();
      const { fetchImpl } = createFetchControl();
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } =
        createHarness({
          autoRepair: false,
          clawCmdImpl: async (command) =>
            command === "doctor --fix --yes"
              ? { ok: true, stdout: "fixed" }
              : { ok: true, stdout: "" },
          fetchImpl,
        });

      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);

      const repairPromise = watchdog.triggerRepair();
      await vi.advanceTimersByTimeAsync(0);
      expect((await repairPromise).ok).toBe(true);
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(watchdog.getStatus().health).toBe("unknown");

      // The relaunch reports in through onGatewayLaunch (its clear resets the
      // episode) and the new process never answers either.
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
      expect(watchdog.getStatus().degradedRetry).toBeNull();
      await advanceUntil(() => watchdog.getStatus().health === "degraded", {
        maxMs: 30_000,
      });
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 0,
        nextDelayMs: 5_000,
      });
      await expectNextRetryAt(watchdog, insertWatchdogEvent, 5_000);
      watchdog.stop();
    });

    it("resets the backoff when the stale plateau timer fires after a failed repair", async () => {
      vi.useFakeTimers();
      const { control, fetchImpl } = createFetchControl();
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } =
        createHarness({
          autoRepair: false,
          clawCmdImpl: async (command) =>
            command === "doctor --fix --yes"
              ? { ok: false, stderr: "doctor exploded" }
              : { ok: true, stdout: "" },
          fetchImpl,
        });

      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);

      // Hold the repair's operation_end resync probe open. Left instant, it
      // would fail and re-degrade BEFORE the stale timer fires — which by
      // design continues the armed timer and its counter (same incident).
      control.healthHang = true;
      const repairPromise = watchdog.triggerRepair();
      await vi.advanceTimersByTimeAsync(0);
      expect((await repairPromise).ok).toBe(false);
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(watchdog.getStatus().health).toBe("unhealthy");
      expect(control.pending).toHaveLength(1);

      // The plateau timer fires against a non-degraded gateway: no probe,
      // and the episode's counter is dropped.
      const fetchCallsBefore = global.fetch.mock.calls.length;
      const retriesBefore = healthChecksFrom(
        insertWatchdogEvent,
        "degraded_retry",
      ).length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(global.fetch.mock.calls.length).toBe(fetchCallsBefore);
      expect(
        healthChecksFrom(insertWatchdogEvent, "degraded_retry"),
      ).toHaveLength(retriesBefore);
      expect(watchdog.getStatus().degradedRetry).toBeNull();

      // The resync probe finally reports the gateway down: a fresh episode.
      control.healthHang = false;
      control.pending.shift().reject(new Error("gateway down"));
      await vi.advanceTimersByTimeAsync(0);
      expect(watchdog.getStatus().health).toBe("degraded");
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 0,
        nextDelayMs: 5_000,
      });
      await expectNextRetryAt(watchdog, insertWatchdogEvent, 5_000);
      watchdog.stop();
    });

    it("suppresses fast_cadence while the degraded loop is armed or in flight", async () => {
      vi.useFakeTimers();
      const { control, fetchImpl } = createFetchControl();
      const probeGatewayTcp = vi.fn(async () => {});
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        probeGatewayTcp,
        fetchImpl,
      });

      watchdog.start();
      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);

      // At the 30s plateau with a 4s probe, the probe-stamp gap seen by the
      // 10s TCP watcher exceeds the 30s fast_cadence threshold before the next
      // retry fires — the exact window the gate has to close.
      control.healthDelayMs = 4_000;
      watchdog.setStatusClientsConnected(true);
      const retriesBefore = healthChecksFrom(
        insertWatchdogEvent,
        "degraded_retry",
      ).length;
      for (let tick = 0; tick < 30; tick += 1) {
        await vi.advanceTimersByTimeAsync(kGatewayTcpWatchIntervalMs);
        expect(
          healthChecksFrom(insertWatchdogEvent, "fast_cadence"),
        ).toHaveLength(0);
      }
      // The loop itself kept probing the whole time.
      expect(
        healthChecksFrom(insertWatchdogEvent, "degraded_retry").length,
      ).toBeGreaterThan(retriesBefore + 3);
      expect(watchdog.getStatus().health).toBe("degraded");
      watchdog.stop();
    });

    it("keeps fast_cadence for a degraded gateway with no armed loop (lifecycle restarting)", async () => {
      vi.useFakeTimers();
      const { fetchImpl } = createFetchControl();
      const probeGatewayTcp = vi.fn(async () => {});
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        probeGatewayTcp,
        fetchImpl,
      });

      watchdog.start();
      watchdog.onExpectedRestart();
      // Past the 50s expected-restart window the failures stop being
      // suppressed, but lifecycle is still "restarting" — the degraded loop
      // never arms for that state.
      await vi.advanceTimersByTimeAsync(55_000);
      expect(watchdog.getStatus()).toMatchObject({
        health: "degraded",
        lifecycle: "restarting",
        degradedRetry: null,
      });
      // No retry is pending, so the failed row must not promise one either —
      // the incidents UI renders details.degradedRetry as "next retry in Ns".
      const failedRows = insertWatchdogEvent.mock.calls
        .map((call) => call[0])
        .filter(
          (row) => row.eventType === "health_check" && row.status === "failed",
        );
      expect(failedRows.length).toBeGreaterThanOrEqual(1);
      for (const row of failedRows) {
        expect(row.details.degradedRetry).toBeNull();
      }

      watchdog.setStatusClientsConnected(true);
      await vi.advanceTimersByTimeAsync(
        kWatchdogConnectedHealthCadenceMs + kGatewayTcpWatchIntervalMs,
      );
      expect(
        healthChecksFrom(insertWatchdogEvent, "fast_cadence").length,
      ).toBeGreaterThanOrEqual(1);
      watchdog.stop();
    });

    it("backs off readiness-degraded retries (green /health, failing /readyz) instead of resetting every tick", async () => {
      vi.useFakeTimers();
      const { control, fetchImpl } = createFetchControl();
      control.healthOk = true;
      control.readyzFailing = ["secrets"];
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
        fetchImpl,
      });

      watchdog.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(watchdog.getStatus()).toMatchObject({
        lifecycle: "running",
        health: "degraded",
      });
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 0,
        nextDelayMs: 5_000,
      });

      // Each retry sees a green /health (which clears the timer) and then a
      // failing /readyz (which re-degrades and re-arms in the same tick): the
      // counter must survive that round trip.
      const schedule = [
        [5_000, 10_000],
        [10_000, 20_000],
        [20_000, 30_000],
        [30_000, 30_000],
      ];
      let fired = 0;
      for (const [delayMs, nextDelayMs] of schedule) {
        await expectNextRetryAt(watchdog, insertWatchdogEvent, delayMs);
        fired += 1;
        expect(watchdog.getStatus().health).toBe("degraded");
        expect(watchdog.getStatus().degradedRetry).toMatchObject({
          attempt: fired,
          nextDelayMs,
          inFlight: false,
        });
      }

      // Readiness recovers on the next retry: a real recovery, counter reset.
      control.readyzFailing = [];
      await vi.advanceTimersByTimeAsync(30_000);
      expect(watchdog.getStatus().health).toBe("healthy");
      expect(watchdog.getStatus().degradedRetry).toBeNull();

      // Readiness degrades again: the new episode starts from 5s.
      control.readyzFailing = ["secrets"];
      watchdog.onGatewayTcpTransition();
      await vi.advanceTimersByTimeAsync(kGatewayTcpTransitionDebounceMs);
      expect(watchdog.getStatus().health).toBe("degraded");
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 0,
        nextDelayMs: 5_000,
      });
      await expectNextRetryAt(watchdog, insertWatchdogEvent, 5_000);
      watchdog.stop();
    });

    it("starts a fresh episode when an in-flight retry fails after a tcp_transition recovery, arming exactly one timer", async () => {
      vi.useFakeTimers();
      const { control, fetchImpl } = createFetchControl();
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
      });

      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);

      // The plateau retry fires and its /health probe hangs.
      control.healthHang = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(control.pending).toHaveLength(1);
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 5,
        inFlight: true,
      });

      // A TCP up-transition probe lands meanwhile and sees a live gateway.
      control.healthHang = false;
      control.healthOk = true;
      watchdog.onGatewayTcpTransition();
      await vi.advanceTimersByTimeAsync(kGatewayTcpTransitionDebounceMs);
      expect(watchdog.getStatus().health).toBe("healthy");
      // Counter reset; the only thing left of the loop is the pending probe.
      expect(watchdog.getStatus().degradedRetry).toEqual({
        attempt: 0,
        nextDelayMs: null,
        dueAt: null,
        inFlight: true,
      });

      // The slow probe finally reports down: a failure observed after a
      // confirmed recovery is a NEW episode, not a continuation of the old.
      control.healthOk = false;
      control.pending.shift().reject(new Error("gateway down"));
      await vi.advanceTimersByTimeAsync(0);
      expect(watchdog.getStatus().health).toBe("degraded");
      expect(watchdog.getStatus().degradedRetry).toEqual({
        attempt: 0,
        nextDelayMs: 5_000,
        dueAt: new Date(Date.now() + 5_000).toISOString(),
        inFlight: false,
      });
      expect(failedRetryDetails(insertWatchdogEvent).at(-1)).toEqual({
        attempt: 0,
        nextDelayMs: 5_000,
      });

      // Exactly one armed timer: one retry at +5s, none stacked behind it.
      await expectNextRetryAt(watchdog, insertWatchdogEvent, 5_000);
      const afterFirst = healthChecksFrom(insertWatchdogEvent, "degraded_retry")
        .length;
      await vi.advanceTimersByTimeAsync(9_999);
      expect(
        healthChecksFrom(insertWatchdogEvent, "degraded_retry"),
      ).toHaveLength(afterFirst);
      watchdog.stop();
    });

    it("holds the loop handle through a long tick: status stays in-flight and fast_cadence never fires", async () => {
      vi.useFakeTimers();
      const { control, fetchImpl } = createFetchControl();
      const probeGatewayTcp = vi.fn(async () => {});
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        probeGatewayTcp,
        fetchImpl,
      });

      watchdog.start();
      await degradeViaBootstrap(watchdog);
      watchdog.setStatusClientsConnected(true);

      // A 36s probe outlasts the 30s fast_cadence threshold on its own, so the
      // gate must hold on the in-flight tick, not just on the armed timer.
      control.healthDelayMs = 36_000;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 1,
        inFlight: true,
      });
      const noFastCadence = () =>
        expect(
          healthChecksFrom(insertWatchdogEvent, "fast_cadence"),
        ).toHaveLength(0);
      for (let tick = 0; tick < 3; tick += 1) {
        await vi.advanceTimersByTimeAsync(kGatewayTcpWatchIntervalMs);
        expect(watchdog.getStatus().degradedRetry).toMatchObject({
          attempt: 1,
          inFlight: true,
        });
        noFastCadence();
      }
      await vi.advanceTimersByTimeAsync(kGatewayTcpWatchIntervalMs);
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 1,
        nextDelayMs: 10_000,
        inFlight: false,
      });
      noFastCadence();
      // Further plateau ticks, each longer than the threshold.
      for (let tick = 0; tick < 24; tick += 1) {
        await vi.advanceTimersByTimeAsync(kGatewayTcpWatchIntervalMs);
        expect(watchdog.getStatus().degradedRetry).not.toBeNull();
        noFastCadence();
      }
      watchdog.stop();
    });

    it("an unexpected gateway exit mid-episode disarms the pending retry and resets the counter", async () => {
      vi.useFakeTimers();
      const { fetchImpl } = createFetchControl();
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
      });

      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);

      watchdog.onGatewayExit({ code: 1, expectedExit: false });
      expect(watchdog.getStatus().degradedRetry).toBeNull();
      // The crash relaunch and its operation_end resync settle; the gateway
      // stays down, so lifecycle stays "crashed" and the loop never re-arms.
      await vi.advanceTimersByTimeAsync(0);
      expect(watchdog.getStatus().lifecycle).toBe("crashed");
      expect(watchdog.getStatus().degradedRetry).toBeNull();

      const retriesBefore = healthChecksFrom(
        insertWatchdogEvent,
        "degraded_retry",
      ).length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        healthChecksFrom(insertWatchdogEvent, "degraded_retry"),
      ).toHaveLength(retriesBefore);
      expect(watchdog.getStatus().degradedRetry).toBeNull();
      watchdog.stop();
    });

    it("stop() disarms the pending degraded retry", async () => {
      vi.useFakeTimers();
      const { fetchImpl } = createFetchControl();
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
      });

      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);

      watchdog.stop();
      expect(watchdog.getStatus().degradedRetry).toBeNull();
      const fetchCallsBefore = global.fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(global.fetch.mock.calls.length).toBe(fetchCallsBefore);
      expect(watchdog.getStatus().degradedRetry).toBeNull();
    });

    it("a clear landing while the handle is null but the counter stands still resets it (reset-before-guard)", async () => {
      vi.useFakeTimers();
      const { control, fetchImpl } = createFetchControl();
      // Hold /readyz open on demand: the ok path parks between its clear
      // ({ resetBackoff: false } — handle nulled, counter kept) and the
      // post-readiness reset, exactly the window a clear must still end.
      const readyzHold = { active: false, pending: [] };
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
        fetchImpl: async (url, opts) => {
          if (readyzHold.active && String(url).includes("readyz")) {
            return new Promise((resolve) => {
              readyzHold.pending.push(resolve);
            });
          }
          return fetchImpl(url, opts);
        },
      });

      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);

      control.healthOk = true;
      readyzHold.active = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(readyzHold.pending).toHaveLength(1);
      expect(watchdog.getStatus().health).toBe("healthy");
      // Handle already nulled ({ resetBackoff: false } keeps delay/dueAt
      // describing the fired timer); only the counter matters here.
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 5,
        inFlight: true,
      });

      // A relaunch reports in while the tick is parked: its clear finds no
      // handle to cancel but must still drop the episode's counter.
      control.healthOk = false;
      readyzHold.active = false;
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000 });
      expect(watchdog.getStatus().degradedRetry).toEqual({
        attempt: 0,
        nextDelayMs: null,
        dueAt: null,
        inFlight: true,
      });
      readyzHold.pending.shift()({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ready: true,
            failing: [],
            eventLoop: { degraded: false },
          }),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(watchdog.getStatus().degradedRetry).toBeNull();

      // The relaunched gateway never answers: the new episode starts at 5s,
      // not at the parked tick's 30s plateau.
      await advanceUntil(() => watchdog.getStatus().health === "degraded", {
        maxMs: 30_000,
      });
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 0,
        nextDelayMs: 5_000,
        inFlight: false,
      });
      await expectNextRetryAt(watchdog, insertWatchdogEvent, 5_000);
      watchdog.stop();
    });

    it("ticks skipped by operationInProgress do not inflate the attempt counter", async () => {
      vi.useFakeTimers();
      const { fetchImpl } = createFetchControl();
      let resolveDoctor = null;
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        clawCmdImpl: async (command) =>
          command === "doctor --fix --yes"
            ? new Promise((resolve) => {
                resolveDoctor = resolve;
              })
            : { ok: true, stdout: "" },
        fetchImpl,
      });

      await degradeViaBootstrap(watchdog);
      await expectNextRetryAt(watchdog, insertWatchdogEvent, 5_000);
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 1,
        nextDelayMs: 10_000,
        inFlight: false,
      });

      // A manual repair hangs in doctor, holding operationInProgress: every
      // retry tick early-returns before probing.
      const repairPromise = watchdog.triggerRepair();
      await vi.advanceTimersByTimeAsync(0);
      expect(typeof resolveDoctor).toBe("function");
      const retriesBefore = healthChecksFrom(
        insertWatchdogEvent,
        "degraded_retry",
      ).length;
      const fetchCallsBefore = global.fetch.mock.calls.length;
      for (let tick = 0; tick < 3; tick += 1) {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(watchdog.getStatus().degradedRetry).toMatchObject({
          attempt: 1,
          nextDelayMs: 10_000,
          inFlight: false,
        });
      }
      expect(
        healthChecksFrom(insertWatchdogEvent, "degraded_retry"),
      ).toHaveLength(retriesBefore);
      expect(global.fetch.mock.calls.length).toBe(fetchCallsBefore);

      // The repair fails; its operation_end resync finds the gateway still
      // down, and the loop's next tick is the first real retry since.
      resolveDoctor({ ok: false, stderr: "doctor exploded" });
      expect((await repairPromise).ok).toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(watchdog.getStatus()).toMatchObject({
        health: "degraded",
        lifecycle: "running",
      });
      await expectNextRetryAt(watchdog, insertWatchdogEvent, 10_000);
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 2,
        nextDelayMs: 20_000,
        inFlight: false,
      });
      watchdog.stop();
    });

    it("a rejection inside the retry probe does not kill the loop", async () => {
      vi.useFakeTimers();
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { fetchImpl } = createFetchControl();
      let throwOnNextResolve = false;
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        // The health-URL resolver is the one awaited dependency on a
        // degraded_retry tick that is not already caught: fetch errors are,
        // and auto-repair (with its notifier) never runs from the loop
        // (allowAutoRepair: false).
        resolveGatewayHealthUrl: () => {
          if (throwOnNextResolve) {
            throwOnNextResolve = false;
            throw new Error("gateway config unreadable");
          }
          return "http://127.0.0.1:18789/health";
        },
        fetchImpl,
      });

      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);

      throwOnNextResolve = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(errorSpy).toHaveBeenCalledWith(
        "[watchdog] degraded retry probe threw: gateway config unreadable",
      );
      // The tick counted (it did try to probe) and the loop re-armed.
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 5,
        nextDelayMs: 30_000,
        inFlight: false,
      });
      await expectNextRetryAt(watchdog, insertWatchdogEvent, 30_000);
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 6,
        inFlight: false,
      });
      watchdog.stop();
    });

    it("a failure from another source while the timer is armed reports the remaining time, not f(attempt)", async () => {
      vi.useFakeTimers();
      const { fetchImpl } = createFetchControl();
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
      });

      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);
      const { dueAt } = watchdog.getStatus().degradedRetry;

      // 10s into the 30s plateau timer a TCP transition probe fails too.
      await vi.advanceTimersByTimeAsync(10_000);
      watchdog.onGatewayTcpTransition();
      await vi.advanceTimersByTimeAsync(kGatewayTcpTransitionDebounceMs);
      const tcpRows = healthChecksFrom(insertWatchdogEvent, "tcp_transition");
      expect(tcpRows).toHaveLength(1);
      expect(tcpRows[0].status).toBe("failed");
      const remainingMs = 30_000 - 10_000 - kGatewayTcpTransitionDebounceMs;
      expect(tcpRows[0].details.degradedRetry).toEqual({
        attempt: 4,
        nextDelayMs: remainingMs,
      });
      // The armed timer is untouched: same due time, same counter.
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 4,
        nextDelayMs: 30_000,
        dueAt,
        inFlight: false,
      });
      await expectNextRetryAt(watchdog, insertWatchdogEvent, remainingMs);
      watchdog.stop();
    });

    it("a crash exit landing mid-probe: the in-flight probe's failed row promises no retry", async () => {
      vi.useFakeTimers();
      const { control, fetchImpl } = createFetchControl();
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
      });

      await degradeViaBootstrap(watchdog);
      await advanceToPlateau(watchdog, insertWatchdogEvent);

      // The plateau retry fires and its /health probe hangs.
      control.healthHang = true;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(control.pending).toHaveLength(1);
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 5,
        inFlight: true,
      });

      // The gateway crashes under the hung probe: the exit clears the handle
      // and resets the counter; the relaunch's operation_end resync fails too.
      control.healthHang = false;
      const rowsBefore = insertWatchdogEvent.mock.calls.length;
      watchdog.onGatewayExit({ code: 1, expectedExit: false });
      await vi.advanceTimersByTimeAsync(0);
      expect(watchdog.getStatus().lifecycle).toBe("crashed");

      // The hung probe finally reports down. Neither the schedule at the
      // degrade site nor the callback's re-arm arms anything outside
      // lifecycle "running", so no failed row may promise a retry.
      control.pending.shift().reject(new Error("gateway down"));
      await vi.advanceTimersByTimeAsync(0);
      const failedRows = insertWatchdogEvent.mock.calls
        .slice(rowsBefore)
        .map((call) => call[0])
        .filter(
          (row) => row.eventType === "health_check" && row.status === "failed",
        );
      expect(failedRows.map((row) => row.source)).toEqual(
        expect.arrayContaining(["operation_end", "degraded_retry"]),
      );
      for (const row of failedRows) {
        expect(row.details.degradedRetry).toBeNull();
      }
      expect(watchdog.getStatus().degradedRetry).toBeNull();

      // Nothing re-armed behind the crash.
      const retriesBefore = healthChecksFrom(
        insertWatchdogEvent,
        "degraded_retry",
      ).length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(
        healthChecksFrom(insertWatchdogEvent, "degraded_retry"),
      ).toHaveLength(retriesBefore);
      watchdog.stop();
    });
  });
});

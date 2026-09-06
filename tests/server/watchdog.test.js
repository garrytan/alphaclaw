const { createWatchdog, kRestartVerdicts } = require("../../lib/server/watchdog");
const {
  kGatewayTcpWatchIntervalMs,
  kWatchdogConnectedHealthCadenceMs,
  kGatewayTcpTransitionDebounceMs,
  kWatchdogDegradedCheckIntervalMs,
  kWatchdogDegradedCheckMaxIntervalMs,
  kGatewayRestartReadyTimeoutMs,
  kGatewayRestartOperationBudgetMs,
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
  // v0.9.75 relaunch / identity seams (all optional; the legacy shim over
  // launchGatewayProcess stays in force when requestGatewayLaunch is absent).
  requestGatewayLaunch = null,
  discoverServingIdentity = null,
  readProcStartTicks = null,
  pidAlive = null,
  classifyOwnershipConflict = null,
  degradedRepairThreshold = null,
  restartGatewayColdStart = null,
  restartGatewayForMitigation = null,
  getLaunchGeneration = null,
  readConfigMtimeMs = null,
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
    ...(requestGatewayLaunch ? { requestGatewayLaunch } : {}),
    ...(discoverServingIdentity ? { discoverServingIdentity } : {}),
    ...(readProcStartTicks ? { readProcStartTicks } : {}),
    ...(pidAlive ? { pidAlive } : {}),
    ...(classifyOwnershipConflict ? { classifyOwnershipConflict } : {}),
    ...(degradedRepairThreshold != null ? { degradedRepairThreshold } : {}),
    ...(restartGatewayColdStart ? { restartGatewayColdStart } : {}),
    ...(restartGatewayForMitigation ? { restartGatewayForMitigation } : {}),
    ...(getLaunchGeneration ? { getLaunchGeneration } : {}),
    ...(readConfigMtimeMs ? { readConfigMtimeMs } : {}),
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

  it("retries a crash-loop repair skipped by an in-flight relaunch until the operation settles, keeps retrying while the relaunched child is an unverified replacement, and repairs once that child dies", async () => {
    vi.useFakeTimers();
    let releaseLaunch;
    const launchGate = new Promise((resolve) => {
      releaseLaunch = resolve;
    });
    const { watchdog, clawCmd, launchGatewayProcess, insertWatchdogEvent } = createHarness({
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

      // Relaunch settles → operationInProgress releases, but the relaunched
      // child is now a PENDING replacement (requested, unverified): the next
      // retry is skipped with replacement_pending — a transient reason the
      // ladder keeps retrying on (v0.9.75) — and Doctor still does not run
      // over a child that may come up any second.
      releaseLaunch({ pid: 4242 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(doctorCalls()).toBe(0);
      const skippedPending = () =>
        insertWatchdogEvent.mock.calls
          .map(([row]) => row)
          .filter(
            (row) =>
              row.eventType === "repair" &&
              row.status === "skipped" &&
              row.details?.reason === "replacement_pending",
          );
      expect(skippedPending().length).toBeGreaterThanOrEqual(1);
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });
      // The pending child dies → the obligation fails (replacement_exited) →
      // the crash loop re-enters and the repair the notification promised runs.
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 4242 });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(2000);
      expect(doctorCalls()).toBeGreaterThanOrEqual(1);
      // The repair's own relaunch is the new (repair-owned) pending replacement.
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242, source: "repair" });
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

    // The relaunched child reports in ("listening on" → launch handler):
    // recovery is identity-gated, so a green probe closes the incident only
    // once the replacement has been observed.
    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
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
    const { watchdog, launchGatewayProcess, insertWatchdogEvent } = createHarness({
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
    // The refusal is a ledger row (skipped, with the reason), never a failure.
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "repair",
        source: "manual",
        status: "skipped",
        details: expect.objectContaining({ reason: "gateway_held" }),
      }),
    );
  });

  it("a hold state that cannot be read fails closed for repair too: skipped gateway_hold_unreadable, no doctor run", async () => {
    for (const hooks of [
      { getInfo: () => { throw new Error("state file unreadable"); } },
      { getInfo: () => ({ gatewayHold: null, stateCorrupted: true }) },
    ]) {
      const clawCalls = [];
      const { watchdog, launchGatewayProcess, insertWatchdogEvent } = createHarness({
        autoRepair: true,
        clawCmdImpl: async (cmd) => {
          clawCalls.push(String(cmd));
          return { ok: true, stdout: JSON.stringify({ ok: true }) };
        },
        releaseChannelHooks: hooks,
      });
      const result = await watchdog.triggerRepair();
      expect(result).toEqual({ ok: false, skipped: true, reason: "gateway_hold_unreadable" });
      expect(clawCalls.some((cmd) => cmd.includes("doctor"))).toBe(false);
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(insertWatchdogEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "repair",
          status: "skipped",
          details: expect.objectContaining({ reason: "gateway_hold_unreadable" }),
        }),
      );
    }
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
    // Doctor ran but nothing replaced the gateway: an honest failure, never
    // "ok, awaiting health check" (v0.9.75 runRepair contract).
    expect(noChildResult).toMatchObject({
      ok: false,
      reason: "launch_aborted",
      verdict: "launch_aborted",
      launchedGateway: false,
    });
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
    expect(throwResult).toMatchObject({
      ok: false,
      reason: "launch_failed",
      verdict: "launch_failed",
      launchedGateway: false,
    });
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "restart",
        source: "repair",
        status: "failed",
        details: { error: "spawn failure" },
      }),
    );
    expect(watchdog.getStatus().lastRepairVerdict).toBe("launch_failed");
    // No ok row was ever written for a relaunch that did not happen.
    expect(insertWatchdogEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "restart", source: "repair", status: "ok" }),
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
      // counter must survive that round trip. Not-ready ticks collapse into
      // ONE health_check {readinessPending} row plus a count (v0.9.75), so the
      // cadence is observed on the readyz probes themselves, not on rows.
      const readyzProbes = () =>
        global.fetch.mock.calls.filter(([url]) => String(url).includes("readyz"))
          .length;
      const expectNextReadyzProbeAt = async (delayMs) => {
        const before = readyzProbes();
        await vi.advanceTimersByTimeAsync(delayMs - 1);
        expect(readyzProbes()).toBe(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(readyzProbes()).toBe(before + 1);
      };
      const readinessPendingRows = () =>
        insertWatchdogEvent.mock.calls
          .map(([event]) => event)
          .filter(
            (event) =>
              event.eventType === "health_check" && event.details?.readinessPending,
          );
      const schedule = [
        [5_000, 10_000],
        [10_000, 20_000],
        [20_000, 30_000],
        [30_000, 30_000],
      ];
      let fired = 0;
      for (const [delayMs, nextDelayMs] of schedule) {
        await expectNextReadyzProbeAt(delayMs);
        fired += 1;
        expect(watchdog.getStatus().health).toBe("degraded");
        expect(watchdog.getStatus().readiness).toBe("not_ready");
        expect(watchdog.getStatus().degradedRetry).toMatchObject({
          attempt: fired,
          nextDelayMs,
          inFlight: false,
        });
      }
      // Five not-ready probes so far (start + four retries): one row.
      expect(readinessPendingRows()).toHaveLength(1);

      // Readiness recovers on the next retry: a real recovery, counter reset,
      // and the deduped run closes with ONE summary row.
      control.readyzFailing = [];
      await vi.advanceTimersByTimeAsync(30_000);
      expect(watchdog.getStatus().health).toBe("healthy");
      expect(watchdog.getStatus().readiness).toBe("ready");
      expect(watchdog.getStatus().degradedRetry).toBeNull();
      expect(readinessPendingRows()).toHaveLength(2);
      expect(readinessPendingRows()[1].details).toMatchObject({
        readinessPending: true,
        repeatedProbes: 4,
      });

      // Readiness degrades again: the new episode starts from 5s.
      control.readyzFailing = ["secrets"];
      watchdog.onGatewayTcpTransition();
      await vi.advanceTimersByTimeAsync(kGatewayTcpTransitionDebounceMs);
      expect(watchdog.getStatus().health).toBe("degraded");
      expect(watchdog.getStatus().degradedRetry).toMatchObject({
        attempt: 0,
        nextDelayMs: 5_000,
      });
      await expectNextReadyzProbeAt(5_000);
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

  describe("relaunch outcomes, serving identity, readiness gating (v0.9.75)", () => {
    const kReadyzUrl = "http://127.0.0.1:18789/readyz";
    const rows = (insertWatchdogEvent) =>
      insertWatchdogEvent.mock.calls.map(([event]) => event);
    const rowsOfType = (insertWatchdogEvent, eventType, status = null) =>
      rows(insertWatchdogEvent).filter(
        (event) =>
          event.eventType === eventType &&
          (status == null || event.status === status),
      );
    const restartRows = (insertWatchdogEvent, { source = null, status = null } = {}) =>
      rows(insertWatchdogEvent).filter(
        (event) =>
          event.eventType === "restart" &&
          (source == null || event.source === source) &&
          (status == null || event.status === status),
      );
    const pendingRows = (insertWatchdogEvent, marker) =>
      rows(insertWatchdogEvent).filter(
        (event) => event.eventType === "health_check" && event.details?.[marker],
      );
    const operationRows = (insertWatchdogEvent) =>
      rows(insertWatchdogEvent).filter(
        (event) => event.eventType === "operation" && event.source === "gateway_restart",
      );
    const noticesIncluding = (notifier, text) =>
      notifier.notify.mock.calls
        .map((call) => String(call?.[0] || ""))
        .filter((message) => message.includes(text));
    const doctorFixCalls = (clawCmd) =>
      clawCmd.mock.calls.filter(([command]) => command === "doctor --fix --yes").length;
    const doctorOk = async (command) =>
      command === "doctor --fix --yes"
        ? { ok: true, stdout: "fixed" }
        : { ok: true, stdout: JSON.stringify({ ok: true }) };
    // gateway.requestGatewayLaunch result shape (the contract every lane uses).
    const launchOutcome = (outcome, fields = {}) => ({
      outcome,
      child: null,
      pid: null,
      generation: null,
      serving: null,
      error: null,
      detail: null,
      ...fields,
    });
    const launchRequested = (pid, generation = null) =>
      launchOutcome("launch_requested", { child: { pid }, pid, generation });
    // An incumbent AlphaClaw did not spawn: launcher/supervisor 700 → worker 701.
    const kIncumbentIdentity = { rootPid: 700, workerPid: 701, startTicks: 123456, pids: [700, 701] };
    const adoptedPayload = (identity = kIncumbentIdentity, extra = {}) => ({
      startedAt: Date.now() - 60_000,
      pid: null,
      rootPid: identity.rootPid,
      servingPid: identity.workerPid ?? identity.rootPid,
      workerPid: identity.workerPid ?? null,
      startTicks: identity.startTicks,
      generation: null,
      supervision: "adopted",
      ...extra,
    });
    // Gateway fake: /health answers while control.healthy; /readyz reports
    // control.readyzFailing.
    const createGatewayControl = () => {
      const control = { healthy: true, readyzFailing: [] };
      const fetchImpl = async (url) => {
        if (!control.healthy) throw new Error("gateway unavailable");
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
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, status: "live" }),
        };
      };
      return { control, fetchImpl };
    };
    const settle = async (turns = 4) => {
      for (let i = 0; i < turns; i += 1) await flushMicrotasks();
    };
    const requireLock = () =>
      require("../../lib/server/gateway-lifecycle-lock").createGatewayLifecycleLock;

    it("exports the relaunch verdict vocabulary", () => {
      expect(kRestartVerdicts).toEqual({
        REPLACEMENT_READY: "replacement_ready",
        REPLACEMENT_PENDING: "replacement_pending",
        REPLACEMENT_FAILED: "replacement_failed",
        REPLACEMENT_SUPERSEDED: "replacement_superseded",
        INCUMBENT_ADOPTED: "incumbent_adopted",
        INCUMBENT_UNHEALTHY: "incumbent_unhealthy",
        CHILD_RETAINED: "child_retained",
        LAUNCH_ABORTED: "launch_aborted",
        LAUNCH_FAILED: "launch_failed",
        LEASE_EXPIRED: "lease_expired",
      });
    });

    // ── acceptance b ──────────────────────────────────────────────────────
    it("b. a crash relaunch that finds our own live child is child_retained: a skipped row, no ok row, the follow-up probe verifies", async () => {
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("child_retained", { child: { pid: 4242 }, pid: 4242, generation: 1 }),
      );
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } = createHarness({
        autoRepair: false,
        requestGatewayLaunch,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 4242, rootPid: 4242, generation: 1 });
      await settle();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 4242, generation: 1 });
      await settle();

      expect(requestGatewayLaunch).toHaveBeenCalledTimes(1);
      expect(requestGatewayLaunch).toHaveBeenCalledWith(
        expect.objectContaining({ reconcileIncumbent: true, shouldAbort: expect.any(Function) }),
      );
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "skipped" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            reason: "child_retained",
            pid: 4242,
            generation: 1,
            intent: "relaunch_if_absent",
          }),
        }),
      ]);
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(0);
      expect(restartRows(insertWatchdogEvent, { status: "requested" })).toHaveLength(0);
      expect(watchdog.getStatus().replacementPending).toBeNull();
      watchdog.stop();
    });

    it("b′. under `replace` child_retained is never a verdict: repair recycles the retained child through the cold restart and the #59 verdict + green/ready probe certify it", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("child_retained", { child: { pid: 4242 }, pid: 4242, generation: 1 }),
      );
      const restartGatewayColdStart = vi.fn(async () => ({ ok: true }));
      const { watchdog, insertWatchdogEvent, clawCmd, launchGatewayProcess } = createHarness({
        autoRepair: true,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        clawCmdImpl: doctorOk,
        requestGatewayLaunch,
        restartGatewayColdStart,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 4242, rootPid: 4242, generation: 1 });
      await settle();
      const result = await watchdog.triggerRepair();
      await settle();

      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(restartGatewayColdStart).toHaveBeenCalledTimes(1);
      expect(restartGatewayColdStart).toHaveBeenCalledWith({ shouldAbort: expect.any(Function) });
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "requested" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            intent: "replace",
            coldRestart: true,
            incumbent: "child_retained",
            incumbentPid: 4242,
          }),
        }),
      ]);
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "skipped" })).toHaveLength(0);
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "ok" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ verified: true, intent: "replace" }),
        }),
      ]);
      expect(result).toMatchObject({
        ok: true,
        verifiedHealthy: true,
        launchedGateway: true,
        pending: false,
        verdict: "replacement_ready",
      });
      expect(watchdog.getStatus()).toMatchObject({
        lastRepairVerdict: "replacement_ready",
        replacementPending: null,
        lifecycle: "running",
        health: "healthy",
      });
      watchdog.stop();
    });

    // ── acceptance c (+ Codex 8) ──────────────────────────────────────────
    // Exit-1 ownership wording a LOSING contender prints (verified against
    // 2026.7.1-2 and 2026.9.1-beta.1 — classifyOwnershipConflict pins the
    // regex; this table pins the watchdog's routing of every row). The
    // listener/port wording is NOT here: isDuplicateGatewayLaunchExit still
    // takes it synchronously (the :857 pin).
    const kOwnershipConflictWordings = [
      ["gateway already running (pid 4321); lock timeout after 5000ms", "gateway_conflict", 4321, null],
      ["failed to acquire gateway lock at /root/.openclaw/gateway.lock", "gateway_conflict", null, null],
      ["another OpenClaw process owns state-lifecycle: /root/.openclaw/state-locks/lifecycle.lock", "gateway_conflict", null, null],
      ["gateway already running under external; existing gateway did not become healthy after 30000ms", "gateway_conflict", null, null],
      ["state directory is locked by agent-embedded (pid 4321)", "state_writer_conflict", 4321, "agent-embedded"],
      ["another embedded OpenClaw state writer is active (pid 4321)", "state_writer_conflict", 4321, null],
      ["failed to acquire gateway state ownership", "state_writer_conflict", null, null],
    ];
    it.each(kOwnershipConflictWordings)(
      "c. a losing contender's exit 1 (%s) with a HEALTHY incumbent is benign: no crash count, no launch, no notice, the incumbent's identity adopted",
      async (wording, kind, holderPid, holderRole) => {
        const discoverServingIdentity = vi.fn(() => kIncumbentIdentity);
        const { watchdog, insertWatchdogEvent, notifier, launchGatewayProcess, clawCmd } =
          createHarness({ autoRepair: true, discoverServingIdentity });
        watchdog.onGatewayExit({
          code: 1,
          signal: null,
          expectedExit: false,
          stderrTail: [`Gateway failed to start: ${wording}`],
          launchedAt: Date.now() - 2_000,
        });
        // Deferred: corroborated against the incumbent's /health first.
        expect(watchdog.getStatus().pendingExitClassification).toBe(true);
        await settle();

        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "running",
          crashCountInWindow: 0,
          gatewayPid: null,
          servingPid: 701,
          servingRootPid: 700,
          supervisionMode: "adopted",
          pendingExitClassification: false,
        });
        expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "ok" })).toEqual([
          expect.objectContaining({
            details: expect.objectContaining({
              incumbentConflict: true,
              code: 1,
              conflict: { kind, holderPid, holderRole },
            }),
          }),
        ]);
        expect(rowsOfType(insertWatchdogEvent, "crash")).toHaveLength(0);
        expect(rowsOfType(insertWatchdogEvent, "config_error")).toHaveLength(0);
        expect(launchGatewayProcess).not.toHaveBeenCalled();
        expect(doctorFixCalls(clawCmd)).toBe(0);
        expect(noticesIncluding(notifier, "went down")).toHaveLength(0);
        expect(noticesIncluding(notifier, "holds the state directory")).toHaveLength(0);
        watchdog.stop();
      },
    );

    it("c′. the same exit with NO healthy gateway on the port is an unhealthy gateway conflict: degraded + incident + one notice naming the pid (never the stderr), no crash row, no relaunch, degraded ladder armed", async () => {
      const { watchdog, insertWatchdogEvent, notifier, launchGatewayProcess } = createHarness({
        autoRepair: true,
        fetchImpl: async () => {
          throw new Error("nobody listening");
        },
      });
      watchdog.onGatewayExit({
        code: 1,
        expectedExit: false,
        stderrTail: [
          "Gateway failed to start: gateway already running (pid 4321); lock timeout after 5000ms",
          "SECRET_STDERR_LINE",
        ],
        launchedAt: Date.now() - 2_000,
      });
      await settle();

      expect(watchdog.getStatus()).toMatchObject({
        lifecycle: "running",
        health: "degraded",
        degradedReason: "gateway_conflict_unhealthy",
        crashCountInWindow: 0,
        supervisionMode: "detached",
      });
      expect(rowsOfType(insertWatchdogEvent, "crash")).toHaveLength(0);
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "skipped" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            reason: "incumbent_conflict_unhealthy",
            conflict: { kind: "gateway_conflict", holderPid: 4321, holderRole: null },
            stderrTail: expect.arrayContaining(["SECRET_STDERR_LINE"]),
          }),
        }),
      ]);
      const conflictNotices = noticesIncluding(
        notifier,
        "🔴 Another gateway (pid 4321) holds the state directory but is not healthy — not relaunching into the conflict",
      );
      expect(conflictNotices).toHaveLength(1);
      expect(conflictNotices[0]).not.toContain("SECRET_STDERR_LINE");
      expect(noticesIncluding(notifier, "went down")).toHaveLength(0);
      expect(watchdog.getStatus().degradedRetry).toMatchObject({ attempt: 0 });
      watchdog.stop();
    });

    it("Codex 8. a state-writer holder gets role-aware copy and backoff relaunches ONLY — never doctor --fix, never gateway stop — capped like a crash loop into a latched notice", async () => {
      const { watchdog, insertWatchdogEvent, notifier, launchGatewayProcess, clawCmd } =
        createHarness({
          autoRepair: true,
          clawCmdImpl: doctorOk,
          fetchImpl: async () => {
            throw new Error("nobody listening");
          },
        });
      const conflictExit = () =>
        watchdog.onGatewayExit({
          code: 1,
          expectedExit: false,
          stderrTail: ["Gateway failed to start: state directory is locked by agent-embedded (pid 4321)"],
          launchedAt: Date.now() - 2_000,
        });
      conflictExit();
      await settle();
      expect(watchdog.getStatus()).toMatchObject({
        lifecycle: "running",
        health: "degraded",
        degradedReason: "state_writer_conflict",
        crashCountInWindow: 0,
      });
      expect(
        noticesIncluding(
          notifier,
          "🟡 Another OpenClaw process (agent-embedded, pid 4321) holds the state directory — the gateway will be relaunched once it releases",
        ),
      ).toHaveLength(1);
      expect(rowsOfType(insertWatchdogEvent, "crash")).toHaveLength(0);

      // Sustained failure under the conflict: relaunch with backoff, no Doctor.
      await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(doctorFixCalls(clawCmd)).toBe(0);
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(restartRows(insertWatchdogEvent, { source: "state_writer_conflict", status: "requested" })).toHaveLength(1);

      // The relaunched contender loses again, twice: the crash-loop cap latches.
      for (let round = 0; round < 2; round += 1) {
        conflictExit();
        await settle();
        await watchdog.runHealthCheck({ source: "health_timer" });
        await settle();
      }
      expect(launchGatewayProcess).toHaveBeenCalledTimes(2);
      expect(restartRows(insertWatchdogEvent, { source: "state_writer_conflict", status: "backoff" })).toHaveLength(1);
      expect(watchdog.getStatus()).toMatchObject({ lifecycle: "crash_loop", health: "unhealthy" });
      expect(rowsOfType(insertWatchdogEvent, "crash_loop")).toEqual([
        expect.objectContaining({
          source: "state_writer_conflict",
          details: expect.objectContaining({ holderPid: 4321, holderRole: "agent-embedded" }),
        }),
      ]);
      expect(
        noticesIncluding(notifier, "another OpenClaw process keeps the state directory locked"),
      ).toHaveLength(1);
      expect(doctorFixCalls(clawCmd)).toBe(0);
      expect(clawCmd.mock.calls.some(([command]) => String(command).startsWith("gateway stop"))).toBe(false);
      expect(rowsOfType(insertWatchdogEvent, "crash")).toHaveLength(0);
      watchdog.stop();
    });

    it("5A. the ownership-conflict probe rides the shared exit resolver: a newer launch mid-probe discards its verdict (no incumbentConflict row, no degraded state)", async () => {
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
        code: 1,
        expectedExit: false,
        stderrTail: ["Gateway failed to start: failed to acquire gateway lock at /root/.openclaw/gateway.lock"],
        launchedAt: Date.now(),
      });
      await flushMicrotasks();
      expect(watchdog.getStatus().pendingExitClassification).toBe(true);
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 999 });
      await flushMicrotasks();
      resolveFirstFetch(healthyResponse());
      await settle();

      expect(rows(insertWatchdogEvent).some((event) => event.details?.incumbentConflict)).toBe(false);
      expect(restartRows(insertWatchdogEvent, { status: "skipped" })).toHaveLength(0);
      expect(watchdog.getStatus()).toMatchObject({
        lifecycle: "running",
        gatewayPid: 999,
        pendingExitClassification: false,
        degradedReason: null,
      });
      watchdog.stop();
    });

    // ── acceptance d (+ 9A dedupe, Codex 12 ordering) ─────────────────────
    it("d. a relaunched child that never reports in is replacement_pending — no ok row, deduped liveness rows — and fails as replacement_not_ready once the ready budget passes", async () => {
      vi.useFakeTimers();
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } = createHarness({
        autoRepair: true,
        clawCmdImpl: doctorOk,
      });
      const result = await watchdog.triggerRepair();

      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        ok: true,
        verifiedHealthy: false,
        launchedGateway: true,
        pending: true,
        verdict: "replacement_pending",
      });
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "requested" })).toEqual([
        expect.objectContaining({ details: { pid: 4242, generation: null, intent: "replace" } }),
      ]);
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(0);
      expect(watchdog.getStatus()).toMatchObject({
        lifecycle: "running",
        health: "healthy",
        lastRepairVerdict: "replacement_pending",
        replacementPending: {
          pid: 4242,
          source: "repair",
          intent: "replace",
          since: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
          deadline: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
        },
      });
      // Four more green probes inside the budget (an incumbent answering):
      // still ONE replacementPending row (9A dedupe), still pending.
      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(10_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
      }
      expect(pendingRows(insertWatchdogEvent, "replacementPending")).toEqual([
        expect.objectContaining({
          source: "repair_verify",
          details: expect.objectContaining({ replacementPending: true, pid: 4242 }),
        }),
      ]);
      expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });

      // The ready budget passes; the port still answers green.
      await vi.advanceTimersByTimeAsync(kGatewayRestartReadyTimeoutMs);
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "failed" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            reason: "replacement_not_ready",
            pid: 4242,
            intent: "replace",
            identityObserved: false,
          }),
        }),
      ]);
      // The deduped run closed with its summary: the repair's op-end probe,
      // the four explicit probes and the deadline tick repeated the verify
      // probe's row.
      expect(pendingRows(insertWatchdogEvent, "replacementPending")).toHaveLength(2);
      expect(pendingRows(insertWatchdogEvent, "replacementPending")[1].details).toMatchObject({
        replacementPending: true,
        repeatedProbes: 6,
      });
      expect(watchdog.getStatus()).toMatchObject({
        replacementPending: null,
        lastRepairVerdict: "replacement_failed",
        health: "unhealthy",
        degradedReason: "replacement_not_ready",
      });
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(0);
      watchdog.stop();
    });

    it("Codex 12. the deadline is evaluated AFTER the probe result: identity arriving on the tick that crosses the ready budget still certifies (ok {verified}), never replacement_not_ready", async () => {
      vi.useFakeTimers();
      const { control, fetchImpl } = createGatewayControl();
      const identity = { current: null };
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        discoverServingIdentity: () => identity.current,
      });
      watchdog.onGatewayExit({ code: 1, expectedExit: false });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242, source: "exit_event" });

      await vi.advanceTimersByTimeAsync(kGatewayRestartReadyTimeoutMs + 5_000);
      identity.current = { rootPid: 4242, workerPid: 4243, startTicks: 9, pids: [4242, 4243] };
      control.readyzFailing = [];
      await watchdog.runHealthCheck({ source: "health_timer" });

      expect(
        restartRows(insertWatchdogEvent, { status: "failed" }).filter(
          (event) => event.details.reason === "replacement_not_ready",
        ),
      ).toHaveLength(0);
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toEqual([
        expect.objectContaining({
          source: "exit_event",
          details: expect.objectContaining({ pid: 4242, servingPid: 4243, verified: true }),
        }),
      ]);
      expect(watchdog.getStatus()).toMatchObject({
        replacementPending: null,
        servingPid: 4243,
        servingRootPid: 4242,
        supervisionMode: "managed",
      });
      watchdog.stop();
    });

    // ── acceptance e (+ twin) ─────────────────────────────────────────────
    it("e. /health green over a failing /readyz: no recovery, no 'running again', no onHealthy, onUnhealthy called, one not-ready notice, deduped readinessPending rows, incident kept open; readyz clearing recovers ONCE and certifies the replacement", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const onHealthy = vi.fn();
      const onUnhealthy = vi.fn();
      const { watchdog, insertWatchdogEvent, notifier } = createHarness({
        autoRepair: false,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        releaseChannelHooks: { onHealthy, onUnhealthy },
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
      await settle();
      expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
      onHealthy.mockClear();
      onUnhealthy.mockClear();

      // Crash → incident + relaunch (pending 4242, unobserved).
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
      await settle();
      expect(noticesIncluding(notifier, "went down")).toHaveLength(1);

      // The new child reports in, but /readyz fails.
      control.readyzFailing = ["secrets"];
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242, rootPid: 4242, generation: 2 });
      await settle();
      await watchdog.runHealthCheck({ source: "health_timer" });
      await watchdog.runHealthCheck({ source: "health_timer" });

      expect(watchdog.getStatus()).toMatchObject({
        lifecycle: "running",
        health: "degraded",
        readiness: "not_ready",
        readinessReason: "secrets",
        degradedReason: "readiness_failing",
        replacementPending: expect.objectContaining({ pid: 4242 }),
      });
      expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
      expect(noticesIncluding(notifier, "Gateway running again")).toHaveLength(0);
      expect(onHealthy).not.toHaveBeenCalled();
      expect(onUnhealthy).toHaveBeenCalled();
      expect(noticesIncluding(notifier, "🟡 Gateway is up but not ready — secrets")).toHaveLength(1);
      expect(pendingRows(insertWatchdogEvent, "readinessPending")).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ readinessPending: true, readinessReason: "secrets" }),
        }),
      ]);
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(0);

      // A second crash inside the same incident: the pending child's exit is
      // booked (replacement_exited), the down notice does NOT re-fire, the
      // deduped not-ready run closes with its summary.
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 4242, generation: 2 });
      await settle();
      expect(noticesIncluding(notifier, "went down")).toHaveLength(1);
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "failed" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ reason: "replacement_exited", pid: 4242, generation: 2, code: 1 }),
        }),
      ]);
      expect(pendingRows(insertWatchdogEvent, "readinessPending")).toHaveLength(2);
      expect(pendingRows(insertWatchdogEvent, "readinessPending")[1].details).toMatchObject({
        readinessPending: true,
        repeatedProbes: 2,
      });

      // Readiness clears with the next child: exactly one recovery, one
      // notice, one onHealthy, one verified ok.
      control.readyzFailing = [];
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242, rootPid: 4242, generation: 3 });
      await settle();
      expect(watchdog.getStatus()).toMatchObject({
        health: "healthy",
        readiness: "ready",
        readinessReason: null,
        degradedReason: null,
        replacementPending: null,
      });
      expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
      expect(noticesIncluding(notifier, "Gateway running again")).toHaveLength(1);
      expect(onHealthy).toHaveBeenCalledTimes(1);
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toEqual([
        expect.objectContaining({
          source: "exit_event",
          details: expect.objectContaining({ pid: 4242, generation: 3, verified: true }),
        }),
      ]);
      watchdog.stop();
    });

    it("e′. a THROWING readiness evaluation reads readiness 'unknown' (D5): recovery proceeds with a readiness_probe_error row, but an unknown readiness never certifies the pending replacement", async () => {
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        resolveGatewayReadyzUrl: () => {
          throw new Error("readyz resolver exploded");
        },
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      await settle();
      expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "unknown" });
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100 });
      await settle();
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
      await settle();

      expect(watchdog.getStatus()).toMatchObject({
        lifecycle: "running",
        health: "healthy",
        readiness: "unknown",
        readinessReason: null,
      });
      expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
      const errorRows = rowsOfType(insertWatchdogEvent, "readiness_probe_error", "failed");
      expect(errorRows.length).toBeGreaterThanOrEqual(1);
      expect(errorRows[0].details.error).toContain("readyz resolver exploded");
      // Unknown readiness never proves a replacement ready (Codex pass 2, 6a).
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(0);
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });
      watchdog.stop();
    });

    // ── acceptance f (+ twin) ─────────────────────────────────────────────
    it("f. one transient liveness failure of an established gateway never runs doctor --fix: degraded + skipped {awaiting_sustained_failure}; a green answer resets the count; the third consecutive failure repairs exactly once", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const { watchdog, insertWatchdogEvent, clawCmd, launchGatewayProcess } = createHarness({
        autoRepair: true,
        fetchImpl,
        clawCmdImpl: doctorOk,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      await settle();
      expect(watchdog.getStatus()).toMatchObject({ health: "healthy", degradedRepairThreshold: 3 });

      control.healthy = false;
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(watchdog.getStatus().health).toBe("degraded");
      expect(doctorFixCalls(clawCmd)).toBe(0);
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(rowsOfType(insertWatchdogEvent, "repair", "skipped")).toEqual([
        expect.objectContaining({
          source: "health_timer",
          details: { reason: "awaiting_sustained_failure", failures: 1, threshold: 3 },
        }),
      ]);
      expect(rowsOfType(insertWatchdogEvent, "health_check", "failed").at(-1).details).toMatchObject({
        consecutiveFailures: 1,
      });

      // /health answers: the episode ends, the next one counts from one.
      control.healthy = true;
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(watchdog.getStatus().health).toBe("healthy");
      control.healthy = false;
      await watchdog.runHealthCheck({ source: "health_timer" });
      await watchdog.runHealthCheck({ source: "degraded_retry" });
      expect(doctorFixCalls(clawCmd)).toBe(0);
      expect(
        rowsOfType(insertWatchdogEvent, "repair", "skipped").map((event) => event.details.failures),
      ).toEqual([1, 1, 2]);

      await watchdog.runHealthCheck({ source: "degraded_retry" });
      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(rowsOfType(insertWatchdogEvent, "repair", "ok")).toEqual([
        expect.objectContaining({ source: "degraded_retry" }),
      ]);
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "requested" })).toHaveLength(1);
      watchdog.stop();
    });

    it("f′. degradedRepairThreshold 1 (WATCHDOG_DEGRADED_REPAIR_THRESHOLD=1) is the kill switch: doctor --fix on the first steady-state failure, no skipped row", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const { watchdog, insertWatchdogEvent, clawCmd } = createHarness({
        autoRepair: true,
        fetchImpl,
        clawCmdImpl: doctorOk,
        degradedRepairThreshold: 1,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      await settle();
      expect(watchdog.getStatus().degradedRepairThreshold).toBe(1);
      control.healthy = false;
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(
        rowsOfType(insertWatchdogEvent, "repair", "skipped").filter(
          (event) => event.details.reason === "awaiting_sustained_failure",
        ),
      ).toHaveLength(0);
      watchdog.stop();
    });

    it("eng 4A. the degraded_retry tick itself escalates to repair once sustained: the probe counted (no un-count), the tick settles out of flight, Doctor exactly once", async () => {
      vi.useFakeTimers();
      const { control, fetchImpl } = createGatewayControl();
      control.healthy = false;
      const { watchdog, insertWatchdogEvent, clawCmd, launchGatewayProcess } = createHarness({
        autoRepair: true,
        fetchImpl,
        clawCmdImpl: doctorOk,
        degradedRepairThreshold: 5,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      // Bootstrap: three startup failures → degraded (3 of 5: no repair yet).
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(watchdog.getStatus().health).toBe("degraded");
      expect(doctorFixCalls(clawCmd)).toBe(0);
      const skipped = () => rowsOfType(insertWatchdogEvent, "repair", "skipped");
      expect(skipped().at(-1).details).toMatchObject({
        reason: "awaiting_sustained_failure",
        failures: 3,
        threshold: 5,
      });
      // Retry 1 (+5s): 4 of 5 — the loop's own tick books the skip.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(doctorFixCalls(clawCmd)).toBe(0);
      expect(skipped().at(-1)).toMatchObject({
        source: "degraded_retry",
        details: expect.objectContaining({ failures: 4 }),
      });
      expect(watchdog.getStatus().degradedRetry).toMatchObject({ attempt: 1, inFlight: false });
      // Retry 2 (+10s): 5 of 5 → repair in-tick from the loop's own probe.
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(rowsOfType(insertWatchdogEvent, "repair", "ok")).toEqual([
        expect.objectContaining({ source: "degraded_retry" }),
      ]);
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "requested" })).toHaveLength(1);
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(watchdog.getStatus().operationInProgress).toBe(false);
      expect(watchdog.getStatus().degradedRetry?.inFlight ?? false).toBe(false);
      watchdog.stop();
    });

    // ── acceptance g / h / 7A ─────────────────────────────────────────────
    it("g. confirmed death → exactly one verified replacement: requested on spawn, no ok after the op-end probe, ok {verified: true} only once the generation-matched launch answers green + ready", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const requestGatewayLaunch = vi.fn(async () => launchRequested(4242, 2));
      const generation = { value: 1 };
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } = createHarness({
        autoRepair: false,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        requestGatewayLaunch,
        getLaunchGeneration: () => generation.value,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
      await settle();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
      await settle();

      expect(requestGatewayLaunch).toHaveBeenCalledTimes(1);
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "requested" })).toEqual([
        expect.objectContaining({ details: { pid: 4242, generation: 2, intent: "relaunch_if_absent" } }),
      ]);
      // The op-end probe was green — liveness only, nobody vouched for 4242.
      expect(pendingRows(insertWatchdogEvent, "replacementPending")).toHaveLength(1);
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(0);
      expect(watchdog.getStatus()).toMatchObject({
        replacementPending: expect.objectContaining({ pid: 4242, source: "exit_event", intent: "relaunch_if_absent" }),
        servingPid: null,
        gatewayPid: 100,
      });

      generation.value = 2;
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242, rootPid: 4242, generation: 2 });
      await settle();
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toEqual([
        expect.objectContaining({
          source: "exit_event",
          details: expect.objectContaining({ pid: 4242, generation: 2, intent: "relaunch_if_absent", verified: true }),
        }),
      ]);
      expect(watchdog.getStatus()).toMatchObject({
        replacementPending: null,
        servingPid: 4242,
        servingRootPid: 4242,
        gatewayPid: 4242,
        supervisionMode: "managed",
        health: "healthy",
        readiness: "ready",
      });
      // Later green probes never re-emit ok.
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(1);
      watchdog.stop();
    });

    it("h. a late UNEXPECTED exit of the previous launch generation is a stale predecessor (no crash count, identity untouched); a probe that straddles the launch leaves health unknown; #58's expected-exit guard is unchanged", async () => {
      const pending = [];
      const fetchImpl = () =>
        new Promise((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } = createHarness({
        autoRepair: false,
        fetchImpl,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
      await flushMicrotasks();
      expect(pending).toHaveLength(1); // gen-1 bootstrap probe in flight
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 200, rootPid: 200, generation: 2 });
      await flushMicrotasks();
      expect(pending).toHaveLength(2);

      // The gen-1 probe fails AFTER gen 2 took over: stale, health untouched.
      pending[0].reject(new Error("gen 1 is gone"));
      await settle();
      expect(watchdog.getStatus()).toMatchObject({
        health: "unknown",
        lifecycle: "running",
        gatewayPid: 200,
        servingPid: 200,
      });
      expect(rowsOfType(insertWatchdogEvent, "health_check", "failed")).toHaveLength(0);

      // The gen-1 launcher finally exits, unexpectedly.
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
      await settle();
      expect(watchdog.getStatus()).toMatchObject({
        lifecycle: "running",
        crashCountInWindow: 0,
        gatewayPid: 200,
        servingPid: 200,
        servingRootPid: 200,
      });
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(rowsOfType(insertWatchdogEvent, "crash")).toHaveLength(0);
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "ok" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            stalePredecessor: true,
            expectedExit: false,
            generation: 1,
            currentGeneration: 2,
            pid: 100,
            currentPid: 200,
            code: 1,
          }),
        }),
      ]);

      // Gen 2 answers: healthy.
      pending[1].resolve({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, status: "live" }),
      });
      await settle();
      expect(watchdog.getStatus().health).toBe("healthy");
      // #58: an EXPECTED late exit of a stale pid (no generation) still records stalePredecessor.
      watchdog.onGatewayExit({ code: 143, expectedExit: true, pid: 100 });
      expect(watchdog.getStatus().lifecycle).toBe("running");
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "ok" })).toHaveLength(2);
      watchdog.stop();
    });

    it("7A. generation counters: adopted launches carry no generation (never fenced), a spawned launch stamps one; a gen-1 exit under gen 1 classifies normally, a gen-1 exit after gen 2 is a stale predecessor", async () => {
      const { watchdog, insertWatchdogEvent } = createHarness({ autoRepair: false });
      watchdog.onGatewayLaunch(adoptedPayload());
      watchdog.onGatewayLaunch(adoptedPayload({ rootPid: 800, workerPid: 801, startTicks: 5, pids: [800, 801] }));
      await settle();
      expect(watchdog.getStatus()).toMatchObject({ supervisionMode: "adopted", servingPid: 801 });
      // A generation-stamped exit against an adopted (null) serving generation
      // is never fenced: classified normally (crash 1).
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 800, generation: 5 });
      await settle();
      expect(watchdog.getStatus().crashCountInWindow).toBe(1);
      expect(rowsOfType(insertWatchdogEvent, "crash")).toHaveLength(1);

      // gen 1 serves; its own exit classifies normally (crash 2).
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 100, rootPid: 100, generation: 1 });
      await settle();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
      await settle();
      expect(watchdog.getStatus().crashCountInWindow).toBe(2);

      // gen 2 serves; gen 1's late exit is fenced.
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 200, rootPid: 200, generation: 2 });
      await settle();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
      await settle();
      expect(watchdog.getStatus()).toMatchObject({
        crashCountInWindow: 2,
        lifecycle: "running",
        servingPid: 200,
        supervisionMode: "managed",
      });
      expect(rows(insertWatchdogEvent).filter((event) => event.details?.stalePredecessor)).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ generation: 1, currentGeneration: 2, pid: 100, currentPid: 200 }),
        }),
      ]);
      watchdog.stop();
    });

    // ── acceptance i (lease) ──────────────────────────────────────────────
    it("i. a repair whose Doctor run outlives the lock lease launches nothing: skipped {lease_expired}, lifecycle/attempts untouched, the queued successor holds the lock", async () => {
      vi.useFakeTimers();
      const createGatewayLifecycleLock = requireLock();
      const lock = createGatewayLifecycleLock({ logger: { warn: () => {} } });
      // The repair hold is leased at the Doctor ceiling (10 min) PLUS the
      // cold-restart budget (runRepair); Doctor overruns it here.
      const kRepairLeaseMs = 10 * 60 * 1000 + kGatewayRestartOperationBudgetMs;
      const { watchdog, clawCmd, launchGatewayProcess, insertWatchdogEvent } = createHarness({
        autoRepair: true,
        gatewayLifecycleLock: lock,
        fetchImpl: async () => {
          throw new Error("down");
        },
        clawCmdImpl: async (command) => {
          if (command === "doctor --fix --yes") {
            await new Promise((resolve) => setTimeout(resolve, kRepairLeaseMs + 60_000));
            return { ok: true, stdout: "fixed" };
          }
          return { ok: true, stdout: "" };
        },
      });
      for (let i = 0; i < 3; i += 1) {
        watchdog.onGatewayExit({ code: 1, expectedExit: false });
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(watchdog.getStatus()).toMatchObject({ lifecycle: "crash_loop", crashCountInWindow: 3 });
      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(lock.getActiveOperation()).toMatchObject({ kind: "repair" });
      const launchesBefore = launchGatewayProcess.mock.calls.length;

      // An operator restart queues behind the repair.
      const successor = lock.acquire("restart");
      // The lease fires while Doctor is still running: force-released.
      await vi.advanceTimersByTimeAsync(kRepairLeaseMs + 1);
      const releaseSuccessor = await successor;
      expect(lock.getActiveOperation()).toMatchObject({ kind: "restart" });

      // Doctor finishes late: the repair asks the lock and stands down.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(rowsOfType(insertWatchdogEvent, "repair", "skipped")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "crash_loop",
            details: { reason: "lease_expired", doctorOk: true },
          }),
        ]),
      );
      expect(launchGatewayProcess.mock.calls.length).toBe(launchesBefore);
      expect(restartRows(insertWatchdogEvent, { source: "repair" })).toHaveLength(0);
      expect(watchdog.getStatus()).toMatchObject({
        lifecycle: "crash_loop",
        repairAttempts: 0,
        replacementPending: null,
      });
      expect(lock.getActiveOperation()).toMatchObject({ kind: "restart" });
      releaseSuccessor();
      watchdog.stop();
    });

    it("C. a launch the spawn fence aborted for an expired lease is a skipped {lease_expired} row (no failed row, lifecycle untouched); a hook-aborted launch keeps today's noChildDetails failed row", async () => {
      const requestGatewayLaunch = vi.fn(async () => launchOutcome("launch_aborted", { detail: "lease_expired" }));
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        requestGatewayLaunch,
        fetchImpl: async () => {
          throw new Error("down");
        },
      });
      watchdog.onGatewayExit({ code: 1, expectedExit: false });
      await settle();
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "skipped" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            reason: "lease_expired",
            detail: "lease_expired",
            intent: "relaunch_if_absent",
          }),
        }),
      ]);
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "failed" })).toHaveLength(0);
      expect(watchdog.getStatus()).toMatchObject({ lifecycle: "crashed", replacementPending: null });

      requestGatewayLaunch.mockResolvedValue(launchOutcome("launch_aborted", { detail: "prelaunch_hook" }));
      watchdog.onGatewayExit({ code: 1, expectedExit: false });
      await settle();
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "failed" })).toEqual([
        expect.objectContaining({ details: { reason: "launchGatewayProcess returned no child" } }),
      ]);
      expect(watchdog.getStatus().replacementPending).toBeNull();
      watchdog.stop();
    });

    it("C″. relaunch_if_absent over a port that answers but is NOT healthy: skipped {incumbent_unhealthy}, the degraded ladder owns escalation, nothing spawned, nothing adopted", async () => {
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("incumbent_present", { pid: 700, serving: kIncumbentIdentity }),
      );
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } = createHarness({
        autoRepair: false,
        requestGatewayLaunch,
        fetchImpl: async () => ({ ok: false, status: 503, text: async () => "" }),
      });
      watchdog.onGatewayExit({ code: 1, expectedExit: false });
      await settle();
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "skipped" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ reason: "incumbent_unhealthy", pid: 700, intent: "relaunch_if_absent" }),
        }),
      ]);
      expect(watchdog.getStatus()).toMatchObject({
        lifecycle: "running",
        health: "degraded",
        supervisionMode: "detached",
        servingPid: null,
        replacementPending: null,
      });
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(restartRows(insertWatchdogEvent, { status: "requested" })).toHaveLength(0);
      expect(watchdog.getStatus().degradedRetry).toMatchObject({ attempt: 0 });
      watchdog.stop();
    });

    // ── 1A wedged incumbent → replace ─────────────────────────────────────
    it("1A. a wedged ADOPTED incumbent (alive, not answering) is replaced through the verified cold-restart path after the sustained gate: Doctor once, the cold restart once under the repair hold with the lease fence, requested {intent: replace} → ok {verified: true}, operation ledger trigger 'repair'; adoption while watched never resets health", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("incumbent_present", { pid: 800, serving: { rootPid: 800, workerPid: 801, startTicks: 123456, pids: [800, 801] } }),
      );
      const createGatewayLifecycleLock = requireLock();
      const lock = createGatewayLifecycleLock();
      let heldDuringRestart = null;
      const restartGatewayColdStart = vi.fn(async () => {
        heldDuringRestart = lock.getActiveOperation()?.kind ?? null;
        control.healthy = true;
        return { ok: true };
      });
      const { watchdog, clawCmd, insertWatchdogEvent, launchGatewayProcess, notifier } = createHarness({
        autoRepair: true,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        clawCmdImpl: doctorOk,
        requestGatewayLaunch,
        restartGatewayColdStart,
        pidAlive: () => true,
        readProcStartTicks: () => 123456,
        gatewayLifecycleLock: lock,
      });
      watchdog.onGatewayLaunch(adoptedPayload());
      await settle();
      expect(watchdog.getStatus()).toMatchObject({ health: "healthy", supervisionMode: "adopted", servingPid: 701 });

      control.healthy = false;
      await watchdog.runHealthCheck({ source: "health_timer" });
      const degradedSince = watchdog.getStatus().degradedSince;
      expect(watchdog.getStatus().health).toBe("degraded");
      // Adoption while the gateway is already watched updates identity ONLY —
      // an unhealthy incumbent stays visibly unhealthy.
      watchdog.onGatewayLaunch(
        adoptedPayload({ rootPid: 800, workerPid: 801, startTicks: 123456, pids: [800, 801] }, { startedAt: Date.now() }),
      );
      expect(watchdog.getStatus()).toMatchObject({
        health: "degraded",
        degradedSince,
        servingPid: 801,
        servingRootPid: 800,
        supervisionMode: "adopted",
      });
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(doctorFixCalls(clawCmd)).toBe(0);
      expect(restartGatewayColdStart).not.toHaveBeenCalled();

      // Third consecutive failure: repair in-tick, intent replace.
      await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(restartGatewayColdStart).toHaveBeenCalledTimes(1);
      expect(restartGatewayColdStart).toHaveBeenCalledWith({ shouldAbort: expect.any(Function) });
      expect(heldDuringRestart).toBe("repair");
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "requested" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            intent: "replace",
            coldRestart: true,
            incumbent: "incumbent_present",
            incumbentPid: 800,
          }),
        }),
      ]);
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "skipped" })).toHaveLength(0);
      expect(rows(insertWatchdogEvent).some((event) => event.details?.reason === "incumbent_adopted")).toBe(false);
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "ok" })).toEqual([
        expect.objectContaining({ details: expect.objectContaining({ verified: true, intent: "replace" }) }),
      ]);
      expect(operationRows(insertWatchdogEvent).map((event) => event.status)).toEqual(["started", "ok"]);
      expect(operationRows(insertWatchdogEvent)[0].details).toMatchObject({ trigger: "repair", source: "repair" });
      expect(watchdog.getStatus()).toMatchObject({
        lastRepairVerdict: "replacement_ready",
        replacementPending: null,
        health: "healthy",
        lifecycle: "running",
      });
      expect(noticesIncluding(notifier, "Auto-repair complete, gateway healthy")).toHaveLength(1);
      expect(lock.getActiveOperation()).toBeNull();
      watchdog.stop();
    });

    it("1A′. an incumbent that survives the cold restart (GatewayIncumbentRestartError) is a FAILED replacement, never ok: failed {incumbent_gateway_still_running}, runRepair ok:false, the operation ledger names the reason", async () => {
      const { GatewayIncumbentRestartError } = require("../../lib/server/gateway");
      const { control, fetchImpl } = createGatewayControl();
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("incumbent_present", { pid: 700, serving: kIncumbentIdentity }),
      );
      const restartGatewayColdStart = vi.fn(async () => {
        throw new GatewayIncumbentRestartError(
          "the previous gateway is still running: the gateway port never released after stop",
          { preStopPids: [700], survivingPids: [700], newPids: [] },
        );
      });
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: true,
        fetchImpl,
        clawCmdImpl: doctorOk,
        requestGatewayLaunch,
        restartGatewayColdStart,
        pidAlive: () => true,
        readProcStartTicks: () => 123456,
      });
      watchdog.onGatewayLaunch(adoptedPayload());
      await settle();
      control.healthy = false;
      const result = await watchdog.triggerRepair();
      await settle();

      expect(result).toMatchObject({
        ok: false,
        reason: "replacement_failed",
        verdict: "replacement_failed",
        verifiedHealthy: false,
        launchedGateway: false,
        pending: false,
      });
      expect(restartGatewayColdStart).toHaveBeenCalledTimes(1);
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "failed" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ reason: "incumbent_gateway_still_running", intent: "replace" }),
        }),
      ]);
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(0);
      expect(operationRows(insertWatchdogEvent).map((event) => event.status)).toEqual(["started", "failed"]);
      expect(operationRows(insertWatchdogEvent)[1].details).toMatchObject({
        trigger: "repair",
        reason: "incumbent_gateway_still_running",
      });
      const status = watchdog.getStatus();
      expect(status.health).not.toBe("healthy");
      expect(status).toMatchObject({
        lastRepairVerdict: "replacement_failed",
        replacementPending: null,
        expectedRestartUntil: null,
      });
      watchdog.stop();
    });

    it("2A. the legacy restartGatewayForMitigation name still drives the repair path's replace (alias) — and its ledger rows say trigger 'repair', not 'memory_mitigation'", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const restartGatewayForMitigation = vi.fn(async () => {
        control.healthy = true;
        return { ok: true };
      });
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("incumbent_present", { pid: 700, serving: kIncumbentIdentity }),
      );
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: true,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        clawCmdImpl: doctorOk,
        requestGatewayLaunch,
        restartGatewayForMitigation,
        pidAlive: () => true,
        readProcStartTicks: () => 123456,
      });
      watchdog.onGatewayLaunch(adoptedPayload());
      await settle();
      control.healthy = false;
      const result = await watchdog.triggerRepair();
      await settle();
      expect(restartGatewayForMitigation).toHaveBeenCalledTimes(1);
      expect(restartGatewayForMitigation).toHaveBeenCalledWith({ shouldAbort: expect.any(Function) });
      expect(result).toMatchObject({ ok: true, verdict: "replacement_ready", verifiedHealthy: true });
      expect(operationRows(insertWatchdogEvent).map((event) => event.details.trigger)).toEqual(["repair", "repair"]);
      watchdog.stop();
    });

    // ── 8A supersession / pending blocks relaunches ──────────────────────
    it("8A. an unresolved pending replacement blocks tick-driven repair (one deduped skipped row, no Doctor); a forced repair supersedes it: failed {replacement_superseded}, ONE pending object", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const { watchdog, insertWatchdogEvent, clawCmd } = createHarness({
        autoRepair: true,
        fetchImpl,
        clawCmdImpl: doctorOk,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      await settle();
      control.healthy = false;
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100 });
      await settle();
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242, source: "exit_event" });

      for (let i = 0; i < 4; i += 1) await watchdog.runHealthCheck({ source: "health_timer" });
      expect(doctorFixCalls(clawCmd)).toBe(0);
      expect(
        rowsOfType(insertWatchdogEvent, "repair", "skipped").filter(
          (event) => event.details.reason === "replacement_pending",
        ),
      ).toEqual([
        expect.objectContaining({
          source: "health_timer",
          details: expect.objectContaining({ reason: "replacement_pending", pendingSource: "exit_event", pid: 4242 }),
        }),
      ]);

      const forced = await watchdog.triggerRepair();
      expect(forced).toMatchObject({ ok: true, verdict: "replacement_pending", pending: true });
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "failed" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ reason: "replacement_superseded", pid: 4242, supersededBy: "repair" }),
        }),
      ]);
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242, source: "repair", intent: "replace" });
      watchdog.stop();
    });

    // ── Codex 1 / 2 / 9 / 10 / 11 ─────────────────────────────────────────
    it("Codex 1. identity is proven by snapshot exclusivity: a foreign serving root keeps the pending unobserved (liveness only — no recovery, no onHealthy, incident open); once the launcher is the only root the next green + ready probe certifies", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const onHealthy = vi.fn();
      const identity = { current: { rootPid: 999, workerPid: null, startTicks: 5, pids: [999] } };
      const discoverServingIdentity = vi.fn(() => identity.current);
      const { watchdog, insertWatchdogEvent, notifier } = createHarness({
        autoRepair: false,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        discoverServingIdentity,
        releaseChannelHooks: { onHealthy, onUnhealthy: () => {} },
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
      await settle();
      onHealthy.mockClear();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
      await settle();
      await watchdog.runHealthCheck({ source: "health_timer" });

      expect(discoverServingIdentity).toHaveBeenCalled();
      expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
      expect(onHealthy).not.toHaveBeenCalled();
      expect(noticesIncluding(notifier, "Gateway running again")).toHaveLength(0);
      expect(pendingRows(insertWatchdogEvent, "replacementPending")).toHaveLength(1);
      expect(watchdog.getStatus()).toMatchObject({
        replacementPending: expect.objectContaining({ pid: 4242 }),
        servingPid: null,
      });

      // The foreign root is gone; our launcher's tree is the only serving tree.
      identity.current = { rootPid: 4242, workerPid: 4243, startTicks: 77, pids: [4242, 4243] };
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
      expect(onHealthy).toHaveBeenCalledTimes(1);
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toEqual([
        expect.objectContaining({
          source: "exit_event",
          details: expect.objectContaining({ pid: 4242, servingPid: 4243, verified: true }),
        }),
      ]);
      expect(watchdog.getStatus()).toMatchObject({
        replacementPending: null,
        servingPid: 4243,
        servingRootPid: 4242,
        supervisionMode: "managed",
      });
      watchdog.stop();
    });

    it("Codex 2. a launch handler that fires DURING the launch call is matched through the generation watermark installed before the call; the following green + ready probe books ok", async () => {
      const { fetchImpl } = createGatewayControl();
      const generation = { value: 6 };
      const ref = {};
      const requestGatewayLaunch = vi.fn(async () => {
        generation.value = 7;
        ref.watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242, rootPid: 4242, generation: 7 });
        return launchRequested(4242, 7);
      });
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        requestGatewayLaunch,
        getLaunchGeneration: () => generation.value,
      });
      ref.watchdog = watchdog;
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 6 });
      await settle();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 6 });
      await settle();

      const requested = restartRows(insertWatchdogEvent, { source: "exit_event", status: "requested" });
      expect(requested).toEqual([
        expect.objectContaining({ details: { pid: 4242, generation: 7, intent: "relaunch_if_absent" } }),
      ]);
      const ok = restartRows(insertWatchdogEvent, { status: "ok" });
      expect(ok).toEqual([
        expect.objectContaining({
          source: "exit_event",
          details: expect.objectContaining({ pid: 4242, generation: 7, verified: true }),
        }),
      ]);
      const all = rows(insertWatchdogEvent);
      expect(all.indexOf(requested[0])).toBeLessThan(all.indexOf(ok[0]));
      expect(watchdog.getStatus()).toMatchObject({
        replacementPending: null,
        servingRootPid: 4242,
        gatewayPid: 4242,
      });
      watchdog.stop();
    });

    it("Codex 9. readiness failing on a steady healthy gateway opens its own incident (gateway_readiness): readiness_degraded row, one not-ready notice; readiness clearing closes it with a recovery", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const { watchdog, insertWatchdogEvent, notifier } = createHarness({
        autoRepair: false,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      await settle();
      expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
      expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);

      control.readyzFailing = ["secrets"];
      await watchdog.runHealthCheck({ source: "health_timer" });
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(watchdog.getStatus()).toMatchObject({
        health: "degraded",
        readiness: "not_ready",
        readinessReason: "secrets",
        degradedReason: "readiness_failing",
      });
      expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(1);
      expect(pendingRows(insertWatchdogEvent, "readinessPending")).toHaveLength(1);
      expect(noticesIncluding(notifier, "🟡 Gateway is up but not ready — secrets")).toHaveLength(1);
      expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);

      // Readiness clears: the incident that the not-ready branch opened is
      // what makes this a recovery (no incident → no recovery row).
      control.readyzFailing = [];
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready", degradedReason: null });
      expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "ok")).toHaveLength(1);
      expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
      expect(noticesIncluding(notifier, "Gateway running again")).toHaveLength(1);
      // Closed: a fresh readiness episode opens (and notifies) again.
      control.readyzFailing = ["secrets"];
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(noticesIncluding(notifier, "🟡 Gateway is up but not ready — secrets")).toHaveLength(2);
      watchdog.stop();
    });

    it("Codex 10. probe-detected death needs PID evidence: a port-down probe with the adopted root alive takes the sustained ladder; a dead root (pidAlive false) skips Doctor and relaunches under the crash discipline", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const alive = { value: true };
      const pidAlive = vi.fn(() => alive.value);
      const { watchdog, insertWatchdogEvent, clawCmd, launchGatewayProcess, notifier } = createHarness({
        autoRepair: true,
        fetchImpl,
        clawCmdImpl: doctorOk,
        pidAlive,
        readProcStartTicks: () => 123456,
      });
      watchdog.onGatewayLaunch(adoptedPayload());
      await settle();
      control.healthy = false;

      // Port down, pid alive: not death.
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(pidAlive).toHaveBeenCalledWith(700);
      expect(rowsOfType(insertWatchdogEvent, "crash")).toHaveLength(0);
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(rowsOfType(insertWatchdogEvent, "repair", "skipped")).toEqual([
        expect.objectContaining({ details: expect.objectContaining({ reason: "awaiting_sustained_failure" }) }),
      ]);
      expect(watchdog.getStatus()).toMatchObject({ health: "degraded", supervisionMode: "adopted", servingPid: 701 });

      // The root is gone.
      alive.value = false;
      await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(doctorFixCalls(clawCmd)).toBe(0);
      expect(rowsOfType(insertWatchdogEvent, "crash")).toEqual([
        expect.objectContaining({
          source: "probe_death",
          status: "failed",
          details: expect.objectContaining({
            reason: "process_gone",
            pid: 700,
            evidence: expect.objectContaining({ pid: 700, kind: "pid_gone" }),
          }),
        }),
      ]);
      expect(restartRows(insertWatchdogEvent, { source: "probe_death", status: "requested" })).toHaveLength(1);
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(noticesIncluding(notifier, "went down")).toHaveLength(1);
      expect(watchdog.getStatus()).toMatchObject({
        servingPid: null,
        servingRootPid: null,
        supervisionMode: "detached",
        replacementPending: expect.objectContaining({ pid: 4242, source: "probe_death" }),
      });
      watchdog.stop();
    });

    it("Codex 10′. changed /proc start ticks of the serving root are death evidence too (pid reused); a MANAGED child's port-down probe never takes the fast path (its exit event owns it)", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const ticks = { value: 123456 };
      const { watchdog, insertWatchdogEvent, clawCmd } = createHarness({
        autoRepair: true,
        fetchImpl,
        clawCmdImpl: doctorOk,
        pidAlive: () => true,
        readProcStartTicks: () => ticks.value,
      });
      watchdog.onGatewayLaunch(adoptedPayload());
      await settle();
      control.healthy = false;
      ticks.value = 999;
      await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(doctorFixCalls(clawCmd)).toBe(0);
      expect(rowsOfType(insertWatchdogEvent, "crash")).toEqual([
        expect.objectContaining({
          source: "probe_death",
          details: expect.objectContaining({
            evidence: expect.objectContaining({
              kind: "start_ticks_changed",
              expectedStartTicks: 123456,
              observedStartTicks: 999,
            }),
          }),
        }),
      ]);

      const managed = createHarness({
        autoRepair: true,
        fetchImpl,
        clawCmdImpl: doctorOk,
        pidAlive: () => false,
        readProcStartTicks: () => 1,
      });
      control.healthy = true;
      managed.watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 4242, rootPid: 4242, startTicks: 1, generation: 1 });
      await settle();
      control.healthy = false;
      await managed.watchdog.runHealthCheck({ source: "health_timer" });
      expect(rowsOfType(managed.insertWatchdogEvent, "crash")).toHaveLength(0);
      expect(managed.watchdog.getStatus()).toMatchObject({ health: "degraded", supervisionMode: "managed" });
      watchdog.stop();
      managed.watchdog.stop();
    });

    it("Codex 11. the launch handler is fenced and idempotent: a stale generation is ignored (row), the current (generation, rootPid) redelivered resets nothing but may enrich the worker pid", async () => {
      const { watchdog, insertWatchdogEvent } = createHarness({ autoRepair: false });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 200, rootPid: 200, generation: 2 });
      await settle();
      const settled = watchdog.getStatus();
      expect(settled).toMatchObject({ health: "healthy", servingPid: 200, servingRootPid: 200 });
      const { uptimeStartedAt } = settled;

      // Delayed notification from the predecessor: ignored.
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 100, rootPid: 100, generation: 1 });
      expect(watchdog.getStatus()).toMatchObject({
        health: "healthy",
        servingPid: 200,
        servingRootPid: 200,
        gatewayPid: 200,
        uptimeStartedAt,
      });
      expect(restartRows(insertWatchdogEvent, { source: "launch_event", status: "skipped" })).toEqual([
        expect.objectContaining({
          details: { reason: "stale_launch_generation", generation: 1, currentGeneration: 2, pid: 100 },
        }),
      ]);
      // Redelivery of the current launch: no reset, worker enrichment allowed.
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 200, rootPid: 200, generation: 2, workerPid: 201 });
      expect(watchdog.getStatus()).toMatchObject({
        health: "healthy",
        servingPid: 201,
        servingRootPid: 200,
        uptimeStartedAt,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 200, rootPid: 200, generation: 2, workerPid: 201 });
      expect(watchdog.getStatus()).toMatchObject({ health: "healthy", servingPid: 201, uptimeStartedAt });
      expect(restartRows(insertWatchdogEvent, { source: "launch_event" })).toHaveLength(1);
      watchdog.stop();
    });

    // ── eng 1A / 3A / K ───────────────────────────────────────────────────
    it("eng 1A. runHealthCheck returns a structured result whose truthiness is liveness: false on a failed probe; {probeOk, healthy, ready, identityClear} on green; midRestart inside an armed window certifies nothing; the settle probe demotes only on !probeOk", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const { watchdog } = createHarness({
        autoRepair: false,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      await settle();
      expect(await watchdog.runHealthCheck({ source: "health_timer" })).toMatchObject({
        probeOk: true,
        healthy: true,
        ready: true,
        identityClear: true,
        midRestart: false,
        verdict: null,
      });
      control.readyzFailing = ["secrets"];
      expect(await watchdog.runHealthCheck({ source: "health_timer" })).toMatchObject({
        probeOk: true,
        healthy: false,
        ready: false,
        identityClear: true,
        midRestart: false,
      });
      control.readyzFailing = [];
      control.healthy = false;
      expect(await watchdog.runHealthCheck({ source: "health_timer" })).toBe(false);
      control.healthy = true;

      // Armed window + lifecycle restarting: liveness passed, nothing certified.
      watchdog.onExpectedRestart();
      const mid = await watchdog.runHealthCheck({ source: "health_timer", allowDuringOperation: true });
      expect(mid).toMatchObject({ probeOk: true, healthy: false, ready: false, identityClear: false, midRestart: true });
      expect(!!mid).toBe(true);
      watchdog.onExpectedRestartSettled();
      await settle();
      expect(watchdog.getStatus().lifecycle).toBe("running");

      // A pending, unobserved replacement: truthy but not identity-clear.
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100 });
      await settle();
      expect(await watchdog.runHealthCheck({ source: "health_timer" })).toMatchObject({
        probeOk: true,
        healthy: true,
        identityClear: false,
        verdict: "replacement_pending",
      });
      // Settle over the unverified replacement with a green probe: NOT demoted.
      watchdog.onExpectedRestart();
      watchdog.onExpectedRestartSettled();
      await settle();
      expect(watchdog.getStatus().lifecycle).toBe("running");
      watchdog.stop();
    });

    it("eng 3A. a port answer from the process that JUST exited is a draining corpse, not an incumbent: no adoption, spawn alongside (reconcileIncumbent false); a different healthy root IS adopted", async () => {
      const { fetchImpl } = createGatewayControl();
      const requestGatewayLaunch = vi.fn(async ({ reconcileIncumbent }) =>
        reconcileIncumbent
          ? launchOutcome("incumbent_present", {
              pid: 100,
              serving: { rootPid: 100, workerPid: 101, startTicks: 1, pids: [100, 101] },
            })
          : launchRequested(4242, 2),
      );
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
        requestGatewayLaunch,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
      await settle();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
      await settle();
      expect(requestGatewayLaunch).toHaveBeenCalledTimes(2);
      expect(requestGatewayLaunch.mock.calls[0][0]).toMatchObject({ reconcileIncumbent: true });
      expect(requestGatewayLaunch.mock.calls[1][0]).toMatchObject({ reconcileIncumbent: false });
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "skipped" })).toHaveLength(0);
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "requested" })).toEqual([
        expect.objectContaining({ details: { pid: 4242, generation: 2, intent: "relaunch_if_absent" } }),
      ]);
      expect(watchdog.getStatus().supervisionMode).not.toBe("adopted");
      watchdog.stop();

      const adopt = vi.fn(async () =>
        launchOutcome("incumbent_present", {
          pid: 300,
          serving: { rootPid: 300, workerPid: 301, startTicks: 3, pids: [300, 301] },
        }),
      );
      const second = createHarness({ autoRepair: false, fetchImpl, requestGatewayLaunch: adopt });
      second.watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
      await settle();
      second.watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
      await settle();
      expect(adopt).toHaveBeenCalledTimes(1);
      expect(restartRows(second.insertWatchdogEvent, { source: "exit_event", status: "skipped" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ reason: "incumbent_adopted", pid: 300, servingPid: 301 }),
        }),
      ]);
      // Adopted at a non-running lifecycle (crashed): today's full launch
      // reset — the child AlphaClaw spawned is gone, so gatewayPid is null.
      expect(second.watchdog.getStatus()).toMatchObject({
        lifecycle: "running",
        supervisionMode: "adopted",
        servingPid: 301,
        servingRootPid: 300,
        gatewayPid: null,
        replacementPending: null,
      });
      expect(restartRows(second.insertWatchdogEvent, { status: "requested" })).toHaveLength(0);
      second.watchdog.stop();
    });

    it("K. the EX_CONFIG mtime auto-retry takes the lifecycle lock BEFORE moving its baseline: under a foreign hold it books ONE deduped skipped row per hold and still retries once the hold ends", async () => {
      const createGatewayLifecycleLock = requireLock();
      const lock = createGatewayLifecycleLock();
      const mtime = { value: 100 };
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } = createHarness({
        autoRepair: false,
        gatewayLifecycleLock: lock,
        readConfigMtimeMs: () => mtime.value,
        fetchImpl: async () => {
          throw new Error("down");
        },
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: ["fatal configuration error"] });
      await settle();
      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");

      const releaseRestart = lock.tryAcquire("restart");
      mtime.value = 200;
      await watchdog.runHealthCheck({ source: "health_timer" });
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(rowsOfType(insertWatchdogEvent, "config_error", "skipped")).toEqual([
        expect.objectContaining({
          source: "config_changed",
          details: { reason: "lifecycle_operation_in_progress", mtimeMs: 200 },
        }),
      ]);
      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");

      releaseRestart();
      await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(restartRows(insertWatchdogEvent, { source: "config_changed", status: "requested" })).toHaveLength(1);
      expect(watchdog.getStatus().lifecycle).toBe("restarting");
      expect(lock.getActiveOperation()).toBeNull();
      watchdog.stop();
    });
    // ── Concurrency review (post-merge fixes) ─────────────────────────────
    it("P1. two green probes racing on the same observed pending book exactly ONE verified ok — the verifier re-checks ownership of the obligation after its awaits", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const discoverServingIdentity = vi.fn(() => ({ rootPid: 4242, workerPid: null, startTicks: 9, pids: [4242] }));
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        discoverServingIdentity,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
      await settle();
      // Port down while the child comes up: the operation-end probe fails, so
      // the obligation is still open (unverified) when the race below starts.
      control.healthy = false;
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
      await settle();
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(0);

      control.healthy = true;
      await Promise.all([
        watchdog.runHealthCheck({ source: "health_timer" }),
        watchdog.runHealthCheck({ source: "fast_cadence" }),
        watchdog.runHealthCheck({ source: "tcp_transition" }),
      ]);

      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(1);
      expect(watchdog.getStatus().replacementPending).toBeNull();
      // A later green probe finds nothing to certify and books nothing.
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(1);
      watchdog.stop();
    });

    it("P2a. a forced repair whose relaunch is aborted by the prelaunch hook does NOT destroy the in-flight replacement obligation: no replacement_superseded row, the crash relaunch's pending survives and is verified later", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const requestGatewayLaunch = vi
        .fn()
        .mockResolvedValueOnce(launchRequested(4242, 1))
        .mockResolvedValueOnce({
          outcome: "launch_aborted",
          child: null,
          pid: null,
          generation: null,
          serving: null,
          error: null,
          detail: "prelaunch_hook",
        });
      const discoverServingIdentity = vi.fn(() => ({ rootPid: 4242, workerPid: null, startTicks: 3, pids: [4242] }));
      const { watchdog, insertWatchdogEvent, clawCmd } = createHarness({
        autoRepair: true,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        clawCmdImpl: doctorOk,
        requestGatewayLaunch,
        discoverServingIdentity,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 0 });
      await settle();
      control.healthy = false;
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 0 });
      await settle();
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242, source: "exit_event" });

      const forced = await watchdog.triggerRepair();
      expect(forced).toMatchObject({ ok: false, reason: "launch_aborted" });
      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(
        restartRows(insertWatchdogEvent, { status: "failed" }).filter(
          (row) => row.details.reason === "replacement_superseded",
        ),
      ).toHaveLength(0);
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242, source: "exit_event" });

      control.healthy = true;
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "ok" })).toEqual([
        expect.objectContaining({ details: expect.objectContaining({ pid: 4242, verified: true }) }),
      ]);
      expect(watchdog.getStatus().replacementPending).toBeNull();
      watchdog.stop();
    });

    // ── Quality / contract review (post-merge fixes) ─────────────────────
    it("C-P2. a state-writer conflict is LATCHED across its own backoff relaunch: a re-exit outside the startup window and a relaunch that hangs to the pending deadline both stay on the relaunch ladder (no Doctor, no cold restart), crashCountInWindow stays 0, degradedSince is armed", async () => {
      vi.useFakeTimers();
      const { kGatewayRestartReadyTimeoutMs } = require("../../lib/server/constants");
      const { control, fetchImpl } = createGatewayControl();
      const coldRestart = vi.fn(async () => ({ ok: true }));
      const { watchdog, insertWatchdogEvent, clawCmd } = createHarness({
        autoRepair: true,
        fetchImpl,
        clawCmdImpl: doctorOk,
        restartGatewayColdStart: coldRestart,
      });
      try {
        const wording = [
          "Gateway failed to start: state directory is locked by agent-embedded (pid 4321); lock timeout after 5000ms",
        ];
        watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
        await vi.advanceTimersByTimeAsync(0);
        control.healthy = false; // nobody serves the port: the holder is a non-gateway writer
        watchdog.onGatewayExit({
          code: 1,
          expectedExit: false,
          pid: 100,
          generation: 1,
          stderrTail: wording,
          launchedAt: Date.now() - 2_000,
        });
        await vi.advanceTimersByTimeAsync(20);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", degradedReason: "state_writer_conflict" });
        expect(watchdog.getStatus().degradedSince).toBeTruthy();

        // A failing tick takes the relaunch ladder, never Doctor.
        await watchdog.runHealthCheck({ source: "health_timer" });
        await vi.advanceTimersByTimeAsync(20);
        expect(doctorFixCalls(clawCmd)).toBe(0);
        expect(restartRows(insertWatchdogEvent, { source: "state_writer_conflict", status: "requested" })).toHaveLength(1);
        expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242, source: "state_writer_conflict" });

        // The relaunched contender re-exits with conflict wording OUTSIDE the
        // 60s startup window: still a conflict (latched), never a crash.
        watchdog.onGatewayExit({
          code: 1,
          expectedExit: false,
          pid: 4242,
          stderrTail: wording,
          launchedAt: Date.now() - 120_000,
        });
        await vi.advanceTimersByTimeAsync(20);
        expect(rowsOfType(insertWatchdogEvent, "crash")).toHaveLength(0);
        expect(watchdog.getStatus().crashCountInWindow).toBe(0);
        expect(watchdog.getStatus().degradedReason).toBe("state_writer_conflict");

        // Second relaunch; this one hangs on the lock until the pending
        // deadline. Past the ready budget the obligation fails and the
        // degraded ladder re-enters — and still never reaches Doctor or the
        // `replace` cold restart.
        await watchdog.runHealthCheck({ source: "health_timer" });
        await vi.advanceTimersByTimeAsync(20);
        expect(restartRows(insertWatchdogEvent, { source: "state_writer_conflict", status: "requested" })).toHaveLength(2);
        await vi.advanceTimersByTimeAsync(kGatewayRestartReadyTimeoutMs + 5_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        await vi.advanceTimersByTimeAsync(20);
        expect(doctorFixCalls(clawCmd)).toBe(0);
        expect(coldRestart).not.toHaveBeenCalled();
        expect(rowsOfType(insertWatchdogEvent, "crash")).toHaveLength(0);
        expect(watchdog.getStatus().crashCountInWindow).toBe(0);
        expect(
          rowsOfType(insertWatchdogEvent, "repair", "skipped").filter(
            (row) => row.details.reason === "state_writer_conflict",
          ).length,
        ).toBeGreaterThanOrEqual(0);
        expect(
          restartRows(insertWatchdogEvent, { source: "state_writer_conflict", status: "requested" }).length,
        ).toBeGreaterThanOrEqual(2);
      } finally {
        watchdog.stop();
        vi.useRealTimers();
      }
    });

    it("C-P3. a redelivered ADOPTED launch payload (generation null) is idempotent: no servingSeq bump, so a probe in flight is not discarded as stale", async () => {
      let resolveHealth = null;
      const fetchImpl = () =>
        new Promise((resolve) => {
          resolveHealth = () =>
            resolve({
              ok: true,
              status: 200,
              text: async () => JSON.stringify({ ok: true, status: "live" }),
            });
        });
      const { watchdog } = createHarness({ autoRepair: false, fetchImpl });
      const adopted = {
        startedAt: Date.now() - 60_000,
        pid: null,
        servingPid: 900,
        rootPid: 900,
        startTicks: 5,
        generation: null,
        supervision: "adopted",
      };
      watchdog.onGatewayLaunch(adopted);
      const probe = watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      watchdog.onGatewayLaunch({ ...adopted, startedAt: Date.now() }); // redelivery
      resolveHealth();
      await probe;
      expect(watchdog.getStatus()).toMatchObject({
        health: "healthy",
        supervisionMode: "adopted",
        servingPid: 900,
        servingRootPid: 900,
      });
      watchdog.stop();
    });

  });
});

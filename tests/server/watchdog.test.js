const {
  createWatchdog,
  kRestartVerdicts,
  kAdvisoryDoctorFloorMs,
  kReadyzListMaxEntries,
  kReadyzEntryMaxChars,
  kReadyzBodyMaxChars,
} = require("../../lib/server/watchdog");
const {
  kGatewayTcpWatchIntervalMs,
  kWatchdogConnectedHealthCadenceMs,
  kGatewayTcpTransitionDebounceMs,
  kWatchdogDegradedCheckIntervalMs,
  kWatchdogDegradedCheckMaxIntervalMs,
  kWatchdogCheckIntervalMs,
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
  // #76 A2: async state-DB schema reader stamped onto `requested` rows.
  readStateDbVersions = null,
  // #76 A3: pure stderr crash classifier + async corroboration-facts reader.
  classifyGatewayCrash = null,
  readCrashFacts = null,
  // Stage 3 (#76 B1 / C2): structural repair instance, persisted-pause seams,
  // the relaunch compat step and the pause's acceptance hold.
  structuralRepair = null,
  readPersistedPause = null,
  writePersistedPause = null,
  assessLaunchCompatibility = null,
  acceptanceHoldMs = null,
  // #76 C6: the explicit-bin command primitive and the streamed doctor
  // runner — runRepair's doctor step routes through one of them while a
  // version mismatch is latched.
  clawCmdWithBin = null,
  repairRunner = null,
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
    ...(readStateDbVersions ? { readStateDbVersions } : {}),
    ...(classifyGatewayCrash ? { classifyGatewayCrash } : {}),
    ...(readCrashFacts ? { readCrashFacts } : {}),
    ...(structuralRepair ? { structuralRepair } : {}),
    ...(readPersistedPause ? { readPersistedPause } : {}),
    ...(writePersistedPause ? { writePersistedPause } : {}),
    ...(assessLaunchCompatibility ? { assessLaunchCompatibility } : {}),
    ...(acceptanceHoldMs != null ? { acceptanceHoldMs } : {}),
    ...(clawCmdWithBin ? { clawCmdWithBin } : {}),
    ...(repairRunner ? { repairRunner } : {}),
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

  it("a structural version_mismatch hold (#76 C2 launch gate) refuses repair for EVERY source — manual included — no doctor run, no launch; the ledger row names the hold class", async () => {
    const clawCalls = [];
    const { watchdog, launchGatewayProcess, insertWatchdogEvent } = createHarness({
      autoRepair: true,
      clawCmdImpl: async (cmd) => {
        clawCalls.push(String(cmd));
        return { ok: true, stdout: JSON.stringify({ ok: true }) };
      },
      releaseChannelHooks: {
        getInfo: () => ({
          gatewayHold: {
            reason: "version_mismatch",
            blamedKeys: [],
            installed: "2026.7.1-2",
            expected: "2026.9.1-beta.1",
            bootId: "boot-1",
          },
        }),
      },
    });

    // doctor --fix from a binary that cannot read the DB is the exact #76
    // mutation the hold exists to prevent; a forced manual repair is no
    // escape hatch either.
    expect(await watchdog.triggerRepair()).toEqual({ ok: false, skipped: true, reason: "gateway_held" });
    expect(await watchdog.runRepair({ source: "crash_loop", correlationId: "c-1" })).toEqual({
      ok: false,
      skipped: true,
      reason: "gateway_held",
    });
    expect(clawCalls.some((cmd) => cmd.includes("doctor"))).toBe(false);
    expect(launchGatewayProcess).not.toHaveBeenCalled();
    expect(insertWatchdogEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "repair",
        source: "manual",
        status: "skipped",
        details: { reason: "gateway_held", hold: "version_mismatch" },
      }),
    );
  });

  it("a caller-supplied hold reason never grants Doctor permission to rewrite held configuration", async () => {
    const mkHooks = (reason) => ({
      getInfo: () => ({
        gatewayHold: { reason, blamedKeys: [], installed: "2026.9.1-beta.1", expected: "2026.9.1-beta.1", bootId: "boot-1" },
      }),
    });
    const owned = createHarness({
      autoRepair: true,
      clawCmdImpl: async (command) =>
        command === "doctor --fix --yes"
          ? { ok: true, stdout: "fixed" }
          : { ok: true, stdout: JSON.stringify({ ok: true }) },
      releaseChannelHooks: mkHooks("version_mismatch"),
    });
    const repaired = await owned.watchdog.runRepair({
      source: "repair/structural",
      correlationId: "c-2",
      force: true,
      ownedHoldReasons: ["version_mismatch"],
    });
    expect(repaired).toEqual({ ok: false, skipped: true, reason: "gateway_held" });
    expect(owned.clawCmd.mock.calls.some((call) => String(call[0]).includes("doctor"))).toBe(false);
    expect(owned.launchGatewayProcess).not.toHaveBeenCalled();

    // Owning version_mismatch says nothing about a corrupt-DB hold.
    const foreign = createHarness({ autoRepair: true, releaseChannelHooks: mkHooks("state_db_unreadable") });
    expect(
      await foreign.watchdog.runRepair({
        source: "repair/structural",
        correlationId: "c-3",
        force: true,
        ownedHoldReasons: ["version_mismatch"],
      }),
    ).toEqual({ ok: false, skipped: true, reason: "gateway_held" });
    expect(foreign.launchGatewayProcess).not.toHaveBeenCalled();

    // An unreadable hold state refuses regardless of what the caller owns.
    const unreadable = createHarness({
      autoRepair: true,
      releaseChannelHooks: { getInfo: () => ({ gatewayHold: null, stateCorrupted: true }) },
    });
    expect(
      await unreadable.watchdog.runRepair({
        source: "repair/structural",
        correlationId: "c-4",
        force: true,
        ownedHoldReasons: ["version_mismatch"],
      }),
    ).toEqual({ ok: false, skipped: true, reason: "gateway_hold_unreadable" });
  });

  describe("which binary runs doctor (#76 C6 / Codex 8)", () => {
    const kExpectedBin = "/root/openclaw-overlay/2026.9.2/node_modules/openclaw/openclaw.mjs";
    const kResolved = {
      bin: kExpectedBin,
      version: "2026.9.2",
      packageDir: "/root/openclaw-overlay/2026.9.2/node_modules/openclaw",
      source: "overlay",
      compatible: true,
      reasons: [],
    };
    const okClaw = async () => ({ ok: true, stdout: JSON.stringify({ ok: true }) });
    const latchBootMismatch = (watchdog) =>
      watchdog.setBootVerdict({
        bootId: "40:1700000000000",
        serverPhase: { verdict: ["installed_not_expected"] },
        openclaw: { expected: "2026.9.2", installedAtBoot: "2026.7.1-2", resolvedForLaunch: "2026.7.1-2" },
      });
    const repairRows = (insertWatchdogEvent) =>
      insertWatchdogEvent.mock.calls.map((call) => call[0]).filter((row) => row.eventType === "repair");
    const doctorFromPath = (clawCmd) =>
      clawCmd.mock.calls.some(([command]) => String(command).includes("doctor --fix"));

    it("with a version mismatch latched, the clawCmd fallback runs doctor through clawCmdWithBin on the bin compatibleBinForCurrentDb resolves — never `openclaw` on PATH — the relaunch proceeds and the ledger row names the build", async () => {
      const compatibleBinForCurrentDb = vi.fn(async () => kResolved);
      const clawCmdWithBin = vi.fn(async () => ({ ok: true, stdout: "fixed", stderr: "" }));
      const { watchdog, clawCmd, launchGatewayProcess, insertWatchdogEvent } = createHarness({
        autoRepair: true,
        clawCmdImpl: okClaw,
        clawCmdWithBin,
        releaseChannelHooks: {
          getInfo: () => ({ gatewayHold: null, installedDiverged: false }),
          compatibleBinForCurrentDb,
        },
      });
      expect(latchBootMismatch(watchdog)).toMatchObject({ source: "boot" });

      const result = await watchdog.triggerRepair();

      expect(result.ok).toBe(true);
      expect(compatibleBinForCurrentDb).toHaveBeenCalledTimes(1);
      expect(clawCmdWithBin).toHaveBeenCalledTimes(1);
      const [bin, command, options] = clawCmdWithBin.mock.calls[0];
      expect(bin).toBe(kExpectedBin);
      expect(command).toBe("doctor --fix --yes");
      expect(options).toEqual(expect.objectContaining({ quiet: true, timeoutMs: expect.any(Number) }));
      expect(doctorFromPath(clawCmd)).toBe(false);
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      const okRow = repairRows(insertWatchdogEvent).find((row) => row.status === "ok");
      expect(okRow.source).toBe("manual");
      expect(okRow.details).toMatchObject({
        ok: true,
        stdout: "fixed",
        doctorBin: { version: "2026.9.2", source: "overlay" },
      });
    });

    it("the channel info's installedDiverged alone (no boot/crash latch, no status tick to run the channel memo) routes the same way — read from the hold gate's own hooks snapshot", async () => {
      const compatibleBinForCurrentDb = vi.fn(async () => kResolved);
      const clawCmdWithBin = vi.fn(async () => ({ ok: true, stdout: "fixed", stderr: "" }));
      const getInfo = vi.fn(() => ({
        gatewayHold: null,
        installedDiverged: true,
        installedVersion: "2026.7.1-2",
        expectedVersion: "2026.9.2",
      }));
      const { watchdog, clawCmd } = createHarness({
        autoRepair: true,
        clawCmdImpl: okClaw,
        clawCmdWithBin,
        releaseChannelHooks: { getInfo, compatibleBinForCurrentDb },
      });
      // No getStatus() before the repair: the 5 s channel memo (which would
      // latch a channel-sourced mismatch) has not run — the gate must see
      // the divergence from the hooks read runRepair itself performs.
      expect(getInfo).not.toHaveBeenCalled();

      const result = await watchdog.runRepair({ source: "crash_loop", correlationId: "c-6" });

      expect(result.ok).toBe(true);
      expect(compatibleBinForCurrentDb).toHaveBeenCalledTimes(1);
      expect(clawCmdWithBin).toHaveBeenCalledTimes(1);
      expect(clawCmdWithBin.mock.calls[0][0]).toBe(kExpectedBin);
      expect(doctorFromPath(clawCmd)).toBe(false);
    });

    it("nothing resolvable → repair/<source>/skipped {version_mismatch, expected, running}: no doctor from ANY binary, no launch, no lock; one row per automatic source, every manual attempt logs; a throwing resolver is the same refusal with the error on the row", async () => {
      const compatibleBinForCurrentDb = vi.fn(async () => null);
      const clawCmdWithBin = vi.fn();
      const lockAcquire = vi.fn(() => () => {});
      const { watchdog, clawCmd, launchGatewayProcess, insertWatchdogEvent } = createHarness({
        autoRepair: true,
        clawCmdImpl: okClaw,
        clawCmdWithBin,
        gatewayLifecycleLock: { tryAcquire: lockAcquire },
        releaseChannelHooks: {
          getInfo: () => ({ gatewayHold: null, installedDiverged: false }),
          compatibleBinForCurrentDb,
        },
      });
      latchBootMismatch(watchdog);

      expect(await watchdog.triggerRepair()).toEqual({ ok: false, skipped: true, reason: "version_mismatch" });
      expect(await watchdog.triggerRepair()).toEqual({ ok: false, skipped: true, reason: "version_mismatch" });
      expect(await watchdog.runRepair({ source: "crash_loop", correlationId: "c-7" })).toEqual({
        ok: false,
        skipped: true,
        reason: "version_mismatch",
      });
      expect(await watchdog.runRepair({ source: "crash_loop", correlationId: "c-8" })).toEqual({
        ok: false,
        skipped: true,
        reason: "version_mismatch",
      });

      expect(compatibleBinForCurrentDb).toHaveBeenCalledTimes(4);
      expect(clawCmdWithBin).not.toHaveBeenCalled();
      expect(doctorFromPath(clawCmd)).toBe(false);
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(lockAcquire).not.toHaveBeenCalled();
      expect(watchdog.getStatus().repairAttempts).toBe(0);
      const skips = repairRows(insertWatchdogEvent).filter(
        (row) => row.status === "skipped" && row.details?.reason === "version_mismatch",
      );
      // manual ×2 (the operator asked, both log), crash_loop ×1 (deduped).
      expect(skips.map((row) => row.source)).toEqual(["manual", "manual", "crash_loop"]);
      expect(skips[0].details).toEqual({
        reason: "version_mismatch",
        expected: "2026.9.2",
        running: "2026.7.1-2",
      });
      expect(skips[2].correlationId).toBe("c-7");

      const throwing = createHarness({
        autoRepair: true,
        clawCmdImpl: okClaw,
        clawCmdWithBin: vi.fn(),
        releaseChannelHooks: {
          getInfo: () => ({ gatewayHold: null, installedDiverged: true }),
          compatibleBinForCurrentDb: async () => {
            throw new Error("state db busy");
          },
        },
      });
      expect(await throwing.watchdog.triggerRepair()).toEqual({
        ok: false,
        skipped: true,
        reason: "version_mismatch",
      });
      expect(doctorFromPath(throwing.clawCmd)).toBe(false);
      expect(repairRows(throwing.insertWatchdogEvent).at(-1).details).toEqual({
        reason: "version_mismatch",
        expected: null,
        running: null,
        error: "state db busy",
      });
    });

    it("without a latched mismatch or a diverged tree the resolver is never consulted and doctor runs from PATH as before", async () => {
      const compatibleBinForCurrentDb = vi.fn(async () => kResolved);
      const clawCmdWithBin = vi.fn();
      const { watchdog, clawCmd, launchGatewayProcess } = createHarness({
        autoRepair: true,
        clawCmdImpl: okClaw,
        clawCmdWithBin,
        releaseChannelHooks: {
          getInfo: () => ({ gatewayHold: null, installedDiverged: false }),
          compatibleBinForCurrentDb,
        },
      });

      expect((await watchdog.triggerRepair()).ok).toBe(true);

      expect(compatibleBinForCurrentDb).not.toHaveBeenCalled();
      expect(clawCmdWithBin).not.toHaveBeenCalled();
      expect(clawCmd).toHaveBeenCalledWith("doctor --fix --yes", expect.objectContaining({ quiet: true }));
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
    });

    it("the streamed repairRunner (production wiring) receives the resolved bin — null while PATH is fine, the compatible bin once a mismatch is latched", async () => {
      const repairRunner = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));
      const compatibleBinForCurrentDb = vi.fn(async () => kResolved);
      const { watchdog, clawCmd } = createHarness({
        autoRepair: true,
        clawCmdImpl: okClaw,
        repairRunner,
        releaseChannelHooks: {
          getInfo: () => ({ gatewayHold: null, installedDiverged: false }),
          compatibleBinForCurrentDb,
        },
      });

      expect((await watchdog.triggerRepair()).ok).toBe(true);
      expect(repairRunner).toHaveBeenLastCalledWith({ correlationId: expect.any(String), bin: null });
      expect(compatibleBinForCurrentDb).not.toHaveBeenCalled();

      latchBootMismatch(watchdog);
      expect((await watchdog.triggerRepair()).ok).toBe(true);
      expect(repairRunner).toHaveBeenLastCalledWith({ correlationId: expect.any(String), bin: kExpectedBin });
      expect(compatibleBinForCurrentDb).toHaveBeenCalledTimes(1);
      expect(doctorFromPath(clawCmd)).toBe(false);
    });

    it("a wiring that can NAME the compatible bin but not RUN it is refused at construction (never a silent fallback to PATH)", () => {
      expect(() =>
        createHarness({
          releaseChannelHooks: { getInfo: () => ({}), compatibleBinForCurrentDb: async () => null },
        }),
      ).toThrow(/compatibleBinForCurrentDb requires clawCmdWithBin or repairRunner/);
      // Either runner satisfies it.
      expect(() =>
        createHarness({
          repairRunner: async () => ({ ok: true }),
          releaseChannelHooks: { getInfo: () => ({}), compatibleBinForCurrentDb: async () => null },
        }),
      ).not.toThrow();
    });
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

  it("notifies once the Doctor budget is exhausted after repeated manual failures (manual repairs themselves keep running — the cap gates automatic sources only)", async () => {
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
    // Stage 3 (F015): the notice says what actually stops — Doctor for the
    // automatic sources — and never claims a pause (crash relaunches go on).
    const exhausted = notifier.notify.mock.calls.find((call) =>
      String(call?.[0] || "").includes("Auto-repair attempts exhausted (2/2)"),
    );
    expect(exhausted).toBeTruthy();
    expect(String(exhausted[0])).toContain("crash relaunches continue with backoff");
    expect(String(exhausted[0])).toContain("Use Repair from the Watchdog tab");
    expect(String(exhausted[0])).not.toContain("Auto-repair paused");
    expect(exhausted[1]).toEqual(
      expect.objectContaining({ id: expect.stringMatching(/^repair-attempts-exhausted-2-\d{8}$/) }),
    );
    // A third MANUAL repair still runs Doctor (force bypasses the cap).
    const third = await watchdog.triggerRepair();
    expect(third.skipped).toBeUndefined();
    expect(watchdog.getStatus().repairAttempts).toBe(3);
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

  it("#87 advisory doctor via the injected collector: null hides nothing behind noise; a structured runtime secret finding lands as ONE readiness_advisory row; hygiene-only findings do not; health stays probe-driven", async () => {
    vi.useFakeTimers();
    const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
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
    const advisoryRows = (insertWatchdogEvent) =>
      insertWatchdogEvent.mock.calls
        .map(([event]) => event)
        .filter((event) => event.eventType === "readiness_advisory");

    // Broken doctor CLI: the collector yields null — no crash noise enters
    // the event log, no advisory row, NO raw clawCmd doctor spawn, and one
    // console line names the drop (`unusable`).
    const collectorNull = vi.fn(async () => null);
    const broken = makeReadyzHarness(collectorNull);
    broken.watchdog.start();
    broken.watchdog.onGatewayLaunch({ startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(collectorNull).toHaveBeenCalledTimes(1);
    expect(
      broken.clawCmdImpl.mock.calls.some(([cmd]) => cmd.startsWith("doctor")),
    ).toBe(false);
    expect(advisoryRows(broken.insertWatchdogEvent)).toHaveLength(0);
    expect(
      consoleLog.mock.calls.some(([line]) =>
        String(line).includes("readiness advisory dropped (unusable)"),
      ),
    ).toBe(true);
    // Health classification is untouched by the broken doctor tool.
    expect(broken.watchdog.getStatus().health).toBe("degraded");
    broken.watchdog.stop?.();

    // Usable doctor output with the REAL runtime finding (security-audit
    // shape, OpenClaw 2026.9.3) while the same degradation is current → one
    // structured readiness_advisory row under the probe's correlationId.
    const collectorSecrets = vi.fn(async () =>
      JSON.stringify({
        ok: false,
        findings: [
          {
            checkId: "gateway.probe_auth_secretref_unavailable",
            severity: "warn",
            title: "Gateway auth SecretRef unavailable",
            detail: "SecretRef env:GATEWAY_TOKEN could not be resolved at probe time",
            remediation: "Set the referenced environment variable.",
          },
        ],
      }),
    );
    const hinted = makeReadyzHarness(collectorSecrets);
    hinted.watchdog.start();
    hinted.watchdog.onGatewayLaunch({ startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(collectorSecrets).toHaveBeenCalledTimes(1);
    const rows = advisoryRows(hinted.insertWatchdogEvent);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("warn");
    expect(rows[0].details.finding).toEqual({
      checkId: "gateway.probe_auth_secretref_unavailable",
      severity: "warning",
      kind: "runtime",
      component: "secrets",
      message: expect.stringContaining("SecretRef"),
    });
    expect(rows[0].details.episode).toBe(1);
    expect(typeof rows[0].details.observedAt).toBe("string");
    expect(typeof rows[0].details.doctorSettledAt).toBe("string");
    const opening = hinted.insertWatchdogEvent.mock.calls
      .map(([event]) => event)
      .find((event) => event.eventType === "readiness_degraded" && event.status === "failed");
    expect(rows[0].correlationId).toBe(opening.correlationId);
    // The legacy prose hint is gone for good.
    expect(
      hinted.insertWatchdogEvent.mock.calls.some(
        ([event]) => event.details?.hint === "doctor reports secret-runtime degradation",
      ),
    ).toBe(false);
    hinted.watchdog.stop?.();

    // Hygiene-only findings (plaintext secrets in config) are Drift Doctor's
    // job: no advisory row, console line `hygiene_only`.
    const collectorHygiene = vi.fn(async () =>
      JSON.stringify({
        findings: [
          { checkId: "config.plaintext_secrets", severity: "warn", title: "Plaintext secrets" },
          { checkId: "config.secrets.gateway_password_in_config", severity: "warn", detail: "x" },
        ],
      }),
    );
    const hygiene = makeReadyzHarness(collectorHygiene);
    hygiene.watchdog.start();
    hygiene.watchdog.onGatewayLaunch({ startedAt: Date.now() });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(advisoryRows(hygiene.insertWatchdogEvent)).toHaveLength(0);
    expect(
      consoleLog.mock.calls.some(([line]) =>
        String(line).includes("readiness advisory dropped (hygiene_only)"),
      ),
    ).toBe(true);
    hygiene.watchdog.stop?.();
    consoleLog.mockRestore();
    vi.useRealTimers();
  });

  it("marks health degraded on green /health + degraded /readyz, with one detached advisory doctor --lint --json (1.8, #87)", async () => {
    vi.useFakeTimers();
    const readyzState = { degraded: true };
    const clawCmdImpl = vi.fn(async (cmd) => ({
      ok: true,
      stdout: cmd.startsWith("doctor")
        ? JSON.stringify({
            ok: false,
            findings: [
              {
                checkId: "gateway.probe_auth_secretref_unavailable",
                severity: "warn",
                title: "Gateway auth SecretRef unavailable",
                detail: "SecretRef could not be resolved",
              },
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
    expect(status.readiness).toBe("not_ready");
    expect(status.eventLoopDegraded).toBe(true);
    expect(status.readyzFailing).toEqual(["secrets"]);
    // The transition logged once and ran ONE advisory `doctor --lint --json`
    // (the contract's verified invocation — never bare `doctor --json`),
    // detached from the probe; its finding landed as a readiness_advisory row.
    const doctorCalls = () =>
      clawCmdImpl.mock.calls.filter(([cmd]) => cmd.startsWith("doctor --lint --json"));
    expect(doctorCalls()).toHaveLength(1);
    expect(clawCmdImpl.mock.calls.some(([cmd]) => cmd === "doctor --json")).toBe(false);
    expect(
      insertWatchdogEvent.mock.calls.filter(
        ([event]) => event.eventType === "readiness_degraded" && event.status === "failed",
      ),
    ).toHaveLength(1);
    expect(
      insertWatchdogEvent.mock.calls.filter(
        ([event]) => event.eventType === "readiness_advisory",
      ),
    ).toHaveLength(1);
    // No restart/repair was driven by readiness degradation.
    expect(status.repairAttempts).toBe(0);

    // A second tick with the SAME degradation does not re-run the doctor.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(doctorCalls()).toHaveLength(1);

    // Recovery: readiness clears → health returns to healthy on the next check.
    readyzState.degraded = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(watchdog.getStatus().health).toBe("healthy");
    expect(watchdog.getStatus().readiness).toBe("ready");
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

      // The slow probe finally reports down. #87 fence 1 ("newest completed
      // wins"): the tcp_transition probe that saw the gateway alive COMPLETED
      // and applied after this one started, so the stale failure is
      // discarded — no failed row, no degradation, nothing armed, one console
      // line. An older observation never lands over a newer one.
      const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      const failedBefore = failedRetryDetails(insertWatchdogEvent).length;
      control.healthOk = false;
      control.pending.shift().reject(new Error("gateway down"));
      await vi.advanceTimersByTimeAsync(0);
      expect(watchdog.getStatus().health).toBe("healthy");
      expect(watchdog.getStatus().degradedRetry).toBeNull();
      expect(failedRetryDetails(insertWatchdogEvent)).toHaveLength(failedBefore);
      expect(
        consoleLog.mock.calls.some(([line]) =>
          /probe #\d+ \(degraded_retry\) superseded by #\d+ — discarded/.test(String(line)),
        ),
      ).toBe(true);
      consoleLog.mockRestore();

      // A failure the gateway shows NEXT is a NEW episode, not a continuation
      // of the old: attempt 0, f(0) = 5s.
      watchdog.onGatewayTcpTransition();
      await vi.advanceTimersByTimeAsync(kGatewayTcpTransitionDebounceMs);
      expect(watchdog.getStatus().health).toBe("degraded");
      expect(watchdog.getStatus().degradedRetry).toEqual({
        attempt: 0,
        nextDelayMs: 5_000,
        dueAt: new Date(Date.now() + 5_000).toISOString(),
        inFlight: false,
      });
      expect(
        healthChecksFrom(insertWatchdogEvent, "tcp_transition").at(-1).details.degradedRetry,
      ).toEqual({
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
      // #87 fence 1: the relaunch's operation_end probe COMPLETED and applied
      // its failed verdict while this one hung, so the older degraded_retry
      // failure is discarded (console line only) — the only failed row after
      // the crash is operation_end's.
      expect(failedRows.map((row) => row.source)).toEqual(["operation_end"]);
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
    // control.readyzFailing. #87 controls: eventLoopDegraded / eventLoopReasons
    // / eventLoopDelayP99Ms (the diagnostic block), ready (force the native
    // flag), readyzStatus (started|starting|draining), readyzHttpStatus (503
    // for a transitional body, 404 for an older gateway, 500 → unavailable),
    // readyzBody (raw override → malformed), readyzHang (hangs until the
    // watchdog's AbortController fires → timeout), readyzThrow (connection
    // error → unavailable), readyzDelayMs (slow /readyz, observation taken at
    // answer time), and the hold queues healthHold/pendingHealth +
    // readyzHold/pendingReadyz for overlap tests (entries are
    // { resolve, reject }; release with control.healthResponse() /
    // control.readyzResponse(overrides) or reject(new Error(...))).
    const createGatewayControl = () => {
      const control = {
        healthy: true,
        readyzFailing: [],
        eventLoopDegraded: false,
        eventLoopReasons: [],
        eventLoopDelayP99Ms: null,
        ready: null,
        readyzStatus: null,
        readyzHttpStatus: null,
        readyzBody: null,
        readyzHang: false,
        readyzThrow: null,
        readyzDelayMs: 0,
        healthHold: false,
        pendingHealth: [],
        readyzHold: false,
        pendingReadyz: [],
      };
      const healthResponse = () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, status: "live" }),
      });
      const readyzResponse = (overrides = {}) => {
        const view = { ...control, ...overrides };
        const httpStatus = view.readyzHttpStatus ?? 200;
        const body =
          view.readyzBody != null
            ? String(view.readyzBody)
            : JSON.stringify({
                ready: view.ready == null ? view.readyzFailing.length === 0 : view.ready,
                failing: view.readyzFailing,
                ...(view.readyzStatus ? { status: view.readyzStatus } : {}),
                eventLoop: {
                  degraded: view.eventLoopDegraded,
                  reasons: view.eventLoopReasons,
                  ...(view.eventLoopDelayP99Ms != null
                    ? { delayP99Ms: view.eventLoopDelayP99Ms }
                    : {}),
                },
              });
        return {
          ok: httpStatus >= 200 && httpStatus < 300,
          status: httpStatus,
          text: async () => body,
        };
      };
      control.healthResponse = healthResponse;
      control.readyzResponse = readyzResponse;
      const fetchImpl = async (url, opts) => {
        if (!control.healthy) throw new Error("gateway unavailable");
        if (String(url).includes("readyz")) {
          if (control.readyzHold) {
            return new Promise((resolve, reject) => {
              control.pendingReadyz.push({ resolve, reject });
            });
          }
          if (control.readyzThrow) throw control.readyzThrow;
          if (control.readyzHang) {
            return new Promise((resolve, reject) => {
              opts?.signal?.addEventListener("abort", () =>
                reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
              );
            });
          }
          if (control.readyzDelayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, control.readyzDelayMs));
          }
          return readyzResponse();
        }
        if (control.healthHold) {
          return new Promise((resolve, reject) => {
            control.pendingHealth.push({ resolve, reject });
          });
        }
        return healthResponse();
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
        VERSION_MISMATCH: "version_mismatch",
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

    it("b′. under `replace` an UNHEALTHY retained child is never a verdict: repair recycles it through the cold restart and the #59 verdict + green/ready probe certify it", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("child_retained", { child: { pid: 4242 }, pid: 4242, generation: 1 }),
      );
      // The child is wedged (not answering) at repair time; the cold restart
      // brings a gateway back on the port.
      const restartGatewayColdStart = vi.fn(async () => {
        control.healthy = true;
        return { ok: true };
      });
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
      control.healthy = false;
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

    // ── #76 A2: the `requested` row names the state DBs' schema ───────────
    it("the restart/<source>/requested row carries stateDb { userVersion, agentUserVersions } read ONCE at request time, before the launch", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const order = [];
      const requestGatewayLaunch = vi.fn(async () => {
        order.push("launch");
        return launchRequested(4242, 2);
      });
      const readStateDbVersions = vi.fn(async () => {
        order.push("stateDb");
        // Extra keys / non-integers are normalized away; integers kept.
        return { userVersion: 15, agentUserVersions: [19, "x", 19], entries: [{}] };
      });
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        requestGatewayLaunch,
        getLaunchGeneration: () => 1,
        readStateDbVersions,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
      await settle();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
      await settle();

      expect(readStateDbVersions).toHaveBeenCalledTimes(1);
      expect(order).toEqual(["stateDb", "launch"]);
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "requested" })).toEqual([
        expect.objectContaining({
          details: {
            pid: 4242,
            generation: 2,
            intent: "relaunch_if_absent",
            stateDb: { userVersion: 15, agentUserVersions: [19, 19] },
          },
        }),
      ]);
      control.healthy = true;
      watchdog.stop();
    });

    it("a throwing or empty stateDb reader never blocks the relaunch and leaves the row without stateDb", async () => {
      for (const readStateDbVersions of [
        vi.fn(async () => {
          throw new Error("sqlite exploded");
        }),
        vi.fn(async () => null),
        vi.fn(async () => ({ userVersion: null, agentUserVersions: [] })),
      ]) {
        const { control, fetchImpl } = createGatewayControl();
        const requestGatewayLaunch = vi.fn(async () => launchRequested(4242, 2));
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          requestGatewayLaunch,
          getLaunchGeneration: () => 1,
          readStateDbVersions,
        });
        watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
        await settle();
        watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
        await settle();

        expect(requestGatewayLaunch).toHaveBeenCalledTimes(1);
        expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "requested" })).toEqual([
          expect.objectContaining({ details: { pid: 4242, generation: 2, intent: "relaunch_if_absent" } }),
        ]);
        control.healthy = true;
        watchdog.stop();
      }
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
    it("i. a repair whose Doctor run outlives the lock lease launches nothing: skipped {lease_expired}, lifecycle untouched and admitted attempt retained, the queued successor holds the lock", async () => {
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
        repairAttempts: 1,
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

    // ── ship-review fixes (v0.9.75) ───────────────────────────────────────
    it("review R1. `replace` re-probes before `gateway stop`: a child that answers healthy after Doctor is retained (child_retained), never cold-restarted; manual repair on a healthy gateway is Doctor only", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("child_retained", { child: { pid: 4242 }, pid: 4242, generation: 1 }),
      );
      const restartGatewayColdStart = vi.fn(async () => ({ ok: true }));
      // Doctor "fixes" the gateway: it answers again by the time the relaunch runs.
      const clawCmdImpl = async (command) => {
        control.healthy = true;
        return doctorOk(command);
      };
      const { watchdog, insertWatchdogEvent, clawCmd, launchGatewayProcess } = createHarness({
        autoRepair: true,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        clawCmdImpl,
        requestGatewayLaunch,
        restartGatewayColdStart,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 4242, rootPid: 4242, generation: 1 });
      await settle();
      control.healthy = false;
      for (let i = 0; i < 3; i += 1) await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();

      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(restartGatewayColdStart).not.toHaveBeenCalled();
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "requested" })).toHaveLength(0);
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "skipped" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({
            reason: "child_retained",
            recoveredBeforeReplace: true,
            intent: "replace",
            pid: 4242,
          }),
        }),
      ]);
      expect(watchdog.getStatus()).toMatchObject({
        lastRepairVerdict: "child_retained",
        replacementPending: null,
        health: "healthy",
        lifecycle: "running",
        repairAttempts: 0,
      });

      // Manual "Run repair" on a healthy gateway: Doctor, no restart.
      const manual = await watchdog.triggerRepair();
      await settle();
      expect(manual).toMatchObject({ ok: true, launchedGateway: false, pending: false, verdict: "child_retained" });
      expect(restartGatewayColdStart).not.toHaveBeenCalled();
      expect(doctorFixCalls(clawCmd)).toBe(2);
      watchdog.stop();
    });

    it("review P1. a replacement that FAILS (incumbent refuses `gateway stop`) counts as a repair attempt and the automatic ladder waits for a recovery: later failing ticks never re-run doctor --fix + stop", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const identity = { rootPid: 800, workerPid: 801, startTicks: 1, pids: [800, 801] };
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("incumbent_present", { pid: 800, serving: identity }),
      );
      const restartGatewayColdStart = vi.fn(async () => {
        const err = new Error("incumbent gateway still running");
        err.incumbent = true;
        err.reason = "incumbent_gateway_still_running";
        throw err;
      });
      const { watchdog, clawCmd, insertWatchdogEvent } = createHarness({
        autoRepair: true,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        clawCmdImpl: doctorOk,
        requestGatewayLaunch,
        restartGatewayColdStart,
        pidAlive: () => true,
        readProcStartTicks: () => 1,
      });
      watchdog.onGatewayLaunch(adoptedPayload(identity));
      await settle();
      control.healthy = false;
      for (let i = 0; i < 3; i += 1) await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();

      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(restartGatewayColdStart).toHaveBeenCalledTimes(1);
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "failed" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ reason: "incumbent_gateway_still_running" }),
        }),
      ]);
      // (The op-end resync probe fails too and re-degrades health; the
      // contract fields are what this pins.)
      expect(watchdog.getStatus()).toMatchObject({
        repairAttempts: 1,
        awaitingAutoRepairRecovery: true,
        lastRepairVerdict: "replacement_failed",
      });

      // Five more failing ticks: no second Doctor, no second `gateway stop`.
      for (let i = 0; i < 5; i += 1) await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(restartGatewayColdStart).toHaveBeenCalledTimes(1);

      // A recovery lifts the latch; the attempt counter waits for a verified
      // replacement, as before.
      control.healthy = true;
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(watchdog.getStatus()).toMatchObject({ health: "healthy", awaitingAutoRepairRecovery: false });
      watchdog.stop();
    });

    it("review R2. an ownership-conflict exit whose holder is NOT healthy yet gets a cold-boot grace (kGatewayRestartReadyTimeoutMs): sustained failures inside it book one repair/skipped {incumbent_startup_grace} row and never Doctor, the latched reason survives probe prose, and past the budget the ladder repairs", async () => {
      vi.useFakeTimers();
      try {
        const { control, fetchImpl } = createGatewayControl();
        control.healthy = false;
        const requestGatewayLaunch = vi.fn(async () =>
          launchOutcome("incumbent_present", { pid: 4321, serving: null }),
        );
        const restartGatewayColdStart = vi.fn(async () => {
          control.healthy = true;
          return { ok: true };
        });
        const { watchdog, clawCmd, insertWatchdogEvent } = createHarness({
          autoRepair: true,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          clawCmdImpl: doctorOk,
          requestGatewayLaunch,
          restartGatewayColdStart,
          // The holder (pid 4321) stays alive for the whole budget; the grace
          // ends early otherwise (C3-B2).
          pidAlive: () => true,
        });
        // Launched past the startup grace (failures inside it are skipped
        // rows, not ladder input); the exit's own launchedAt keeps the
        // step-aside classification window open.
        watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
        watchdog.onGatewayExit({
          code: 1,
          expectedExit: false,
          pid: 100,
          generation: 1,
          stderrTail: ["gateway already running (pid 4321); lock timeout after 5000ms"],
          launchedAt: Date.now(),
        });
        await vi.advanceTimersByTimeAsync(20);
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "gateway_conflict_unhealthy",
          incumbentConflict: { kind: "gateway_conflict", holderPid: 4321, holderRole: null },
        });
        expect(watchdog.getStatus().incumbentGraceUntil).toEqual(expect.any(String));

        // Well past the sustained gate, inside the grace: no Doctor, one row.
        for (let i = 0; i < 4; i += 1) await watchdog.runHealthCheck({ source: "health_timer" });
        await vi.advanceTimersByTimeAsync(20);
        expect(doctorFixCalls(clawCmd)).toBe(0);
        expect(restartGatewayColdStart).not.toHaveBeenCalled();
        const graceRows = () =>
          rowsOfType(insertWatchdogEvent, "repair", "skipped").filter(
            (row) => row.details.reason === "incumbent_startup_grace",
          );
        expect(graceRows()).toHaveLength(1);
        // Probe prose does not overwrite the latched conflict reason.
        expect(watchdog.getStatus().degradedReason).toBe("gateway_conflict_unhealthy");
        expect(watchdog.getStatus().readiness).toBe("unknown");

        // Past the budget the ladder repairs (replace → cold restart).
        await vi.advanceTimersByTimeAsync(kGatewayRestartReadyTimeoutMs + 1_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        await vi.advanceTimersByTimeAsync(50);
        expect(doctorFixCalls(clawCmd)).toBe(1);
        expect(restartGatewayColdStart).toHaveBeenCalledTimes(1);
        expect(graceRows()).toHaveLength(1);
        watchdog.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("review R3. a pending needs OUR generation once known: a foreign launch with a higher generation (boot / restart route) never verifies it, and the pending child's exit still ends the obligation even when the generation fence marks it a stale predecessor", async () => {
      const { fetchImpl } = createGatewayControl();
      const requestGatewayLaunch = vi.fn(async () => launchRequested(4242, 5));
      const { watchdog, insertWatchdogEvent } = createHarness({
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        requestGatewayLaunch,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 4 });
      await settle();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 4, stderrTail: ["boom"] });
      await settle();
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });

      // A foreign launch (generation 6 ≠ ours 5) answers green: liveness only.
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 9000, rootPid: 9000, generation: 6 });
      await settle();
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(
        restartRows(insertWatchdogEvent, { status: "ok" }).filter((row) => row.details.verified === true),
      ).toHaveLength(0);
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });

      // Our child (gen 5 < serving gen 6) dies: fenced as a stale predecessor,
      // but its obligation ends now — not after a 300s deadline.
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 4242, generation: 5, stderrTail: ["EADDRINUSE"] });
      await settle();
      expect(
        restartRows(insertWatchdogEvent, { source: "exit_event", status: "failed" }).filter(
          (row) => row.details.reason === "replacement_exited",
        ),
      ).toEqual([
        expect.objectContaining({ details: expect.objectContaining({ stalePredecessor: true }) }),
      ]);
      expect(watchdog.getStatus().replacementPending).toBeNull();
      expect(rowsOfType(insertWatchdogEvent, "crash")).toHaveLength(1);
      watchdog.stop();
    });

    it("review R4. runRepair settles a pending replacement that outlived its ready budget while probes were failing: the ladder's repair proceeds (replacement_not_ready booked) instead of skipping {replacement_pending} for the rest of the budget", async () => {
      vi.useFakeTimers();
      try {
        const { control, fetchImpl } = createGatewayControl();
        let launches = 0;
        const requestGatewayLaunch = vi.fn(async () => {
          launches += 1;
          return launchRequested(4240 + launches, launches);
        });
        const { watchdog, insertWatchdogEvent, clawCmd } = createHarness({
          autoRepair: true,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          clawCmdImpl: doctorOk,
          requestGatewayLaunch,
        });
        watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 0 });
        await vi.advanceTimersByTimeAsync(20);
        // The relaunched child never comes up: every probe fails from here.
        control.healthy = false;
        watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 0, stderrTail: ["boom"] });
        await vi.advanceTimersByTimeAsync(50);
        expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4241 });

        // Inside the budget: the sustained ladder reaches runRepair, which
        // skips on the pending obligation.
        for (let i = 0; i < 4; i += 1) await watchdog.runHealthCheck({ source: "health_timer" });
        await vi.advanceTimersByTimeAsync(20);
        expect(doctorFixCalls(clawCmd)).toBe(0);
        expect(
          rowsOfType(insertWatchdogEvent, "repair", "skipped").filter(
            (row) => row.details.reason === "replacement_pending",
          ).length,
        ).toBeGreaterThanOrEqual(1);

        // Past the budget, still failing: the pending is settled at the head
        // of runRepair and Doctor runs.
        await vi.advanceTimersByTimeAsync(kGatewayRestartReadyTimeoutMs + 1_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        await vi.advanceTimersByTimeAsync(50);
        expect(
          restartRows(insertWatchdogEvent, { source: "exit_event", status: "failed" }).filter(
            (row) => row.details.reason === "replacement_not_ready",
          ),
        ).toHaveLength(1);
        expect(doctorFixCalls(clawCmd)).toBe(1);
        watchdog.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    it("review R5. `replace` with no cold-restart dependency wired is an honest failed replacement {cold_restart_unavailable}: runRepair ok:false, nothing pending, counted as an attempt", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const identity = { rootPid: 800, workerPid: 801, startTicks: 1, pids: [800, 801] };
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("incumbent_present", { pid: 800, serving: identity }),
      );
      const { watchdog, insertWatchdogEvent, clawCmd } = createHarness({
        autoRepair: true,
        fetchImpl,
        clawCmdImpl: doctorOk,
        requestGatewayLaunch,
        pidAlive: () => true,
        readProcStartTicks: () => 1,
      });
      watchdog.onGatewayLaunch(adoptedPayload(identity));
      await settle();
      control.healthy = false;
      const result = await watchdog.triggerRepair();
      await settle();
      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(result).toMatchObject({ ok: false, verdict: "replacement_failed", reason: "replacement_failed", launchedGateway: false });
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "failed" })).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ reason: "cold_restart_unavailable", intent: "replace" }),
        }),
      ]);
      expect(watchdog.getStatus()).toMatchObject({
        lastRepairVerdict: "replacement_failed",
        replacementPending: null,
        repairAttempts: 1,
      });
      watchdog.stop();
    });

    it("review R6. a failed liveness probe resets the readiness axis: readiness 'ready' never sits beside a degraded health", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const { watchdog } = createHarness({ fetchImpl, resolveGatewayReadyzUrl: () => kReadyzUrl });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      await settle();
      expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
      control.healthy = false;
      await watchdog.runHealthCheck({ source: "health_timer" });
      expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "unknown", readinessReason: null });
      watchdog.stop();
    });

    it("review C3-A. a failed replacement's latch lifts by itself once the incumbent it could not stop is gone: the next failing tick relaunches into the free port instead of waiting for a recovery that cannot come", async () => {
      const { control, fetchImpl } = createGatewayControl();
      const identity = { rootPid: 800, workerPid: 801, startTicks: 1, pids: [800, 801] };
      let holderAlive = true;
      let portHeld = true;
      const requestGatewayLaunch = vi.fn(async () =>
        portHeld
          ? launchOutcome("incumbent_present", { pid: 800, serving: identity })
          : launchRequested(4242, 7),
      );
      const restartGatewayColdStart = vi.fn(async () => {
        const err = new Error("incumbent gateway still running");
        err.incumbent = true;
        err.reason = "incumbent_gateway_still_running";
        throw err;
      });
      const { watchdog, clawCmd, insertWatchdogEvent } = createHarness({
        autoRepair: true,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        clawCmdImpl: doctorOk,
        requestGatewayLaunch,
        restartGatewayColdStart,
        pidAlive: (pid) => (pid === 800 ? holderAlive : true),
        readProcStartTicks: () => 1,
      });
      watchdog.onGatewayLaunch(adoptedPayload(identity));
      await settle();
      control.healthy = false;
      for (let i = 0; i < 3; i += 1) await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(watchdog.getStatus().awaitingAutoRepairRecovery).toBe(true);

      // Still wedged and alive: the latch holds.
      await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(doctorFixCalls(clawCmd)).toBe(1);

      // The operator kills the wedged gateway the notice named: nothing is
      // left to replace, so the latch lifts and the ladder relaunches.
      holderAlive = false;
      portHeld = false;
      await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(
        rowsOfType(insertWatchdogEvent, "repair", "ok").filter((row) => row.details.latchLifted === true),
      ).toEqual([
        expect.objectContaining({
          details: expect.objectContaining({ reason: "nothing_left_to_replace", pid: 800 }),
        }),
      ]);
      // Two requested rows: the failed cold-restart replace, then the fresh
      // spawn into the free port.
      const requested = restartRows(insertWatchdogEvent, { source: "repair", status: "requested" });
      expect(requested).toHaveLength(2);
      expect(requested[0].details).toMatchObject({ coldRestart: true, incumbentPid: 800 });
      expect(requested[1].details).toMatchObject({ pid: 4242, generation: 7, intent: "replace" });
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });
      // Doctor ran once more (the lift is a real repair, not a bare relaunch).
      expect(doctorFixCalls(clawCmd)).toBe(2);
      watchdog.stop();
    });

    it("review C3-B1. the cold-boot grace is for an EXTERNAL holder only: the draining corpse of the process that just exited arms no grace", async () => {
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("incumbent_present", {
          pid: 100,
          serving: { rootPid: 100, workerPid: 101, startTicks: 1, pids: [100, 101] },
        }),
      );
      const { watchdog, insertWatchdogEvent } = createHarness({
        autoRepair: false,
        requestGatewayLaunch,
        fetchImpl: async () => ({ ok: false, status: 503, text: async () => "" }),
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
      await settle();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 1 });
      await settle();
      expect(restartRows(insertWatchdogEvent, { source: "exit_event", status: "skipped" })).toEqual([
        expect.objectContaining({ details: expect.objectContaining({ reason: "incumbent_unhealthy", pid: 100 }) }),
      ]);
      expect(watchdog.getStatus()).toMatchObject({ health: "degraded", incumbentGraceUntil: null });
      watchdog.stop();
    });

    it("review C3-B2. the grace ends early when its holder is gone: a conflict holder that dies mid-budget no longer shields the port, and the ladder repairs on the next sustained failure", async () => {
      const { control, fetchImpl } = createGatewayControl();
      control.healthy = false;
      let holderAlive = true;
      const requestGatewayLaunch = vi.fn(async () => launchRequested(4242, 2));
      const { watchdog, clawCmd, insertWatchdogEvent } = createHarness({
        autoRepair: true,
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        clawCmdImpl: doctorOk,
        requestGatewayLaunch,
        pidAlive: (pid) => (pid === 4321 ? holderAlive : true),
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 1 });
      watchdog.onGatewayExit({
        code: 1,
        expectedExit: false,
        pid: 100,
        generation: 1,
        stderrTail: ["gateway already running (pid 4321); lock timeout after 5000ms"],
        launchedAt: Date.now(),
      });
      await settle();
      expect(watchdog.getStatus().incumbentGraceUntil).toEqual(expect.any(String));
      for (let i = 0; i < 3; i += 1) await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(doctorFixCalls(clawCmd)).toBe(0);
      expect(
        rowsOfType(insertWatchdogEvent, "repair", "skipped").filter(
          (row) => row.details.reason === "incumbent_startup_grace",
        ),
      ).toEqual([expect.objectContaining({ details: expect.objectContaining({ holderPid: 4321 }) })]);

      holderAlive = false;
      await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(watchdog.getStatus().incumbentGraceUntil).toBeNull();
      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(restartRows(insertWatchdogEvent, { source: "repair", status: "requested" })).toHaveLength(1);
      watchdog.stop();
    });

    it("review C3-C1. a planned restart supersedes an open pending: replacement_superseded {supersededBy: expected_restart}, nothing left liveness-only for the rest of the budget", async () => {
      const { fetchImpl } = createGatewayControl();
      const requestGatewayLaunch = vi.fn(async () => launchRequested(4242, 5));
      const { watchdog, insertWatchdogEvent } = createHarness({
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        requestGatewayLaunch,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 4 });
      await settle();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 4, stderrTail: ["boom"] });
      await settle();
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });
      watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000 });
      expect(watchdog.getStatus().replacementPending).toBeNull();
      expect(
        restartRows(insertWatchdogEvent, { source: "exit_event", status: "failed" }).filter(
          (row) => row.details.reason === "replacement_superseded",
        ),
      ).toEqual([
        expect.objectContaining({ details: expect.objectContaining({ supersededBy: "expected_restart", pid: 4242 }) }),
      ]);
      watchdog.stop();
    });

    it("review C3-C2. the pending child's EXPECTED late exit after a successor took gatewayPid (route restart, draining predecessor) still ends its obligation as replacement_exited", async () => {
      const { fetchImpl } = createGatewayControl();
      const requestGatewayLaunch = vi.fn(async () => launchRequested(4242, 5));
      const { watchdog, insertWatchdogEvent } = createHarness({
        fetchImpl,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        requestGatewayLaunch,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100, rootPid: 100, generation: 4 });
      await settle();
      watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100, generation: 4, stderrTail: ["boom"] });
      await settle();
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });
      // The successor (a foreign generation) notifies first...
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 9001, rootPid: 9001, generation: 6 });
      await settle();
      expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });
      // ...then the pending child drains out as an EXPECTED exit.
      watchdog.onGatewayExit({ code: 0, expectedExit: true, pid: 4242, generation: 5 });
      await settle();
      expect(watchdog.getStatus().replacementPending).toBeNull();
      expect(
        restartRows(insertWatchdogEvent, { source: "exit_event", status: "failed" }).filter(
          (row) => row.details.reason === "replacement_exited",
        ),
      ).toEqual([expect.objectContaining({ details: expect.objectContaining({ stalePredecessor: true }) })]);
      expect(rowsOfType(insertWatchdogEvent, "crash")).toHaveLength(1);
      watchdog.stop();
    });

    it("review C3-E. a FLAPPING incumbent (answers one probe in two) is not healthy for the pre-replace check: it is replaced, not retained", async () => {
      const { control, fetchImpl } = createGatewayControl();
      let flapping = false;
      let flapCalls = 0;
      const flappyFetch = async (url) => {
        if (flapping && !String(url).includes("readyz")) {
          flapCalls += 1;
          if (flapCalls % 2 === 1) throw new Error("gateway unavailable");
          return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, status: "live" }) };
        }
        return fetchImpl(url);
      };
      const requestGatewayLaunch = vi.fn(async () =>
        launchOutcome("child_retained", { child: { pid: 4242 }, pid: 4242, generation: 1 }),
      );
      const restartGatewayColdStart = vi.fn(async () => {
        flapping = false;
        control.healthy = true;
        return { ok: true };
      });
      const clawCmdImpl = async (command) => {
        flapping = true;
        return doctorOk(command);
      };
      const { watchdog, clawCmd } = createHarness({
        autoRepair: true,
        fetchImpl: flappyFetch,
        resolveGatewayReadyzUrl: () => kReadyzUrl,
        clawCmdImpl,
        requestGatewayLaunch,
        restartGatewayColdStart,
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 4242, rootPid: 4242, generation: 1 });
      await settle();
      control.healthy = false;
      for (let i = 0; i < 3; i += 1) await watchdog.runHealthCheck({ source: "health_timer" });
      await settle();
      expect(doctorFixCalls(clawCmd)).toBe(1);
      expect(restartGatewayColdStart).toHaveBeenCalledTimes(1);
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
        // The ladder routes a latched state-writer conflict to the backoff
        // relaunch BEFORE runRepair, so no repair row of any kind exists here
        // (the runRepair refusal itself is pinned by the manual/crash_loop
        // test below).
        expect(rowsOfType(insertWatchdogEvent, "repair")).toHaveLength(0);
        // Third backoff relaunch once the pending failed: the ready-budget
        // advance also aged the first relaunch out of the 5-minute window, so
        // the cap (kWatchdogCrashLoopThreshold) is not yet reached.
        expect(
          restartRows(insertWatchdogEvent, { source: "state_writer_conflict", status: "requested" }),
        ).toHaveLength(3);
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

    // ── #87: native readiness, transitional readiness, probe ownership, detached Doctor ──
    describe("#87 readiness classification, transitional readiness, probe ownership fence, detached advisory Doctor", () => {
      const tick = () => vi.advanceTimersByTimeAsync(0);
      const readyzProbeCount = () =>
        global.fetch.mock.calls.filter(([url]) => String(url).includes("readyz")).length;
      const launchEstablished = (watchdog) =>
        watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 100 });
      const kRuntimeFinding = {
        checkId: "gateway.probe_auth_secretref_unavailable",
        severity: "warn",
        title: "Gateway auth SecretRef unavailable",
        detail: "SecretRef env:GATEWAY_TOKEN could not be resolved at probe time",
        remediation: "Set the referenced environment variable.",
      };
      const doctorPayload = (findings) => JSON.stringify({ ok: false, findings });
      let consoleLog;
      beforeEach(() => {
        consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
      });
      afterEach(() => {
        consoleLog.mockRestore();
      });
      const consoleLines = (needle) =>
        consoleLog.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(needle));
      const advisoryRows = (insertWatchdogEvent) => rowsOfType(insertWatchdogEvent, "readiness_advisory");
      const probeErrorRows = (insertWatchdogEvent) =>
        rowsOfType(insertWatchdogEvent, "readiness_probe_error", "failed");

      // ── 1. event-loop pressure is telemetry ─────────────────────────────
      it("#87 1. eventLoop.degraded on a ready /readyz is telemetry: healthy + ready, no incident, no notice, dispatch open; one event_loop_pressure warn {reasons allowlisted, delayP99Ms} then ok {durationMs}; flapping logs at most one warn per 10 min", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        control.eventLoopDegraded = true;
        control.eventLoopReasons = ["cpu", "not_a_real_reason"];
        control.eventLoopDelayP99Ms = 812;
        const onHealthy = vi.fn();
        const onUnhealthy = vi.fn();
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          releaseChannelHooks: { onHealthy, onUnhealthy },
        });
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "ready",
          readinessReason: null,
          readinessProbe: "ok",
          readinessStatus: null,
          eventLoopDegraded: true,
          repairAttempts: 0,
        });
        expect(watchdog.isReadyForDispatch()).toEqual({ ok: true, reason: "" });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        expect(notifier.notify).not.toHaveBeenCalled();
        expect(onUnhealthy).not.toHaveBeenCalled();
        const warns = () => rowsOfType(insertWatchdogEvent, "event_loop_pressure", "warn");
        const oks = () => rowsOfType(insertWatchdogEvent, "event_loop_pressure", "ok");
        expect(warns()).toHaveLength(1);
        expect(warns()[0].details).toEqual({ degraded: true, reasons: ["cpu"], delayP99Ms: 812 });
        expect(oks()).toHaveLength(0);
        // Still degraded 30s later: same episode, no second warn.
        await vi.advanceTimersByTimeAsync(30_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(warns()).toHaveLength(1);
        // Pressure clears: ok closes the logged episode with its duration.
        control.eventLoopDegraded = false;
        await vi.advanceTimersByTimeAsync(30_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(oks()).toHaveLength(1);
        expect(oks()[0].details.degraded).toBe(false);
        expect(oks()[0].details.durationMs).toBe(60_000);
        expect(watchdog.getStatus().eventLoopDegraded).toBe(false);
        // Flapping every probe inside the 10-min floor: no new warn, and an
        // episode that never logged a warn never logs an ok either.
        for (let i = 0; i < 4; i += 1) {
          control.eventLoopDegraded = !control.eventLoopDegraded;
          await vi.advanceTimersByTimeAsync(30_000);
          await watchdog.runHealthCheck({ source: "health_timer" });
        }
        expect(warns()).toHaveLength(1);
        expect(oks()).toHaveLength(1);
        // Past the floor a new episode warns again.
        control.eventLoopDegraded = true;
        await vi.advanceTimersByTimeAsync(10 * 60_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(warns()).toHaveLength(2);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        watchdog.stop();
      });

      // ── 3. explicit ready:false is native not_ready ─────────────────────
      it("#87 3. 200 {ready:false, failing:[]} is a native not_ready: reason ready:false, health degraded, gateway_readiness opening row {unreadyReason explicit}, one not-ready notice", async () => {
        const { control, fetchImpl } = createGatewayControl();
        control.ready = false;
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await settle();
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "readiness_failing",
          readiness: "not_ready",
          readinessReason: "ready:false",
          readinessProbe: "ok",
          readyzFailing: [],
        });
        const opened = rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed");
        expect(opened).toHaveLength(1);
        expect(opened[0].details).toMatchObject({
          failing: [],
          unreadyReason: "explicit",
          reason: "ready:false",
        });
        expect(noticesIncluding(notifier, "Gateway is up but not ready")).toHaveLength(1);
        expect(pendingRows(insertWatchdogEvent, "readinessPending")).toHaveLength(1);
        watchdog.stop();
      });

      // ── 4. transitional readiness ───────────────────────────────────────
      it("#87 4a. 503 {status:'starting'} is transitional: readiness not_ready + readinessStatus, health healthy, no incident, no notice, no hooks, one deduped pending row {readinessStatus}; the bootstrap loop keeps the 5s cadence until `started`, then stops", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        control.readyzStatus = "starting";
        control.ready = false;
        control.readyzHttpStatus = 503;
        const onHealthy = vi.fn();
        const onUnhealthy = vi.fn();
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          releaseChannelHooks: { onHealthy, onUnhealthy },
        });
        watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 100 });
        await tick();
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "running",
          health: "healthy",
          degradedReason: null,
          readiness: "not_ready",
          readinessReason: "starting",
          readinessStatus: "starting",
          readinessProbe: "ok",
        });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        expect(notifier.notify).not.toHaveBeenCalled();
        expect(onHealthy).not.toHaveBeenCalled();
        expect(onUnhealthy).not.toHaveBeenCalled();
        expect(watchdog.getStatus().degradedRetry).toBeNull();
        // 5s cadence while transitional.
        const before = readyzProbeCount();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(readyzProbeCount()).toBe(before + 1);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(readyzProbeCount()).toBe(before + 2);
        const pending = pendingRows(insertWatchdogEvent, "readinessPending");
        expect(pending).toHaveLength(1);
        expect(pending[0].details).toMatchObject({
          readinessPending: true,
          readinessReason: "starting",
          readinessStatus: "starting",
        });
        expect(onHealthy).not.toHaveBeenCalled();
        expect(onUnhealthy).not.toHaveBeenCalled();
        // `started` → ready within one 5s tick; the loop stops.
        control.readyzStatus = "started";
        control.ready = null;
        control.readyzHttpStatus = 200;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "ready",
          readinessStatus: "started",
        });
        expect(onHealthy).toHaveBeenCalledTimes(1);
        const after = readyzProbeCount();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(readyzProbeCount()).toBe(after);
        // No incident ever: no opening row, no recovery row, no notice.
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        expect(notifier.notify).not.toHaveBeenCalled();
        watchdog.stop();
      });

      it("#87 4b. `draining` is transitional too, and 503 {status:'starting', failing:[...]} stays transitional (status precedence) while 503 {failing:[...]} without a status is a real not_ready incident", async () => {
        const drain = createGatewayControl();
        drain.control.readyzStatus = "draining";
        drain.control.ready = false;
        drain.control.readyzHttpStatus = 503;
        const draining = createHarness({
          autoRepair: false,
          fetchImpl: drain.fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(draining.watchdog);
        await settle();
        expect(draining.watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "not_ready",
          readinessStatus: "draining",
          readinessReason: "draining",
        });
        expect(rowsOfType(draining.insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        expect(pendingRows(draining.insertWatchdogEvent, "readinessPending")[0].details).toMatchObject({
          readinessStatus: "draining",
        });
        draining.watchdog.stop();

        const startingWithFailing = createGatewayControl();
        startingWithFailing.control.readyzStatus = "starting";
        startingWithFailing.control.ready = false;
        startingWithFailing.control.readyzHttpStatus = 503;
        startingWithFailing.control.readyzFailing = ["telegram"];
        const transitional = createHarness({
          autoRepair: false,
          fetchImpl: startingWithFailing.fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(transitional.watchdog);
        await settle();
        expect(transitional.watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "not_ready",
          readinessStatus: "starting",
          readyzFailing: ["telegram"],
        });
        expect(rowsOfType(transitional.insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        expect(transitional.notifier.notify).not.toHaveBeenCalled();
        transitional.watchdog.stop();

        const components = createGatewayControl();
        components.control.ready = false;
        components.control.readyzHttpStatus = 503;
        components.control.readyzFailing = ["telegram"];
        const incident = createHarness({
          autoRepair: false,
          fetchImpl: components.fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(incident.watchdog);
        await settle();
        expect(incident.watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "readiness_failing",
          readiness: "not_ready",
          readinessReason: "telegram",
          readinessStatus: null,
        });
        const opened = rowsOfType(incident.insertWatchdogEvent, "readiness_degraded", "failed");
        expect(opened).toHaveLength(1);
        expect(opened[0].details).toMatchObject({ failing: ["telegram"], unreadyReason: "components" });
        expect(noticesIncluding(incident.notifier, "up but not ready")).toHaveLength(1);
        incident.watchdog.stop();
      });

      it("#87 4c. a transitional gateway keeps a crash incident open (pending rows) and closes it within one 5s tick of `started`; the pending replacement is certified only by `started`", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        // Crash → relaunch; the new child answers /health but /readyz says starting.
        control.readyzStatus = "starting";
        control.ready = false;
        control.readyzHttpStatus = 503;
        watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100 });
        await tick();
        watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
        await tick();
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "running",
          health: "healthy",
          readiness: "not_ready",
          readinessStatus: "starting",
          replacementPending: expect.objectContaining({ pid: 4242 }),
        });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        expect(noticesIncluding(notifier, "running again")).toHaveLength(0);
        expect(restartRows(insertWatchdogEvent, { status: "ok" })).toHaveLength(0);
        // Two more 5s ticks: still one deduped pending row, still pending.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(
          pendingRows(insertWatchdogEvent, "readinessPending").filter(
            (row) => row.details.readinessStatus === "starting",
          ),
        ).toHaveLength(1);
        expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });
        // `started` → recovery + verified replacement within one tick.
        control.readyzStatus = "started";
        control.ready = null;
        control.readyzHttpStatus = 200;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(noticesIncluding(notifier, "running again")).toHaveLength(1);
        expect(restartRows(insertWatchdogEvent, { status: "ok" })).toEqual([
          expect.objectContaining({ details: expect.objectContaining({ pid: 4242, verified: true }) }),
        ]);
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "ready",
          readinessStatus: "started",
          replacementPending: null,
        });
        watchdog.stop();
      });

      it("#87 4c′. T3: the relaunched replacement never leaves `starting`: the pending's ready budget expires on a transitional tick — restart failed {reason: replacement_not_ready, readiness: not_ready}, replacementPending null — and the X2 expiry that follows degrades with ONE readiness_degraded/failed row", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        control.readyzStatus = "starting";
        control.ready = false;
        control.readyzHttpStatus = 503;
        watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100 });
        await tick();
        watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
        await tick();
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "running",
          health: "healthy",
          readiness: "not_ready",
          readinessStatus: "starting",
          replacementPending: expect.objectContaining({ pid: 4242 }),
        });
        const failedRestarts = () => restartRows(insertWatchdogEvent, { status: "failed" });
        const openings = () => rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed");
        // Inside the budget: still pending, still transitional, no rows.
        await vi.advanceTimersByTimeAsync(kGatewayRestartReadyTimeoutMs - 5_000);
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readinessStatus: "starting",
          replacementPending: expect.objectContaining({ pid: 4242 }),
        });
        expect(failedRestarts()).toHaveLength(0);
        expect(openings()).toHaveLength(0);
        // The budget tick (installed at the exit, T0 + budget): the pending
        // deadline is met on this transitional observation
        // (recordTransitionalReadiness → evaluatePendingReplacementDeadline)
        // while the transitional clock, started by the first probe at T0,
        // needs to EXCEED the budget — so the X2 expiry lands one 5s tick
        // later. The two expiries are adjacent ticks, not the same probe.
        await vi.advanceTimersByTimeAsync(5_000);
        expect(failedRestarts()).toHaveLength(1);
        expect(failedRestarts()[0].details).toMatchObject({
          reason: "replacement_not_ready",
          readiness: "not_ready",
          identityObserved: true,
        });
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "not_ready",
          readinessStatus: "starting",
          replacementPending: null,
        });
        expect(openings()).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(openings()).toHaveLength(1);
        expect(openings()[0].details).toMatchObject({ status: "starting", unreadyReason: "starting" });
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "readiness_failing",
          readiness: "not_ready",
          readinessReason: expect.stringContaining("starting did not complete within"),
          replacementPending: null,
        });
        expect(failedRestarts()).toHaveLength(1);
        expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(1);
        expect(noticesIncluding(notifier, "running again")).toHaveLength(0);
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        watchdog.stop();
      });

      it("#87 4d. X2: `starting` past kGatewayRestartReadyTimeoutMs expires the transitional budget — a real not_ready: degraded, incident, notice, degraded-retry cadence instead of the 5s bootstrap loop; never a restart", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        control.readyzStatus = "starting";
        control.ready = false;
        control.readyzHttpStatus = 503;
        const { watchdog, insertWatchdogEvent, notifier, launchGatewayProcess } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 100 });
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "not_ready" });
        await vi.advanceTimersByTimeAsync(kGatewayRestartReadyTimeoutMs + 5_000);
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "readiness_failing",
          readiness: "not_ready",
          readinessStatus: "starting",
          readinessReason: expect.stringContaining("starting did not complete within"),
        });
        const opened = rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed");
        expect(opened).toHaveLength(1);
        expect(opened[0].details).toMatchObject({ status: "starting", unreadyReason: "starting" });
        expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(1);
        expect(watchdog.getStatus().degradedRetry).not.toBeNull();
        // Bootstrap loop stopped, no transitional recheck armed: the
        // degraded-retry backoff owns the cadence — exactly one /readyz at
        // f(0)=5s, f(1)=10s, f(2)=20s after the expiry (TQ-5), never a probe
        // every 5s.
        for (const delayMs of [5_000, 10_000, 20_000]) {
          const before = readyzProbeCount();
          await vi.advanceTimersByTimeAsync(delayMs - 1);
          expect(readyzProbeCount()).toBe(before);
          await vi.advanceTimersByTimeAsync(1);
          expect(readyzProbeCount()).toBe(before + 1);
        }
        expect(launchGatewayProcess).not.toHaveBeenCalled();
        expect(watchdog.getStatus().repairAttempts).toBe(0);
        // `started` still recovers.
        control.readyzStatus = "started";
        control.ready = null;
        control.readyzHttpStatus = 200;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "ok")).toHaveLength(1);
        watchdog.stop();
      });

      it("#87 4e. 404 is `unsupported`: readiness unknown, readinessProbe unsupported, no rows; timeout / connection error / HTTP 500 / malformed body read unknown with one readiness_probe_error {kind} per transition under a 5-min per-kind floor", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        control.readyzHttpStatus = 404;
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "unknown",
          readinessProbe: "unsupported",
        });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(0);
        expect(notifier.notify).not.toHaveBeenCalled();
        // HTTP 500 → unavailable (row 1).
        control.readyzHttpStatus = 500;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "unknown", readinessProbe: "unavailable" });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(1);
        expect(probeErrorRows(insertWatchdogEvent)[0].details).toMatchObject({ kind: "unavailable", httpStatus: 500 });
        // Timeout (row 2).
        control.readyzHttpStatus = null;
        control.readyzHang = true;
        const hung = watchdog.runHealthCheck({ source: "health_timer" });
        await vi.advanceTimersByTimeAsync(5_000);
        await hung;
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "unknown", readinessProbe: "timeout" });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(2);
        expect(probeErrorRows(insertWatchdogEvent)[1].details).toMatchObject({ kind: "timeout", httpStatus: null });
        // Back to unavailable inside the floor: a transition, but no row.
        control.readyzHang = false;
        control.readyzThrow = new Error("connect ECONNREFUSED");
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus().readinessProbe).toBe("unavailable");
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(2);
        // Same kind again: not a transition, no row.
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(2);
        // Malformed (row 3: first malformed).
        control.readyzThrow = null;
        control.readyzBody = "<html>proxy says hi</html>";
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus().readinessProbe).toBe("malformed");
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(3);
        expect(probeErrorRows(insertWatchdogEvent)[2].details).toMatchObject({ kind: "malformed", httpStatus: 200 });
        // Past the floor the unavailable transition logs again (the regular
        // 120s timer keeps observing malformed meanwhile — same kind, no row).
        await vi.advanceTimersByTimeAsync(5 * 60_000 + 1_000);
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(3);
        control.readyzBody = null;
        control.readyzThrow = new Error("connect ECONNREFUSED");
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(probeErrorRows(insertWatchdogEvent).filter((row) => row.details.kind === "unavailable")).toHaveLength(2);
        // A fresh healthy gateway never held recovery through any of this.
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        expect(pendingRows(insertWatchdogEvent, "readinessPending")).toHaveLength(0);
        // A consumed body ends the run.
        control.readyzThrow = null;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({ readiness: "ready", readinessProbe: "ok" });
        watchdog.stop();
      });

      // ── 5. X1 recovery hold ─────────────────────────────────────────────
      it("#87 5. X1: a /readyz timeout while a readiness incident is open holds recovery — no recovery row, no 'running again', incident open, one readinessPending {readinessProbe:'timeout'} row, health kept degraded; after kGatewayRestartReadyTimeoutMs of errors → readiness_probe_error {recoveryAssumed} and recovery proceeds", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const onHealthy = vi.fn();
        const onUnhealthy = vi.fn();
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          releaseChannelHooks: { onHealthy, onUnhealthy },
        });
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(1);
        onHealthy.mockClear();
        // The f(0)=5s retry fires; its /readyz hangs and times out at +5s.
        control.readyzHang = true;
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "ok")).toHaveLength(0);
        expect(noticesIncluding(notifier, "running again")).toHaveLength(0);
        expect(onHealthy).not.toHaveBeenCalled();
        const held = pendingRows(insertWatchdogEvent, "readinessPending").filter(
          (row) => row.details.readinessProbe === "timeout",
        );
        expect(held).toHaveLength(1);
        expect(held[0].details).toMatchObject({
          readinessPending: true,
          readinessReason: "readiness probe timeout",
          readinessProbe: "timeout",
        });
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "readiness_failing",
          readiness: "not_ready",
          readinessReason: "secrets",
          readinessProbe: "timeout",
        });
        expect(probeErrorRows(insertWatchdogEvent)).toEqual([
          expect.objectContaining({ details: expect.objectContaining({ kind: "timeout" }) }),
        ]);
        expect(watchdog.getStatus().degradedRetry).not.toBeNull();
        // Bound: errors persist past the ready budget → fail open with an
        // explicit row, recovery proceeds, the incident closes.
        control.readyzHang = false;
        control.readyzThrow = new Error("connect ECONNREFUSED");
        // Exactly the budget is still inside it; one ms past it fails open.
        vi.setSystemTime(Date.now() + kGatewayRestartReadyTimeoutMs - 10_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        vi.setSystemTime(Date.now() + 10_001);
        await watchdog.runHealthCheck({ source: "health_timer" });
        const assumed = probeErrorRows(insertWatchdogEvent).filter(
          (row) => row.details.recoveryAssumed === true,
        );
        expect(assumed).toHaveLength(1);
        expect(assumed[0].details.kind).toBe("unavailable");
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(noticesIncluding(notifier, "running again")).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "unknown",
          readinessProbe: "unavailable",
        });
        expect(onHealthy).toHaveBeenCalledTimes(1);
        // Once open, a later probe error on this now-unknown readiness never
        // holds again (the hold is keyed on the last accepted not_ready).
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(watchdog.getStatus().health).toBe("healthy");
        watchdog.stop();
      });

      it("#87 5′. a 404 during an open readiness incident fails open at once: recovery proceeds, readinessProbe unsupported, no probe-error row, no pending row", async () => {
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await settle();
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        control.readyzHttpStatus = 404;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(noticesIncluding(notifier, "running again")).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "unknown",
          readinessProbe: "unsupported",
        });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(0);
        expect(
          pendingRows(insertWatchdogEvent, "readinessPending").filter((row) => row.details.readinessProbe),
        ).toHaveLength(0);
        watchdog.stop();
      });

      it("#87 5b. Y2: transport errors on four consecutive probes keep health degraded (readiness_failing) and the retry loop firing at 5/10/20/30s; the incident stays open; the hold ends within one retry of /readyz answering", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        control.readyzThrow = new Error("connect ECONNREFUSED");
        for (const delayMs of [5_000, 10_000, 20_000, 30_000]) {
          const before = readyzProbeCount();
          await vi.advanceTimersByTimeAsync(delayMs - 1);
          expect(readyzProbeCount()).toBe(before);
          await vi.advanceTimersByTimeAsync(1);
          expect(readyzProbeCount()).toBe(before + 1);
          expect(watchdog.getStatus()).toMatchObject({
            health: "degraded",
            degradedReason: "readiness_failing",
            readiness: "not_ready",
            readinessProbe: "unavailable",
          });
          expect(watchdog.getStatus().degradedRetry).not.toBeNull();
        }
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "ok")).toHaveLength(0);
        expect(noticesIncluding(notifier, "running again")).toHaveLength(0);
        // One deduped hold row, one probe-error row for the whole run.
        expect(
          pendingRows(insertWatchdogEvent, "readinessPending").filter(
            (row) => row.details.readinessProbe === "unavailable",
          ),
        ).toHaveLength(1);
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(1);
        // /readyz answers ready: the next retry (≤30s) recovers.
        control.readyzThrow = null;
        control.readyzFailing = [];
        await vi.advanceTimersByTimeAsync(30_000);
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "ok")).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "ready",
          readinessProbe: "ok",
          degradedRetry: null,
        });
        watchdog.stop();
      });

      // ── 6. the issue's sequence ─────────────────────────────────────────
      const runIssueSequence = async (doctorResult) => {
        vi.useFakeTimers();
        let resolveDoctor = null;
        const collector = vi.fn(
          () =>
            new Promise((resolve) => {
              resolveDoctor = resolve;
            }),
        );
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          collectAdvisoryDoctorJson: collector,
        });
        // A at 0s: not ready → incident opens, Doctor starts (detached).
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(1);
        expect(collector).toHaveBeenCalledTimes(1);
        expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(1);
        // Retry B at 5s: recovered.
        control.readyzFailing = [];
        await vi.advanceTimersByTimeAsync(5_000);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "ok")).toHaveLength(1);
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        const noticesAfterB = notifier.notify.mock.calls.length;
        // Doctor settles at 13s.
        await vi.advanceTimersByTimeAsync(8_000);
        resolveDoctor(doctorResult);
        await tick();
        // 120s: nothing reopened, nothing re-notified.
        await vi.advanceTimersByTimeAsync(107_000);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(1);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "ok")).toHaveLength(1);
        expect(advisoryRows(insertWatchdogEvent)).toHaveLength(0);
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(notifier.notify.mock.calls.length).toBe(noticesAfterB);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready", degradedRetry: null });
        watchdog.stop();
      };

      it("#87 6. the issue's sequence (A not_ready at 0s, B recovered at 5s, Doctor settles at 13s with a matching runtime finding, 120s): ONE opening row, ONE recovery, readiness ready from 5s on, no readiness_advisory, no second opening, no notice after B — the drop is console-visible as degradation_cleared", async () => {
        await runIssueSequence(doctorPayload([kRuntimeFinding]));
        expect(consoleLines("readiness advisory dropped (degradation_cleared)")).toHaveLength(1);
      });

      it("#87 6′. the same sequence with a null collector result and with non-matching Doctor output changes nothing either", async () => {
        await runIssueSequence(null);
        await runIssueSequence(
          doctorPayload([{ checkId: "channels.telegram.token_missing", severity: "error", message: "secret error" }]),
        );
      });

      // ── 7. advisory attaches only to the SAME episode ───────────────────
      it("#87 7. Doctor settles while the SAME degradation is current → one readiness_advisory/warn with the structured finding, the opening probe's correlationId, observedAt = its start, doctorStartedAt from collectWithMeta, episode = the opening episode", async () => {
        vi.useFakeTimers();
        const t0 = Date.now();
        let resolveDoctor = null;
        const collector = vi.fn(
          () =>
            new Promise((resolve) => {
              resolveDoctor = resolve;
            }),
        );
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          collectAdvisoryDoctorJson: collector,
        });
        launchEstablished(watchdog);
        await tick();
        const opening = rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed");
        expect(opening).toHaveLength(1);
        // The same degradation holds through two retries.
        await vi.advanceTimersByTimeAsync(15_000);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(1);
        resolveDoctor({ stdout: doctorPayload([kRuntimeFinding]), spawnStartedAtMs: t0 + 20 });
        await tick();
        const rows = advisoryRows(insertWatchdogEvent);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          source: opening[0].source,
          status: "warn",
          correlationId: opening[0].correlationId,
        });
        expect(rows[0].details).toEqual({
          finding: {
            checkId: "gateway.probe_auth_secretref_unavailable",
            severity: "warning",
            kind: "runtime",
            component: "secrets",
            message: expect.stringContaining("SecretRef"),
          },
          observedAt: new Date(t0).toISOString(),
          doctorStartedAt: new Date(t0 + 20).toISOString(),
          doctorSettledAt: new Date(Date.now()).toISOString(),
          episode: 1,
        });
        // Still ONE incident: the advisory is evidence, not a trigger.
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        watchdog.stop();
      });

      it("#87 7′. X4: degrade → Doctor A pending → recover → same-key degrade again → Doctor A settles → NO row (episode_closed); the new episode's own Doctor attaches with episode 2", async () => {
        vi.useFakeTimers();
        const resolvers = [];
        const collector = vi.fn(
          () =>
            new Promise((resolve) => {
              resolvers.push(resolve);
            }),
        );
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          collectAdvisoryDoctorJson: collector,
        });
        launchEstablished(watchdog);
        await tick();
        expect(collector).toHaveBeenCalledTimes(1);
        // Recover at the 5s retry.
        control.readyzFailing = [];
        await vi.advanceTimersByTimeAsync(5_000);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        // Same key degrades again past the per-key Doctor floor (P2): a NEW
        // episode, its own Doctor.
        vi.setSystemTime(Date.now() + kAdvisoryDoctorFloorMs);
        control.readyzFailing = ["secrets"];
        await vi.advanceTimersByTimeAsync(5_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        expect(collector).toHaveBeenCalledTimes(2);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(2);
        // Doctor A (episode 1) settles with a matching finding: dropped.
        resolvers[0](doctorPayload([kRuntimeFinding]));
        await tick();
        expect(advisoryRows(insertWatchdogEvent)).toHaveLength(0);
        expect(consoleLines("readiness advisory dropped (episode_closed)")).toHaveLength(1);
        // Doctor B (episode 2) attaches.
        resolvers[1](doctorPayload([kRuntimeFinding]));
        await tick();
        const rows = advisoryRows(insertWatchdogEvent);
        expect(rows).toHaveLength(1);
        expect(rows[0].details.episode).toBe(2);
        expect(rows[0].correlationId).toBe(
          rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")[1].correlationId,
        );
        watchdog.stop();
      });

      it("#87 7b. Y4: a Doctor spawn coalesced from the previous episode (spawnStartedAtMs before this probe) is dropped as stale_doctor_job; the collector's next spawn attaches to the current episode", async () => {
        vi.useFakeTimers();
        const t0 = Date.now();
        // A single-flight fake: the first call starts S1 (stamped t0); a call
        // while S1 is in flight JOINS it (same promise, same stamp); after S1
        // settles the next call starts S2 with a fresh stamp.
        let inFlight = null;
        const spawns = [];
        const collector = vi.fn(() => {
          if (!inFlight) {
            const job = { spawnStartedAtMs: Date.now(), resolve: null, promise: null };
            job.promise = new Promise((resolve) => {
              job.resolve = (stdout) => {
                inFlight = null;
                resolve({ stdout, spawnStartedAtMs: job.spawnStartedAtMs });
              };
            });
            inFlight = job;
            spawns.push(job);
          }
          return inFlight.promise;
        });
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          collectAdvisoryDoctorJson: collector,
        });
        // Episode 1 → S1.
        launchEstablished(watchdog);
        await tick();
        expect(spawns).toHaveLength(1);
        expect(spawns[0].spawnStartedAtMs).toBe(t0);
        // Recovery, then episode 2 (past the per-key Doctor floor, P2)
        // degrades and its hint JOINS S1.
        control.readyzFailing = [];
        await vi.advanceTimersByTimeAsync(5_000);
        expect(watchdog.getStatus().readiness).toBe("ready");
        vi.setSystemTime(Date.now() + kAdvisoryDoctorFloorMs);
        control.readyzFailing = ["secrets"];
        await vi.advanceTimersByTimeAsync(5_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus().readiness).toBe("not_ready");
        expect(collector).toHaveBeenCalledTimes(2);
        expect(spawns).toHaveLength(1);
        // S1 settles with a matching finding: episode 1's hint is closed,
        // episode 2's hint sees a spawn older than its probe → stale.
        spawns[0].resolve(doctorPayload([kRuntimeFinding]));
        await tick();
        expect(advisoryRows(insertWatchdogEvent)).toHaveLength(0);
        expect(consoleLines("readiness advisory dropped (episode_closed)")).toHaveLength(1);
        expect(consoleLines("readiness advisory dropped (stale_doctor_job)")).toHaveLength(1);
        // The degradation widens inside episode 2 (key change, same episode):
        // the hint calls the collector again → S2, a fresh spawn → attaches.
        control.readyzFailing = ["secrets", "telegram"];
        await vi.advanceTimersByTimeAsync(5_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(collector).toHaveBeenCalledTimes(3);
        expect(spawns).toHaveLength(2);
        expect(spawns[1].spawnStartedAtMs).toBeGreaterThan(spawns[0].spawnStartedAtMs);
        spawns[1].resolve(doctorPayload([kRuntimeFinding]));
        await tick();
        const rows = advisoryRows(insertWatchdogEvent);
        expect(rows).toHaveLength(1);
        expect(rows[0].details.episode).toBe(2);
        expect(rows[0].details.doctorStartedAt).toBe(new Date(spawns[1].spawnStartedAtMs).toISOString());
        watchdog.stop();
      });

      // ── 8. cross-generation ─────────────────────────────────────────────
      it("#87 8. a launch between the opening probe and the Doctor settle drops the advisory (generation); a probe straddling a launch returns false and mutates nothing", async () => {
        vi.useFakeTimers();
        let resolveDoctor = null;
        const collector = vi.fn(
          () =>
            new Promise((resolve) => {
              resolveDoctor = resolve;
            }),
        );
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          collectAdvisoryDoctorJson: collector,
        });
        launchEstablished(watchdog);
        await tick();
        expect(collector).toHaveBeenCalledTimes(1);
        // A new gateway generation reports in (relaunch by another actor).
        watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
        // Hold its bootstrap probe so the generation change is the only thing
        // that happened when the Doctor settles.
        control.healthHold = true;
        await tick();
        resolveDoctor(doctorPayload([kRuntimeFinding]));
        await tick();
        expect(advisoryRows(insertWatchdogEvent)).toHaveLength(0);
        expect(consoleLines("readiness advisory dropped (generation)")).toHaveLength(1);
        control.healthHold = false;
        for (const entry of control.pendingHealth.splice(0)) entry.resolve(control.healthResponse());
        await tick();
        watchdog.stop();

        // Straddling probe: begun before a launch, answered after it.
        const second = createGatewayControl();
        const straddle = createHarness({
          autoRepair: false,
          fetchImpl: second.fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(straddle.watchdog);
        await tick();
        second.control.healthHold = true;
        const older = straddle.watchdog.runHealthCheck({ source: "health_timer" });
        await tick();
        expect(second.control.pendingHealth).toHaveLength(1);
        straddle.watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
        await tick();
        // The launch reset health to unknown; the newer bootstrap probe is
        // held too. Release ONLY the older probe.
        expect(second.control.pendingHealth).toHaveLength(2);
        const snapshot = straddle.watchdog.getStatus();
        expect(snapshot.health).toBe("unknown");
        second.control.pendingHealth.shift().resolve(second.control.healthResponse());
        expect(await older).toBe(false);
        expect(straddle.watchdog.getStatus()).toMatchObject({
          health: "unknown",
          readiness: "unknown",
          lastHealthCheckAt: snapshot.lastHealthCheckAt,
        });
        expect(consoleLines("superseded by a newer gateway generation — discarded")).toHaveLength(1);
        second.control.healthHold = false;
        second.control.pendingHealth.shift().resolve(second.control.healthResponse());
        await tick();
        expect(straddle.watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        straddle.watchdog.stop();
      });

      // ── 9. Doctor never blocks or breaks the tick ───────────────────────
      it("#87 9. a hung Doctor never delays the verdict: degraded, incident row, notice and the 5s retry armed within the probe; a rejecting Doctor is one console line, no throw", async () => {
        vi.useFakeTimers();
        const hung = createGatewayControl();
        hung.control.readyzFailing = ["secrets"];
        const neverSettles = vi.fn(() => new Promise(() => {}));
        const a = createHarness({
          autoRepair: false,
          fetchImpl: hung.fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          collectAdvisoryDoctorJson: neverSettles,
        });
        launchEstablished(a.watchdog);
        await tick();
        expect(neverSettles).toHaveBeenCalledTimes(1);
        expect(a.watchdog.getStatus()).toMatchObject({
          health: "degraded",
          readiness: "not_ready",
          degradedRetry: expect.objectContaining({ attempt: 0, nextDelayMs: 5_000 }),
        });
        expect(rowsOfType(a.insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(1);
        expect(noticesIncluding(a.notifier, "up but not ready")).toHaveLength(1);
        // The retry fires on schedule — the Doctor is not on the tick.
        const before = readyzProbeCount();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(readyzProbeCount()).toBe(before + 1);
        a.watchdog.stop();

        const rejecting = createGatewayControl();
        rejecting.control.readyzFailing = ["secrets"];
        const rejects = vi.fn(async () => {
          throw new Error("doctor exploded");
        });
        const b = createHarness({
          autoRepair: false,
          fetchImpl: rejecting.fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          collectAdvisoryDoctorJson: rejects,
        });
        launchEstablished(b.watchdog);
        await tick();
        expect(rejects).toHaveBeenCalledTimes(1);
        expect(b.watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        expect(consoleLines("readiness advisory dropped (failed)")).toEqual([
          expect.stringContaining("doctor exploded"),
        ]);
        expect(advisoryRows(b.insertWatchdogEvent)).toHaveLength(0);
        b.watchdog.stop();
      });

      // ── 10. overlapping probes (X3 / Y1) ────────────────────────────────
      // Returns { probe } (an async function returning the promise itself
      // would chain onto the held probe and never settle).
      const startProbe = async (watchdog, source) => {
        const probe = watchdog.runHealthCheck({ source });
        await settle();
        return { probe };
      };

      it("#87 10a. slow failing A + fast ok B → A discarded (console line), health stays healthy, no failed row", async () => {
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await settle();
        control.healthHold = true;
        const { probe: a } = await startProbe(watchdog, "health_timer");
        const { probe: b } = await startProbe(watchdog, "tcp_transition");
        expect(control.pendingHealth).toHaveLength(2);
        const [aHealth, bHealth] = control.pendingHealth.splice(0);
        bHealth.resolve(control.healthResponse());
        expect(await b).toMatchObject({ probeOk: true, healthy: true, ready: true });
        aHealth.reject(new Error("gateway unavailable"));
        expect(await a).toBe(false);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready", degradedRetry: null });
        expect(rowsOfType(insertWatchdogEvent, "health_check", "failed")).toHaveLength(0);
        expect(consoleLines("probe #")).toEqual([
          expect.stringMatching(/probe #\d+ \(health_timer\) superseded by #\d+ — discarded/),
        ]);
        watchdog.stop();
      });

      it("#87 10b. slow ok A + fast failing B → A discarded, health degraded (B's failure stands)", async () => {
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await settle();
        control.healthHold = true;
        const { probe: a } = await startProbe(watchdog, "health_timer");
        const { probe: b } = await startProbe(watchdog, "tcp_transition");
        const [aHealth, bHealth] = control.pendingHealth.splice(0);
        bHealth.reject(new Error("gateway unavailable"));
        expect(await b).toBe(false);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "unknown" });
        aHealth.resolve(control.healthResponse());
        expect(await a).toBe(false);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "unknown" });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        expect(consoleLines("superseded by #")).toHaveLength(1);
        watchdog.stop();
      });

      it("#87 10c. slow-readyz A + fast failing-liveness B → A's readiness is discarded at fence 2 (the failure claimed): health degraded, readiness unknown", async () => {
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await settle();
        control.readyzHold = true;
        const { probe: a } = await startProbe(watchdog, "health_timer");
        expect(control.pendingReadyz).toHaveLength(1);
        control.healthy = false;
        expect(await watchdog.runHealthCheck({ source: "tcp_transition" })).toBe(false);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "unknown" });
        control.healthy = true;
        control.pendingReadyz.shift().resolve(control.readyzResponse({ readyzHold: false }));
        expect(await a).toBe(false);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "unknown" });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        expect(consoleLines("superseded by #")).toHaveLength(1);
        watchdog.stop();
      });

      it("#87 fence 4: a NEWER liveness failure during B's recovery notice discards B — B resolves false with one console line, health stays degraded, no onHealthy, no health_check/ok row", async () => {
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const onHealthy = vi.fn();
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          releaseChannelHooks: { onHealthy, onUnhealthy: vi.fn() },
        });
        launchEstablished(watchdog);
        await settle();
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(1);
        onHealthy.mockClear();
        // B: /health ok, /readyz ready → recovery row, then the recovery
        // notice is HELD inside notifyOncePerIncident.
        control.readyzFailing = [];
        let releaseNotice = null;
        notifier.notify.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              releaseNotice = resolve;
            }),
        );
        const { probe: b } = await startProbe(watchdog, "health_timer");
        expect(typeof releaseNotice).toBe("function");
        expect(noticesIncluding(notifier, "running again")).toHaveLength(1);
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        const okRowsBefore = rowsOfType(insertWatchdogEvent, "health_check", "ok").length;
        // C (newer): /health fails and claims — degraded, readiness unknown.
        control.healthy = false;
        expect(await watchdog.runHealthCheck({ source: "tcp_transition" })).toBe(false);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "unknown" });
        control.healthy = true;
        // B's notice completes: fence 4 discards B.
        releaseNotice({ ok: true });
        expect(await b).toBe(false);
        expect(consoleLines("superseded by #")).toEqual([
          expect.stringMatching(/probe #\d+ \(health_timer\) superseded by #\d+ — discarded/),
        ]);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "unknown" });
        expect(onHealthy).not.toHaveBeenCalled();
        expect(rowsOfType(insertWatchdogEvent, "health_check", "ok")).toHaveLength(okRowsBefore);
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        watchdog.stop();
      });

      it("#87 10d. Y1 interleaving: newer B /health ok (step 1 writes port truth) → older A /health FAILS and commits → B's readyz ok → healthy + ready, no armed retry, the failure counter restarts from B (the next miss counts 1, not 2), and the ONE recovery row is emitted while live health reads healthy", async () => {
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        // A readiness incident is OPEN first (TQ-2), so B's ready verdict is a
        // real recovery — recovery row + notice — not a no-op green tick.
        control.readyzFailing = ["secrets"];
        launchEstablished(watchdog);
        await settle();
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(1);
        // Live health at emit time of every recovery row: the row's details
        // literal says "healthy"; this pins the STATE it was written under.
        const healthAtRecovery = [];
        insertWatchdogEvent.mockImplementation((event) => {
          if (event.eventType === "recovery") healthAtRecovery.push(watchdog.getStatus().health);
        });
        control.readyzFailing = [];
        control.healthHold = true;
        control.readyzHold = true;
        const { probe: a } = await startProbe(watchdog, "health_timer");
        const { probe: b } = await startProbe(watchdog, "tcp_transition");
        const [aHealth, bHealth] = control.pendingHealth.splice(0);
        // B's /health answers: step 1 writes port truth; B waits on /readyz.
        bHealth.resolve(control.healthResponse());
        await settle();
        expect(control.pendingReadyz).toHaveLength(1);
        // A's /health fails and COMMITS (nothing newer has applied yet).
        aHealth.reject(new Error("gateway unavailable"));
        expect(await a).toBe(false);
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          readiness: "unknown",
          degradedRetry: expect.objectContaining({ attempt: 0 }),
        });
        // B's readyz answers ready: the newest completed probe owns BOTH axes.
        control.pendingReadyz.shift().resolve(control.readyzResponse({ readyzHold: false }));
        expect(await b).toMatchObject({ probeOk: true, healthy: true, ready: true });
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          degradedReason: null,
          readiness: "ready",
          degradedRetry: null,
        });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(healthAtRecovery).toEqual(["healthy"]);
        // TQ-1: the consecutive-failure counter restarted with B — A's
        // committed miss was superseded by B's port truth, so the next miss
        // counts 1, not 2.
        control.healthHold = false;
        control.healthy = false;
        expect(await watchdog.runHealthCheck({ source: "health_timer" })).toBe(false);
        const failed = rowsOfType(insertWatchdogEvent, "health_check", "failed");
        expect(failed).toHaveLength(2);
        expect(failed[1].details.consecutiveFailures).toBe(1);
        watchdog.stop();
      });

      it("#87 10e. all 24 completion orders of 4 overlapping probes × 3 staging modes (interleaved; every liveness first; liveness in REVERSE seq order so an older liveness failure commits after the newest probe's step-1 write) end on the newest probe's observation on both axes", async () => {
        const permutations = (items) =>
          items.length <= 1
            ? [items]
            : items.flatMap((item, index) =>
                permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [
                  item,
                  ...rest,
                ]),
              );
        const kObservations = [
          { liveness: true, failing: [] },
          { liveness: false },
          { liveness: true, failing: ["secrets"] },
        ];
        const expectedFor = (observation) =>
          !observation.liveness
            ? { health: "degraded", readiness: "unknown" }
            : observation.failing.length
              ? { health: "degraded", readiness: "not_ready" }
              : { health: "healthy", readiness: "ready" };
        const orders = permutations([0, 1, 2, 3]);
        expect(orders).toHaveLength(24);
        const kModes = ["interleaved", "staged", "reverse"];
        for (const [index, order] of orders.entries()) {
          for (const [modeIndex, mode] of kModes.entries()) {
            const observations = [
              kObservations[index % 3],
              kObservations[(index + 1) % 3],
              kObservations[(index + 2) % 3],
              // The newest probe's observation is chosen per mode, independent
              // of the three older ones, so every kind ends every sequence.
              kObservations[(index + modeIndex) % 3],
            ];
            const { control, fetchImpl } = createGatewayControl();
            const { watchdog } = createHarness({
              autoRepair: false,
              fetchImpl,
              resolveGatewayReadyzUrl: () => kReadyzUrl,
            });
            launchEstablished(watchdog);
            await settle();
            control.healthHold = true;
            control.readyzHold = true;
            const probes = [];
            for (let i = 0; i < 4; i += 1) {
              probes.push((await startProbe(watchdog, "health_timer")).probe);
            }
            const healths = control.pendingHealth.splice(0);
            expect(healths).toHaveLength(4);
            const readyzOf = new Map();
            const releaseLiveness = async (i) => {
              if (observations[i].liveness) {
                healths[i].resolve(control.healthResponse());
                await settle();
                readyzOf.set(i, control.pendingReadyz.shift());
              } else {
                healths[i].reject(new Error("gateway unavailable"));
                await settle();
              }
            };
            const releaseReadiness = async (i) => {
              const entry = readyzOf.get(i);
              if (!entry) return;
              entry.resolve(control.readyzResponse({ readyzHold: false, readyzFailing: observations[i].failing }));
              await settle();
            };
            if (mode === "staged") {
              // Every liveness answer first (seq order), then readiness in
              // the permutation's order.
              for (let i = 0; i < 4; i += 1) await releaseLiveness(i);
              for (const i of order) await releaseReadiness(i);
            } else if (mode === "reverse") {
              // Liveness in REVERSE seq order (TQ-3): the newest probe's
              // step-1 port truth lands first, then an OLDER liveness failure
              // commits over it; readiness then lands in the permutation's
              // order. The newest completed probe must still own both axes.
              for (let i = 3; i >= 0; i -= 1) await releaseLiveness(i);
              for (const i of order) await releaseReadiness(i);
            } else {
              for (const i of order) {
                await releaseLiveness(i);
                await releaseReadiness(i);
              }
            }
            await Promise.all(probes);
            const label = `order ${order.join(",")} mode=${mode}`;
            expect(watchdog.getStatus(), label).toMatchObject(expectedFor(observations[3]));
            watchdog.stop();
          }
        }
      });

      it("#87 10f. sustained overlap: /readyz takes 4s and a probe starts every 2s for 30s → readiness updates within the first 6s (no starvation) and ends equal to the last completed probe's observation", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        control.readyzDelayMs = 4_000;
        const { watchdog } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        let firstReadyAtMs = null;
        const t0 = Date.now();
        for (let elapsed = 0; elapsed < 30_000; elapsed += 2_000) {
          void watchdog.runHealthCheck({ source: "health_timer" });
          await vi.advanceTimersByTimeAsync(2_000);
          if (firstReadyAtMs == null && watchdog.getStatus().readiness === "ready") {
            firstReadyAtMs = Date.now() - t0;
          }
          // From 20s on the gateway reports failing components.
          if (Date.now() - t0 >= 20_000) control.readyzFailing = ["secrets"];
        }
        expect(firstReadyAtMs).not.toBeNull();
        expect(firstReadyAtMs).toBeLessThanOrEqual(6_000);
        // Let every in-flight probe land; later retry probes answer at once so
        // the sample is not taken inside a probe's 4s readyz window (where
        // step 1 has written port truth and readiness is still pending).
        control.readyzDelayMs = 0;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "readiness_failing",
          readiness: "not_ready",
          readinessReason: "secrets",
          readinessProbe: "ok",
        });
        watchdog.stop();
      });

      // ── R. adversarial-review gaps (five-lens review of the #87 tree) ───
      it("#87 R1. an exit resets the readiness axis: not_ready incident → three crashes with no relaunch left (crash_loop, auto-repair off) → the gateway comes back green but its first /readyz times out → NO recovery hold: readiness unknown, health healthy, no readinessProbe:timeout pending row, no degraded write", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        // Two crashes relaunch (the relaunch request resets the axis itself);
        // a probe then re-reads the still-failing /readyz so readiness is
        // not_ready again right before the exit under test.
        watchdog.onGatewayExit({ code: 1, expectedExit: false });
        await tick();
        watchdog.onGatewayExit({ code: 1, expectedExit: false });
        await tick();
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({
          readiness: "not_ready",
          readinessReason: "secrets",
          readinessProbe: "ok",
        });
        // The third crash: crash_loop, nothing relaunches (auto-repair off) —
        // the EXIT itself must forget what the dead process said on /readyz.
        watchdog.onGatewayExit({ code: 1, expectedExit: false });
        await tick();
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "crash_loop",
          health: "unhealthy",
          readiness: "unknown",
          readinessReason: null,
          readinessProbe: null,
          readinessStatus: null,
        });
        // The gateway comes back (operator / external supervisor): /health
        // green, its first /readyz hangs → timeout. Nothing to hold on.
        control.readyzHang = true;
        const probe = watchdog.runHealthCheck({ source: "health_timer" });
        await vi.advanceTimersByTimeAsync(5_000);
        expect(await probe).toMatchObject({ probeOk: true, healthy: true });
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "running",
          health: "healthy",
          degradedReason: null,
          readiness: "unknown",
          readinessProbe: "timeout",
          degradedRetry: null,
        });
        expect(
          pendingRows(insertWatchdogEvent, "readinessPending").filter(
            (row) => row.details.readinessProbe === "timeout",
          ),
        ).toHaveLength(0);
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        watchdog.stop();
      });

      it("#87 R2. a fail-open recovery ends the degradation episode: X1 bound expiry {recoveryAssumed} writes readiness_degraded ok {recovered, assumed, kind} and clears the key → the SAME failing components open a SECOND episode (second failed row, advisory episode 2, health degraded, second notice); the 404 fail-open path does the same (episode 3)", async () => {
        vi.useFakeTimers();
        const collector = vi.fn(async () => ({
          stdout: doctorPayload([kRuntimeFinding]),
          spawnStartedAtMs: Date.now(),
        }));
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          collectAdvisoryDoctorJson: collector,
        });
        const openings = () => rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed");
        const closings = () => rowsOfType(insertWatchdogEvent, "readiness_degraded", "ok");
        const episodes = () => advisoryRows(insertWatchdogEvent).map((row) => row.details.episode);
        launchEstablished(watchdog);
        await tick();
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        expect(openings()).toHaveLength(1);
        expect(episodes()).toEqual([1]);
        expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(1);
        // /readyz becomes unreadable: the first held probe starts the hold clock.
        control.readyzThrow = new Error("connect ECONNREFUSED");
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        // One ms past the budget: fail open — recoveryAssumed, the episode
        // closes with its own row, recovery proceeds.
        vi.setSystemTime(Date.now() + kGatewayRestartReadyTimeoutMs + 1);
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(
          probeErrorRows(insertWatchdogEvent).filter((row) => row.details.recoveryAssumed === true),
        ).toHaveLength(1);
        expect(closings()).toHaveLength(1);
        expect(closings()[0].details).toEqual({ recovered: true, assumed: true, kind: "unavailable" });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "unknown" });
        // The SAME components fail again in this generation: a NEW episode —
        // second opening row, episode 2 on its advisory (past the per-key
        // Doctor floor, P2), degraded, notified.
        vi.setSystemTime(Date.now() + kAdvisoryDoctorFloorMs);
        control.readyzThrow = null;
        await watchdog.runHealthCheck({ source: "health_timer" });
        await tick();
        expect(openings()).toHaveLength(2);
        expect(openings()[1].details).toMatchObject({ failing: ["secrets"], reason: "secrets" });
        expect(episodes()).toEqual([1, 2]);
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "readiness_failing",
          readiness: "not_ready",
          readinessReason: "secrets",
        });
        expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(2);
        // 404 (`unsupported`) fails open at once with the same closing row…
        control.readyzHttpStatus = 404;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(closings()).toHaveLength(2);
        expect(closings()[1].details).toEqual({ recovered: true, assumed: true, kind: "unsupported" });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(2);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "unknown", readinessProbe: "unsupported" });
        // …and the same components afterwards are episode 3 (again past the
        // per-key Doctor floor).
        vi.setSystemTime(Date.now() + kAdvisoryDoctorFloorMs);
        control.readyzHttpStatus = null;
        await watchdog.runHealthCheck({ source: "health_timer" });
        await tick();
        expect(openings()).toHaveLength(3);
        expect(episodes()).toEqual([1, 2, 3]);
        expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(3);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        watchdog.stop();
      });

      it("#87 R3. no fenced write after an await: newer B (200 started, channels suppressed) is held in the safe-mode notify await; older A (503 starting, suppression cleared) arrives meanwhile, is held in its own notify, and settles AFTER B → A is discarded at fence 3: readinessStatus 'started', no transitional pending row, and the transitional clock is clear (a fresh `starting` a full budget later is transitional, not expired)", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready", readinessStatus: null });
        // Deferred notifier: every notice is held until released, in order.
        const pendingNotifies = [];
        notifier.notify.mockImplementation(
          () =>
            new Promise((resolve) => {
              pendingNotifies.push(resolve);
            }),
        );
        control.readyzHold = true;
        const a = watchdog.runHealthCheck({ source: "health_timer" });
        await tick();
        const b = watchdog.runHealthCheck({ source: "tcp_transition" });
        await tick();
        expect(control.pendingReadyz).toHaveLength(2);
        const [aReadyz, bReadyz] = control.pendingReadyz.splice(0);
        // B's body first: 200 started with suppressed channels → safe_mode
        // failed row, notify HELD (B has not claimed).
        bReadyz.resolve(
          control.readyzResponse({
            readyzHold: false,
            readyzBody: JSON.stringify({
              ready: true,
              status: "started",
              failing: [],
              suppressed: ["telegram"],
              eventLoop: { degraded: false },
            }),
          }),
        );
        await tick();
        expect(pendingNotifies).toHaveLength(1);
        expect(rowsOfType(insertWatchdogEvent, "safe_mode", "failed")).toHaveLength(1);
        // A's body during B's await: 503 starting, suppression gone → safe
        // mode clears (the axis is not seq-fenced by design), notify HELD too.
        aReadyz.resolve(
          control.readyzResponse({
            readyzHold: false,
            readyzHttpStatus: 503,
            readyzBody: JSON.stringify({
              ready: false,
              status: "starting",
              failing: [],
              suppressed: [],
              eventLoop: { degraded: false },
            }),
          }),
        );
        await tick();
        expect(pendingNotifies).toHaveLength(2);
        // Neither body has touched the readiness axis or its telemetry yet.
        expect(watchdog.getStatus()).toMatchObject({ readiness: "ready", readinessStatus: null, readinessReason: null });
        // B settles first and claims; A settles after and is discarded.
        pendingNotifies[0]({ ok: true });
        expect(await b).toMatchObject({ probeOk: true, healthy: true, ready: true });
        expect(watchdog.getStatus()).toMatchObject({ readiness: "ready", readinessStatus: "started" });
        pendingNotifies[1]({ ok: true });
        expect(await a).toBe(false);
        expect(consoleLines("superseded by #")).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "ready",
          readinessReason: null,
          readinessStatus: "started",
          readinessProbe: "ok",
        });
        expect(pendingRows(insertWatchdogEvent, "readinessPending")).toHaveLength(0);
        // The transitional clock is clear: a fresh `starting` observed a full
        // budget later gets a fresh budget — transitional, never "did not
        // complete" (A's discarded 503 must not have started the clock).
        vi.setSystemTime(Date.now() + kGatewayRestartReadyTimeoutMs + 1);
        control.readyzHold = false;
        control.readyzStatus = "starting";
        control.ready = false;
        control.readyzHttpStatus = 503;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          degradedReason: null,
          readiness: "not_ready",
          readinessReason: "starting",
          readinessStatus: "starting",
        });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(0);
        watchdog.stop();
      });

      it("#87 R4. a non-transitional body ends the transitional clock: starting → expired (degraded) → 200 {failing:[telegram]} → starting again is transitional (reason 'starting', no 'did not complete') and expires only after another FULL budget", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        control.readyzStatus = "starting";
        control.ready = false;
        control.readyzHttpStatus = 503;
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        const openings = () => rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed");
        watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 100 });
        await tick();
        await vi.advanceTimersByTimeAsync(kGatewayRestartReadyTimeoutMs + 5_000);
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          readinessReason: expect.stringContaining("starting did not complete within"),
        });
        expect(openings()).toHaveLength(1);
        // A real not_ready with components: non-transitional → the clock ends.
        control.readyzStatus = null;
        control.readyzFailing = ["telegram"];
        control.readyzHttpStatus = 200;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          readiness: "not_ready",
          readinessReason: "telegram",
          readinessStatus: null,
        });
        expect(openings()).toHaveLength(2);
        // A fresh `starting` phase: transitional again, on a fresh budget.
        control.readyzStatus = "starting";
        control.readyzFailing = [];
        control.readyzHttpStatus = 503;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          degradedReason: null,
          readiness: "not_ready",
          readinessReason: "starting",
          readinessStatus: "starting",
        });
        // Inside the new budget (5s rechecks all the way): still transitional.
        await vi.advanceTimersByTimeAsync(kGatewayRestartReadyTimeoutMs - 5_000);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readinessReason: "starting" });
        expect(openings()).toHaveLength(2);
        // Past it: expired again, one more opening row (same episode).
        await vi.advanceTimersByTimeAsync(10_000);
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "readiness_failing",
          readinessReason: expect.stringContaining("starting did not complete within"),
        });
        expect(openings()).toHaveLength(3);
        watchdog.stop();
      });

      it("#87 R5. liveness latches are post-claim: in crash_loop (auto-repair off) a slow ok A whose /readyz is pending when a fast FAILING B claims leaves lifecycle crash_loop and lastExit standing (A discarded, no recovery); a single ok probe in `crashed` still flips lifecycle to running", async () => {
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await settle();
        for (let i = 0; i < 3; i += 1) {
          watchdog.onGatewayExit({ code: 1, expectedExit: false });
          await settle();
        }
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "crash_loop",
          health: "unhealthy",
          lastExit: expect.objectContaining({ code: 1 }),
        });
        control.healthHold = true;
        control.readyzHold = true;
        const { probe: a } = await startProbe(watchdog, "health_timer");
        const { probe: b } = await startProbe(watchdog, "tcp_transition");
        const [aHealth, bHealth] = control.pendingHealth.splice(0);
        // A's /health answers: step 1 is port truth only — lifecycle, lastExit
        // and the crash latches are untouched while A waits on /readyz.
        aHealth.resolve(control.healthResponse());
        await settle();
        expect(control.pendingReadyz).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "crash_loop",
          health: "healthy",
          lastExit: expect.objectContaining({ code: 1 }),
        });
        // B fails and claims.
        bHealth.reject(new Error("gateway unavailable"));
        expect(await b).toBe(false);
        // A's /readyz answers: fence 2 discards it — nothing A wrote pre-claim
        // outlives it, and no latch ever flipped.
        control.pendingReadyz.shift().resolve(control.readyzResponse({ readyzHold: false }));
        expect(await a).toBe(false);
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "crash_loop",
          health: "degraded",
          readiness: "unknown",
          lastExit: expect.objectContaining({ code: 1 }),
        });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        expect(consoleLines("superseded by #")).toHaveLength(1);
        watchdog.stop();

        // Positive case: `crashed` (relaunch aborted, nothing pending) + ONE
        // ok probe → the deferred latch applies: running, lastExit cleared.
        const aborted = createGatewayControl();
        const requestGatewayLaunch = vi.fn(async () =>
          launchOutcome("launch_aborted", { detail: "lease_expired" }),
        );
        const crashed = createHarness({
          autoRepair: false,
          fetchImpl: aborted.fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          requestGatewayLaunch,
        });
        launchEstablished(crashed.watchdog);
        await settle();
        // The port is dark while the relaunch is attempted (a green answer
        // there would be adopted as an incumbent); it comes back afterwards.
        aborted.control.healthy = false;
        crashed.watchdog.onGatewayExit({ code: 1, expectedExit: false });
        await settle();
        // (Health is whatever the relaunch's pre-spawn probe of the dark port
        // left — the latch under test is the lifecycle / lastExit pair.)
        expect(crashed.watchdog.getStatus()).toMatchObject({
          lifecycle: "crashed",
          replacementPending: null,
          lastExit: expect.objectContaining({ code: 1 }),
        });
        aborted.control.healthy = true;
        expect(await crashed.watchdog.runHealthCheck({ source: "health_timer" })).toMatchObject({
          probeOk: true,
          healthy: true,
          ready: true,
        });
        expect(crashed.watchdog.getStatus()).toMatchObject({
          lifecycle: "running",
          health: "healthy",
          readiness: "ready",
          lastExit: null,
        });
        expect(rowsOfType(crashed.insertWatchdogEvent, "recovery")).toHaveLength(1);
        crashed.watchdog.stop();
      });

      it("#87 R6. the X1 hold restores degraded health + the retry loop BEFORE the identity gate: with a pending replacement unobserved, probe 1 not_ready (retry armed) → probe 2 /health ok + /readyz unavailable → health degraded (readiness_failing), degradedRetry non-null, the replacementPending run continues (one row + one counted repeat)", async () => {
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await settle();
        // A crash relaunch through the legacy shim (pid 4242, never announced)
        // leaves the replacement pending with its identity unobserved.
        control.healthy = false;
        watchdog.onGatewayExit({ code: 1, expectedExit: false });
        await settle();
        expect(watchdog.getStatus().replacementPending).toMatchObject({ pid: 4242 });
        // Probe 1: green /health, /readyz not ready → readiness written, the
        // retry armed, liveness-only (replacementPending) row.
        control.healthy = true;
        control.readyzFailing = ["secrets"];
        expect(await watchdog.runHealthCheck({ source: "health_timer" })).toMatchObject({
          probeOk: true,
          identityClear: false,
        });
        // (Under the identity gate the readiness verdict degrades health and
        // arms the retry; the readiness_failing reason itself is step 4's,
        // which the gate returns before — pre-existing, not under test here.)
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "running",
          health: "degraded",
          readiness: "not_ready",
          readinessReason: "secrets",
        });
        expect(watchdog.getStatus().degradedRetry).not.toBeNull();
        expect(pendingRows(insertWatchdogEvent, "replacementPending")).toHaveLength(1);
        // Probe 2: /health ok, /readyz unavailable → held. The hold's Y2
        // restoration must survive the identity-gate return.
        control.readyzThrow = new Error("connect ECONNREFUSED");
        expect(await watchdog.runHealthCheck({ source: "health_timer" })).toMatchObject({
          probeOk: true,
          identityClear: false,
        });
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "readiness_failing",
          readiness: "not_ready",
          readinessReason: "secrets",
          readinessProbe: "unavailable",
        });
        expect(watchdog.getStatus().degradedRetry).not.toBeNull();
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        // Same pending run: no second full row; stop() flushes the summary
        // carrying the one repeat.
        expect(pendingRows(insertWatchdogEvent, "replacementPending")).toHaveLength(1);
        watchdog.stop();
        const replacementRows = pendingRows(insertWatchdogEvent, "replacementPending");
        expect(replacementRows).toHaveLength(2);
        expect(replacementRows[1].details).toMatchObject({ replacementPending: true, repeatedProbes: 1 });
      });

      it("#87 R7. transitional readiness OUTSIDE the bootstrap loop keeps a 5s recheck cadence: steady state → the worker restarts in place (no launch event) → a health_timer probe reads 503 starting → /readyz re-probed exactly every 5s until `started`, then the recheck stops and the 120s cadence resumes; a phase that never completes expires at ~budget through the rechecks, not budget+120s", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        // Steady state: the bootstrap loop is over, the regular timer owns the
        // cadence — one probe per 120s.
        let before = readyzProbeCount();
        await vi.advanceTimersByTimeAsync(kWatchdogCheckIntervalMs);
        expect(readyzProbeCount()).toBe(before + 1);
        // The worker restarts in place: the regular tick reads 503 starting.
        control.readyzStatus = "starting";
        control.ready = false;
        control.readyzHttpStatus = 503;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({
          lifecycle: "running",
          health: "healthy",
          readiness: "not_ready",
          readinessReason: "starting",
          degradedRetry: null,
        });
        // Exactly one /readyz per 5s while transitional.
        for (let i = 0; i < 3; i += 1) {
          before = readyzProbeCount();
          await vi.advanceTimersByTimeAsync(4_999);
          expect(readyzProbeCount()).toBe(before);
          await vi.advanceTimersByTimeAsync(1);
          expect(readyzProbeCount()).toBe(before + 1);
          expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readinessReason: "starting" });
        }
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        expect(pendingRows(insertWatchdogEvent, "readinessPending")).toHaveLength(1);
        // `started`: ready within one recheck; the recheck stops.
        control.readyzStatus = "started";
        control.ready = null;
        control.readyzHttpStatus = 200;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready", readinessStatus: "started" });
        before = readyzProbeCount();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(readyzProbeCount()).toBe(before);
        // The regular cadence resumes: the next 120s tick is the next probe.
        await vi.advanceTimersByTimeAsync(kWatchdogCheckIntervalMs - 50_000);
        expect(readyzProbeCount()).toBe(before + 1);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        // A phase that never completes: through the recheck cadence the X2
        // budget expires within one recheck of the budget (not at the next
        // 120s tick), degrades, opens the incident and hands the cadence to
        // the degraded-retry loop.
        control.readyzStatus = "starting";
        control.ready = false;
        control.readyzHttpStatus = 503;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readinessReason: "starting" });
        await vi.advanceTimersByTimeAsync(kGatewayRestartReadyTimeoutMs + 5_000);
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "readiness_failing",
          readiness: "not_ready",
          readinessReason: expect.stringContaining("starting did not complete within"),
        });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(1);
        expect(watchdog.getStatus().degradedRetry).not.toBeNull();
        watchdog.stop();
      });

      it("#87 R7′. T2: the armed transitional recheck is cancelled by stop() and by an exit — an armed 5s shot never probes a stopped watchdog, and no `readiness_recheck` probe fires for a gateway generation that ended", async () => {
        vi.useFakeTimers();
        // stop()
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await tick();
        await vi.advanceTimersByTimeAsync(kWatchdogCheckIntervalMs);
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        control.readyzStatus = "starting";
        control.ready = false;
        control.readyzHttpStatus = 503;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({ readiness: "not_ready", readinessStatus: "starting" });
        const readyzBefore = readyzProbeCount();
        const fetchBefore = global.fetch.mock.calls.length;
        watchdog.stop();
        await vi.advanceTimersByTimeAsync(10_000);
        expect(readyzProbeCount()).toBe(readyzBefore);
        expect(global.fetch.mock.calls.length).toBe(fetchBefore);

        // onGatewayExit (unexpected): the shot armed for the exited
        // generation never fires; whatever the relaunch probes, nothing runs
        // under source `readiness_recheck` and /readyz is not read again
        // while the port is down.
        const second = createGatewayControl();
        const exited = createHarness({
          autoRepair: false,
          fetchImpl: second.fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(exited.watchdog);
        await tick();
        await vi.advanceTimersByTimeAsync(kWatchdogCheckIntervalMs);
        second.control.readyzStatus = "starting";
        second.control.ready = false;
        second.control.readyzHttpStatus = 503;
        await exited.watchdog.runHealthCheck({ source: "health_timer" });
        expect(exited.watchdog.getStatus()).toMatchObject({ readiness: "not_ready", readinessStatus: "starting" });
        const rowsBefore = exited.insertWatchdogEvent.mock.calls.length;
        const secondReadyzBefore = global.fetch.mock.calls.filter(([url]) => String(url).includes("readyz")).length;
        second.control.healthy = false;
        exited.watchdog.onGatewayExit({ code: 1, expectedExit: false, pid: 100 });
        await vi.advanceTimersByTimeAsync(10_000);
        const later = exited.insertWatchdogEvent.mock.calls.slice(rowsBefore).map(([row]) => row);
        expect(later.filter((row) => row.source === "readiness_recheck")).toEqual([]);
        expect(global.fetch.mock.calls.filter(([url]) => String(url).includes("readyz"))).toHaveLength(secondReadyzBefore);
        expect(exited.watchdog.getStatus()).toMatchObject({ readiness: "unknown", readinessStatus: null });
        exited.watchdog.stop();
      });

      it("#87 P1. the telemetry floors survive a liveness flap: one readiness_probe_error {unavailable} and one event_loop_pressure warn across /health failing and recovering inside the floors; a launch (generation change) re-arms both", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        control.eventLoopDegraded = true;
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        const warns = () => rowsOfType(insertWatchdogEvent, "event_loop_pressure", "warn");
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready", eventLoopDegraded: true });
        expect(warns()).toHaveLength(1);
        // /readyz → HTTP 500: one probe-error row.
        control.readyzHttpStatus = 500;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({ readiness: "unknown", readinessProbe: "unavailable" });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(1);
        // Liveness flap: /health fails (the readiness AXIS resets) …
        control.healthy = false;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "unknown", readinessProbe: null });
        // … and answers again 60s later with /readyz still HTTP 500: a
        // null→unavailable transition inside the 5-min floor — no second row.
        control.healthy = true;
        vi.setSystemTime(Date.now() + 60_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readinessProbe: "unavailable" });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(1);
        // The body comes back with the diagnostic still degraded: the same
        // pressure episode (10-min floor) — no second warn.
        control.readyzHttpStatus = null;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({ readiness: "ready", eventLoopDegraded: true });
        expect(warns()).toHaveLength(1);
        // A second flap inside the floors changes nothing either.
        control.healthy = false;
        await watchdog.runHealthCheck({ source: "health_timer" });
        control.healthy = true;
        control.readyzHttpStatus = 500;
        vi.setSystemTime(Date.now() + 60_000);
        await watchdog.runHealthCheck({ source: "health_timer" });
        control.readyzHttpStatus = null;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(1);
        expect(warns()).toHaveLength(1);
        // A launch is a generation change: both floors start clean.
        control.readyzHttpStatus = 500;
        watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ readinessProbe: "unavailable" });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(2);
        control.readyzHttpStatus = null;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(warns()).toHaveLength(2);
        watchdog.stop();
      });

      it("#87 P2. the advisory Doctor has a per-key floor (kAdvisoryDoctorFloorMs): the same failing components degrading again 1 min later spawn NO collector (console `floor`), a different key inside the floor does, and the first key 11 min after its spawn does again", async () => {
        vi.useFakeTimers();
        expect(kAdvisoryDoctorFloorMs).toBe(10 * 60_000);
        const collector = vi.fn(async () => ({
          stdout: doctorPayload([kRuntimeFinding]),
          spawnStartedAtMs: Date.now(),
        }));
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          collectAdvisoryDoctorJson: collector,
        });
        const openings = () => rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed");
        const recover = async () => {
          control.readyzFailing = [];
          await watchdog.runHealthCheck({ source: "health_timer" });
          expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        };
        launchEstablished(watchdog);
        await tick();
        await tick();
        expect(collector).toHaveBeenCalledTimes(1);
        expect(advisoryRows(insertWatchdogEvent)).toHaveLength(1);
        const firstSpawnAt = Date.now();
        // Episode 2, same key, 1 min later: the verdict applies (opening row,
        // degraded) but no spawn — one console line names the floor.
        await recover();
        vi.setSystemTime(firstSpawnAt + 60_000);
        control.readyzFailing = ["secrets"];
        await watchdog.runHealthCheck({ source: "health_timer" });
        await tick();
        expect(openings()).toHaveLength(2);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        expect(collector).toHaveBeenCalledTimes(1);
        expect(consoleLines("readiness advisory dropped (floor)")).toHaveLength(1);
        expect(advisoryRows(insertWatchdogEvent)).toHaveLength(1);
        // A different key inside the floor (the degradation widens): spawns.
        control.readyzFailing = ["secrets", "telegram"];
        await watchdog.runHealthCheck({ source: "health_timer" });
        await tick();
        expect(collector).toHaveBeenCalledTimes(2);
        // The first key again, 11 min after its spawn: spawns.
        await recover();
        vi.setSystemTime(firstSpawnAt + 11 * 60_000);
        control.readyzFailing = ["secrets"];
        await watchdog.runHealthCheck({ source: "health_timer" });
        await tick();
        expect(collector).toHaveBeenCalledTimes(3);
        expect(consoleLines("readiness advisory dropped (floor)")).toHaveLength(1);
        // A launch resets the floor map with the other telemetry floors.
        await recover();
        control.readyzFailing = ["secrets"];
        watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 4242 });
        await tick();
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ readiness: "not_ready" });
        expect(collector).toHaveBeenCalledTimes(4);
        watchdog.stop();
      });

      it("#87 SEC1 (transport). a valid-JSON /readyz body over kReadyzBodyMaxChars is never parsed: readinessProbe malformed, readiness unknown, one readiness_probe_error {kind: malformed}; getStatus().readyzFailing is capped to the list/entry bounds", async () => {
        const { control, fetchImpl } = createGatewayControl();
        control.readyzBody = JSON.stringify({ ready: true, pad: "x".repeat(kReadyzBodyMaxChars) });
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await settle();
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "unknown",
          readinessProbe: "malformed",
        });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(1);
        expect(probeErrorRows(insertWatchdogEvent)[0].details).toMatchObject({ kind: "malformed", httpStatus: 200 });
        control.readyzBody = null;
        control.readyzFailing = Array.from({ length: 25 }, (_, i) => `component-${i}-${"y".repeat(200)}`);
        await watchdog.runHealthCheck({ source: "health_timer" });
        const status = watchdog.getStatus();
        expect(status.readiness).toBe("not_ready");
        expect(status.readyzFailing).toHaveLength(kReadyzListMaxEntries);
        for (const entry of status.readyzFailing) expect(entry.length).toBeLessThanOrEqual(kReadyzEntryMaxChars);
        expect(status.readinessReason.length).toBeLessThanOrEqual(200);
        watchdog.stop();
      });

      // ── A1 pure classifier edges (direct) ───────────────────────────────
      it("#87 A1 edges. classifyReadinessResponse: 405/501 are unsupported, an unparseable HTTP status is unavailable 'HTTP ?', a non-object/array body is malformed, `ready` absent + failing[] is components (compat), a bare 503 object is explicit, a transitional status wins over failing/ready:false, an unknown status is ignored, and eventLoop/reasons/delayP99Ms/suppressed normalize; the enums are exported", () => {
        const {
          classifyReadinessResponse,
          kReadinessStatuses,
          kReadinessProbeKinds,
          kUnreadyReasons,
        } = require("../../lib/server/watchdog");
        expect(kReadinessStatuses).toEqual(["started", "starting", "draining"]);
        expect(kReadinessProbeKinds).toEqual([
          "ok",
          "unconfigured",
          "unsupported",
          "unavailable",
          "timeout",
          "malformed",
        ]);
        expect(kUnreadyReasons).toEqual(["starting", "draining", "components", "explicit"]);
        for (const httpStatus of [404, 405, 501]) {
          expect(classifyReadinessResponse({ httpStatus, body: { ready: true } })).toEqual({
            ok: false,
            kind: "unsupported",
            httpStatus,
            reason: `gateway readyz returned HTTP ${httpStatus}`,
          });
        }
        // Unparseable / absent status: unavailable, never a consumed body.
        expect(classifyReadinessResponse({ httpStatus: undefined, body: { ready: true } })).toEqual({
          ok: false,
          kind: "unavailable",
          httpStatus: null,
          reason: "gateway readyz returned HTTP ?",
        });
        expect(classifyReadinessResponse({})).toMatchObject({ ok: false, kind: "unavailable", httpStatus: null });
        expect(classifyReadinessResponse({ httpStatus: "502", body: {} })).toMatchObject({
          kind: "unavailable",
          httpStatus: 502,
        });
        // Non-object bodies (including arrays) are malformed on a 2xx/503.
        for (const body of [null, undefined, "ready", 7, [{ ready: true }]]) {
          expect(classifyReadinessResponse({ httpStatus: 200, body })).toMatchObject({
            ok: false,
            kind: "malformed",
            httpStatus: 200,
          });
        }
        expect(classifyReadinessResponse({ httpStatus: 503, body: [] })).toMatchObject({ kind: "malformed" });
        // Compat: no `ready` field at all, failing[] present → components (coerced strings, blanks dropped).
        expect(
          classifyReadinessResponse({ httpStatus: 200, body: { failing: ["telegram", 7, "", null] } }),
        ).toMatchObject({
          ok: true,
          kind: "not_ready",
          ready: false,
          unreadyReason: "components",
          failing: ["telegram", "7"],
          status: null,
        });
        // Bare 503 object → explicit; 503 + failing (no ready) → components.
        expect(classifyReadinessResponse({ httpStatus: 503, body: {} })).toMatchObject({
          ok: true,
          kind: "not_ready",
          unreadyReason: "explicit",
          failing: [],
        });
        expect(classifyReadinessResponse({ httpStatus: 503, body: { failing: ["x"] } })).toMatchObject({
          unreadyReason: "components",
        });
        // Transitional status takes precedence over failing[] and ready:false.
        expect(
          classifyReadinessResponse({
            httpStatus: 503,
            body: { ready: false, status: "draining", failing: ["telegram"] },
          }),
        ).toMatchObject({ kind: "not_ready", status: "draining", unreadyReason: "draining", failing: ["telegram"] });
        // An unknown status string is not a phase; ready:true is authoritative even beside a failing[] list.
        expect(classifyReadinessResponse({ httpStatus: 200, body: { ready: true, status: "booting" } })).toMatchObject({
          kind: "ready",
          ready: true,
          status: null,
          unreadyReason: null,
        });
        expect(classifyReadinessResponse({ httpStatus: 200, body: { ready: true, failing: ["telegram"] } })).toMatchObject(
          { kind: "ready", failing: ["telegram"], unreadyReason: null },
        );
        // eventLoop normalization: non-object → null/false; degraded is coerced; reasons allowlisted; delay must be finite.
        expect(classifyReadinessResponse({ httpStatus: 200, body: { ready: true, eventLoop: "degraded" } })).toMatchObject({
          eventLoop: null,
          eventLoopDegraded: false,
        });
        expect(classifyReadinessResponse({ httpStatus: 200, body: { ready: true, eventLoop: [{ degraded: true }] } })).toMatchObject({
          eventLoop: null,
          eventLoopDegraded: false,
        });
        expect(
          classifyReadinessResponse({
            httpStatus: 200,
            body: { ready: true, eventLoop: { degraded: 1, reasons: "cpu", delayP99Ms: "812" } },
          }),
        ).toMatchObject({ eventLoopDegraded: true, eventLoop: { reasons: [], delayP99Ms: null } });
        expect(
          classifyReadinessResponse({
            httpStatus: 200,
            body: {
              ready: true,
              eventLoop: { degraded: false, reasons: ["cpu", "event_loop_delay", "bogus"], delayP99Ms: 12.5 },
            },
          }),
        ).toMatchObject({ eventLoopDegraded: false, eventLoop: { reasons: ["cpu", "event_loop_delay"], delayP99Ms: 12.5 } });
        // suppressed[] is coerced like failing[]; a non-array is empty.
        expect(
          classifyReadinessResponse({ httpStatus: 200, body: { ready: true, suppressed: ["telegram", null, 3] } }),
        ).toMatchObject({ suppressed: ["telegram", "3"] });
        expect(classifyReadinessResponse({ httpStatus: 200, body: { ready: true, suppressed: "telegram" } })).toMatchObject({
          suppressed: [],
        });
        // SEC1: gateway-controlled lists and bodies are bounded — 20 entries
        // per list, 100 chars per entry, and a body over 64 KB is malformed
        // from its size alone (before any parse); 404 still wins over size.
        expect([kReadyzListMaxEntries, kReadyzEntryMaxChars, kReadyzBodyMaxChars]).toEqual([20, 100, 64 * 1024]);
        const many = Array.from({ length: 25 }, (_, i) => `component-${i}`);
        const capped = classifyReadinessResponse({
          httpStatus: 200,
          body: { ready: false, failing: many, suppressed: many },
        });
        expect(capped.failing).toEqual(many.slice(0, 20));
        expect(capped.suppressed).toEqual(many.slice(0, 20));
        expect(capped).toMatchObject({ kind: "not_ready", unreadyReason: "components" });
        expect(
          classifyReadinessResponse({ httpStatus: 200, body: { ready: false, failing: ["x".repeat(500)] } }).failing,
        ).toEqual(["x".repeat(100)]);
        // Empty entries do not consume list slots.
        expect(
          classifyReadinessResponse({ httpStatus: 200, body: { ready: false, failing: ["", null, ...many] } }).failing,
        ).toEqual(many.slice(0, 20));
        expect(
          classifyReadinessResponse({ httpStatus: 200, body: { ready: true }, rawBodyChars: kReadyzBodyMaxChars + 1 }),
        ).toMatchObject({ ok: false, kind: "malformed", httpStatus: 200, reason: expect.stringContaining("over") });
        expect(
          classifyReadinessResponse({ httpStatus: 503, body: null, rawBodyChars: kReadyzBodyMaxChars + 1 }),
        ).toMatchObject({ ok: false, kind: "malformed", httpStatus: 503 });
        expect(
          classifyReadinessResponse({ httpStatus: 200, body: { ready: true }, rawBodyChars: kReadyzBodyMaxChars }),
        ).toMatchObject({ ok: true, kind: "ready" });
        expect(classifyReadinessResponse({ httpStatus: 404, body: null, rawBodyChars: 1e7 }).kind).toBe("unsupported");
        expect(classifyReadinessResponse({ httpStatus: 500, body: null, rawBodyChars: 1e7 }).kind).toBe("unavailable");
      });

      // ── 4f. unconfigured readyz URL ─────────────────────────────────────
      it("#87 4f. `unconfigured`: an empty readyz URL reads readiness unknown with readinessProbe unconfigured — no /readyz fetch, no probe-error row, no held row, no hold; while a readiness episode is open, losing the URL fails open at once with readiness_degraded ok {assumed, kind:'unconfigured'} and recovery", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        let readyzUrl = "";
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => readyzUrl,
        });
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "unknown",
          readinessReason: null,
          readinessStatus: null,
          readinessProbe: "unconfigured",
        });
        expect(readyzProbeCount()).toBe(0);
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(0);
        expect(pendingRows(insertWatchdogEvent, "readinessPending")).toHaveLength(0);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        // The URL appears and names failing components: a real episode opens.
        readyzUrl = kReadyzUrl;
        control.readyzFailing = ["secrets"];
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          readiness: "not_ready",
          readinessReason: "secrets",
          readinessProbe: "ok",
        });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(1);
        expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(1);
        const pendingBefore = pendingRows(insertWatchdogEvent, "readinessPending").length;
        // The URL vanishes mid-episode: unconfigured is not a transport kind —
        // no X1 hold, fail open at once with the assumed-recovery closing row.
        readyzUrl = "";
        const probesBefore = readyzProbeCount();
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(readyzProbeCount()).toBe(probesBefore);
        const closings = rowsOfType(insertWatchdogEvent, "readiness_degraded", "ok");
        expect(closings).toHaveLength(1);
        expect(closings[0].details).toEqual({ recovered: true, assumed: true, kind: "unconfigured" });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          degradedReason: null,
          degradedRetry: null,
          readiness: "unknown",
          readinessReason: null,
          readinessProbe: "unconfigured",
        });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(0);
        expect(pendingRows(insertWatchdogEvent, "readinessProbe")).toHaveLength(0);
        expect(pendingRows(insertWatchdogEvent, "readinessPending")).toHaveLength(pendingBefore);
        watchdog.stop();
      });

      // ── R2′. thrown readiness evaluation while an episode is open ───────
      it("#87 R2′. a THROWING readiness evaluation while a readiness episode is open fails open with its own closing row {recovered, assumed, kind:'error'} plus one readiness_probe_error {error}; recovery proceeds, health/degradedReason clear, and the same failing components afterwards are a NEW episode (second opening row, second notice)", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        let explode = false;
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => {
            if (explode) throw new Error("readyz resolver exploded");
            return kReadyzUrl;
          },
        });
        const openings = () => rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed");
        const closings = () => rowsOfType(insertWatchdogEvent, "readiness_degraded", "ok");
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({
          health: "degraded",
          degradedReason: "readiness_failing",
          readiness: "not_ready",
          readinessReason: "secrets",
        });
        expect(openings()).toHaveLength(1);
        expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(1);
        explode = true;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(closings()).toHaveLength(1);
        expect(closings()[0].details).toEqual({ recovered: true, assumed: true, kind: "error" });
        const errorRows = probeErrorRows(insertWatchdogEvent);
        expect(errorRows).toHaveLength(1);
        expect(errorRows[0].details.error).toContain("readyz resolver exploded");
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          degradedReason: null,
          readiness: "unknown",
          readinessReason: null,
        });
        // The same components afterwards: episode 2 with its own opening row and notice — not an early return.
        explode = false;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(openings()).toHaveLength(2);
        expect(openings()[1].details).toMatchObject({ failing: ["secrets"], unreadyReason: "components", reason: "secrets" });
        expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(2);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        watchdog.stop();
      });

      // ── 5c. X1 hold while the phase is transitional ─────────────────────
      it("#87 5c. X1 while transitional: 503 starting (outside the bootstrap loop) then /readyz unreadable → the hold keeps health healthy (no degraded write, no retry loop), readiness stays not_ready/starting with readinessProbe unavailable, one deduped held row {readinessProbe}, one probe-error row, and the 5s recheck cadence carries the hold until `started` reads ready — no incident, no recovery row, no notice", async () => {
        vi.useFakeTimers();
        const { control, fetchImpl } = createGatewayControl();
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
        });
        launchEstablished(watchdog);
        await tick();
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        control.readyzStatus = "starting";
        control.ready = false;
        control.readyzHttpStatus = 503;
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "not_ready",
          readinessReason: "starting",
          readinessStatus: "starting",
          readinessProbe: "ok",
        });
        // /readyz becomes unreadable while the phase is still `starting`.
        control.readyzThrow = new Error("connect ECONNREFUSED");
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          degradedReason: null,
          degradedRetry: null,
          readiness: "not_ready",
          readinessReason: "starting",
          readinessStatus: "starting",
          readinessProbe: "unavailable",
        });
        const held = pendingRows(insertWatchdogEvent, "readinessProbe");
        expect(held).toHaveLength(1);
        expect(held[0].details).toMatchObject({
          readinessPending: true,
          readinessProbe: "unavailable",
          readinessReason: "readiness probe unavailable",
        });
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(1);
        expect(probeErrorRows(insertWatchdogEvent)[0].details).toMatchObject({ kind: "unavailable" });
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        expect(notifier.notify).not.toHaveBeenCalled();
        // The recheck cadence carries the hold: exactly one /readyz attempt per 5s.
        let before = readyzProbeCount();
        await vi.advanceTimersByTimeAsync(4_999);
        expect(readyzProbeCount()).toBe(before);
        await vi.advanceTimersByTimeAsync(1);
        expect(readyzProbeCount()).toBe(before + 1);
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "not_ready",
          readinessReason: "starting",
          readinessProbe: "unavailable",
        });
        // Still one held row (deduped), still one probe-error row (same kind).
        expect(pendingRows(insertWatchdogEvent, "readinessProbe")).toHaveLength(1);
        expect(probeErrorRows(insertWatchdogEvent)).toHaveLength(1);
        // `started` answers on the next recheck: ready, cadence over, nothing to recover.
        control.readyzThrow = null;
        control.readyzStatus = "started";
        control.ready = null;
        control.readyzHttpStatus = 200;
        await vi.advanceTimersByTimeAsync(5_000);
        expect(watchdog.getStatus()).toMatchObject({
          health: "healthy",
          readiness: "ready",
          readinessReason: null,
          readinessStatus: "started",
          readinessProbe: "ok",
        });
        expect(rowsOfType(insertWatchdogEvent, "recovery")).toHaveLength(0);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded")).toHaveLength(0);
        expect(notifier.notify).not.toHaveBeenCalled();
        before = readyzProbeCount();
        await vi.advanceTimersByTimeAsync(30_000);
        expect(readyzProbeCount()).toBe(before);
        watchdog.stop();
      });

      // ── 7c. collector answer shapes ─────────────────────────────────────
      it("#87 7c. a collector answer without spawnStartedAtMs ({ stdout } only) attaches with doctorStartedAt null (no staleness check); a collector answer that is neither string nor object is dropped as unusable — one console line, no row, verdict untouched", async () => {
        vi.useFakeTimers();
        const collector = vi.fn(async () => ({ stdout: doctorPayload([kRuntimeFinding]) }));
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          collectAdvisoryDoctorJson: collector,
        });
        launchEstablished(watchdog);
        await tick();
        await tick();
        expect(advisoryRows(insertWatchdogEvent)).toHaveLength(1);
        expect(advisoryRows(insertWatchdogEvent)[0].details).toMatchObject({
          doctorStartedAt: null,
          episode: 1,
          finding: { checkId: "gateway.probe_auth_secretref_unavailable", kind: "runtime" },
        });
        // Recover, then re-degrade (past the per-key Doctor floor, P2) with a
        // collector that hands back a number.
        control.readyzFailing = [];
        await watchdog.runHealthCheck({ source: "health_timer" });
        expect(watchdog.getStatus()).toMatchObject({ health: "healthy", readiness: "ready" });
        collector.mockImplementation(async () => 42);
        vi.setSystemTime(Date.now() + kAdvisoryDoctorFloorMs);
        control.readyzFailing = ["secrets"];
        await watchdog.runHealthCheck({ source: "health_timer" });
        await tick();
        expect(collector).toHaveBeenCalledTimes(2);
        expect(advisoryRows(insertWatchdogEvent)).toHaveLength(1);
        expect(consoleLines("readiness advisory dropped (unusable)")).toHaveLength(1);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(2);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        watchdog.stop();
      });

      // ── B2′. clawCmd fallback through the CLI classifier ────────────────
      it("#87 B2′. the clawCmd fallback runs `doctor --lint --json` (quiet, 20s) through the CLI classifier: a failing exit with stderr-only output is not usable — dropped (unusable), no readiness_advisory row, while the verdict was already applied (degraded, opening row, notice)", async () => {
        vi.useFakeTimers();
        const clawCmdImpl = vi.fn(async (command) =>
          command.startsWith("doctor --lint --json")
            ? { ok: false, code: 1, stdout: "", stderr: "Error: doctor exploded\n" }
            : { ok: true, stdout: "" },
        );
        const { control, fetchImpl } = createGatewayControl();
        control.readyzFailing = ["secrets"];
        const { watchdog, insertWatchdogEvent, notifier } = createHarness({
          autoRepair: false,
          fetchImpl,
          resolveGatewayReadyzUrl: () => kReadyzUrl,
          clawCmdImpl,
        });
        launchEstablished(watchdog);
        await tick();
        await tick();
        const doctorCalls = clawCmdImpl.mock.calls.filter(([cmd]) => String(cmd).startsWith("doctor"));
        expect(doctorCalls).toHaveLength(1);
        expect(doctorCalls[0][0]).toBe("doctor --lint --json");
        expect(doctorCalls[0][1]).toMatchObject({ quiet: true, timeoutMs: 20000 });
        expect(advisoryRows(insertWatchdogEvent)).toHaveLength(0);
        expect(consoleLines("readiness advisory dropped (unusable)")).toHaveLength(1);
        expect(rowsOfType(insertWatchdogEvent, "readiness_degraded", "failed")).toHaveLength(1);
        expect(noticesIncluding(notifier, "up but not ready")).toHaveLength(1);
        expect(watchdog.getStatus()).toMatchObject({ health: "degraded", readiness: "not_ready" });
        watchdog.stop();
      });
    });

  });

  describe("crash-cause classification + version mismatch (#76 A3/A4, recording only)", () => {
    const {
      classifyGatewayCrash: realClassify,
      fingerprintGatewayCrash,
    } = require("../../lib/server/gateway-crash-cause");
    const kStateDbPath = "/data/.openclaw/state/openclaw.sqlite";
    // 2026.7.1-2 wording from the #76 incident box (issue #76 A3 header table).
    const kSchemaTooNewTail = [
      "[gateway] starting",
      `OpenClaw state database ${kStateDbPath} uses newer schema version 15; this OpenClaw build supports 12.`,
      "Refused by openclaw 2026.7.1-2.",
    ];
    const kLegacyApprovalsTail = [
      "Legacy exec approvals exist at /data/.openclaw/exec-approvals.json. Run `openclaw doctor --fix` before using exec approvals.",
    ];
    const kHeapOomTail = [
      "FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory",
    ];
    const flushAll = async () => {
      for (let i = 0; i < 4; i += 1) await flushMicrotasks();
    };
    const rowsOf = (insertWatchdogEvent, eventType) =>
      insertWatchdogEvent.mock.calls
        .map((call) => call[0])
        .filter((row) => row?.eventType === eventType);
    const noticesOf = (notifier) => notifier.notify.mock.calls.map((call) => String(call[0]));
    const failingFetch = async () => {
      throw new Error("gateway unavailable");
    };
    const pinnedInfo = (overrides = {}) => ({
      isPin: true,
      inStabilizationWindow: false,
      installedVersion: "2026.7.1-2",
      expectedVersion: "2026.9.2",
      installedDiverged: false,
      ...overrides,
    });
    const crashHarness = (overrides = {}) =>
      createHarness({
        autoRepair: false,
        fetchImpl: failingFetch,
        classifyGatewayCrash: realClassify,
        ...overrides,
      });
    const crashOnce = (watchdog, { code = 1, stderrTail = kSchemaTooNewTail } = {}) => {
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
      watchdog.onGatewayExit({ code, signal: null, expectedExit: false, stderrTail });
    };

    it("consults the injected classifier with the exit shape and stamps cause/fingerprint/suspectedCause on the crash row; lastExit carries the cause with corroboration pending", async () => {
      const classifier = vi.fn((input) => realClassify(input));
      const { watchdog, insertWatchdogEvent, notifier } = crashHarness({
        classifyGatewayCrash: classifier,
        // Facts that never arrive: corroboration stays pending.
        readCrashFacts: () => new Promise(() => {}),
      });
      crashOnce(watchdog);
      await flushAll();
      expect(classifier).toHaveBeenCalledWith({ code: 1, signal: null, stderrTail: kSchemaTooNewTail });
      const [crashRow] = rowsOf(insertWatchdogEvent, "crash");
      const expectedFingerprint = fingerprintGatewayCrash({
        cause: "state_schema_too_new",
        code: 1,
        matchedLine: kSchemaTooNewTail[1],
      });
      expect(crashRow.details).toMatchObject({
        code: 1,
        stderrTail: kSchemaTooNewTail,
        cause: "state_schema_too_new",
        fingerprint: expectedFingerprint,
        suspectedCause: "state_schema_too_new",
      });
      expect(expectedFingerprint).toMatch(/^[a-f0-9]{12}$/);
      const status = watchdog.getStatus();
      expect(status.lastExit).toMatchObject({ code: 1, cause: "state_schema_too_new", corroborated: null });
      expect(status.versionMismatch).toBe(null);
      expect(rowsOf(insertWatchdogEvent, "crash_cause")).toHaveLength(0);
      // The operator hears the suspicion, never a claim.
      const down = noticesOf(notifier).find((m) => m.includes("🔴 Gateway went down"));
      expect(down).toContain("Suspected cause: `state_schema_too_new`");
      watchdog.stop();
    });

    it("corroborated facts write ONE crash_cause row, latch the version mismatch (source crash) from the channel info, name the degradation and log version_mismatch once", async () => {
      const readCrashFacts = vi.fn(async () => ({
        userVersionsByPath: { [kStateDbPath]: 15 },
        supportedSchema: { state: 12, agent: 17, source: "declared" },
        installedDiverged: false,
        legacyExecApprovalsPresent: false,
      }));
      const { watchdog, insertWatchdogEvent } = crashHarness({
        readCrashFacts,
        releaseChannelHooks: { getInfo: () => pinnedInfo(), requestRollback: () => null },
      });
      crashOnce(watchdog);
      expect(readCrashFacts).not.toHaveBeenCalled(); // never on the synchronous ladder
      await flushAll();
      expect(readCrashFacts).toHaveBeenCalledTimes(1);
      const causeRows = rowsOf(insertWatchdogEvent, "crash_cause");
      expect(causeRows).toHaveLength(1);
      expect(causeRows[0]).toMatchObject({
        source: "crash_classifier",
        status: "failed",
        details: {
          cause: "state_schema_too_new",
          corroborated: true,
          by: "user_version",
          suspectedCause: null,
          versions: { found: 15, supports: 12 },
          dbPath: kStateDbPath,
          code: 1,
        },
      });
      expect(causeRows[0].details.fingerprint).toMatch(/^[a-f0-9]{12}$/);
      // The crash row's correlation id ties the follow-up to its crash.
      expect(causeRows[0].correlationId).toBe(rowsOf(insertWatchdogEvent, "crash")[0].correlationId);
      const mismatchRows = rowsOf(insertWatchdogEvent, "version_mismatch");
      expect(mismatchRows).toHaveLength(1);
      expect(mismatchRows[0]).toMatchObject({
        source: "crash",
        status: "failed",
        details: {
          expected: "2026.9.2",
          running: "2026.7.1-2",
          source: "crash",
          cause: "state_schema_too_new",
          by: "user_version",
        },
      });
      const status = watchdog.getStatus();
      expect(status.versionMismatch).toMatchObject({
        expected: "2026.9.2",
        running: "2026.7.1-2",
        source: "crash",
      });
      expect(typeof status.versionMismatch.detectedAt).toBe("string");
      expect(status.degradedReason).toBe("version_mismatch");
      expect(status.lastExit).toMatchObject({ cause: "state_schema_too_new", corroborated: true });
      // The latched scalar is frame-stable and the same mismatch never re-logs.
      const again = watchdog.getStatus().versionMismatch;
      expect(JSON.stringify(again)).toBe(JSON.stringify(status.versionMismatch));
      crashOnce(watchdog);
      await flushAll();
      expect(rowsOf(insertWatchdogEvent, "version_mismatch")).toHaveLength(1);
      expect(rowsOf(insertWatchdogEvent, "crash_cause")).toHaveLength(2);
      watchdog.stop();
    });

    it("uncorroborated facts (or a throwing reader) record a SUSPECTED cause only: info row, no latch, degradation untouched", async () => {
      const { watchdog, insertWatchdogEvent } = crashHarness({
        // The DB really carries 12 (stderr's 15 is not what is on disk) and
        // 12 is not above the supported 15: nothing independent agrees.
        readCrashFacts: async () => ({
          userVersionsByPath: { [kStateDbPath]: 12 },
          supportedSchema: { state: 15, agent: 19 },
          installedDiverged: false,
          legacyExecApprovalsPresent: false,
        }),
        releaseChannelHooks: { getInfo: () => pinnedInfo(), requestRollback: () => null },
      });
      crashOnce(watchdog);
      await flushAll();
      const [row] = rowsOf(insertWatchdogEvent, "crash_cause");
      expect(row).toMatchObject({
        status: "info",
        details: {
          cause: "state_schema_too_new",
          corroborated: false,
          by: null,
          suspectedCause: "state_schema_too_new",
        },
      });
      expect(row.details).not.toHaveProperty("factsUnavailable");
      const status = watchdog.getStatus();
      expect(status.versionMismatch).toBe(null);
      // The relaunch's failing probe owns degradedReason here; the suspected
      // cause must not overwrite it with version_mismatch.
      expect(status.degradedReason).not.toBe("version_mismatch");
      expect(status.lastExit).toMatchObject({ cause: "state_schema_too_new", corroborated: false });
      expect(rowsOf(insertWatchdogEvent, "version_mismatch")).toHaveLength(0);
      watchdog.stop();

      const throwing = crashHarness({
        readCrashFacts: async () => {
          throw new Error("state db busy");
        },
      });
      crashOnce(throwing.watchdog);
      await flushAll();
      const [thrownRow] = rowsOf(throwing.insertWatchdogEvent, "crash_cause");
      expect(thrownRow.details).toMatchObject({
        corroborated: false,
        factsUnavailable: true,
        factsError: "state db busy",
      });
      expect(throwing.watchdog.getStatus().versionMismatch).toBe(null);
      throwing.watchdog.stop();

      // No facts reader wired at all: still a suspected cause, still honest.
      const bare = crashHarness();
      crashOnce(bare.watchdog);
      await flushAll();
      expect(rowsOf(bare.insertWatchdogEvent, "crash_cause")[0].details).toMatchObject({
        corroborated: false,
        factsUnavailable: true,
      });
      bare.watchdog.stop();
    });

    it("a cause with no corroborator stamps the crash row (no suspectedCause) and writes no crash_cause row; `unknown` adds no Suspected-cause line", async () => {
      const oom = crashHarness({ readCrashFacts: vi.fn(async () => ({})) });
      crashOnce(oom.watchdog, { code: 134, stderrTail: kHeapOomTail });
      await flushAll();
      const [crashRow] = rowsOf(oom.insertWatchdogEvent, "crash");
      expect(crashRow.details).toMatchObject({ cause: "oom", fingerprint: expect.stringMatching(/^[a-f0-9]{12}$/) });
      expect(crashRow.details).not.toHaveProperty("suspectedCause");
      expect(rowsOf(oom.insertWatchdogEvent, "crash_cause")).toHaveLength(0);
      expect(oom.watchdog.getStatus().lastExit).toMatchObject({ cause: "oom", corroborated: null });
      expect(noticesOf(oom.notifier).find((m) => m.includes("🔴 Gateway went down"))).toContain(
        "Suspected cause: `oom`",
      );
      oom.watchdog.stop();

      const unknown = crashHarness();
      crashOnce(unknown.watchdog, { stderrTail: ["something odd happened"] });
      await flushAll();
      expect(rowsOf(unknown.insertWatchdogEvent, "crash")[0].details).toMatchObject({ cause: "unknown" });
      expect(noticesOf(unknown.notifier).find((m) => m.includes("🔴 Gateway went down"))).not.toContain(
        "Suspected cause",
      );
      unknown.watchdog.stop();
    });

    it("the crash_loop row carries the same cause + fingerprint and the crash-loop notice names the suspicion", async () => {
      const { watchdog, insertWatchdogEvent, notifier } = crashHarness();
      for (let i = 0; i < 3; i += 1) crashOnce(watchdog);
      await flushAll();
      const [loopRow] = rowsOf(insertWatchdogEvent, "crash_loop");
      expect(loopRow.details).toMatchObject({
        crashesInWindow: 3,
        cause: "state_schema_too_new",
        suspectedCause: "state_schema_too_new",
        fingerprint: rowsOf(insertWatchdogEvent, "crash")[0].details.fingerprint,
      });
      const loopNotice = noticesOf(notifier).find((m) => m.includes("crash loop detected"));
      expect(loopNotice).toContain("Suspected cause: `state_schema_too_new`");
      watchdog.stop();
    });

    it("a throwing classifier — or none injected — leaves the legacy row shape and the ladder untouched", async () => {
      const throwing = crashHarness({
        classifyGatewayCrash: () => {
          throw new Error("classifier bug");
        },
        readCrashFacts: vi.fn(async () => ({})),
      });
      crashOnce(throwing.watchdog);
      await flushAll();
      const [row] = rowsOf(throwing.insertWatchdogEvent, "crash");
      expect(row.details).toMatchObject({ code: 1, stderrTail: kSchemaTooNewTail });
      expect(row.details).not.toHaveProperty("cause");
      expect(row.details).not.toHaveProperty("fingerprint");
      expect(throwing.watchdog.getStatus().lastExit).toMatchObject({ code: 1, cause: null, corroborated: null });
      expect(throwing.launchGatewayProcess).toHaveBeenCalled(); // relaunch still happened
      expect(rowsOf(throwing.insertWatchdogEvent, "crash_cause")).toHaveLength(0);
      throwing.watchdog.stop();

      const legacy = createHarness({ autoRepair: false, fetchImpl: failingFetch });
      crashOnce(legacy.watchdog);
      await flushAll();
      expect(rowsOf(legacy.insertWatchdogEvent, "crash")[0].details).not.toHaveProperty("cause");
      expect(legacy.watchdog.getStatus().lastExit).toMatchObject({ cause: null, corroborated: null });
      expect(legacy.watchdog.getStatus().versionMismatch).toBe(null);
      legacy.watchdog.stop();
    });

    it("exit 78: the config_error row stamps the cause; a legacy exec-approvals file on a sqlite-era box corroborates legacy_exec_approvals (issue #23) and latches the mismatch", async () => {
      const { watchdog, insertWatchdogEvent } = crashHarness({
        readCrashFacts: async () => ({
          userVersionsByPath: {},
          supportedSchema: { state: 15, agent: 19 },
          installedDiverged: false,
          legacyExecApprovalsPresent: true,
        }),
      });
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
      watchdog.onGatewayExit({ code: 78, signal: null, expectedExit: false, stderrTail: kLegacyApprovalsTail });
      await flushAll();
      const [configRow] = rowsOf(insertWatchdogEvent, "config_error");
      expect(configRow.details).toMatchObject({
        code: 78,
        cause: "legacy_exec_approvals",
        suspectedCause: "legacy_exec_approvals",
      });
      const [causeRow] = rowsOf(insertWatchdogEvent, "crash_cause");
      expect(causeRow).toMatchObject({
        status: "failed",
        details: { cause: "legacy_exec_approvals", corroborated: true, by: "legacy_exec_approvals_file", code: 78 },
      });
      expect(watchdog.getStatus()).toMatchObject({
        lifecycle: "configuration_error",
        lastExit: { code: 78, cause: "legacy_exec_approvals", corroborated: true },
        versionMismatch: { source: "crash", expected: null, running: null },
      });
      watchdog.stop();
    });

    it("setBootVerdict latches installed_not_expected (source boot) with ONE version_mismatch event, naming the tree the gateway RUNS (describeReportVersions: resolvedForLaunch, never the pre-sync installedAtBoot); consistent verdicts and repeats are no-ops", () => {
      const { watchdog, insertWatchdogEvent } = createHarness({ autoRepair: false });
      expect(typeof watchdog.setBootVerdict).toBe("function");
      // An activation boot: the pre-sync tree differs from the launch tree
      // and the verdict is silent — no latch, whatever installedAtBoot says.
      const consistent = {
        bootId: "40:1700000000000",
        serverPhase: { verdict: [] },
        openclaw: { expected: "2026.9.2", installedAtBoot: "2026.7.1-2", resolvedForLaunch: "2026.9.2" },
      };
      expect(watchdog.setBootVerdict(consistent)).toBe(null);
      expect(rowsOf(insertWatchdogEvent, "version_mismatch")).toHaveLength(0);
      expect(watchdog.getStatus().versionMismatch).toBe(null);

      // The #76 shape: the applied build never activated, so the tree the
      // gateway will run (resolvedForLaunch) is the stale one. installedAtBoot
      // and the server phase's own read are set to THIRD versions so a latch
      // built on either would be visibly wrong: the bin phase's post-sync
      // read outranks both (describeReportVersions' order).
      const inconsistent = {
        bootId: "40:1700000000000",
        serverPhase: { verdict: ["installed_not_expected", "pidfile_contradiction"], installedVersion: "2026.9.1" },
        openclaw: { expected: "2026.9.2", installedAtBoot: "2026.8.2", resolvedForLaunch: "2026.7.1-2" },
      };
      const latched = watchdog.setBootVerdict(inconsistent);
      expect(latched).toMatchObject({ expected: "2026.9.2", running: "2026.7.1-2", source: "boot" });
      expect(watchdog.getStatus().versionMismatch).toEqual(latched);
      const rows = rowsOf(insertWatchdogEvent, "version_mismatch");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        source: "boot",
        status: "failed",
        details: {
          expected: "2026.9.2",
          running: "2026.7.1-2",
          source: "boot",
          bootId: "40:1700000000000",
          verdict: ["installed_not_expected", "pidfile_contradiction"],
        },
      });
      // Same verdict again (a re-run of the finalize step): nothing new.
      expect(watchdog.setBootVerdict(inconsistent)).toEqual(latched);
      expect(rowsOf(insertWatchdogEvent, "version_mismatch")).toHaveLength(1);
      // A top-level verdict[] (an older report shape) is accepted too; a
      // non-string entry is ignored rather than thrown on.
      const other = createHarness({ autoRepair: false });
      other.watchdog.setBootVerdict({
        verdict: ["installed_not_expected", 42],
        openclaw: { expected: "b", installedAtBoot: "z", resolvedForLaunch: "a" },
      });
      expect(other.watchdog.getStatus().versionMismatch).toMatchObject({ expected: "b", running: "a", source: "boot" });
      // A report with no bin phase (openclaw: null — the server phase created
      // it) falls back to the server phase's own read and its channel
      // snapshot, the same order describeReportVersions gives the verdict.
      const serverOnly = createHarness({ autoRepair: false });
      serverOnly.watchdog.setBootVerdict({
        bootId: "41:1",
        openclaw: null,
        serverPhase: {
          verdict: ["installed_not_expected"],
          installedVersion: "2026.7.1-2",
          channelInfo: { installedVersion: "2026.9.1", expectedVersion: "2026.9.2", installedDiverged: true },
        },
      });
      expect(serverOnly.watchdog.getStatus().versionMismatch).toMatchObject({ expected: "2026.9.2", running: "2026.7.1-2", source: "boot" });
      // A bin phase that only knows the PRE-sync tree names no running
      // version: installedAtBoot is evidence about the sync, not the launch,
      // and the latch must never claim a tree nothing is running.
      const preSyncOnly = createHarness({ autoRepair: false });
      preSyncOnly.watchdog.setBootVerdict({
        bootId: "42:1",
        serverPhase: { verdict: ["installed_not_expected"] },
        openclaw: { installedAtBoot: "2026.7.1-2", expected: "2026.9.2" },
      });
      expect(preSyncOnly.watchdog.getStatus().versionMismatch).toMatchObject({ expected: "2026.9.2", running: null, source: "boot" });
      expect(rowsOf(preSyncOnly.insertWatchdogEvent, "version_mismatch")[0].details).toMatchObject({ running: null, expected: "2026.9.2" });
      // A junk report never throws.
      expect(() => other.watchdog.setBootVerdict(null)).not.toThrow();
      expect(() => other.watchdog.setBootVerdict("nonsense")).not.toThrow();
    });

    it("the channel memo latches installedDiverged (source channel, event deferred off the status tick) and clears itself when the tree converges — a boot latch is never cleared by it", async () => {
      vi.useFakeTimers();
      try {
        const info = pinnedInfo({ installedDiverged: true });
        const getInfo = vi.fn(() => info);
        const { watchdog, insertWatchdogEvent } = createHarness({
          autoRepair: false,
          releaseChannelHooks: { getInfo, requestRollback: () => null },
        });
        const status = watchdog.getStatus();
        expect(status.versionMismatch).toMatchObject({
          expected: "2026.9.2",
          running: "2026.7.1-2",
          source: "channel",
        });
        // getStatus() itself wrote nothing: the row lands on the next turn.
        expect(rowsOf(insertWatchdogEvent, "version_mismatch")).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(0);
        const rows = rowsOf(insertWatchdogEvent, "version_mismatch");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          source: "channel",
          details: { expected: "2026.9.2", running: "2026.7.1-2", source: "channel", installedDiverged: true },
        });
        // One channel read per 5s memo window, whatever the tick rate.
        watchdog.getStatus();
        watchdog.getStatus();
        expect(getInfo).toHaveBeenCalledTimes(1);

        // The tree converges: the channel-sourced latch clears on the next read.
        info.installedDiverged = false;
        vi.advanceTimersByTime(6_000);
        expect(watchdog.getStatus().versionMismatch).toBe(null);
        expect(getInfo).toHaveBeenCalledTimes(2);

        // A boot verdict latch is evidence about THIS boot; the channel memo
        // saying "not diverged" does not erase it.
        watchdog.setBootVerdict({
          bootId: "b",
          serverPhase: { verdict: ["installed_not_expected"] },
          openclaw: { expected: "2026.9.2", installedAtBoot: "2026.7.1-2", resolvedForLaunch: "2026.7.1-2" },
        });
        vi.advanceTimersByTime(6_000);
        expect(watchdog.getStatus().versionMismatch).toMatchObject({ source: "boot" });
        // And an equal channel mismatch on top keeps the boot latch (first
        // detection wins; no duplicate event).
        info.installedDiverged = true;
        vi.advanceTimersByTime(6_000);
        expect(watchdog.getStatus().versionMismatch).toMatchObject({ source: "boot" });
        await vi.advanceTimersByTimeAsync(0);
        expect(rowsOf(insertWatchdogEvent, "version_mismatch")).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("while a mismatch is latched every notice carries the ⚠️ line — right after the house header, or prepended when the message has none", async () => {
      const { watchdog, notifier } = crashHarness();
      watchdog.setBootVerdict({
        bootId: "b",
        serverPhase: { verdict: ["installed_not_expected"] },
        openclaw: { expected: "2026.9.2", installedAtBoot: "2026.7.1-2", resolvedForLaunch: "2026.7.1-2" },
      });
      // A header-bearing notice (the crash notice) and a header-less one (the
      // OOM classifier's remedy line) from the same exit.
      crashOnce(watchdog, { code: 134, stderrTail: kHeapOomTail });
      await flushAll();
      const notices = noticesOf(notifier);
      const down = notices.find((m) => m.includes("🔴 Gateway went down"));
      expect(down.split("\n").slice(0, 3)).toEqual([
        "🐺 *AlphaClaw Watchdog*",
        "⚠️ Version mismatch: running 2026.7.1-2, expected 2026.9.2",
        expect.stringContaining("🔴 Gateway went down"),
      ]);
      const oomNotice = notices.find((m) => m.includes("Gateway ran out of JavaScript heap"));
      expect(oomNotice.startsWith("⚠️ Version mismatch: running 2026.7.1-2, expected 2026.9.2\nGateway ran out of JavaScript heap")).toBe(true);
      // Exactly one line per notice, never doubled.
      expect(down.match(/⚠️ Version mismatch/g)).toHaveLength(1);
      watchdog.stop();

      // Without a latch the notices are byte-identical to before.
      const plain = crashHarness();
      crashOnce(plain.watchdog, { code: 134, stderrTail: kHeapOomTail });
      await flushAll();
      expect(noticesOf(plain.notifier).some((m) => m.includes("Version mismatch"))).toBe(false);
      plain.watchdog.stop();
    });
  });
  describe("cause-keyed structural ladder + scoped pause (#76 B1 / B3 / C2 runtime, Stage 3 I3)", () => {
    const {
      classifyGatewayCrash: realClassify,
      fingerprintGatewayCrash,
    } = require("../../lib/server/gateway-crash-cause");
    const {
      kAutoRepairPauseReasons,
      kCrashCauseLadderEnvKey,
      kLaunchCompatGateEnvKey,
      kStructuralRelaunchSource,
    } = require("../../lib/server/watchdog-structural-repair");
    const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
    const kStateDbPath = "/data/.openclaw/state/openclaw.sqlite";
    const kSchemaTooNewTail = [
      "[gateway] starting",
      `OpenClaw state database ${kStateDbPath} uses newer schema version 15; this OpenClaw build supports 12.`,
      "Refused by openclaw 2026.7.1-2.",
    ];
    const kFingerprint = fingerprintGatewayCrash({
      cause: "state_schema_too_new",
      code: 1,
      signal: null,
      matchedLine: kSchemaTooNewTail[1],
    });
    // Independent facts that corroborate the stderr line (user_version 15 on
    // the named DB; the running build declares 12).
    const corroboratingFacts = {
      userVersionsByPath: { [kStateDbPath]: 15 },
      supportedSchema: { state: 12, agent: null, source: "declared" },
      installedDiverged: true,
      legacyExecApprovalsPresent: false,
    };
    const uncorroboratedFacts = {
      userVersionsByPath: { [kStateDbPath]: 12 },
      supportedSchema: null,
      installedDiverged: false,
      legacyExecApprovalsPresent: false,
    };
    const flushAll = async (turns = 12) => {
      for (let i = 0; i < turns; i += 1) await flushMicrotasks();
    };
    const rowsOf = (insertWatchdogEvent, eventType, status = null) =>
      insertWatchdogEvent.mock.calls
        .map((call) => call[0])
        .filter((row) => row?.eventType === eventType && (status == null || row.status === status));
    const noticesOf = (notifier) => notifier.notify.mock.calls;
    const noticeText = (notifier, needle) =>
      noticesOf(notifier).find((call) => String(call[0]).includes(needle)) ?? null;
    const doctorCalls = (clawCmd) =>
      clawCmd.mock.calls.filter((call) => call[0] === "doctor --fix --yes").length;
    const failingFetch = async () => {
      throw new Error("gateway unavailable");
    };
    const healthyFetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, status: "live" }),
    });
    const activated = (to) => ({ ok: true, action: "activated", from: "2026.7.1-2", to, runId: "run-1" });
    const refused = (code) => ({ ok: false, code, action: "none", message: code });
    // Hooks shaped like lib/server.js's releaseChannelHooks; `info` is mutable
    // so a rung can flip the installed version like the real reconcile does.
    const makeHooks = ({
      installedVersion = "2026.7.1-2",
      expectedVersion = "2026.9.2",
      installedDiverged = true,
      reconcile = null,
      recover = null,
    } = {}) => {
      const info = {
        isPin: false,
        installedIsPin: true,
        inStabilizationWindow: false,
        stabilization: { inWindow: false },
        installedVersion,
        expectedVersion,
        installedDiverged,
        gatewayHold: null,
        stateCorrupted: false,
      };
      const hooks = {
        info,
        getInfo: vi.fn(() => ({ ...info })),
        requestRollback: vi.fn(() => null),
        requestForwardRecovery: vi.fn(() => ({ ok: false, code: "not_pin" })),
        reconcileInstalled: vi.fn(
          reconcile ||
            (async () => {
              info.installedVersion = info.expectedVersion;
              info.installedDiverged = false;
              return activated(info.expectedVersion);
            }),
        ),
        recoverBootable: vi.fn(recover || (async () => refused("no_bootable_version"))),
        renameStrayExecApprovals: vi.fn(() => ({ reaped: false })),
        undoLastConfigRestore: vi.fn(() => ({ ok: false, code: "no_restore" })),
        completeReconcileRun: vi.fn(),
      };
      return hooks;
    };
    const ladderHarness = ({ hooks, facts = corroboratingFacts, ...overrides } = {}) =>
      createHarness({
        autoRepair: true,
        fetchImpl: failingFetch,
        classifyGatewayCrash: realClassify,
        readCrashFacts: vi.fn(async () => facts),
        releaseChannelHooks: hooks,
        readStateDbVersions: async () => ({ userVersion: 15, agentUserVersions: [17] }),
        writePersistedPause: vi.fn(),
        ...overrides,
      });
    const crash = (watchdog, { code = 1, stderrTail = kSchemaTooNewTail } = {}) => {
      watchdog.onGatewayExit({ code, signal: null, expectedExit: false, stderrTail });
    };
    // A harness whose structural repair cannot help: reconcile refuses
    // (overlay_missing) and the chooser finds nothing → the pause latches.
    const pausedHarness = async (overrides = {}) => {
      const hooks = makeHooks({
        reconcile: async () => refused("overlay_missing"),
        recover: async () => refused("no_bootable_version"),
      });
      const h = ladderHarness({ hooks, ...overrides });
      crash(h.watchdog);
      await flushAll();
      expect(h.watchdog.getStatus().autoRepairPaused).toMatchObject({ cause: "state_schema_too_new" });
      return { ...h, hooks };
    };

    afterEach(() => {
      delete process.env[kCrashCauseLadderEnvKey];
      delete process.env[kLaunchCompatGateEnvKey];
    });

    it("a corroborated state_schema_too_new crash on a diverged tree runs reconcileInstalled under the ladder's own lifecycle hold, then relaunches ONCE (replace) — no doctor, no rollback, no relaunch of the crashed binary, the reconcile run completed with the relaunch verdict", async () => {
      const lock = createGatewayLifecycleLock();
      const hooks = makeHooks();
      const { watchdog, insertWatchdogEvent, clawCmd, launchGatewayProcess, notifier } = ladderHarness({
        hooks,
        gatewayLifecycleLock: lock,
      });
      crash(watchdog);
      // Synchronous half: the crash row carries the cause, nothing launched.
      expect(rowsOf(insertWatchdogEvent, "crash")[0].details).toMatchObject({
        cause: "state_schema_too_new",
        fingerprint: kFingerprint,
        suspectedCause: "state_schema_too_new",
      });
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      await flushAll();

      expect(hooks.reconcileInstalled).toHaveBeenCalledTimes(1);
      const [reconcileArgs] = hooks.reconcileInstalled.mock.calls[0];
      expect(reconcileArgs).toMatchObject({ source: "structural_repair", relaunch: true });
      expect(typeof reconcileArgs.hold).toBe("function");
      expect(reconcileArgs.hold.kind).toBe("structural_repair");
      expect(hooks.undoLastConfigRestore).toHaveBeenCalledTimes(1);
      expect(hooks.recoverBootable).not.toHaveBeenCalled();
      expect(hooks.requestRollback).not.toHaveBeenCalled();
      expect(doctorCalls(clawCmd)).toBe(0);
      // Exactly one launch: the corrected tree, after the activation.
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(launchGatewayProcess.mock.invocationCallOrder[0]).toBeGreaterThan(
        hooks.reconcileInstalled.mock.invocationCallOrder[0],
      );
      expect(rowsOf(insertWatchdogEvent, "restart", "requested")[0]).toMatchObject({
        source: kStructuralRelaunchSource,
        details: { intent: "replace", stateDb: { userVersion: 15, agentUserVersions: [17] } },
      });
      expect(hooks.completeReconcileRun).toHaveBeenCalledWith({
        runId: "run-1",
        relaunch: { ok: true, verdict: "replacement_pending" },
      });
      const repairRows = rowsOf(insertWatchdogEvent, "repair");
      expect(repairRows).toHaveLength(1);
      expect(repairRows[0]).toMatchObject({
        source: "structural",
        status: "ok",
        details: {
          cause: "state_schema_too_new",
          fingerprint: kFingerprint,
          corroborated: true,
          by: "user_version",
          verdict: "replacement_pending",
          runId: "run-1",
          paused: null,
        },
      });
      expect(repairRows[0].details.plan.map((p) => `${p.step}:${p.outcome}`)).toEqual([
        "reconcile_installed:activated",
        "undo_config_restore:no_restore",
        "relaunch:replacement_pending",
      ]);
      expect(rowsOf(insertWatchdogEvent, "version_mismatch")).toHaveLength(1);
      expect(rowsOf(insertWatchdogEvent, "crash_loop")).toHaveLength(0);
      const status = watchdog.getStatus();
      expect(status.autoRepairPaused).toBe(null);
      expect(status.replacementPending).toMatchObject({ source: kStructuralRelaunchSource, intent: "replace" });
      expect(status.operationInProgress).toBe(false);
      expect(lock.tryAcquire("test")).toBeTruthy(); // the ladder released its hold
      const down = noticeText(notifier, "Gateway stopped");
      expect(String(down[0])).toContain(
        "cause `state_schema_too_new` confirmed; AlphaClaw is fixing the installed build instead of relaunching it",
      );
      expect(noticeText(notifier, "will retry automatically")).toBe(null);
      watchdog.stop();
    });

    it("three schema crashes with nothing to activate: launchGatewayProcess frozen, no doctor, the pause latches ONCE (persisted through writePersistedPause with the fixture shape), later crashes are skipped {auto_repair_paused}, and the B3 notice names cause / versions / DB schema / last plan / diagnose", async () => {
      const { watchdog, insertWatchdogEvent, clawCmd, launchGatewayProcess, notifier, hooks } =
        await pausedHarness();
      crash(watchdog);
      await flushAll();
      crash(watchdog);
      await flushAll();

      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(doctorCalls(clawCmd)).toBe(0);
      expect(hooks.requestRollback).not.toHaveBeenCalled();
      expect(hooks.requestForwardRecovery).not.toHaveBeenCalled();
      // One ladder run, then two refusals while paused.
      expect(hooks.reconcileInstalled).toHaveBeenCalledTimes(1);
      expect(hooks.recoverBootable).toHaveBeenCalledTimes(1);
      expect(rowsOf(insertWatchdogEvent, "repair", "failed")).toHaveLength(1);
      expect(rowsOf(insertWatchdogEvent, "repair", "skipped").map((r) => r.details.reason)).toEqual([
        "auto_repair_paused",
        "auto_repair_paused",
      ]);
      expect(rowsOf(insertWatchdogEvent, "crash")).toHaveLength(3);
      expect(rowsOf(insertWatchdogEvent, "crash_loop")).toHaveLength(0);

      const paused = rowsOf(insertWatchdogEvent, "auto_repair_paused");
      expect(paused).toHaveLength(1);
      expect(paused[0]).toMatchObject({
        source: "structural",
        status: "failed",
        details: {
          cause: "state_schema_too_new",
          fingerprint: kFingerprint,
          reason: kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED,
          attempts: 1,
          installedVersion: "2026.7.1-2",
          expected: "2026.9.2",
          corroborated: true,
          lastPlan: { rung: "recover_bootable", outcome: "no_bootable_version" },
        },
      });
      const status = watchdog.getStatus();
      expect(status.autoRepairPaused).toEqual({
        at: expect.any(String),
        cause: "state_schema_too_new",
        fingerprint: kFingerprint,
        installedVersion: "2026.7.1-2",
        attempts: 1,
        lastPlan: { rung: "recover_bootable", outcome: "no_bootable_version" },
        reason: "structural_repair_failed",
        corroborated: true,
        expected: "2026.9.2",
      });
      expect(new Date(status.autoRepairPaused.at).toISOString()).toBe(status.autoRepairPaused.at);
      expect(status.lifecycle).toBe("crashed");
      expect(status.degradedReason).toBe("version_mismatch");

      const notice = noticeText(notifier, "🔴 Auto-repair paused");
      expect(notice).toBeTruthy();
      const lines = String(notice[0]).split("\n");
      expect(lines[0]).toBe("🐺 *AlphaClaw Watchdog*");
      expect(lines[1]).toBe("⚠️ Version mismatch: running 2026.7.1-2, expected 2026.9.2");
      expect(lines[2]).toContain("🔴 Auto-repair paused");
      expect(lines[2]).toContain("[View logs](");
      expect(lines[3]).toBe("Cause: `state_schema_too_new`");
      expect(lines[4]).toBe("Running: 2026.7.1-2 · Expected: 2026.9.2");
      expect(lines[5]).toBe("DB schema: state 15 (running build supports 12) · agent 17 (—)");
      expect(lines[6]).toBe("Last plan: recover_bootable → no bootable version");
      expect(lines[7]).toBe(
        "Next: Retry · Repair · View logs from the Watchdog tab — a Repair sent with force resumes automatic repair once.",
      );
      expect(lines[8]).toBe("Details: `alphaclaw diagnose`");
      expect(notice[1]).toEqual(
        expect.objectContaining({
          eventType: "crash",
          id: expect.stringMatching(new RegExp(`^auto-repair-paused-${kFingerprint}-\\d{8}$`)),
        }),
      );
      expect(noticesOf(notifier).filter((call) => String(call[0]).includes("Auto-repair paused"))).toHaveLength(1);
      watchdog.stop();
    });

    it("the pause is persisted through writePersistedPause with exactly the fixture's keys (at ms, cause, fingerprint, installedVersion, attempts, lastPlan {rung, outcome}, reason)", async () => {
      const writePersistedPause = vi.fn();
      const { watchdog } = await pausedHarness({ writePersistedPause });
      expect(writePersistedPause).toHaveBeenCalledTimes(1);
      const [persisted] = writePersistedPause.mock.calls[0];
      expect(persisted).toEqual({
        at: expect.any(Number),
        cause: "state_schema_too_new",
        fingerprint: kFingerprint,
        installedVersion: "2026.7.1-2",
        attempts: 1,
        lastPlan: { rung: "recover_bootable", outcome: "no_bootable_version" },
        reason: "structural_repair_failed",
      });
      expect(Object.keys(persisted)).toHaveLength(7);
      watchdog.stop();
    });

    it("a paused box still recovers when the gateway comes back on its own: one green probe does not clear the pause, the acceptance hold does; an unhealthy tick in between resets the clock; the clear unlinks the persisted record", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-06T08:05:00.000Z"));
      const writePersistedPause = vi.fn();
      const { watchdog, insertWatchdogEvent } = await pausedHarness({
        writePersistedPause,
        acceptanceHoldMs: 5000,
      });
      writePersistedPause.mockClear();
      global.fetch = vi.fn(healthyFetch);

      await watchdog.runHealthCheck({ source: "test" });
      expect(watchdog.getStatus().health).toBe("healthy");
      expect(watchdog.getStatus().autoRepairPaused).not.toBe(null); // one green probe is not acceptance

      vi.setSystemTime(Date.now() + 3000);
      global.fetch = vi.fn(failingFetch);
      await watchdog.runHealthCheck({ source: "test" }); // resets the clock
      global.fetch = vi.fn(healthyFetch);
      vi.setSystemTime(Date.now() + 3000);
      await watchdog.runHealthCheck({ source: "test" }); // 6 s since the FIRST green, 0 since the reset
      expect(watchdog.getStatus().autoRepairPaused).not.toBe(null);

      vi.setSystemTime(Date.now() + 5000);
      await watchdog.runHealthCheck({ source: "test" });
      expect(watchdog.getStatus().autoRepairPaused).toBe(null);
      expect(writePersistedPause).toHaveBeenCalledWith(null);
      expect(rowsOf(insertWatchdogEvent, "repair", "ok").at(-1)).toMatchObject({
        source: "health_check",
        details: { pauseCleared: "healthy_acceptance", cause: "state_schema_too_new", fingerprint: kFingerprint },
      });
      watchdog.stop();
    });

    it("operator resume is one-shot: a plain manual repair while paused is refused (skipped auto_repair_paused, 409-shaped), triggerRepair({ force: true }) clears the pause for that attempt and runs Doctor, and the same fingerprint re-latches with attempts 2", async () => {
      const writePersistedPause = vi.fn();
      const { watchdog, insertWatchdogEvent, clawCmd, hooks } = await pausedHarness({ writePersistedPause });
      const refusedRepair = await watchdog.triggerRepair();
      expect(refusedRepair).toMatchObject({
        ok: false,
        skipped: true,
        reason: "auto_repair_paused",
        pause: { cause: "state_schema_too_new", fingerprint: kFingerprint },
      });
      expect(rowsOf(insertWatchdogEvent, "repair", "skipped").at(-1)).toMatchObject({
        source: "manual",
        details: { reason: "auto_repair_paused", pauseReason: "structural_repair_failed" },
      });
      expect(doctorCalls(clawCmd)).toBe(0);

      const resumed = await watchdog.triggerRepair({ force: true });
      expect(resumed.skipped).toBeUndefined();
      expect(doctorCalls(clawCmd)).toBe(1);
      expect(rowsOf(insertWatchdogEvent, "repair", "ok").some(
        (row) => row.source === "manual" && row.details?.pauseCleared === "operator_resume",
      )).toBe(true);
      expect(writePersistedPause).toHaveBeenLastCalledWith(null);
      expect(watchdog.getStatus().autoRepairPaused).toBe(null);

      // Same fingerprint again, the structure still cannot be fixed → re-latch.
      crash(watchdog);
      await flushAll();
      expect(hooks.reconcileInstalled).toHaveBeenCalledTimes(2);
      expect(watchdog.getStatus().autoRepairPaused).toMatchObject({ fingerprint: kFingerprint, attempts: 2 });
      expect(rowsOf(insertWatchdogEvent, "auto_repair_paused")).toHaveLength(2);
      watchdog.stop();
    });

    it("plain repairAttempts exhaustion is NOT a pause: past kWatchdogMaxRepairAttempts runRepair books repair/<source>/skipped {repair_attempts_exhausted} while restartAfterCrash keeps relaunching", async () => {
      const { watchdog, insertWatchdogEvent, clawCmd, launchGatewayProcess } = createHarness({
        autoRepair: true,
        clawCmdImpl: async (command) =>
          command === "doctor --fix --yes" ? { ok: false, stderr: "doctor exploded" } : { ok: true, stdout: "" },
        fetchImpl: failingFetch,
      });
      // Two failed Doctor runs exhaust the (default 2) budget.
      await watchdog.triggerRepair();
      await watchdog.triggerRepair();
      expect(watchdog.getStatus().repairAttempts).toBe(2);
      expect(doctorCalls(clawCmd)).toBe(2);

      crash(watchdog, { stderrTail: [] });
      await flushMicrotasks();
      crash(watchdog, { stderrTail: [] });
      await flushMicrotasks();
      expect(launchGatewayProcess).toHaveBeenCalledTimes(2); // backoff relaunches continue
      crash(watchdog, { stderrTail: [] });
      await flushAll();
      expect(watchdog.getStatus().lifecycle).toBe("crash_loop");
      expect(doctorCalls(clawCmd)).toBe(2); // the crash-loop repair did not run Doctor again
      expect(rowsOf(insertWatchdogEvent, "repair", "skipped").at(-1)).toMatchObject({
        source: "crash_loop",
        details: { reason: "repair_attempts_exhausted", attempts: 2, limit: 2 },
      });
      expect(watchdog.getStatus().autoRepairPaused).toBe(null);
      expect(rowsOf(insertWatchdogEvent, "auto_repair_paused")).toHaveLength(0);
      watchdog.stop();
    });

    it("runtime compat step (C2): a relaunch against a binary that cannot read the databases books restart/<source>/skipped {version_mismatch, expected, running, intent}, clears the pending replacement, latches the mismatch and hands the cause to the structural ladder; OPENCLAW_LAUNCH_COMPAT_GATE=off launches as before", async () => {
      const hooks = makeHooks();
      let installedCompatible = false;
      const assessLaunchCompatibility = vi.fn(async () =>
        installedCompatible
          ? { compatible: true, reasons: [], installedVersion: hooks.info.installedVersion, holdReason: null }
          : {
              compatible: false,
              reasons: ["state_schema_too_new"],
              installedVersion: "2026.7.1-2",
              holdReason: "version_mismatch",
            },
      );
      hooks.reconcileInstalled.mockImplementation(async () => {
        hooks.info.installedVersion = "2026.9.2";
        hooks.info.installedDiverged = false;
        installedCompatible = true;
        return activated("2026.9.2");
      });
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } = createHarness({
        autoRepair: false,
        fetchImpl: failingFetch,
        releaseChannelHooks: hooks,
        assessLaunchCompatibility,
      });
      // A plain crash (no classifier): the legacy ladder asks for a relaunch.
      watchdog.onGatewayExit({ code: 1, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();
      const skipped = rowsOf(insertWatchdogEvent, "restart", "skipped");
      expect(skipped[0]).toMatchObject({
        source: "exit_event",
        details: {
          reason: "version_mismatch",
          expected: "2026.9.2",
          running: "2026.7.1-2",
          intent: "relaunch_if_absent",
          reasons: ["state_schema_too_new"],
          holdReason: "version_mismatch",
        },
      });
      expect(rowsOf(insertWatchdogEvent, "restart", "failed")).toHaveLength(0);
      const status = watchdog.getStatus();
      expect(status.versionMismatch).toMatchObject({ expected: "2026.9.2", running: "2026.7.1-2", source: "relaunch" });
      expect(status.degradedReason).toBe("version_mismatch");
      // The structural ladder took over: reconcile, then the ONE launch of the
      // corrected tree (its own compat step now passes).
      await flushAll();
      expect(hooks.reconcileInstalled).toHaveBeenCalledWith(
        expect.objectContaining({ source: "structural_repair", relaunch: true }),
      );
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(rowsOf(insertWatchdogEvent, "restart", "requested")[0].source).toBe(kStructuralRelaunchSource);
      expect(watchdog.getStatus().replacementPending).toMatchObject({ source: kStructuralRelaunchSource });
      expect(rowsOf(insertWatchdogEvent, "repair", "ok")[0].details.plan[0]).toEqual({
        step: "reconcile_installed",
        outcome: "activated",
        detail: "2026.7.1-2 → 2026.9.2",
      });
      watchdog.stop();

      // Kill switch: the seam is never consulted, the launch proceeds.
      process.env[kLaunchCompatGateEnvKey] = "off";
      const compat = vi.fn(async () => ({ compatible: false, reasons: ["state_schema_too_new"] }));
      const off = createHarness({
        autoRepair: false,
        fetchImpl: failingFetch,
        releaseChannelHooks: makeHooks(),
        assessLaunchCompatibility: compat,
      });
      off.watchdog.onGatewayExit({ code: 1, expectedExit: false, stderrTail: [] });
      await flushAll();
      expect(compat).not.toHaveBeenCalled();
      expect(off.launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(rowsOf(off.insertWatchdogEvent, "restart", "requested")[0].source).toBe("exit_event");
      off.watchdog.stop();
    });

    it("compat step inside runRepair: Doctor ran, the relaunch was refused → skipped {version_mismatch}, admitted Doctor attempt counted, no 'Auto-repair failed' notice", async () => {
      const assessLaunchCompatibility = vi.fn(async () => ({
        compatible: false,
        reasons: ["agent_schema_too_new"],
        installedVersion: "2026.7.1-2",
      }));
      const { watchdog, clawCmd, notifier, insertWatchdogEvent } = createHarness({
        autoRepair: true,
        fetchImpl: failingFetch,
        releaseChannelHooks: makeHooks(),
        assessLaunchCompatibility,
      });
      const result = await watchdog.triggerRepair();
      expect(doctorCalls(clawCmd)).toBe(1);
      expect(result).toMatchObject({
        ok: false,
        skipped: true,
        reason: "version_mismatch",
        verdict: kRestartVerdicts.VERSION_MISMATCH,
        launchedGateway: false,
      });
      expect(watchdog.getStatus().repairAttempts).toBe(1);
      expect(watchdog.getStatus().lastRepairVerdict).toBe("version_mismatch");
      expect(noticeText(notifier, "Auto-repair failed")).toBe(null);
      expect(rowsOf(insertWatchdogEvent, "restart", "skipped")[0]).toMatchObject({
        source: "repair",
        details: { reason: "version_mismatch", intent: "replace" },
      });
      watchdog.stop();
    });

    it("kill switch OPENCLAW_CRASH_CAUSE_LADDER=off: classification and corroboration still record, but the legacy ladder relaunches and nothing structural or pausing acts", async () => {
      process.env[kCrashCauseLadderEnvKey] = "off";
      const hooks = makeHooks();
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } = ladderHarness({ hooks });
      crash(watchdog);
      await flushAll();
      expect(rowsOf(insertWatchdogEvent, "crash")[0].details.cause).toBe("state_schema_too_new");
      expect(rowsOf(insertWatchdogEvent, "crash_cause")[0].details.corroborated).toBe(true);
      expect(rowsOf(insertWatchdogEvent, "version_mismatch")).toHaveLength(1);
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(rowsOf(insertWatchdogEvent, "restart", "requested")[0].source).toBe("exit_event");
      expect(hooks.reconcileInstalled).not.toHaveBeenCalled();
      expect(rowsOf(insertWatchdogEvent, "repair")).toHaveLength(0);
      expect(watchdog.getStatus().autoRepairPaused).toBe(null);
      watchdog.stop();
    });

    it("hooks without reconcileInstalled (legacy wiring) keep the pre-Stage-3 ladder byte-for-byte: corroborated cause, legacy relaunch", async () => {
      const { watchdog, insertWatchdogEvent, launchGatewayProcess } = ladderHarness({
        hooks: { getInfo: () => makeHooks().info, requestRollback: vi.fn(() => null) },
      });
      crash(watchdog);
      await flushAll();
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(rowsOf(insertWatchdogEvent, "repair")).toHaveLength(0);
      expect(watchdog.getStatus().autoRepairPaused).toBe(null);
      watchdog.stop();
    });

    it("re-arms a persisted pause at construction for the same installedVersion (one skipped row, repairs refused) and drops it for a different one; a throwing reader is one warning", () => {
      const persisted = {
        at: 1788681900000,
        cause: "state_schema_too_new",
        fingerprint: kFingerprint,
        installedVersion: "2026.7.1-2",
        attempts: 3,
        lastPlan: { rung: "reconcile_installed", outcome: "overlay_missing" },
        reason: "structural_repair_failed",
      };
      const sameWrite = vi.fn();
      const same = ladderHarness({
        hooks: makeHooks(),
        readPersistedPause: () => ({ ...persisted }),
        writePersistedPause: sameWrite,
      });
      expect(same.watchdog.getStatus().autoRepairPaused).toEqual({
        ...persisted,
        at: "2026-09-06T08:05:00.000Z",
        corroborated: null,
        expected: "2026.9.2",
      });
      expect(rowsOf(same.insertWatchdogEvent, "repair", "skipped")[0]).toMatchObject({
        source: "structural",
        details: { reason: "auto_repair_paused", rearmed: true, attempts: 3 },
      });
      expect(sameWrite).not.toHaveBeenCalled();
      same.watchdog.stop();

      const changedWrite = vi.fn();
      const changed = ladderHarness({
        hooks: makeHooks({ installedVersion: "2026.9.2", installedDiverged: false }),
        readPersistedPause: () => ({ ...persisted }),
        writePersistedPause: changedWrite,
      });
      expect(changed.watchdog.getStatus().autoRepairPaused).toBe(null);
      expect(changedWrite).toHaveBeenCalledWith(null);
      changed.watchdog.stop();

      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const throwing = ladderHarness({
        hooks: makeHooks(),
        readPersistedPause: () => {
          throw new Error("EIO");
        },
      });
      expect(throwing.watchdog.getStatus().autoRepairPaused).toBe(null);
      expect(warn.mock.calls.some((call) => String(call[0]).includes("persisted auto-repair pause unreadable"))).toBe(true);
      throwing.watchdog.stop();
    });

    it("an installedVersion change observed on the channel clears the pause (a manual restart or a blocklist Clear alone never does)", async () => {
      const writePersistedPause = vi.fn();
      const { watchdog, hooks, insertWatchdogEvent } = await pausedHarness({ writePersistedPause });
      // Manual restart-shaped events: the pause survives.
      watchdog.onExpectedRestart({ expiresAt: Date.now() + 60_000 });
      watchdog.onExpectedRestartSettled();
      await flushAll();
      expect(watchdog.getStatus().autoRepairPaused).not.toBe(null);
      // The operator applied a compatible build: the tree changed.
      hooks.info.installedVersion = "2026.9.2";
      hooks.info.installedDiverged = false;
      const refusedRepair = await watchdog.triggerRepair();
      expect(refusedRepair.reason).not.toBe("auto_repair_paused");
      expect(watchdog.getStatus().autoRepairPaused).toBe(null);
      expect(writePersistedPause).toHaveBeenLastCalledWith(null);
      expect(rowsOf(insertWatchdogEvent, "repair", "ok").some(
        (row) => row.details?.pauseCleared === "installed_version_changed",
      )).toBe(true);
      watchdog.stop();
    });

    it("rule (b): an UNcorroborated version-family fingerprint whose relaunched child exits inside its launch window twice latches the pause with 'Suspected cause' wording", async () => {
      const hooks = makeHooks({ installedDiverged: false });
      const { watchdog, insertWatchdogEvent, launchGatewayProcess, notifier } = ladderHarness({
        hooks,
        facts: uncorroboratedFacts,
        autoRepair: false,
      });
      crash(watchdog); // no pending yet → legacy relaunch (pid 4242)
      await flushAll();
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      crash(watchdog); // the pending child died inside its window → count 1 → relaunch again
      await flushAll();
      expect(launchGatewayProcess).toHaveBeenCalledTimes(2);
      expect(watchdog.getStatus().autoRepairPaused).toBe(null);
      crash(watchdog); // count 2 → pause
      await flushAll();
      expect(launchGatewayProcess).toHaveBeenCalledTimes(2);
      expect(hooks.reconcileInstalled).not.toHaveBeenCalled();
      expect(watchdog.getStatus().autoRepairPaused).toMatchObject({
        cause: "state_schema_too_new",
        fingerprint: kFingerprint,
        reason: kAutoRepairPauseReasons.REPLACEMENT_EXITED_TWICE,
        corroborated: false,
        lastPlan: null,
      });
      expect(rowsOf(insertWatchdogEvent, "restart", "failed").filter((r) => r.details.reason === "replacement_exited")).toHaveLength(2);
      const notice = noticeText(notifier, "🔴 Auto-repair paused");
      expect(String(notice[0])).toContain("Suspected cause: `state_schema_too_new`");
      expect(String(notice[0])).toContain("Last plan: relaunched build exited twice inside its launch window");
      // A further crash relaunches nothing: four crashes in the window put the
      // legacy path on its crash-loop branch, which the pause stops cold (no
      // rollback, no doctor).
      crash(watchdog);
      await flushAll();
      expect(launchGatewayProcess).toHaveBeenCalledTimes(2);
      expect(rowsOf(insertWatchdogEvent, "repair", "skipped").at(-1)?.details).toMatchObject({
        reason: "auto_repair_paused",
        fingerprint: kFingerprint,
      });
      expect(hooks.requestRollback).not.toHaveBeenCalled();
      watchdog.stop();
    });
  });
});


describe("Doctor admission accounting", () => {
  const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
  afterEach(() => {
    vi.useRealTimers();
    global.fetch = kOriginalFetch;
    if (kOriginalAutoRepair == null) delete process.env.WATCHDOG_AUTO_REPAIR;
    else process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
  });
  it("charges a throwing runner once and preserves the automatic cap", async () => {
    const repairRunner = vi.fn(async () => { throw new Error("doctor process failed"); });
    const { watchdog } = createHarness({ repairRunner, fetchImpl: async () => { throw new Error("offline"); } });
    try {
      const limit = watchdog.getStatus().repairAttemptLimit;
      for (let i = 0; i < limit; i += 1) {
        expect(await watchdog.runRepair({ source: "degraded_retry", correlationId: `throw-${i}` }))
          .toMatchObject({ ok: false, reason: "repair_failed" });
        await flushMicrotasks();
      }
      expect(await watchdog.runRepair({ source: "degraded_retry", correlationId: "over-cap" }))
        .toMatchObject({ skipped: true, reason: "repair_attempts_exhausted" });
      expect(repairRunner).toHaveBeenCalledTimes(limit);
      expect(watchdog.getStatus().repairAttempts).toBe(limit);
    } finally { watchdog.stop(); }
  });

  it("rechecks the automatic cap when concurrent binary reads finish on opposite sides of the last allowed attempt", async () => {
    let suspect = false;
    let delayLookup = true;
    const lookups = [];
    const binary = { bin: "/verified/doctor.js", version: "1.0.0" };
    const repairRunner = vi.fn(async () => ({ ok: false }));
    const lock = createGatewayLifecycleLock();
    const { watchdog } = createHarness({ gatewayLifecycleLock: lock, repairRunner,
      fetchImpl: async () => { throw new Error("offline"); },
      releaseChannelHooks: {
        getInfo: () => ({ installedDiverged: suspect }),
        compatibleBinForCurrentDb: () => delayLookup
          ? new Promise((resolve) => { lookups.push(resolve); }) : Promise.resolve(binary),
      },
    });
    try {
      const limit = watchdog.getStatus().repairAttemptLimit;
      for (let i = 0; i < limit - 1; i += 1) {
        await watchdog.runRepair({ source: "degraded_retry", correlationId: `prefill-${i}` });
        await flushMicrotasks();
      }
      suspect = true;
      const first = watchdog.runRepair({ source: "degraded_retry", correlationId: "first-lookup" });
      const second = watchdog.runRepair({ source: "degraded_retry", correlationId: "second-lookup" });
      expect(lookups).toHaveLength(2);
      lookups[0](binary);
      await first;
      await flushMicrotasks();
      lookups[1](binary);
      expect(await second).toMatchObject({ skipped: true, reason: "repair_attempts_exhausted", attempts: limit });
      expect(repairRunner).toHaveBeenCalledTimes(limit);
      expect(watchdog.getStatus().repairAttempts).toBe(limit);
      expect(lock.getActiveOperation()).toBeNull();
      // The automatic cap must not turn into a ban on an operator's repair.
      delayLookup = false;
      await watchdog.runRepair({ source: "manual", correlationId: "operator", force: true });
      expect(repairRunner).toHaveBeenCalledTimes(limit + 1);
    } finally { watchdog.stop(); }
  });

  it.each([false, true])("honors an auto-repair disable during binary discovery while preserving manual force=%s", async (force) => {
    let finishLookup;
    const repairRunner = vi.fn(async () => ({ ok: false }));
    const lock = createGatewayLifecycleLock();
    const { watchdog } = createHarness({ gatewayLifecycleLock: lock, repairRunner,
      fetchImpl: async () => { throw new Error("offline"); },
      releaseChannelHooks: {
        getInfo: () => ({ installedDiverged: true }),
        compatibleBinForCurrentDb: () => new Promise((resolve) => { finishLookup = resolve; }),
      },
    });
    try {
      const pending = watchdog.runRepair({ source: force ? "manual" : "degraded_retry", correlationId: "disable-race", force });
      expect(finishLookup).toBeTypeOf("function");
      process.env.WATCHDOG_AUTO_REPAIR = "false";
      watchdog.updateSettings({ autoRepair: false });
      finishLookup({ bin: "/verified/doctor.js", version: "1.0.0" });
      const result = await pending;
      if (!force) expect(result).toMatchObject({ skipped: true, reason: "auto_repair_disabled" });
      expect(repairRunner).toHaveBeenCalledTimes(force ? 1 : 0);
      expect(watchdog.getStatus().repairAttempts).toBe(force ? 1 : 0);
      expect(lock.getActiveOperation()).toBeNull();
    } finally { watchdog.stop(); }
  });

  it("does not replace a newly pending gateway after an older automatic binary lookup finishes", async () => {
    let finishOldLookup;
    const binary = { bin: "/verified/doctor.js", version: "1.0.0" };
    const lookup = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOldLookup = resolve; }))
      .mockResolvedValue(binary);
    const repairRunner = vi.fn(async () => ({ ok: true }));
    const lock = createGatewayLifecycleLock();
    const { watchdog } = createHarness({ gatewayLifecycleLock: lock, repairRunner,
      fetchImpl: async () => { throw new Error("not ready"); },
      releaseChannelHooks: { getInfo: () => ({ installedDiverged: true }), compatibleBinForCurrentDb: lookup },
    });
    try {
      const pending = watchdog.runRepair({ source: "degraded_retry", correlationId: "old-lookup" });
      const current = await watchdog.runRepair({ source: "manual", correlationId: "new-replacement", force: true });
      expect(current).toMatchObject({ ok: true, pending: true });
      finishOldLookup(binary);
      expect(await pending).toMatchObject({ skipped: true, reason: "replacement_pending" });
      expect(repairRunner).toHaveBeenCalledTimes(1);
      expect(watchdog.getStatus().repairAttempts).toBe(1);
      expect(lock.getActiveOperation()).toBeNull();
    } finally { watchdog.stop(); }
  });

  it("Doctor success with an unverified replacement retains its admitted attempt", async () => {
    const { watchdog } = createHarness({ autoRepair: false,
      fetchImpl: async () => { throw new Error("not ready"); } });
    try {
      const result = await watchdog.runRepair({ source: "manual", correlationId: "pending", force: true });
      expect(result).toMatchObject({ ok: true, pending: true });
      expect(watchdog.getStatus().repairAttempts).toBe(1);
      watchdog.onGatewayExit({ code: 1, expectedExit: true, pid: 4242 });
      await flushMicrotasks();
      expect(watchdog.getStatus().repairAttempts).toBe(1);
      watchdog.onGatewayExit({ code: 1, expectedExit: true, pid: 4242 });
      await flushMicrotasks();
      expect(watchdog.getStatus().repairAttempts).toBe(1);
    } finally { watchdog.stop(); }
  });

  it("a green probe begun before Doctor admission cannot erase the newly charged attempt", async () => {
    let finishProbe;
    let finishDoctor;
    let firstProbe = true;
    const repairRunner = vi.fn(() => new Promise((resolve) => { finishDoctor = resolve; }));
    const { watchdog } = createHarness({ autoRepair: false, repairRunner,
      fetchImpl: () => {
        if (firstProbe) {
          firstProbe = false;
          return new Promise((resolve) => { finishProbe = resolve; });
        }
        return Promise.reject(new Error("offline"));
      },
    });
    try {
      const staleProbe = watchdog.runHealthCheck({ source: "before_doctor" });
      await vi.waitFor(() => expect(finishProbe).toBeTypeOf("function"));
      const repair = watchdog.runRepair({ source: "manual", correlationId: "new-attempt", force: true });
      await vi.waitFor(() => expect(repairRunner).toHaveBeenCalledTimes(1));
      expect(watchdog.getStatus().repairAttempts).toBe(1);
      finishProbe({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, status: "live" }) });
      expect(await staleProbe).toBe(false);
      expect(watchdog.getStatus().repairAttempts).toBe(1);
      finishDoctor({ ok: false });
      await repair;
      await flushMicrotasks();
      expect(watchdog.getStatus().repairAttempts).toBe(1);
    } finally { watchdog.stop(); }
  });
});

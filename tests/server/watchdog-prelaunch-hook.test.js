// Prelaunch hook outcomes reaching the watchdog (lane I integration of lane
// C's gateway.setGatewayPrelaunchHookHandler seam):
//   watchdog.onPrelaunchHook(outcome)      — degradedReason narration +
//                                            ONE degraded (health_check/failed)
//                                            row; cleared by launch / healthy
//   createGatewayPrelaunchHookHandler(...) — the composition lib/server.js
//                                            installs: ledger row + important
//                                            notification + onPrelaunchHook
const {
  createWatchdog,
  createGatewayPrelaunchHookHandler,
} = require("../../lib/server/watchdog");
const { kWatchdogPhases } = require("../../lib/server/watchdog-phase");

const kOriginalQuiet = process.env.WATCHDOG_NOTIFICATIONS_QUIET;

const healthyFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ ok: true }),
});

const createHarness = ({ fetchImpl = healthyFetch } = {}) => {
  const insertWatchdogEvent = vi.fn();
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true })),
    launchGatewayProcess: vi.fn(async () => null),
    insertWatchdogEvent,
    notifier,
    readEnvFile: vi.fn(() => ""),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "http://localhost",
    resolveGatewayHealthUrl: () => "http://gateway/health",
    resolveGatewayReadyzUrl: () => "",
    sleepImpl: () => Promise.resolve(),
    supervisorModeActive: () => false,
  });
  vi.stubGlobal("fetch", vi.fn(fetchImpl));
  return { watchdog, insertWatchdogEvent, notifier };
};

// Exactly the outcome shape gateway.js reports (tests/server/gateway.test.js
// pins it against the real launch paths).
const refusedOutcome = (overrides = {}) => ({
  status: "refused",
  code: "not_root_owned",
  hookPath: "/opt/alphaclaw/hooks/pre-gateway-launch",
  message: "prelaunch hook must be owned by root (uid 1000)",
  site: "managed launch",
  durationMs: 3,
  exitCode: null,
  signal: null,
  ...overrides,
});
const failedOutcome = (overrides = {}) => ({
  status: "failed",
  code: "nonzero_exit",
  hookPath: "/opt/alphaclaw/hooks/pre-gateway-launch",
  message: "prelaunch hook exited 2",
  site: "restart",
  durationMs: 812,
  exitCode: 2,
  signal: null,
  ...overrides,
});
const ranOutcome = (overrides = {}) => ({
  status: "ran",
  code: null,
  hookPath: "/opt/alphaclaw/hooks/pre-gateway-launch",
  message: null,
  site: "managed launch",
  durationMs: 40,
  exitCode: 0,
  signal: null,
  ...overrides,
});

const degradedRows = (insertWatchdogEvent) =>
  insertWatchdogEvent.mock.calls
    .map(([row]) => row)
    .filter((row) => row.eventType === "health_check" && row.status === "failed");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (kOriginalQuiet == null) delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
  else process.env.WATCHDOG_NOTIFICATIONS_QUIET = kOriginalQuiet;
});

describe("watchdog.onPrelaunchHook", () => {
  it("a refused hook sets degradedReason=prelaunch_hook_failed, narrates the outcome on getStatus(), and writes ONE degraded row — without inventing a phase", () => {
    const { watchdog, insertWatchdogEvent } = createHarness();
    const before = watchdog.getStatus();
    expect(before.prelaunchHook).toBe(null);
    expect(before.degradedReason).toBe(null);

    watchdog.onPrelaunchHook(refusedOutcome());

    const status = watchdog.getStatus();
    expect(status.degradedReason).toBe("prelaunch_hook_failed");
    expect(status.prelaunchHook).toEqual({
      status: "refused",
      code: "not_root_owned",
      site: "managed launch",
      hookPath: "/opt/alphaclaw/hooks/pre-gateway-launch",
      message: "prelaunch hook must be owned by root (uid 1000)",
      at: expect.any(String),
    });
    expect(Date.parse(status.prelaunchHook.at)).not.toBeNaN();
    // The phase enum is untouched (15 values) and the phase is whatever the
    // existing latches derive — here the never-started "stopped" — with the
    // new reason narrating it.
    expect(kWatchdogPhases).toHaveLength(15);
    expect(status.phase).toBe(before.phase);
    expect(status.lifecycle).toBe(before.lifecycle);
    expect(status.health).toBe(before.health);

    // The degraded row watchdog-incidents.js classifies as an incident open.
    const rows = degradedRows(insertWatchdogEvent);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      eventType: "health_check",
      source: "prelaunch_hook",
      status: "failed",
      details: {
        reason: "prelaunch_hook_failed",
        launchAborted: true,
        hookStatus: "refused",
        code: "not_root_owned",
        site: "managed launch",
        hookPath: "/opt/alphaclaw/hooks/pre-gateway-launch",
        exitCode: null,
        signal: null,
        durationMs: 3,
      },
    });
    expect(rows[0].correlationId).toBeTruthy();
  });

  it("a failed hook (non-zero exit) carries exitCode/signal/site into the row and the narration", () => {
    const { watchdog, insertWatchdogEvent } = createHarness();
    watchdog.onPrelaunchHook(failedOutcome({ signal: "SIGKILL", exitCode: null }));
    expect(watchdog.getStatus().prelaunchHook).toMatchObject({
      status: "failed",
      code: "nonzero_exit",
      site: "restart",
    });
    expect(degradedRows(insertWatchdogEvent)[0].details).toMatchObject({
      hookStatus: "failed",
      exitCode: null,
      signal: "SIGKILL",
      durationMs: 812,
    });
  });

  it("ignores 'ran' with no prior failure and unknown statuses (no state, no rows)", () => {
    const { watchdog, insertWatchdogEvent } = createHarness();
    watchdog.onPrelaunchHook(ranOutcome());
    watchdog.onPrelaunchHook({ status: "weird" });
    watchdog.onPrelaunchHook(null);
    watchdog.onPrelaunchHook();
    expect(watchdog.getStatus().prelaunchHook).toBe(null);
    expect(watchdog.getStatus().degradedReason).toBe(null);
    expect(insertWatchdogEvent).not.toHaveBeenCalled();
  });

  it("a later 'ran' outcome clears the failure narration (that launch proceeds)", () => {
    const { watchdog } = createHarness();
    watchdog.onPrelaunchHook(refusedOutcome());
    expect(watchdog.getStatus().degradedReason).toBe("prelaunch_hook_failed");
    watchdog.onPrelaunchHook(ranOutcome());
    expect(watchdog.getStatus().degradedReason).toBe(null);
    expect(watchdog.getStatus().prelaunchHook).toBe(null);
  });

  it("the next successful launch (onGatewayLaunch) clears the failure narration", () => {
    const { watchdog } = createHarness();
    watchdog.onPrelaunchHook(refusedOutcome());
    watchdog.onGatewayLaunch({ pid: 4242, startedAt: Date.now() });
    const status = watchdog.getStatus();
    expect(status.degradedReason).toBe(null);
    expect(status.prelaunchHook).toBe(null);
    expect(status.lifecycle).toBe("running");
  });

  it("a refused light restart of a LIVE gateway keeps phase healthy and the next healthy probe clears the narration (and closes the incident with its ok row)", async () => {
    vi.useFakeTimers();
    try {
      const { watchdog, insertWatchdogEvent } = createHarness();
      watchdog.onGatewayLaunch({ pid: 111, startedAt: Date.now() - 60_000 });
      await vi.advanceTimersByTimeAsync(10);
      expect(watchdog.getStatus().phase).toBe("healthy");

      watchdog.onPrelaunchHook(refusedOutcome({ site: "light restart" }));
      const during = watchdog.getStatus();
      expect(during.phase).toBe("healthy");
      expect(during.health).toBe("healthy");
      expect(during.degradedReason).toBe("prelaunch_hook_failed");
      expect(during.prelaunchHook.site).toBe("light restart");
      const rowsBefore = insertWatchdogEvent.mock.calls.length;

      // Next regular health check (120s cadence) is healthy → cleared, and
      // its non-skipped ok row is what watchdog-incidents.js closes on.
      await vi.advanceTimersByTimeAsync(120_000);
      const after = watchdog.getStatus();
      expect(after.degradedReason).toBe(null);
      expect(after.prelaunchHook).toBe(null);
      expect(after.phase).toBe("healthy");
      const okRows = insertWatchdogEvent.mock.calls
        .slice(rowsBefore)
        .map(([row]) => row)
        .filter(
          (row) =>
            row.eventType === "health_check" &&
            row.status === "ok" &&
            !row.details?.skipped,
        );
      expect(okRows.length).toBeGreaterThanOrEqual(1);
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clearing never clobbers a probe-derived degradedReason", async () => {
    vi.useFakeTimers();
    try {
      let mode = "healthy";
      const { watchdog } = createHarness({
        fetchImpl: async () =>
          mode === "healthy"
            ? healthyFetch()
            : {
                ok: false,
                status: 503,
                text: async () => JSON.stringify({ error: "queue backlog" }),
              },
      });
      watchdog.onGatewayLaunch({ pid: 111, startedAt: Date.now() - 60_000 });
      await vi.advanceTimersByTimeAsync(10);
      mode = "failing";
      await vi.advanceTimersByTimeAsync(120_000);
      expect(watchdog.getStatus().degradedReason).toBe("queue backlog");

      // A 'ran' hook outcome (some other launch path proceeding) leaves the
      // probe's reason alone.
      watchdog.onPrelaunchHook(ranOutcome());
      expect(watchdog.getStatus().degradedReason).toBe("queue backlog");
      watchdog.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("the narration is frame-stable across getStatus() reads (SSE dedupe safety) and bounded in length", () => {
    const { watchdog } = createHarness();
    watchdog.onPrelaunchHook(
      refusedOutcome({ message: "m".repeat(1000), code: "c".repeat(200), site: "s".repeat(200) }),
    );
    const first = watchdog.getStatus().prelaunchHook;
    const second = watchdog.getStatus().prelaunchHook;
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.message).toHaveLength(200);
    expect(first.code).toHaveLength(80);
    expect(first.site).toHaveLength(60);
  });
});

// P2 review fix: a relaunch that returns NO child because the hook refused/
// failed is a fail-closed abort, not EX_CONFIG. The two config-error paths
// that relaunch (the openclaw.json-mtime auto-retry and the medic's post-fix
// relaunch) used to re-latch configuration_error for it — telling the operator
// "fix openclaw.json" (and, on the medic path, sending the EX_CONFIG
// notification) for a hook problem. Both branches pinned: hook-aborted →
// stand down with the hook narration; genuine no-child → latch as before.
describe("config-error relaunch paths vs a hook-aborted launch", () => {
  const flushMicrotasks = async () =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });
  const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
  const kOriginalNotificationsDisabled = process.env.WATCHDOG_NOTIFICATIONS_DISABLED;

  afterEach(() => {
    if (kOriginalAutoRepair == null) delete process.env.WATCHDOG_AUTO_REPAIR;
    else process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
    if (kOriginalNotificationsDisabled == null) {
      delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    } else {
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED = kOriginalNotificationsDisabled;
    }
  });

  // The gateway is down throughout (nothing launches); the injected reader
  // stands in for gateway.getLastGatewayPrelaunchHookOutcome.
  const createLatchHarness = ({ configMedic = null } = {}) => {
    process.env.WATCHDOG_AUTO_REPAIR = "false";
    process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
    const insertWatchdogEvent = vi.fn();
    const notifier = { notify: vi.fn(async () => ({ ok: true })) };
    const mtimeRef = { value: 100 };
    const hookOutcomeRef = { value: null };
    const launchGatewayProcess = vi.fn(async () => null);
    const watchdog = createWatchdog({
      clawCmd: vi.fn(async () => ({ ok: true, stdout: "" })),
      launchGatewayProcess,
      insertWatchdogEvent,
      notifier,
      readEnvFile: vi.fn(() => ""),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      resolveSetupUrl: () => "http://localhost",
      resolveGatewayHealthUrl: () => "http://gateway/health",
      resolveGatewayReadyzUrl: () => "",
      sleepImpl: () => Promise.resolve(),
      supervisorModeActive: () => false,
      readConfigMtimeMs: () => mtimeRef.value,
      getLastGatewayPrelaunchHookOutcome: () => hookOutcomeRef.value,
      configMedic,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("gateway unavailable");
      }),
    );
    return {
      watchdog,
      insertWatchdogEvent,
      notifier,
      mtimeRef,
      hookOutcomeRef,
      launchGatewayProcess,
    };
  };
  const latchWithExit78 = (harness) => {
    harness.watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    harness.watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: ["fatal configuration error"],
    });
  };
  const rows = (harness) => harness.insertWatchdogEvent.mock.calls.map(([row]) => row);
  const standDownRows = (harness) =>
    rows(harness).filter(
      (row) => row.eventType === "config_error" && row.status === "skipped",
    );
  const messages = (harness) => harness.notifier.notify.mock.calls.map(([m]) => m);

  describe("openclaw.json-change auto-retry", () => {
    it("hook REFUSED the relaunch → no configuration_error re-latch: lifecycle stopped, degradedReason prelaunch_hook_failed, one stand-down row", async () => {
      const harness = createLatchHarness();
      latchWithExit78(harness);
      await flushMicrotasks();
      expect(harness.watchdog.getStatus()).toMatchObject({
        lifecycle: "configuration_error",
        phase: "config_error_latched",
      });

      // The operator edits openclaw.json; the retry's launch is aborted by
      // the hook (gateway.js records the outcome, launch resolves null).
      harness.mtimeRef.value = 200;
      harness.hookOutcomeRef.value = refusedOutcome({ site: "managed launch" });
      await harness.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(harness.launchGatewayProcess).toHaveBeenCalledTimes(1);

      const status = harness.watchdog.getStatus();
      expect(status.lifecycle).toBe("stopped");
      expect(status.lifecycle).not.toBe("configuration_error");
      expect(status.phase).toBe("stopped");
      expect(status.health).toBe("unhealthy");
      expect(status.degradedReason).toBe("prelaunch_hook_failed");
      expect(status.prelaunchHook).toMatchObject({
        status: "refused",
        code: "not_root_owned",
        site: "managed launch",
      });
      expect(standDownRows(harness)).toEqual([
        expect.objectContaining({
          source: "config_changed",
          details: {
            reason: "prelaunch_hook_aborted_launch",
            hookStatus: "refused",
            code: "not_root_owned",
            site: "managed launch",
          },
        }),
      ]);
      // Exactly one degraded row narrates the hook (the handler's own call,
      // when wired, is not duplicated by the stand-down).
      expect(degradedRows(harness.insertWatchdogEvent)).toHaveLength(1);
      harness.watchdog.stop();
    });

    it("hook FAILED (non-zero exit) is handled the same as refused, and does not duplicate an already-showing narration", async () => {
      const harness = createLatchHarness();
      latchWithExit78(harness);
      await flushMicrotasks();

      // Production order: the installed handler narrates the outcome via
      // onPrelaunchHook INSIDE the launch, before launchGatewayProcess
      // resolves null.
      const outcome = failedOutcome({ site: "managed launch" });
      harness.launchGatewayProcess.mockImplementation(async () => {
        harness.hookOutcomeRef.value = outcome;
        harness.watchdog.onPrelaunchHook(outcome);
        return null;
      });
      harness.mtimeRef.value = 200;
      await harness.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();

      const status = harness.watchdog.getStatus();
      expect(status.lifecycle).toBe("stopped");
      expect(status.phase).toBe("stopped");
      expect(status.degradedReason).toBe("prelaunch_hook_failed");
      expect(status.prelaunchHook).toMatchObject({ status: "failed", code: "nonzero_exit" });
      expect(standDownRows(harness)).toHaveLength(1);
      expect(degradedRows(harness.insertWatchdogEvent)).toHaveLength(1);
      harness.watchdog.stop();
    });

    it("control: a no-child relaunch WITHOUT a hook abort (outcome ran / none) re-latches configuration_error exactly as before", async () => {
      for (const outcome of [null, ranOutcome()]) {
        const harness = createLatchHarness();
        latchWithExit78(harness);
        await flushMicrotasks();

        harness.mtimeRef.value = 200;
        harness.hookOutcomeRef.value = outcome;
        await harness.watchdog.runHealthCheck({ source: "health_timer" });
        await flushMicrotasks();
        expect(harness.launchGatewayProcess).toHaveBeenCalledTimes(1);

        const status = harness.watchdog.getStatus();
        expect(status.lifecycle).toBe("configuration_error");
        expect(status.phase).toBe("config_error_latched");
        expect(status.degradedReason).not.toBe("prelaunch_hook_failed");
        expect(standDownRows(harness)).toHaveLength(0);
        harness.watchdog.stop();
      }
    });
  });

  describe("medic post-fix relaunch", () => {
    const createMedic = () => ({
      isEnabled: vi.fn(() => true),
      run: vi.fn(async () => ({
        fixed: true,
        tier: "managed_key",
        actions: ["removed gateway.controlUi.environment"],
        backup: "openclaw.json.medic-x.bak",
      })),
    });

    it("hook REFUSED the medic's relaunch → no re-latch and NO EX_CONFIG notification (the hook handler already told the operator)", async () => {
      const harness = createLatchHarness({ configMedic: createMedic() });
      // The exit-78 latch's own notification is sent before the medic runs;
      // the relaunch that follows the fix is what the hook aborts.
      harness.hookOutcomeRef.value = refusedOutcome({ site: "managed launch" });
      latchWithExit78(harness);
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(harness.launchGatewayProcess).toHaveBeenCalledTimes(1);
      const status = harness.watchdog.getStatus();
      expect(status.lifecycle).toBe("stopped");
      expect(status.phase).toBe("stopped");
      expect(status.degradedReason).toBe("prelaunch_hook_failed");
      expect(standDownRows(harness)).toEqual([
        expect.objectContaining({
          source: "medic",
          details: expect.objectContaining({
            reason: "prelaunch_hook_aborted_launch",
            hookStatus: "refused",
          }),
        }),
      ]);
      // The auto-repair notice went out; the post-relaunch "restart is
      // paused until the config is fixed" latch notice did NOT.
      const sent = messages(harness);
      expect(sent.some((m) => m.includes("auto-repaired"))).toBe(true);
      expect(
        sent.filter((m) => m.includes("automatic gateway restart is paused")),
      ).toHaveLength(0);
      harness.watchdog.stop();
    });

    it("control: the medic's relaunch returning no child WITHOUT a hook abort re-latches configuration_error and notifies", async () => {
      const harness = createLatchHarness({ configMedic: createMedic() });
      harness.hookOutcomeRef.value = null;
      latchWithExit78(harness);
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      expect(harness.launchGatewayProcess).toHaveBeenCalledTimes(1);
      const status = harness.watchdog.getStatus();
      expect(status.lifecycle).toBe("configuration_error");
      expect(status.phase).toBe("config_error_latched");
      expect(standDownRows(harness)).toHaveLength(0);
      expect(
        messages(harness).some((m) =>
          m.includes("automatic gateway restart is paused"),
        ),
      ).toBe(true);
      harness.watchdog.stop();
    });
  });
});

// The crash-relaunch (exit_event) and repair-relaunch ledger rows used to say
// only "returned no child" — when the prelaunch hook is what aborted that
// relaunch, the real cause lived in console.error alone. noChildDetails() now
// names the abort on the row. The no-hook shape stays byte-identical
// (watchdog.test.js pins it), so the key appears exactly when a refused/failed
// outcome gated the launch.
describe("crash/repair relaunch ledger rows name a hook-aborted launch (noChildDetails)", () => {
  const flushMicrotasks = async () =>
    new Promise((resolve) => {
      setImmediate(resolve);
    });
  const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
  const kOriginalNotificationsDisabled = process.env.WATCHDOG_NOTIFICATIONS_DISABLED;

  afterEach(() => {
    if (kOriginalAutoRepair == null) delete process.env.WATCHDOG_AUTO_REPAIR;
    else process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
    if (kOriginalNotificationsDisabled == null) {
      delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    } else {
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED = kOriginalNotificationsDisabled;
    }
  });

  // The gateway is down throughout and every relaunch returns no child; the
  // injected reader stands in for gateway.getLastGatewayPrelaunchHookOutcome.
  const createNoChildHarness = ({ autoRepair = false, hookOutcome = null } = {}) => {
    process.env.WATCHDOG_AUTO_REPAIR = autoRepair ? "true" : "false";
    process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
    const insertWatchdogEvent = vi.fn();
    const watchdog = createWatchdog({
      clawCmd: vi.fn(async (command) =>
        command === "doctor --fix --yes"
          ? { ok: true, stdout: "fixed" }
          : { ok: true, stdout: "" },
      ),
      launchGatewayProcess: vi.fn(async () => null),
      insertWatchdogEvent,
      notifier: { notify: vi.fn(async () => ({ ok: true })) },
      readEnvFile: vi.fn(() => ""),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      resolveSetupUrl: () => "http://localhost",
      resolveGatewayHealthUrl: () => "http://gateway/health",
      resolveGatewayReadyzUrl: () => "",
      sleepImpl: () => Promise.resolve(),
      supervisorModeActive: () => false,
      getLastGatewayPrelaunchHookOutcome: () => hookOutcome,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("gateway unavailable");
      }),
    );
    const relaunchFailures = (source) =>
      insertWatchdogEvent.mock.calls
        .map(([row]) => row)
        .filter(
          (row) =>
            row.eventType === "restart" && row.source === source && row.status === "failed",
        );
    return { watchdog, insertWatchdogEvent, relaunchFailures };
  };

  it("crash relaunch (exit_event): the failed row carries prelaunchHook {status, code} for a refused or failed hook", async () => {
    for (const [outcome, expected] of [
      [refusedOutcome({ site: "restart" }), { status: "refused", code: "not_root_owned" }],
      [failedOutcome({ site: "restart" }), { status: "failed", code: "nonzero_exit" }],
    ]) {
      const harness = createNoChildHarness({ hookOutcome: outcome });
      harness.watchdog.onGatewayExit({ code: 1, expectedExit: false });
      await flushMicrotasks();
      const rows = harness.relaunchFailures("exit_event");
      expect(rows).toHaveLength(1);
      expect(rows[0].details).toEqual({
        reason: "launchGatewayProcess returned no child",
        prelaunchHook: expected,
      });
      harness.watchdog.stop();
    }
  });

  it("crash relaunch (exit_event) control: no hook abort (outcome null / ran) keeps the exact legacy detail shape", async () => {
    for (const outcome of [null, ranOutcome()]) {
      const harness = createNoChildHarness({ hookOutcome: outcome });
      harness.watchdog.onGatewayExit({ code: 1, expectedExit: false });
      await flushMicrotasks();
      const rows = harness.relaunchFailures("exit_event");
      expect(rows).toHaveLength(1);
      expect(rows[0].details).toEqual({ reason: "launchGatewayProcess returned no child" });
      harness.watchdog.stop();
    }
  });

  it("repair relaunch: the post-doctor failed row names the hook abort the same way (and not without one)", async () => {
    const aborted = createNoChildHarness({
      autoRepair: true,
      hookOutcome: refusedOutcome({ site: "managed launch" }),
    });
    const result = await aborted.watchdog.triggerRepair();
    expect(result).toMatchObject({ ok: true, launchedGateway: false });
    expect(aborted.relaunchFailures("repair")).toHaveLength(1);
    expect(aborted.relaunchFailures("repair")[0].details).toEqual({
      reason: "launchGatewayProcess returned no child",
      prelaunchHook: { status: "refused", code: "not_root_owned" },
    });
    aborted.watchdog.stop();

    const plain = createNoChildHarness({ autoRepair: true, hookOutcome: null });
    await plain.watchdog.triggerRepair();
    expect(plain.relaunchFailures("repair")).toHaveLength(1);
    expect(plain.relaunchFailures("repair")[0].details).toEqual({
      reason: "launchGatewayProcess returned no child",
    });
    plain.watchdog.stop();
  });
});

describe("createGatewayPrelaunchHookHandler (the lib/server.js composition)", () => {
  const fakeWatchdog = () => ({
    recordOperationEvent: vi.fn(),
    onPrelaunchHook: vi.fn(),
  });

  it("requires a watchdog with recordOperationEvent", () => {
    expect(() => createGatewayPrelaunchHookHandler()).toThrow(TypeError);
    expect(() => createGatewayPrelaunchHookHandler({ watchdog: {} })).toThrow(
      /watchdog is required/,
    );
  });

  it("'ran': ledger row only (kind prelaunch_hook, status ran) + onPrelaunchHook; no notification", () => {
    const watchdog = fakeWatchdog();
    const notify = vi.fn(async () => ({ ok: true }));
    const handler = createGatewayPrelaunchHookHandler({ watchdog, notify, nowFn: () => 5 * 3_600_000 });
    const outcome = ranOutcome();
    handler(outcome);
    expect(watchdog.recordOperationEvent).toHaveBeenCalledTimes(1);
    expect(watchdog.recordOperationEvent).toHaveBeenCalledWith({
      kind: "prelaunch_hook",
      status: "ran",
      details: {
        code: null,
        hookPath: "/opt/alphaclaw/hooks/pre-gateway-launch",
        site: "managed launch",
        durationMs: 40,
        exitCode: 0,
        signal: null,
        message: null,
      },
    });
    expect(notify).not.toHaveBeenCalled();
    expect(watchdog.onPrelaunchHook).toHaveBeenCalledWith(outcome);
  });

  it("'refused': ledger row + ONE important-class (untagged) notification with id prelaunch-hook-<code>-<site> + onPrelaunchHook", () => {
    const watchdog = fakeWatchdog();
    const notify = vi.fn(async () => ({ ok: true }));
    const handler = createGatewayPrelaunchHookHandler({ watchdog, notify, nowFn: () => 5 * 3_600_000 });
    const outcome = refusedOutcome();
    handler(outcome);

    expect(watchdog.recordOperationEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "prelaunch_hook",
        status: "refused",
        details: expect.objectContaining({
          code: "not_root_owned",
          site: "managed launch",
          message: "prelaunch hook must be owned by root (uid 1000)",
        }),
      }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
    const [message, opts] = notify.mock.calls[0];
    expect(message.split("\n")[0]).toBe("🐺 *AlphaClaw Watchdog*");
    expect(message).toContain("🔴 Gateway launch aborted by the prelaunch hook");
    expect(message).toContain("Reason: `not_root_owned`");
    expect(message).toContain("Site: managed launch");
    expect(message).toContain("Detail: prelaunch hook must be owned by root (uid 1000)");
    // Important class: NO verbose/audit tags — an aborted launch is never
    // filtered by "Important only" mode.
    expect(opts).toEqual({
      eventType: "prelaunch_hook",
      id: "prelaunch-hook-not_root_owned-managed-launch-5",
    });
    expect(watchdog.onPrelaunchHook).toHaveBeenCalledWith(outcome);
  });

  it("'failed': the id is keyed on code + site + hour bucket — a retry loop at one site dedupes, a fresh incident an hour later re-alerts", () => {
    const watchdog = fakeWatchdog();
    const notify = vi.fn(async () => ({ ok: true }));
    const handler = createGatewayPrelaunchHookHandler({ watchdog, notify, nowFn: () => 5 * 3_600_000 });
    handler(failedOutcome());
    handler(failedOutcome());
    handler(failedOutcome({ site: "light restart" }));
    expect(notify.mock.calls.map(([, opts]) => opts.id)).toEqual([
      "prelaunch-hook-nonzero_exit-restart-5",
      "prelaunch-hook-nonzero_exit-restart-5",
      "prelaunch-hook-nonzero_exit-light-restart-5",
    ]);
    expect(notify.mock.calls[0][0]).toContain("Reason: `nonzero_exit`");
    // A delivered outbox entry never revives on the same id, so without the
    // bucket every later independent failure at this site would be silenced.
    const later = createGatewayPrelaunchHookHandler({ watchdog, notify, nowFn: () => 6 * 3_600_000 + 1 });
    later(failedOutcome());
    expect(notify.mock.calls.at(-1)[1].id).toBe("prelaunch-hook-nonzero_exit-restart-6");
  });

  it("a rejecting or throwing notify is logged and never blocks the ledger row or the watchdog narration", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rejecting = fakeWatchdog();
    const rejectingHandler = createGatewayPrelaunchHookHandler({
      watchdog: rejecting,
      notify: vi.fn(async () => {
        throw new Error("telegram down");
      }),
    });
    expect(() => rejectingHandler(refusedOutcome())).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
    expect(rejecting.recordOperationEvent).toHaveBeenCalledTimes(1);
    expect(rejecting.onPrelaunchHook).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("prelaunch-hook notification failed: telegram down"),
    );

    const throwing = fakeWatchdog();
    const throwingHandler = createGatewayPrelaunchHookHandler({
      watchdog: throwing,
      notify: () => {
        throw new Error("sync boom");
      },
    });
    expect(() => throwingHandler(failedOutcome())).not.toThrow();
    expect(throwing.onPrelaunchHook).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("prelaunch-hook notification failed: sync boom"),
    );
  });

  it("works without a notifier (notify omitted) — ledger + narration only", () => {
    const watchdog = fakeWatchdog();
    const handler = createGatewayPrelaunchHookHandler({ watchdog });
    expect(() => handler(refusedOutcome())).not.toThrow();
    expect(watchdog.recordOperationEvent).toHaveBeenCalledTimes(1);
    expect(watchdog.onPrelaunchHook).toHaveBeenCalledTimes(1);
  });

  it("against a REAL watchdog: the operation row (eventType operation / source prelaunch_hook) and the degraded row both land, and getStatus() narrates the abort", () => {
    const { watchdog, insertWatchdogEvent } = createHarness();
    const notify = vi.fn(async () => ({ ok: true }));
    const handler = createGatewayPrelaunchHookHandler({ watchdog, notify, nowFn: () => 5 * 3_600_000 });
    handler(refusedOutcome());

    const rows = insertWatchdogEvent.mock.calls.map(([row]) => row);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "operation",
          source: "prelaunch_hook",
          status: "refused",
          details: expect.objectContaining({ code: "not_root_owned", site: "managed launch" }),
        }),
        expect.objectContaining({
          eventType: "health_check",
          source: "prelaunch_hook",
          status: "failed",
          details: expect.objectContaining({ reason: "prelaunch_hook_failed" }),
        }),
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(watchdog.getStatus()).toMatchObject({
      degradedReason: "prelaunch_hook_failed",
      prelaunchHook: expect.objectContaining({ status: "refused", code: "not_root_owned" }),
    });
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining("Gateway launch aborted by the prelaunch hook"),
      expect.objectContaining({
        id: expect.stringMatching(/^prelaunch-hook-not_root_owned-managed-launch-\d+$/),
      }),
    );
  });
});

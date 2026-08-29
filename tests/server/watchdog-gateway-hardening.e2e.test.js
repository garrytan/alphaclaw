const express = require("express");
const request = require("supertest");

const { createWatchdog } = require("../../lib/server/watchdog");
const { registerWatchdogRoutes } = require("../../lib/server/routes/watchdog");

// End-to-end coverage for the OpenClaw 2026.7.1+ gateway-lifecycle contract:
// exit code 78 (EX_CONFIG) fatal config errors, and control-plane-safe mode
// where /health stays green while /readyz reports suppressed channels. Uses
// the real watchdog wired into the real routes against a stateful fake
// gateway.

const flushMicrotasks = async () =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

const kOriginalAutoRepair = process.env.WATCHDOG_AUTO_REPAIR;
const kOriginalNotificationsDisabled =
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
const kOriginalFetch = global.fetch;

const createFakeGateway = () => ({
  healthy: true,
  suppressed: [],
});

const createStack = ({
  autoRepair = false,
  fakeGateway,
  configMedic = null,
  releaseChannelHooks = null,
  medicRunBudgetMs = undefined,
  medicLockWaitMs = undefined,
  gatewayLifecycleLock = null,
  readConfigMtimeMs = undefined,
} = {}) => {
  process.env.WATCHDOG_AUTO_REPAIR = autoRepair ? "true" : "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";

  const gateway = fakeGateway || createFakeGateway();

  global.fetch = vi.fn(async (url) => {
    if (!gateway.healthy) throw new Error("gateway unavailable");
    if (String(url).includes("/readyz")) {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            ready: true,
            failing: [],
            ...(gateway.suppressed.length > 0
              ? { suppressed: gateway.suppressed }
              : {}),
          }),
      };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, status: "live" }),
    };
  });

  const clawCmd = vi.fn(async (command) => {
    if (command.startsWith("gateway call channels.start")) {
      const paramsJson = command.replace(
        /^gateway call channels\.start --params '(.*)'$/,
        "$1",
      );
      const params = JSON.parse(paramsJson);
      gateway.suppressed = gateway.suppressed.filter(
        (channel) => channel !== params.channel,
      );
      return { ok: true, stdout: "{}" };
    }
    if (command === "doctor --fix --yes") {
      gateway.healthy = true;
      return { ok: true, stdout: "fixed" };
    }
    return { ok: true, stdout: "" };
  });

  const launchGatewayProcess = vi.fn(() => ({ pid: 4242 }));
  const insertWatchdogEvent = vi.fn();
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };

  const watchdog = createWatchdog({
    clawCmd,
    launchGatewayProcess,
    insertWatchdogEvent,
    notifier,
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "https://setup.example.com",
    resolveGatewayHealthUrl: () => "http://127.0.0.1:18789/health",
    resolveGatewayReadyzUrl: () => "http://127.0.0.1:18789/readyz",
    configMedic,
    ...(releaseChannelHooks ? { releaseChannelHooks } : {}),
    ...(medicRunBudgetMs === undefined ? {} : { medicRunBudgetMs }),
    ...(medicLockWaitMs === undefined ? {} : { medicLockWaitMs }),
    ...(gatewayLifecycleLock ? { gatewayLifecycleLock } : {}),
    ...(readConfigMtimeMs ? { readConfigMtimeMs } : {}),
  });

  const app = express();
  app.use(express.json());
  registerWatchdogRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    watchdog,
    watchdogNotifier: notifier,
    getRecentEvents: vi.fn(() => []),
    readLogTail: vi.fn(() => ""),
    watchdogTerminal: {},
  });

  return {
    app,
    watchdog,
    gateway,
    clawCmd,
    launchGatewayProcess,
    insertWatchdogEvent,
    notifier,
  };
};

describe("server/watchdog gateway hardening (e2e)", () => {
  afterEach(() => {
    if (kOriginalAutoRepair == null) {
      delete process.env.WATCHDOG_AUTO_REPAIR;
    } else {
      process.env.WATCHDOG_AUTO_REPAIR = kOriginalAutoRepair;
    }
    if (kOriginalNotificationsDisabled == null) {
      delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    } else {
      process.env.WATCHDOG_NOTIFICATIONS_DISABLED =
        kOriginalNotificationsDisabled;
    }
    if (kOriginalFetch == null) {
      delete global.fetch;
    } else {
      global.fetch = kOriginalFetch;
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("surfaces safe mode in the status API and recovers via resume-channels", async () => {
    const { app, watchdog, gateway, clawCmd } = createStack();
    gateway.suppressed = ["telegram", "discord"];

    watchdog.start();
    await flushMicrotasks();
    await flushMicrotasks();

    const statusRes = await request(app).get("/api/watchdog/status");
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toEqual(
      expect.objectContaining({
        lifecycle: "running",
        health: "healthy",
        safeMode: true,
        suppressedChannels: ["telegram", "discord"],
      }),
    );

    const resumeRes = await request(app).post("/api/watchdog/resume-channels");
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body.ok).toBe(true);
    expect(resumeRes.body.result.results).toEqual([
      { channel: "telegram", ok: true },
      { channel: "discord", ok: true },
    ]);
    expect(clawCmd).toHaveBeenCalledWith(
      `gateway call channels.start --params '{"channel":"telegram"}'`,
      { quiet: true },
    );
    expect(clawCmd).toHaveBeenCalledWith(
      `gateway call channels.start --params '{"channel":"discord"}'`,
      { quiet: true },
    );
    expect(gateway.suppressed).toEqual([]);

    const clearedRes = await request(app).get("/api/watchdog/status");
    expect(clearedRes.body.status).toEqual(
      expect.objectContaining({ safeMode: false, suppressedChannels: [] }),
    );

    const idempotentRes = await request(app).post(
      "/api/watchdog/resume-channels",
    );
    expect(idempotentRes.status).toBe(409);
    expect(idempotentRes.body.error).toBe("no_suppressed_channels");
    watchdog.stop();
  });

  it("reports configuration_error on exit 78 and recovers through manual repair", async () => {
    const { app, watchdog, gateway, clawCmd, launchGatewayProcess } =
      createStack({ autoRepair: false });
    gateway.healthy = false;

    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
    watchdog.onGatewayExit({
      code: 78,
      expectedExit: false,
      stderrTail: ["fatal configuration error"],
    });
    await flushMicrotasks();

    const statusRes = await request(app).get("/api/watchdog/status");
    expect(statusRes.body.status).toEqual(
      expect.objectContaining({
        lifecycle: "configuration_error",
        health: "unhealthy",
        crashCountInWindow: 0,
      }),
    );
    // The EX_CONFIG contract: no automatic relaunch without repair.
    expect(launchGatewayProcess).not.toHaveBeenCalled();

    const repairRes = await request(app).post("/api/watchdog/repair");
    expect(repairRes.status).toBe(200);
    expect(repairRes.body.ok).toBe(true);
    expect(clawCmd).toHaveBeenCalledWith("doctor --fix --yes", {
      quiet: true,
      timeoutMs: 600000,
    });
    expect(launchGatewayProcess).toHaveBeenCalledTimes(1);

    const recoveredRes = await request(app).get("/api/watchdog/status");
    expect(recoveredRes.body.status).toEqual(
      expect.objectContaining({ lifecycle: "running", health: "healthy" }),
    );
    watchdog.stop();
  });

  describe("EX_CONFIG latch auto-retry on config change (issue #21 bug 9)", () => {
    const latchWithExit78 = (stack) => {
      stack.gateway.healthy = false;
      stack.watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 1234 });
      stack.watchdog.onGatewayExit({
        code: 78,
        expectedExit: false,
        stderrTail: ["fatal configuration error"],
      });
    };

    it("clears the latch and relaunches exactly once per distinct openclaw.json change", async () => {
      const mtimeRef = { value: 100 };
      const stack = createStack({
        readConfigMtimeMs: () => mtimeRef.value,
      });
      latchWithExit78(stack);
      await flushMicrotasks();
      expect(stack.watchdog.getStatus().lifecycle).toBe(
        "configuration_error",
      );

      // Unchanged config: the latch stays inert.
      await stack.watchdog.runHealthCheck({ source: "health_timer" });
      expect(stack.launchGatewayProcess).not.toHaveBeenCalled();

      // The operator (or medic, or a boot restore) edits openclaw.json.
      mtimeRef.value = 200;
      stack.gateway.healthy = true;
      await stack.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(stack.launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(stack.watchdog.getStatus().lifecycle).toBe("restarting");

      // Same mtime again: no second relaunch for the same edit.
      await stack.watchdog.runHealthCheck({ source: "health_timer" });
      expect(stack.launchGatewayProcess).toHaveBeenCalledTimes(1);
      stack.watchdog.stop();
    });

    it("re-latches on a second exit 78 and stays inert until the config changes again", async () => {
      const mtimeRef = { value: 100 };
      const stack = createStack({
        readConfigMtimeMs: () => mtimeRef.value,
      });
      latchWithExit78(stack);
      await flushMicrotasks();

      mtimeRef.value = 200;
      await stack.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(stack.launchGatewayProcess).toHaveBeenCalledTimes(1);

      // The relaunched gateway exits 78 again: re-latched with the NEW
      // baseline — the same mtime can never retry twice.
      stack.watchdog.onGatewayExit({
        code: 78,
        expectedExit: false,
        stderrTail: ["fatal configuration error"],
      });
      await flushMicrotasks();
      expect(stack.watchdog.getStatus().lifecycle).toBe(
        "configuration_error",
      );
      await stack.watchdog.runHealthCheck({ source: "health_timer" });
      expect(stack.launchGatewayProcess).toHaveBeenCalledTimes(1);

      mtimeRef.value = 300;
      await stack.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(stack.launchGatewayProcess).toHaveBeenCalledTimes(2);
      stack.watchdog.stop();
    });

    it("does not auto-retry while openclaw.json is missing", async () => {
      const mtimeRef = { value: 100 };
      const stack = createStack({
        readConfigMtimeMs: () =>
          mtimeRef.value === null ? null : mtimeRef.value,
      });
      latchWithExit78(stack);
      await flushMicrotasks();

      // File deleted mid-repair: null reads as "unchanged".
      mtimeRef.value = null;
      await stack.watchdog.runHealthCheck({ source: "health_timer" });
      expect(stack.launchGatewayProcess).not.toHaveBeenCalled();

      // It reappears with a fresh mtime: one retry.
      mtimeRef.value = 500;
      await stack.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(stack.launchGatewayProcess).toHaveBeenCalledTimes(1);
      stack.watchdog.stop();
    });

    it("does not auto-retry while a medic run holds the operation flag", async () => {
      const mtimeRef = { value: 100 };
      let resolveMedic;
      const configMedic = {
        isEnabled: vi.fn(() => true),
        run: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveMedic = resolve;
            }),
        ),
      };
      const stack = createStack({
        configMedic,
        medicRunBudgetMs: 60_000,
        readConfigMtimeMs: () => mtimeRef.value,
      });
      latchWithExit78(stack);
      await flushMicrotasks();
      expect(configMedic.run).toHaveBeenCalledTimes(1);

      // Config changes while the medic is mid-run: the retry must not race
      // the medic's own relaunch.
      mtimeRef.value = 200;
      await stack.watchdog.runHealthCheck({ source: "health_timer" });
      expect(stack.launchGatewayProcess).not.toHaveBeenCalled();

      resolveMedic({ fixed: false, tier: "none", diagnosis: null });
      await flushMicrotasks();
      await flushMicrotasks();
      // Medic settled without a fix; the pending config change now retries.
      await stack.watchdog.runHealthCheck({ source: "health_timer" });
      await flushMicrotasks();
      expect(stack.launchGatewayProcess).toHaveBeenCalledTimes(1);
      stack.watchdog.stop();
    });
  });

  describe("startup medic on exit 78", () => {
    const kStripeStderr = [
      'gateway.controlUi: Unrecognized key: "environment"',
    ];

    const createMedicMock = ({ fixed, diagnosis = null, enabled = true } = {}) => ({
      isEnabled: vi.fn(() => enabled),
      run: vi.fn(async () =>
        fixed
          ? {
              fixed: true,
              tier: "managed_key",
              actions: ["removed gateway.controlUi.environment"],
              backup: "openclaw.json.medic-x.bak",
            }
          : { fixed: false, tier: "ai", diagnosis },
      ),
    });

    it("repairs, notifies recovery, and relaunches instead of latching", async () => {
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog, launchGatewayProcess, notifier, insertWatchdogEvent } =
        createStack({ configMedic });

      watchdog.onGatewayExit({
        code: 78,
        expectedExit: false,
        stderrTail: kStripeStderr,
      });
      await flushMicrotasks();
      await flushMicrotasks();

      expect(configMedic.run).toHaveBeenCalledWith(
        expect.objectContaining({
          exitCode: 78,
          stderrTail: kStripeStderr,
          allowDoctorFix: true,
          attempt: 1,
        }),
      );
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      const messages = notifier.notify.mock.calls.map((call) => call[0]);
      expect(messages.some((m) => m.includes("auto-repaired"))).toBe(true);
      expect(
        messages.some((m) => m.includes("restart is paused")),
      ).toBe(false);
      expect(
        insertWatchdogEvent.mock.calls.some(
          (call) => call[0].eventType === "medic" && call[0].status === "ok",
        ),
      ).toBe(true);
      expect(watchdog.getStatus().lifecycle).toBe("restarting");
      watchdog.stop();
    });

    it("latches with the AI diagnosis when the medic cannot fix", async () => {
      const configMedic = createMedicMock({
        fixed: false,
        diagnosis: "gateway.port expects a number; fix it by hand.",
      });
      const { watchdog, launchGatewayProcess, notifier } = createStack({
        configMedic,
      });

      watchdog.onGatewayExit({
        code: 78,
        expectedExit: false,
        stderrTail: ["gateway.port: Invalid input"],
      });
      await flushMicrotasks();
      await flushMicrotasks();

      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
      const messages = notifier.notify.mock.calls.map((call) => call[0]);
      const latchMessage = messages.find((m) => m.includes("restart is paused"));
      expect(latchMessage).toBeTruthy();
      expect(latchMessage).toContain(
        "Model-suggested diagnosis (unverified): gateway.port expects a number",
      );
      watchdog.stop();
    });

    it("strips links from the model diagnosis before it rides a notification", async () => {
      const configMedic = {
        isEnabled: () => true,
        run: vi.fn(async () => ({
          fixed: false,
          tier: "ai",
          diagnosis:
            "Fix it at [this dashboard](https://evil.example/steal) or https://evil.example/paste-your-token",
        })),
      };
      const { watchdog, notifier } = createStack({ configMedic });

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();

      const messages = notifier.notify.mock.calls.map((call) => call[0]);
      const latchMessage = messages.find((m) => m.includes("restart is paused"));
      expect(latchMessage).toContain("Model-suggested diagnosis (unverified):");
      expect(latchMessage).not.toContain("evil.example");
      expect(latchMessage).toContain("[link removed]");
      watchdog.stop();
    });

    it("caps medic attempts per incident, then latches the legacy way", async () => {
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog, launchGatewayProcess, notifier } = createStack({
        configMedic,
      });

      // Fix → relaunch → exit 78 again → fix → relaunch → exit 78 again:
      // the third exit must latch without a third medic run.
      for (let i = 0; i < 3; i += 1) {
        watchdog.onGatewayExit({
          code: 78,
          expectedExit: false,
          stderrTail: kStripeStderr,
        });
        // eslint-disable-next-line no-await-in-loop
        await flushMicrotasks();
        // eslint-disable-next-line no-await-in-loop
        await flushMicrotasks();
      }

      expect(configMedic.run).toHaveBeenCalledTimes(2);
      expect(configMedic.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ attempt: 2 }),
      );
      expect(launchGatewayProcess).toHaveBeenCalledTimes(2);
      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
      const messages = notifier.notify.mock.calls.map((call) => call[0]);
      expect(messages.some((m) => m.includes("restart is paused"))).toBe(true);
      watchdog.stop();
    });

    it("resets the attempt budget once the gateway really launches", async () => {
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog } = createStack({ configMedic });

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();
      watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 99 });

      // A later, unrelated incident gets a fresh attempt 1.
      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();
      expect(configMedic.run).toHaveBeenLastCalledWith(
        expect.objectContaining({ attempt: 1 }),
      );
      watchdog.stop();
    });

    it("latches when the medic overruns its run budget instead of holding the lock", async () => {
      const configMedic = {
        isEnabled: () => true,
        run: vi.fn(() => new Promise(() => {})), // never resolves
      };
      const { watchdog, launchGatewayProcess, notifier } = createStack({
        configMedic,
        medicRunBudgetMs: 40,
      });

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
      const messages = notifier.notify.mock.calls.map((call) => call[0]);
      expect(messages.some((m) => m.includes("restart is paused"))).toBe(true);
      watchdog.stop();
    });

    it("fails doctor gating CLOSED when the channel state cannot be read", async () => {
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog } = createStack({
        configMedic,
        releaseChannelHooks: {
          getInfo: vi.fn(() => {
            throw new Error("state file torn");
          }),
          requestRollback: vi.fn(),
        },
      });

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();

      // An unreadable channel state could hide a live stabilization window —
      // unattended doctor --fix must not be offered (openclaw#107226).
      expect(configMedic.run).toHaveBeenCalledWith(
        expect.objectContaining({ allowDoctorFix: false }),
      );
      watchdog.stop();
    });

    // Load-bearing invariant for the backup quiesce (issues #11/#18): a
    // gateway exit during a managed operation schedules a relaunch 10s later
    // (watchdog.js onGatewayExit), and ONLY a held lifecycle lock blocks it.
    // The quiesce deliberately stops the gateway while holding that lock —
    // if someone "simplifies" restartAfterCrash's tryAcquire gate, the
    // watchdog would relaunch the gateway mid-backup and resurrect the
    // vanished-file race this whole design exists to kill.
    it("holds the 10s managed-operation relaunch while the lifecycle lock is held elsewhere", async () => {
      vi.useFakeTimers();
      try {
        const {
          createGatewayLifecycleLock,
        } = require("../../lib/server/gateway-lifecycle-lock");
        const lock = createGatewayLifecycleLock();
        const releaseQuiesce = lock.tryAcquire("backup_quiesce");
        const { watchdog, launchGatewayProcess } = createStack({
          gatewayLifecycleLock: lock,
        });

        watchdog.beginManagedOperation();
        watchdog.onGatewayExit({ code: 143, expectedExit: false, stderrTail: [] });
        await vi.advanceTimersByTimeAsync(11_000);
        // Lock held (the backup is running against a quiesced state dir):
        // the relaunch is skipped, not queued.
        expect(launchGatewayProcess).not.toHaveBeenCalled();

        // Lock released, next managed-operation exit relaunches on schedule.
        releaseQuiesce();
        watchdog.onGatewayExit({ code: 143, expectedExit: false, stderrTail: [] });
        await vi.advanceTimersByTimeAsync(11_000);
        expect(launchGatewayProcess).toHaveBeenCalled();
        watchdog.stop();
      } finally {
        vi.useRealTimers();
      }
    });

    // Issue #20: a lock-held exit-78 used to SKIP the medic outright — the
    // boot sequence holds the lock exactly when a bad migration crashes the
    // gateway, so the medic never ran and the box crash-looped. The medic now
    // queues behind a transient holder for a bounded window.
    it("queues behind a transient lifecycle holder and runs once it releases", async () => {
      const {
        createGatewayLifecycleLock,
      } = require("../../lib/server/gateway-lifecycle-lock");
      const lock = createGatewayLifecycleLock();
      const releaseBoot = lock.tryAcquire("boot");
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog, gateway, launchGatewayProcess } = createStack({
        configMedic,
        gatewayLifecycleLock: lock,
      });
      // The gateway just exited 78 — it is down for the whole queue wait
      // (otherwise the post-acquire liveness re-check reads it as superseded).
      gateway.healthy = false;

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();
      // Still queued — the holder owns the gateway.
      expect(configMedic.run).not.toHaveBeenCalled();
      expect(launchGatewayProcess).not.toHaveBeenCalled();

      // The transient holder (boot) releases → the queued medic runs with a
      // real attempt and relaunches, then releases the lock.
      releaseBoot();
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();
      expect(configMedic.run).toHaveBeenCalledTimes(1);
      expect(configMedic.run).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1 }),
      );
      expect(launchGatewayProcess).toHaveBeenCalledTimes(1);
      expect(lock.tryAcquire("test")).toBeTruthy(); // released after the run
      watchdog.stop();
    });

    it("latches without burning an attempt when the holder never releases within the wait window", async () => {
      const {
        createGatewayLifecycleLock,
      } = require("../../lib/server/gateway-lifecycle-lock");
      const lock = createGatewayLifecycleLock();
      const releaseApply = lock.tryAcquire("apply"); // held for the whole test
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog, launchGatewayProcess, notifier } = createStack({
        configMedic,
        gatewayLifecycleLock: lock,
        medicLockWaitMs: 20,
      });

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await new Promise((resolve) => setTimeout(resolve, 80));
      await flushMicrotasks();

      expect(configMedic.run).not.toHaveBeenCalled();
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
      const messages = notifier.notify.mock.calls.map((call) => call[0]);
      expect(messages.some((m) => m.includes("restart is paused"))).toBe(true);

      // The skip refunded the attempt: with the lock free again, the next
      // exit-78 still gets a real attempt 1 (and releases the lock after).
      releaseApply();
      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();
      expect(configMedic.run).toHaveBeenCalledTimes(1);
      expect(configMedic.run).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1 }),
      );
      expect(lock.tryAcquire("test")).toBeTruthy(); // released after the run
      watchdog.stop();
    });

    it("self-releases a late-acquired lock after the wait window expired", async () => {
      const {
        createGatewayLifecycleLock,
      } = require("../../lib/server/gateway-lifecycle-lock");
      const lock = createGatewayLifecycleLock();
      const releaseApply = lock.tryAcquire("apply");
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog } = createStack({
        configMedic,
        gatewayLifecycleLock: lock,
        medicLockWaitMs: 20,
      });

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      // The wait window expires with the holder still live → latch, refund.
      await new Promise((resolve) => setTimeout(resolve, 60));
      await flushMicrotasks();
      expect(configMedic.run).not.toHaveBeenCalled();
      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");

      // The holder releases AFTER the window: the queued acquire resolves
      // late and must self-release — never strand the lock.
      releaseApply();
      await flushMicrotasks();
      await flushMicrotasks();
      const probe = lock.tryAcquire("probe");
      expect(probe).toBeTruthy();
      probe();

      // The timed-out skip refunded the attempt: the next exit-78 still gets
      // a real attempt 1.
      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();
      expect(configMedic.run).toHaveBeenCalledTimes(1);
      expect(configMedic.run).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1 }),
      );
      watchdog.stop();
    });

    it("skips a queued medic as superseded when the prior holder already relaunched the gateway", async () => {
      const {
        createGatewayLifecycleLock,
      } = require("../../lib/server/gateway-lifecycle-lock");
      const lock = createGatewayLifecycleLock();
      const releaseBoot = lock.tryAcquire("boot");
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog, gateway, launchGatewayProcess, insertWatchdogEvent } =
        createStack({
          configMedic,
          gatewayLifecycleLock: lock,
        });
      gateway.healthy = false;

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      expect(configMedic.run).not.toHaveBeenCalled();

      // The holder repairs the config and relaunches before releasing: the
      // queued medic's exit-78 observation is now stale.
      gateway.healthy = true;
      releaseBoot();
      await flushMicrotasks();
      await flushMicrotasks();
      await flushMicrotasks();

      // Superseded: no medic run, no config mutation, no competing relaunch —
      // and the lock is released, not stranded.
      expect(configMedic.run).not.toHaveBeenCalled();
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(
        insertWatchdogEvent.mock.calls.some(
          (call) =>
            call[0].eventType === "medic" &&
            call[0].status === "skipped" &&
            (call[0].details || {}).reason === "medic_superseded",
        ),
      ).toBe(true);
      const probe = lock.tryAcquire("probe");
      expect(probe).toBeTruthy();
      probe();

      // The superseded skip did not burn the attempt: a later real incident
      // (gateway down again, lock free) still gets attempt 1.
      gateway.healthy = false;
      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();
      expect(configMedic.run).toHaveBeenCalledTimes(1);
      expect(configMedic.run).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1 }),
      );
      watchdog.stop();
    });

    it("re-latches when the post-fix relaunch fails", async () => {
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog, launchGatewayProcess, notifier } = createStack({
        configMedic,
      });
      launchGatewayProcess.mockImplementation(() => {
        throw new Error("spawn ENOENT");
      });

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: kStripeStderr });
      await flushMicrotasks();
      await flushMicrotasks();

      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
      const messages = notifier.notify.mock.calls.map((call) => call[0]);
      expect(messages.some((m) => m.includes("restart is paused"))).toBe(true);
      watchdog.stop();
    });

    it("allows doctor --fix when channel state is readable and outside a stabilization window", async () => {
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog } = createStack({
        configMedic,
        releaseChannelHooks: {
          getInfo: vi.fn(() => ({ isPin: true, inStabilizationWindow: false })),
          requestRollback: vi.fn(),
        },
      });

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();

      expect(configMedic.run).toHaveBeenCalledWith(
        expect.objectContaining({ allowDoctorFix: true }),
      );
      watchdog.stop();
    });

    it("rate-limits medic runs across incidents (listen-then-die flapping)", async () => {
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog, notifier } = createStack({ configMedic });

      // Five full incident cycles: exit-78 → medic run → gateway reaches
      // "listening" (resets the per-incident attempt budget).
      for (let i = 0; i < 5; i += 1) {
        watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
        // eslint-disable-next-line no-await-in-loop
        await flushMicrotasks();
        // eslint-disable-next-line no-await-in-loop
        await flushMicrotasks();
        watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 100 + i });
      }
      expect(configMedic.run).toHaveBeenCalledTimes(5);

      // The 6th incident inside the window latches without a medic run.
      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();
      expect(configMedic.run).toHaveBeenCalledTimes(5);
      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
      const messages = notifier.notify.mock.calls.map((call) => call[0]);
      expect(messages.some((m) => m.includes("restart is paused"))).toBe(true);
      watchdog.stop();
    });

    it("skips the relaunch and latches when the lease expired during the fix", async () => {
      // Only Date is faked: the medic's own async flow keeps real timers, but
      // the lease check reads Date.now().
      vi.useFakeTimers({ toFake: ["Date"] });
      const configMedic = {
        isEnabled: () => true,
        run: vi.fn(async () => {
          vi.setSystemTime(Date.now() + 11 * 60 * 1000); // past the 10-min lease
          return { fixed: true, tier: "managed_key", actions: ["removed x"] };
        }),
      };
      const { watchdog, launchGatewayProcess, notifier } = createStack({
        configMedic,
      });

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();

      // The lock may have been force-released to another operation — a launch
      // here would race it. Latch instead.
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
      const messages = notifier.notify.mock.calls.map((call) => call[0]);
      expect(messages.some((m) => m.includes("restart is paused"))).toBe(true);
      expect(messages.some((m) => m.includes("Restarting the gateway"))).toBe(false);
      vi.useRealTimers();
      watchdog.stop();
    });

    it("re-arms the medic after the rate-limit window expires", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog } = createStack({ configMedic });

      for (let i = 0; i < 5; i += 1) {
        watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
        // eslint-disable-next-line no-await-in-loop
        await flushMicrotasks();
        // eslint-disable-next-line no-await-in-loop
        await flushMicrotasks();
        watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 200 + i });
      }
      expect(configMedic.run).toHaveBeenCalledTimes(5);

      // An hour later the window has drained — the medic runs again.
      vi.setSystemTime(Date.now() + 61 * 60 * 1000);
      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();
      expect(configMedic.run).toHaveBeenCalledTimes(6);
      vi.useRealTimers();
      watchdog.stop();
    });

    it("denies doctor --fix when rollback was eligible but went unhandled (stabilization window)", async () => {
      const configMedic = createMedicMock({ fixed: true });
      const { watchdog } = createStack({
        configMedic,
        releaseChannelHooks: {
          // Eligible: non-pin build inside its stabilization window...
          getInfo: vi.fn(() => ({ isPin: false, inStabilizationWindow: true })),
          // ...but the rollback request goes unhandled (state race).
          requestRollback: vi.fn(() => null),
        },
      });

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();

      // openclaw#107226: unattended doctor --fix must not mutate state under
      // a build we may be about to abandon.
      expect(configMedic.run).toHaveBeenCalledWith(
        expect.objectContaining({ allowDoctorFix: false }),
      );
      watchdog.stop();
    });

    it("latches with a medic event when configMedic.run rejects", async () => {
      const configMedic = {
        isEnabled: () => true,
        run: vi.fn(async () => {
          throw new Error("medic exploded");
        }),
      };
      const { watchdog, launchGatewayProcess, notifier, insertWatchdogEvent } =
        createStack({ configMedic });

      watchdog.onGatewayExit({ code: 78, expectedExit: false, stderrTail: [] });
      await flushMicrotasks();
      await flushMicrotasks();

      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
      expect(
        insertWatchdogEvent.mock.calls.some(
          (call) =>
            call[0].eventType === "medic" &&
            call[0].status === "failed" &&
            JSON.stringify(call[0].details || {}).includes("medic exploded"),
        ),
      ).toBe(true);
      const messages = notifier.notify.mock.calls.map((call) => call[0]);
      expect(messages.some((m) => m.includes("restart is paused"))).toBe(true);
      watchdog.stop();
    });

    it("keeps the legacy latch when the medic is disabled", async () => {
      const configMedic = createMedicMock({ fixed: true, enabled: false });
      const { watchdog, launchGatewayProcess, notifier } = createStack({
        configMedic,
      });

      watchdog.onGatewayExit({
        code: 78,
        expectedExit: false,
        stderrTail: kStripeStderr,
      });
      await flushMicrotasks();

      expect(configMedic.run).not.toHaveBeenCalled();
      expect(launchGatewayProcess).not.toHaveBeenCalled();
      expect(watchdog.getStatus().lifecycle).toBe("configuration_error");
      const messages = notifier.notify.mock.calls.map((call) => call[0]);
      expect(messages.some((m) => m.includes("restart is paused"))).toBe(true);
      watchdog.stop();
    });
  });
});

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
      expect(latchMessage).toContain("AI diagnosis: gateway.port expects a number");
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

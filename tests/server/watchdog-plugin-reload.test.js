const { createWatchdog } = require("../../lib/server/watchdog");

// GST-3345: OpenClaw 2026.11.4 keeps /readyz at 503 failing:["plugin-reload"]
// with pluginReload.phase "failed" after a hot reload whose plugin service
// start ran past its 5 s limit, until a later reload or a restart. The bodies
// below are the pinned gateway's (tests/live/plugin-reload-failure.e2e.test.js
// captures them live).
const kReadyzUrl = "http://127.0.0.1:18789/readyz";
const kHealthUrl = "http://127.0.0.1:18789/health";
const readyzBody = (phase) =>
  phase === "ready"
    ? { ready: true, coreReady: true, failing: [] }
    : {
        ready: false,
        coreReady: false,
        failing: ["plugin-reload"],
        pluginReload: {
          phase,
          pluginIds: ["ghome"],
          ...(phase === "failed"
            ? { reason: "Plugin activation or recovery failed. Retry openclaw plugins reload <id> after admitted work settles, or restart the Gateway." }
            : {}),
        },
      };

const kOriginalEnv = {
  WATCHDOG_AUTO_REPAIR: process.env.WATCHDOG_AUTO_REPAIR,
  WATCHDOG_NOTIFICATIONS_DISABLED: process.env.WATCHDOG_NOTIFICATIONS_DISABLED,
  WATCHDOG_NOTIFICATIONS_QUIET: process.env.WATCHDOG_NOTIFICATIONS_QUIET,
};
const kOriginalFetch = global.fetch;

const createHarness = ({ autoRepair = true, phase = "failed", fingerprint = "cfg-a" } = {}) => {
  process.env.WATCHDOG_AUTO_REPAIR = autoRepair ? "true" : "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
  delete process.env.WATCHDOG_NOTIFICATIONS_QUIET;
  const gateway = { phase, fingerprint };
  global.fetch = vi.fn(async (url) => {
    if (String(url).includes("/readyz")) {
      const body = readyzBody(gateway.phase);
      return { ok: body.ready, status: body.ready ? 200 : 503, text: async () => JSON.stringify(body) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, status: "live" }) };
  });
  const insertWatchdogEvent = vi.fn();
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  let watchdog = null;
  let launches = 0;
  const restartGatewayColdStart = vi.fn(async () => {
    launches += 1;
    watchdog.onGatewayLaunch({ startedAt: Date.now(), pid: 5000 + launches, rootPid: 5000 + launches, generation: 1 + launches });
    gateway.phase = gateway.phaseAfterRestart ?? "ready";
    return { ok: true };
  });
  watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true, stdout: JSON.stringify({ ok: true }) })),
    launchGatewayProcess: vi.fn(() => ({ pid: 4242 })),
    insertWatchdogEvent,
    notifier,
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "https://setup.example.com",
    resolveGatewayHealthUrl: () => kHealthUrl,
    resolveGatewayReadyzUrl: () => kReadyzUrl,
    sleepImpl: () => Promise.resolve(),
    supervisorModeActive: () => false,
    readProcStartTicks: () => null,
    pidAlive: () => false,
    resolvePidVerdict: () => "unknown",
    restartGatewayColdStart,
    readOpenclawConfigFingerprint: () => gateway.fingerprint,
  });
  const repairRows = () =>
    insertWatchdogEvent.mock.calls
      .map(([event]) => event)
      .filter((event) => event.eventType === "repair" && event.details?.trigger === "plugin_reload_failed");
  const notices = () => notifier.notify.mock.calls.map(([message]) => String(message));
  return { watchdog, gateway, restartGatewayColdStart, insertWatchdogEvent, notifier, repairRows, notices };
};

const boot = async (harness) => {
  harness.watchdog.start();
  harness.watchdog.onGatewayLaunch({ startedAt: Date.now() - 60_000, pid: 4242, rootPid: 4242, generation: 1 });
  await vi.advanceTimersByTimeAsync(10);
};

describe("watchdog: failed plugin hot reload (GST-3345)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    for (const [key, value] of Object.entries(kOriginalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    global.fetch = kOriginalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("restarts the gateway once through the ladder after the failure holds for 30 s, then reports recovery", async () => {
    const h = createHarness();
    await boot(h);
    expect(h.watchdog.getStatus()).toMatchObject({ readiness: "not_ready", health: "degraded", lifecycle: "running" });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.restartGatewayColdStart).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(40_000);
    expect(h.restartGatewayColdStart).toHaveBeenCalledTimes(1);
    expect(h.restartGatewayColdStart).toHaveBeenCalledWith({
      shouldAbort: expect.any(Function),
      opId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      source: "watchdog",
      reason: "plugin_reload_failed",
    });
    const started = h.repairRows().find((row) => row.status === "started");
    expect(started).toMatchObject({ source: "watchdog", details: { pluginIds: ["ghome"] } });
    expect(started.details.failedForMs).toBeGreaterThanOrEqual(30_000);
    expect(h.repairRows().map((row) => row.status)).toEqual(["started", "ok"]);
    expect(h.notices().some((text) => text.includes("Restarting gateway: a plugin reload failed") && text.includes("`ghome`"))).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.watchdog.getStatus()).toMatchObject({ readiness: "ready", health: "healthy", lifecycle: "running" });
    expect(h.notices().some((text) => text.includes("Gateway running again") && text.includes("Recovered after automatic repair."))).toBe(true);
    expect(h.restartGatewayColdStart).toHaveBeenCalledTimes(1);
    h.watchdog.stop();
  });

  it("never restarts while a reload is still in progress (reloading, recovering)", async () => {
    const h = createHarness({ phase: "reloading" });
    await boot(h);
    await vi.advanceTimersByTimeAsync(90_000);
    h.gateway.phase = "recovering";
    await vi.advanceTimersByTimeAsync(90_000);
    expect(h.watchdog.getStatus().readiness).toBe("not_ready");
    expect(h.restartGatewayColdStart).not.toHaveBeenCalled();
    expect(h.repairRows()).toEqual([]);
    h.watchdog.stop();
  });

  it("a reload that recovers inside the window does not restart, and a later failure starts a fresh window", async () => {
    const h = createHarness();
    const advanceUntilReadiness = async (readiness) => {
      for (let i = 0; i < 300 && h.watchdog.getStatus().readiness !== readiness; i += 1) {
        await vi.advanceTimersByTimeAsync(1_000);
      }
      expect(h.watchdog.getStatus().readiness).toBe(readiness);
    };
    await boot(h);
    await vi.advanceTimersByTimeAsync(12_000);
    h.gateway.phase = "ready";
    await advanceUntilReadiness("ready");
    expect(h.restartGatewayColdStart).not.toHaveBeenCalled();

    h.gateway.phase = "failed";
    await advanceUntilReadiness("not_ready");
    await vi.advanceTimersByTimeAsync(25_000);
    expect(h.restartGatewayColdStart).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.restartGatewayColdStart).toHaveBeenCalledTimes(1);
    h.watchdog.stop();
  });

  it("restarts at most once per config: a repeat failure on the same config notifies the owner once, a changed config may restart again", async () => {
    const h = createHarness();
    h.gateway.phaseAfterRestart = "failed";
    await boot(h);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.restartGatewayColdStart).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.restartGatewayColdStart).toHaveBeenCalledTimes(1);
    const capNotices = h.notices().filter((text) => text.includes("A plugin reload failed again"));
    expect(capNotices).toHaveLength(1);
    expect(capNotices[0]).toContain("will not restart it again until the config changes");
    expect(h.repairRows().filter((row) => row.status === "skipped")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ reason: "already_restarted_for_config" }) }),
    ]);

    h.gateway.fingerprint = "cfg-b";
    h.gateway.phaseAfterRestart = "ready";
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.restartGatewayColdStart).toHaveBeenCalledTimes(2);
    expect(h.notices().filter((text) => text.includes("A plugin reload failed again"))).toHaveLength(1);
    h.watchdog.stop();
  });

  it("turning auto-repair off while the restart notice is being sent stops the restart", async () => {
    const h = createHarness();
    let releaseNotice = null;
    h.notifier.notify.mockImplementation((message) =>
      String(message).includes("Restarting gateway: a plugin reload failed")
        ? new Promise((resolve) => {
            releaseNotice = () => resolve({ ok: true });
          })
        : Promise.resolve({ ok: true }),
    );
    await boot(h);
    for (let i = 0; i < 120 && !releaseNotice; i += 1) await vi.advanceTimersByTimeAsync(1_000);
    expect(releaseNotice).toEqual(expect.any(Function));
    process.env.WATCHDOG_AUTO_REPAIR = "false";
    expect(h.watchdog.updateSettings({ autoRepair: false })).toMatchObject({ autoRepair: false });
    releaseNotice();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.restartGatewayColdStart).not.toHaveBeenCalled();
    expect(h.repairRows().map((row) => [row.status, row.details?.reason ?? null])).toEqual([
      ["started", null],
      ["skipped", "auto_repair_disabled"],
    ]);
    h.watchdog.stop();
  });

  it("with auto-repair off it records the skip once and does not restart", async () => {
    const h = createHarness({ autoRepair: false });
    await boot(h);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.restartGatewayColdStart).not.toHaveBeenCalled();
    expect(h.repairRows()).toEqual([
      expect.objectContaining({ status: "skipped", details: expect.objectContaining({ reason: "auto_repair_disabled" }) }),
    ]);
    h.watchdog.stop();
  });
});

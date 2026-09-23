const fs = require("fs");
const os = require("os");
const path = require("path");
const { createWatchdog } = require("../../lib/server/watchdog");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");
const { createUpgradeOverseer } = require("../../lib/server/upgrade-overseer");
const { createRunLedger } = require("../../lib/server/openclaw-run-ledger");

const kStartMs = 1_700_000_000_000;
const kMinute = 60_000;
const kMb = 1024 * 1024;
const kOperationId = "aaaaaaaa-0000-4000-8000-000000000102";

describe("issue #102 runtime safety (e2e)", () => {
  let root;
  let watchdog;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(kStartMs);
    vi.stubEnv("WATCHDOG_AUTO_REPAIR", "true");
    vi.stubEnv("WATCHDOG_NOTIFICATIONS_DISABLED", "false");
    vi.stubEnv("WATCHDOG_NOTIFICATIONS_QUIET", "true");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-runtime-safety-"));
  });

  afterEach(() => {
    watchdog?.stop();
    watchdog = null;
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const createStack = ({ maxRestartsPerDay = 2, restarts = [], onNotify, pidAlive, discoverServingIdentity } = {}) => {
    const processState = { pid: 400000001, alive: true, healthy: true, rssMb: 410 };
    const lock = createGatewayLifecycleLock();
    const events = [];
    const notifier = { notify: vi.fn(async (message, opts) => {
      onNotify?.(message, opts);
      return { ok: true };
    }) };
    const doctor = vi.fn(async () => {
      if (processState.alive) {
        return { ok: false, stderr: "StateDatabaseCoordinatorContentionError: another OpenClaw process owns gateway-lifecycle" };
      }
      return { ok: false, stderr: "unrelated config repair failure" };
    });
    const restart = vi.fn(async () => ({ ok: true }));
    const statePath = path.join(root, "memory-mitigation-state.json");
    fs.writeFileSync(statePath, JSON.stringify({ restarts }));
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (!processState.healthy) throw new Error("gateway health timed out");
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, ready: true }) };
    }));
    const settings = { enabled: true, autoRestart: true, effectiveAutoRestart: true, budgetMb: 400, maxRestartsPerDay };
    watchdog = createWatchdog({
      clawCmd: doctor,
      launchGatewayProcess: vi.fn(),
      requestGatewayLaunch: async () => processState.alive
        ? { outcome: "incumbent_present", pid: processState.pid,
            serving: { rootPid: processState.pid, workerPid: processState.pid } }
        : { outcome: "launch_aborted" },
      notifier,
      gatewayLifecycleLock: lock,
      pidAlive: pidAlive || (() => processState.alive),
      discoverServingIdentity,
      readProcStartTicks: () => "101",
      readEnvFile: () => [],
      insertWatchdogEvent: (event) => events.push(event),
      resolveSetupUrl: () => "http://localhost:3000",
      resolveGatewayHealthUrl: () => "http://localhost:18789/health",
      resolveGatewayReadyzUrl: () => "http://localhost:18789/readyz",
      readMemorySettings: () => settings,
      readMemorySample: () => ({ rssBytes: processState.rssMb * kMb }),
      memoryMonitorConfig: { startupGraceMs: 0, fastPathConfirmEvals: 2 },
      memoryMitigationStatePath: statePath,
      restartGatewayForMitigation: restart,
      degradedRepairThreshold: 2,
    });
    watchdog.onGatewayLaunch({ pid: processState.pid, startedAt: Date.now(), startTicks: "101" });
    return { processState, lock, events, notifier, doctor, restart, settings };
  };

  const driveMemory = async (stack, from, ticks) => {
    for (let i = from; i < from + ticks; i += 1) {
      vi.setSystemTime(kStartMs + i * kMinute);
      stack.processState.rssMb = 410 + i * 5;
      await watchdog.checkMemoryTrend();
    }
  };

  it("alerts within five minutes of a sustained over-cap brake and records it once over 82 minutes", async () => {
    const stack = createStack({ restarts: [kStartMs - 12 * 60 * kMinute, kStartMs - 6 * 60 * kMinute] });
    await driveMemory(stack, 0, 5);
    const brakeNotices = () => stack.notifier.notify.mock.calls.filter(([message]) => message.includes("auto-restart brake engaged"));
    expect(brakeNotices()).toHaveLength(1);
    expect(brakeNotices()[0][1]).toMatchObject({ eventType: "memory", verbose: false });
    await driveMemory(stack, 5, 77);
    expect(brakeNotices()).toHaveLength(1);
    expect(stack.events.filter((event) => event.details?.reason === "rate_brake")).toHaveLength(1);
    expect(brakeNotices()[0][0]).toContain("Group RSS:");
    expect(stack.restart).not.toHaveBeenCalled();
    expect(watchdog.getStatus().crashCountInWindow).toBe(0);

    watchdog.onGatewayLaunch({ pid: ++stack.processState.pid, startedAt: Date.now(), startTicks: "102" });
    await driveMemory(stack, 82, 5);
    expect(brakeNotices()).toHaveLength(2);
  });

  it("announces the brake immediately if the operator lowers the budget during the restart notice", async () => {
    const stack = createStack({
      maxRestartsPerDay: 4,
      restarts: [kStartMs - 4 * 60 * kMinute],
      onNotify: (message) => {
        if (message.includes("Restarting gateway before")) stack.settings.maxRestartsPerDay = 1;
      },
    });
    for (let i = 0; i < 5; i += 1) {
      await driveMemory(stack, i, 1);
      if (stack.events.some((event) => event.details?.recheck)) break;
    }
    expect(stack.events.some((event) => event.details?.recheck)).toBe(true);
    expect(stack.notifier.notify.mock.calls.filter(([message]) => message.includes("auto-restart brake engaged"))).toHaveLength(1);
    expect(stack.restart).not.toHaveBeenCalled();
    expect(JSON.parse(fs.readFileSync(path.join(root, "memory-mitigation-state.json"))).restarts).toHaveLength(1);
    expect(stack.lock.getActiveOperation()).toBeNull();
  });

  it("health_timer skips live Doctor while retaining the verified replacement failure brake", async () => {
    const stack = createStack();
    stack.restart.mockImplementation(async () => {
      const error = new Error("incumbent gateway still running");
      error.incumbent = true;
      error.reason = "incumbent_gateway_still_running";
      throw error;
    });
    await watchdog.runHealthCheck({ source: "health_timer" });
    stack.processState.healthy = false;
    vi.setSystemTime(kStartMs + 20 * kMinute);
    for (let i = 0; i < 6; i += 1) {
      await watchdog.runHealthCheck({ source: "health_timer" });
    }
    expect(stack.doctor).not.toHaveBeenCalled();
    expect(stack.events.filter((event) => event.eventType === "repair" && event.details?.reason === "gateway_running")).toHaveLength(1);
    expect(stack.restart).toHaveBeenCalledTimes(1);
    expect(watchdog.getStatus()).toMatchObject({ repairAttempts: 1, awaitingAutoRepairRecovery: true });
    expect(stack.lock.getActiveOperation()).toBeNull();
    stack.processState.alive = false;
    await watchdog.runHealthCheck({ source: "health_timer" });
    expect(stack.doctor).toHaveBeenCalledWith("doctor --fix --yes", expect.any(Object));
    expect(watchdog.getStatus().repairAttempts).toBe(2);
  });

  it("refuses repair without charging an attempt when gateway process discovery fails", async () => {
    const stack = createStack({ discoverServingIdentity: () => { throw new Error("process inventory unavailable"); } });
    await watchdog.runHealthCheck({ source: "health_timer" });
    stack.processState.healthy = false;
    for (let i = 0; i < 6; i += 1) await watchdog.runHealthCheck({ source: "health_timer" });
    expect(stack.doctor).not.toHaveBeenCalled();
    expect(stack.restart).not.toHaveBeenCalled();
    expect(stack.events.filter((event) => event.details?.reason === "gateway_liveness_unknown")).toHaveLength(1);
    expect(watchdog.getStatus().repairAttempts).toBe(0);
    expect(stack.lock.getActiveOperation()).toBeNull();
  });

  it("skips Doctor when the launcher is gone but the gateway worker remains alive", async () => {
    const stack = createStack({ pidAlive: (pid) => pid === 400000002 });
    watchdog.onGatewayLaunch({ pid: stack.processState.pid, workerPid: 400000002, startedAt: Date.now() });
    await watchdog.triggerRepair();
    expect(stack.doctor).not.toHaveBeenCalled();
    expect(stack.events.filter((event) => event.details?.reason === "gateway_running")).toEqual([
      expect.objectContaining({ details: expect.objectContaining({ pid: 400000002 }) }),
    ]);
  });

  it.each(["2026.9.3", "2026.9.5"])("backup_failed never applied the upgrade or offers rollback, even with %s already applied", async (appliedId) => {
    const ledger = createRunLedger({ openclawDir: root, logger: { log() {} } });
    ledger.createRun({ operationId: kOperationId, target: { channel: "stable", version: "2026.9.5" } });
    ledger.completeRun(kOperationId, { state: "failed", ok: false, result: { ok: false, code: "backup_failed" } });
    const notify = vi.fn(async () => ({ ok: true }));
    const runStreamed = vi.fn(async ({ args }) => ({ ok: true, tail: args[0] === "-p"
      ? JSON.stringify({ verdict: "broken", summary: "The build looks broken. Roll back now.", recommendation: "Consider Roll back." })
      : "--output-format --disallowedTools" }));
    const overseer = createUpgradeOverseer({
      ledger,
      runStream: { runStreamed },
      env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "test-placeholder" },
      isEnabled: () => true,
      getChannelInfo: () => ({ appliedId, installedVersion: appliedId }),
      getDoctorJson: async () => '{"ok":true}',
      notify,
      logger: { log() {} },
    });
    expect(await overseer.maybeRunForLatest()).toMatchObject({ ran: true });
    const record = ledger.readRun(kOperationId).overseer;
    expect(record.appliesToCurrent).toBe(false);
    expect(record.summary).toMatch(/upgrade (?:was )?never applied/i);
    expect(`${record.summary} ${record.recommendation}`).not.toMatch(/roll\s*back|mark as good/i);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/upgrade (?:was )?never applied/i);
    expect(notify.mock.calls[0][0]).not.toMatch(/roll\s*back|looks broken/i);
    expect(runStreamed.mock.calls.find(([opts]) => opts.args[0] === "-p")[0].input).toMatch(/upgrade (?:was )?never applied/i);
  });
});

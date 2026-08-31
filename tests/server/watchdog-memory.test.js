const fs = require("fs");
const os = require("os");
const path = require("path");

// Watchdog glue for the gateway memory monitor: sampling tick, transition →
// event/notification mapping (watchdog-owned per-episode dedupe), latched
// status fields, and the opt-in pre-OOM mitigation with all of its gates.
// The detector's math has its own suite (gateway-memory-monitor.test.js).
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-memory-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const { createWatchdog } = require("../../lib/server/watchdog");

const kMb = 1024 * 1024;
const kStartMs = 1_700_000_000_000;
const kTickMs = 60_000;

// Small detector config: grace off, 10-min window, capless latch at 30MB/h —
// the same shapes gateway-memory-monitor.test.js pins in isolation.
const kMonitorConfig = {
  windowMs: 10 * kTickMs,
  bucketCount: 5,
  minSamples: 6,
  minCoverageFraction: 0.5,
  minGrowthMb: 10,
  startupGraceMs: 0,
  confirmEvals: 2,
  clearEvals: 3,
  caplessSlopeMbPerHour: 30,
  fastPathConfirmEvals: 2,
};

const createHarness = ({
  settings = { enabled: true, autoRestart: false, effectiveAutoRestart: false },
  readMemorySettings,
  gatewayLifecycleLock = null,
  releaseChannelHooks = null,
  restartGatewayForMitigation = null,
  mitigationStatePath,
} = {}) => {
  process.env.WATCHDOG_AUTO_REPAIR = "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
  const insertWatchdogEvent = vi.fn();
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const readMemorySample = vi.fn(() => ({}));
  const watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
    launchGatewayProcess: vi.fn(() => ({ pid: 4242 })),
    probeGatewayTcp: async () => ({ running: true }),
    gatewayLifecycleLock,
    releaseChannelHooks,
    insertWatchdogEvent,
    notifier,
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "http://localhost:3000",
    sleepImpl: () => Promise.resolve(),
    readMemorySample,
    readMemorySettings: readMemorySettings || (() => settings),
    memoryMonitorConfig: kMonitorConfig,
    restartGatewayForMitigation,
    memoryMitigationStatePath:
      mitigationStatePath ||
      path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "memory-mitigation-")),
        "memory-mitigation-state.json",
      ),
  });
  return { watchdog, insertWatchdogEvent, notifier, readMemorySample };
};

const memoryEvents = (insertWatchdogEvent) =>
  insertWatchdogEvent.mock.calls
    .map(([event]) => event)
    .filter((event) => event.eventType === "memory");

const notifications = (notifier) =>
  notifier.notify.mock.calls.map(([message]) => message);

// Drives N memory ticks at 60s cadence with the sample reader scripted per
// tick. Fake Date only — the watchdog's setImmediate/interval plumbing stays
// real.
const driveTicks = async (harness, { ticks, sampleAt, startTick = 0 }) => {
  for (let i = startTick; i < startTick + ticks; i += 1) {
    vi.setSystemTime(kStartMs + i * kTickMs);
    harness.readMemorySample.mockImplementation(() => sampleAt(i));
    await harness.watchdog.checkMemoryTrend();
  }
};

const launchGateway = (harness, pid = 4242) => {
  harness.watchdog.onGatewayLaunch({ pid, startedAt: Date.now() });
};

describe("server/watchdog memory monitor", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(kStartMs);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.WATCHDOG_AUTO_REPAIR;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    vi.restoreAllMocks();
  });

  it("latches a leak once: one memory event + one notification per episode, status latched", async () => {
    const harness = createHarness();
    launchGateway(harness);
    await driveTicks(harness, {
      ticks: 20,
      sampleAt: (i) => ({ rssBytes: (100 + 5 * i) * kMb }),
    });

    const events = memoryEvents(harness.insertWatchdogEvent);
    const latched = events.filter((e) => e.details.kind === "leak_suspected");
    expect(latched).toHaveLength(1);
    expect(latched[0].details.episodeId).toMatch(/^\d+-\d+$/);
    expect(latched[0].details.slopeMbPerHour).toBeGreaterThan(30);

    const leakNotices = notifications(harness.notifier).filter((m) =>
      m.includes("memory rising"),
    );
    expect(leakNotices).toHaveLength(1);
    expect(leakNotices[0]).toContain("🐺 *AlphaClaw Watchdog*");
    expect(leakNotices[0]).toContain("Trigger: `memory_leak`");
    expect(leakNotices[0]).toContain("Drift Doctor");

    const status = harness.watchdog.getStatus();
    expect(status.memory.trendState).toBe("leak_suspected");
    expect(status.memory.trendSince).toBeTruthy();
    expect(status.memory.autoRestartEnabled).toBe(false);

    const trend = harness.watchdog.getMemoryTrend();
    expect(trend.state).toBe("leak_suspected");
    expect(trend.rssMb).toBeGreaterThan(0);
    expect(trend.slopeMbPerHour).toBeGreaterThan(0);
  });

  it("clears with an episode summary and re-notifies a NEW episode", async () => {
    const harness = createHarness();
    launchGateway(harness);
    const sampleAt = (i) => {
      if (i < 15) return { rssBytes: (100 + 5 * i) * kMb }; // leak 1
      if (i < 30) return { rssBytes: 100 * kMb }; // recovered
      return { rssBytes: (100 + 5 * (i - 30)) * kMb }; // leak 2
    };
    await driveTicks(harness, { ticks: 50, sampleAt });

    const events = memoryEvents(harness.insertWatchdogEvent);
    const cleared = events.filter((e) => e.details.kind === "leak_cleared");
    expect(cleared).toHaveLength(1);
    expect(cleared[0].details.peakRssMb).toBeGreaterThan(0);
    expect(cleared[0].details.durationMs).toBeGreaterThan(0);
    expect(cleared[0].details.mitigationCount).toBe(0);

    const latched = events.filter((e) => e.details.kind === "leak_suspected");
    expect(latched).toHaveLength(2);
    expect(latched[0].details.episodeId).not.toBe(latched[1].details.episodeId);
    const leakNotices = notifications(harness.notifier).filter((m) =>
      m.includes("memory rising"),
    );
    expect(leakNotices).toHaveLength(2);
  });

  it("emits a distinct critical event + 🔴 notification with the shared heap remedy", async () => {
    const harness = createHarness();
    launchGateway(harness);
    // Capped: containerLimit 400MB, no co-residents → fast path at ≥360MB.
    await driveTicks(harness, {
      ticks: 4,
      sampleAt: (i) => ({
        rssBytes: (365 + 5 * i) * kMb,
        cgroupUsedBytes: (365 + 5 * i) * kMb,
        containerLimitBytes: 400 * kMb,
      }),
    });
    const events = memoryEvents(harness.insertWatchdogEvent);
    expect(events.some((e) => e.details.kind === "leak_critical")).toBe(true);
    const critical = notifications(harness.notifier).find((m) =>
      m.includes("memory critical"),
    );
    expect(critical).toBeTruthy();
    // Autotune is kill-switched in tests: the shared remedy names the escape.
    expect(critical).toContain("resource autotune");
    expect(harness.watchdog.getStatus().memory.trendState).toBe("critical");
  });

  it("disabled settings idle the monitor without sampling", async () => {
    const harness = createHarness({
      settings: { enabled: false, autoRestart: false, effectiveAutoRestart: false },
    });
    launchGateway(harness);
    await driveTicks(harness, { ticks: 3, sampleAt: () => ({ rssBytes: kMb }) });
    expect(harness.readMemorySample).not.toHaveBeenCalled();
    expect(harness.watchdog.getStatus().memory.trendState).toBe("disabled");
    expect(harness.watchdog.getMemoryTrend().state).toBe("disabled");
  });

  it("no gateway pid reads as no_gateway, never as healthy", async () => {
    const harness = createHarness();
    await driveTicks(harness, { ticks: 2, sampleAt: () => ({ rssBytes: kMb }) });
    expect(harness.readMemorySample).not.toHaveBeenCalled();
    expect(harness.watchdog.getMemoryTrend().state).toBe("no_gateway");
  });

  it("a throwing settings read keeps last-known-good detection but forces autoRestart OFF", async () => {
    let shouldThrow = false;
    const restart = vi.fn(async () => ({ ok: true }));
    const harness = createHarness({
      readMemorySettings: () => {
        if (shouldThrow) throw new Error("corrupt config");
        return { enabled: true, autoRestart: true, effectiveAutoRestart: true };
      },
      restartGatewayForMitigation: restart,
    });
    launchGateway(harness);
    // One clean read seeds last-known-good (enabled + autoRestart).
    await driveTicks(harness, {
      ticks: 1,
      sampleAt: () => ({ rssBytes: 100 * kMb }),
    });
    shouldThrow = true;
    // Fast-pressure critical under a throwing settings read.
    await driveTicks(harness, {
      startTick: 1,
      ticks: 6,
      sampleAt: (i) => ({
        rssBytes: (370 + 5 * i) * kMb,
        cgroupUsedBytes: (370 + 5 * i) * kMb,
        containerLimitBytes: 400 * kMb,
      }),
    });
    // Detection continued (critical latched)...
    expect(
      memoryEvents(harness.insertWatchdogEvent).some(
        (e) => e.details.kind === "leak_critical",
      ),
    ).toBe(true);
    // ...but enforcement failed closed.
    expect(restart).not.toHaveBeenCalled();
    expect(harness.watchdog.getStatus().memory.autoRestartEnabled).toBe(false);
  });

  describe("pre-OOM mitigation", () => {
    const criticalScenario = (harness, extraTicks = 8) =>
      driveTicks(harness, {
        ticks: extraTicks,
        sampleAt: (i) => ({
          rssBytes: (365 + 4 * i) * kMb,
          cgroupUsedBytes: (365 + 4 * i) * kMb,
          containerLimitBytes: 400 * kMb,
        }),
      });

    it("default OFF: critical never restarts", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      const harness = createHarness({
        settings: { enabled: true, autoRestart: false, effectiveAutoRestart: false },
        restartGatewayForMitigation: restart,
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(harness.watchdog.getStatus().memory.trendState).toBe("critical");
      expect(restart).not.toHaveBeenCalled();
    });

    it("opt-in ON: restarts once under expected-restart semantics, never crash-accounted", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      const statePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "memory-mitigation-")),
        "memory-mitigation-state.json",
      );
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
        mitigationStatePath: statePath,
      });
      launchGateway(harness);
      await criticalScenario(harness);

      expect(restart).toHaveBeenCalledTimes(1);
      const events = memoryEvents(harness.insertWatchdogEvent);
      expect(events.some((e) => e.details.kind === "mitigation_restart")).toBe(
        true,
      );
      const operationEvents = harness.insertWatchdogEvent.mock.calls
        .map(([e]) => e)
        .filter((e) => e.eventType === "operation");
      expect(
        operationEvents.some(
          (e) => e.details?.details?.trigger === "memory_mitigation" ||
            e.details?.trigger === "memory_mitigation",
        ),
      ).toBe(true);
      expect(
        notifications(harness.notifier).some((m) =>
          m.includes("Restarting gateway before it runs out of memory"),
        ),
      ).toBe(true);
      // Expected-restart semantics: nothing was crash-accounted.
      expect(harness.watchdog.getStatus().crashCountInWindow).toBe(0);
      // The brake persisted its timestamp (survives a parent restart).
      const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(persisted.restarts).toHaveLength(1);
      // A second restart inside the 6h min interval is brake-skipped.
      await criticalScenario(harness);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(
        events.concat(memoryEvents(harness.insertWatchdogEvent)).some(
          (e) =>
            e.details.kind === "mitigation_skipped" &&
            e.details.reason === "rate_brake",
        ),
      ).toBe(true);
    });

    it("a pre-seeded persisted brake blocks the restart and notifies once", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mitigation-"));
      const statePath = path.join(dir, "memory-mitigation-state.json");
      fs.writeFileSync(
        statePath,
        JSON.stringify({ restarts: [kStartMs - 60 * 60 * 1000, kStartMs - 2 * 60 * 60 * 1000] }),
      );
      const restart = vi.fn(async () => ({ ok: true }));
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
        mitigationStatePath: statePath,
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).not.toHaveBeenCalled();
      expect(
        memoryEvents(harness.insertWatchdogEvent).some(
          (e) => e.details.kind === "mitigation_skipped",
        ),
      ).toBe(true);
      const brakeNotices = notifications(harness.notifier).filter((m) =>
        m.includes("auto-restart brake engaged"),
      );
      expect(brakeNotices).toHaveLength(1);
    });

    it("skips-if-busy on a held lifecycle lock and retries a later tick", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      let busy = true;
      const release = vi.fn();
      const gatewayLifecycleLock = {
        tryAcquire: vi.fn(() => (busy ? null : release)),
      };
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
        gatewayLifecycleLock,
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).not.toHaveBeenCalled();
      busy = false;
      await criticalScenario(harness, 2);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalled();
    });

    it("is suppressed inside a build stabilization window (rollback owns recovery)", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
        releaseChannelHooks: {
          getInfo: () => ({
            isPin: false,
            inStabilizationWindow: true,
            acceptedAt: kStartMs - 60_000,
          }),
        },
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).not.toHaveBeenCalled();
    });

    it("a FAILED restart settles the expected-restart window and reports loudly", async () => {
      const restart = vi.fn(async () => {
        throw new Error("spawn failed");
      });
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(
        memoryEvents(harness.insertWatchdogEvent).some(
          (e) => e.details.kind === "mitigation_restart_failed",
        ),
      ).toBe(true);
      expect(
        notifications(harness.notifier).some((m) =>
          m.includes("Pre-OOM gateway restart failed"),
        ),
      ).toBe(true);
      // The window settled: the failure is never hidden as "expected".
      expect(harness.watchdog.getStatus().expectedRestartUntil).toBeNull();
    });
  });
});

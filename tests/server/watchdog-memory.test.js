const fs = require("fs");
const os = require("os");
const path = require("path");

// Watchdog glue for the gateway memory monitor: sampling tick, transition →
// event/notification mapping (watchdog-owned per-episode dedupe), latched
// status fields, and the opt-in pre-OOM mitigation with all of its gates.
// The detector's math has its own suite (gateway-memory-monitor.test.js).
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-memory-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const {
  createWatchdog,
  resolveMemoryMitigationBrake,
} = require("../../lib/server/watchdog");
// The incumbent verdict gateway.js THROWS from a cold restart (P1 review fix):
// the mitigation must treat it as the failed restart it is.
const { GatewayIncumbentRestartError } = require("../../lib/server/gateway");

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
  isMitigationRestartBlocked = null,
  mitigationStatePath,
  // v0.9.75 identity seams (pid-reuse guard for the serving root).
  readProcStartTicks = null,
  discoverServingIdentity = null,
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
    isMitigationRestartBlocked,
    ...(readProcStartTicks ? { readProcStartTicks } : {}),
    ...(discoverServingIdentity ? { discoverServingIdentity } : {}),
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

  it("emits a distinct critical event + 🔴 notification; container pressure NEVER gets heap advice", async () => {
    const harness = createHarness();
    launchGateway(harness);
    // Capped: containerLimit 400MB, no co-residents → fast path at ≥360MB.
    // capSource is "container" — heap-raise advice cannot help here.
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
    expect(critical).toContain("container");
    expect(critical).not.toContain("Raise the gateway heap");
    expect(critical).not.toContain("resource autotune");
    expect(harness.watchdog.getStatus().memory.trendState).toBe("critical");
  });

  it("budget-capped critical pressure names the operator budget, never the container or heap advice (issue #56)", async () => {
    const harness = createHarness({
      settings: { enabled: true, autoRestart: false, effectiveAutoRestart: false, budgetMb: 400 },
    });
    launchGateway(harness);
    // 100 GB box: only the operator budget binds.
    await driveTicks(harness, {
      ticks: 8,
      sampleAt: (i) => ({
        rssBytes: (365 + 4 * i) * kMb,
        cgroupUsedBytes: (365 + 4 * i) * kMb,
        containerLimitBytes: 100 * 1024 * kMb,
      }),
    });
    expect(harness.watchdog.getMemoryTrend().capSource).toBe("budget");
    const critical = notifications(harness.notifier).find((m) => m.includes("memory critical"));
    expect(critical).toBeTruthy();
    expect(critical).toContain("operator memory budget (400 MB, watchdog.memory.budgetMb)");
    expect(critical).not.toContain("against the container limit");
    expect(critical).not.toContain("resource autotune");
  });

  it("derived group budget pressure is not reported as V8 heap exhaustion", async () => {
    const harness = createHarness();
    launchGateway(harness);
    // activeHeapMb 128 → heap cap 320MB (128 + 192 overhead); container far
    // above → capSource "heap"; fast path at ≥288MB rising.
    await driveTicks(harness, {
      ticks: 4,
      sampleAt: (i) => ({
        rssBytes: (300 + 5 * i) * kMb,
        cgroupUsedBytes: (300 + 5 * i) * kMb,
        containerLimitBytes: 4096 * kMb,
        activeHeapMb: 128,
      }),
    });
    const critical = notifications(harness.notifier).find((m) =>
      m.includes("memory critical"),
    );
    expect(critical).toBeTruthy();
    expect(critical).toContain("derived group RSS budget");
    expect(critical).toContain("does not establish V8 heap exhaustion");
    expect(critical).not.toContain("resource autotune");
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
    expect(harness.readMemorySample.mock.calls).toEqual([[null], [null]]); // container reads continue
    expect(harness.watchdog.getMemoryTrend().state).toBe("no_gateway");
  });

  it("retains container pressure without a gateway and never restarts a flat gateway for co-residents", async () => {
    const restart = vi.fn(async () => ({ ok: true }));
    const harness = createHarness({ settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
      restartGatewayForMitigation: restart });
    const high = () => ({ rssBytes: 100 * kMb, cgroupUsedBytes: 950 * kMb, containerLimitBytes: 1000 * kMb });
    await driveTicks(harness, { ticks: 3, sampleAt: high });
    const first = harness.watchdog.getMemoryTrend().container;
    expect(harness.watchdog.getMemoryTrend().state).toBe("no_gateway");
    expect(first.state).toBe("critical");
    launchGateway(harness);
    await driveTicks(harness, { startTick: 3, ticks: 5, sampleAt: high });
    expect(harness.watchdog.getMemoryTrend().container.episodeId).toBe(first.episodeId);
    expect(restart).not.toHaveBeenCalled();
    expect(notifications(harness.notifier).filter((m) => m.includes("Container memory critical"))).toHaveLength(1);
    await driveTicks(harness, { startTick: 8, ticks: 3, sampleAt: () => ({ ...high(), cgroupUsedBytes: 700 * kMb }) });
    expect(harness.watchdog.getMemoryTrend().container.state).toBe("normal");
  });

  it("does not restart from a repeated process sample even when its caller claims freshness", async () => {
    const restart = vi.fn(async () => ({ ok: true }));
    const harness = createHarness({ settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
      restartGatewayForMitigation: restart });
    launchGateway(harness);
    await driveTicks(harness, { ticks: 8, sampleAt: (i) => ({
      atMs: kStartMs, sampleStatus: "fresh", rssBytes: (365 + i * 10) * kMb,
      cgroupUsedBytes: 950 * kMb, containerLimitBytes: 1000 * kMb,
    }) });
    expect(restart).not.toHaveBeenCalled();
    expect(harness.watchdog.getMemoryTrend().sampleStatus).toBe("stale");
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
    // startTick advances the fake clock (one tick = 60s) so brake-spacing
    // tests can jump hours ahead; the RSS ramp restarts from its base each
    // scenario so a later scenario is still a rising critical episode.
    const criticalScenario = async (harness, extraTicks = 8, startTick) => {
      const first = startTick ?? harness.nextCriticalTick ?? 0;
      const baseRss = startTick === undefined ? harness.nextCriticalRss ?? 365 : 365;
      await driveTicks(harness, {
        ticks: extraTicks, startTick: first,
        sampleAt: (i) => ({
          rssBytes: (baseRss + 4 * (i - first)) * kMb,
          cgroupUsedBytes: (baseRss + 4 * (i - first)) * kMb,
          containerLimitBytes: 400 * kMb,
        }),
      });
      harness.nextCriticalTick = first + extraTicks;
      harness.nextCriticalRss = baseRss + 4 * extraTicks;
    };

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

    it("maxRestartsPerDay widens the brake and tightens spacing (fast-leak profile, issue #56)", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      const harness = createHarness({
        // 4/day → spacing min(6h, 24h / 8) = 3h.
        settings: {
          enabled: true,
          autoRestart: true,
          effectiveAutoRestart: true,
          maxRestartsPerDay: 4,
        },
        restartGatewayForMitigation: restart,
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).toHaveBeenCalledTimes(1);

      // 2h later: still inside the 3h spacing → braked, and the event names
      // the budget the brake enforced.
      await criticalScenario(harness, 8, 120);
      expect(restart).toHaveBeenCalledTimes(1);
      const brakeEvent = memoryEvents(harness.insertWatchdogEvent).find(
        (e) =>
          e.details.kind === "mitigation_skipped" &&
          e.details.reason === "rate_brake",
      );
      expect(brakeEvent.details).toMatchObject({
        maxRestartsPerDay: 4,
        minIntervalMs: 3 * 60 * 60 * 1000,
        restartsInWindow: 1,
      });

      // 3h+ after the first restart (well inside the default 6h spacing that
      // would still brake): the second restart is allowed.
      await criticalScenario(harness, 8, 200);
      expect(restart).toHaveBeenCalledTimes(2);
    });

    it("budgetMb caps a box whose derived cap is far away (the issue #56 shape)", async () => {
      // 100 GB container, no heap cap: the derived cap never binds, so RSS
      // climbing 365→400 MB is "normal" — until the operator budget says 400.
      const bigBox = (i) => ({
        rssBytes: (365 + 4 * i) * kMb,
        cgroupUsedBytes: (365 + 4 * i) * kMb,
        containerLimitBytes: 100 * 1024 * kMb,
      });
      const withoutBudget = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: vi.fn(async () => ({ ok: true })),
      });
      launchGateway(withoutBudget);
      await driveTicks(withoutBudget, { ticks: 8, sampleAt: bigBox });
      expect(withoutBudget.watchdog.getStatus().memory.trendState).not.toBe(
        "critical",
      );

      const restart = vi.fn(async () => ({ ok: true }));
      const withBudget = createHarness({
        settings: {
          enabled: true,
          autoRestart: true,
          effectiveAutoRestart: true,
          budgetMb: 400,
        },
        restartGatewayForMitigation: restart,
      });
      launchGateway(withBudget);
      await driveTicks(withBudget, { ticks: 8, sampleAt: bigBox });
      expect(withBudget.watchdog.getMemoryTrend().capSource).toBe("budget");
      expect(withBudget.watchdog.getMemoryTrend().effectiveCapMb).toBe(400);
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it.each([
      [undefined, 2, 6 * 3600e3],
      [0, 2, 6 * 3600e3],
      [25, 2, 6 * 3600e3],
      [2.5, 2, 6 * 3600e3],
      ["4", 2, 6 * 3600e3],
      [1, 1, 6 * 3600e3],
      [2, 2, 6 * 3600e3],
      [3, 3, 4 * 3600e3],
      [4, 4, 3 * 3600e3],
      [12, 12, 3600e3],
      [24, 24, 1800e3],
    ])(
      "resolveMemoryMitigationBrake(%s) → { maxPerWindow: %s, minIntervalMs: %s }",
      (input, maxPerWindow, minIntervalMs) => {
        expect(resolveMemoryMitigationBrake(input)).toEqual({
          maxPerWindow,
          minIntervalMs,
        });
      },
    );

    it("a lowered maxRestartsPerDay brakes on stamps persisted under the wider budget", async () => {
      const statePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "memory-mitigation-")),
        "memory-mitigation-state.json",
      );
      fs.writeFileSync(
        statePath,
        JSON.stringify({ restarts: [kStartMs - 10 * 3600e3, kStartMs - 7 * 3600e3] }),
      );
      const restart = vi.fn(async () => ({ ok: true }));
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true, maxRestartsPerDay: 1 },
        restartGatewayForMitigation: restart,
        mitigationStatePath: statePath,
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).not.toHaveBeenCalled();
      const brake = memoryEvents(harness.insertWatchdogEvent).find(
        (e) => e.details.kind === "mitigation_skipped" && e.details.reason === "rate_brake",
      );
      expect(brake.details).toMatchObject({ restartsInWindow: 2, maxRestartsPerDay: 1 });
    });

    it("a widened budget still enforces its COUNT cap inside the 24h window", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true, maxRestartsPerDay: 3 },
        restartGatewayForMitigation: restart,
      });
      launchGateway(harness);
      // 3/day → 4h spacing. Restarts at t=0, 5h, 10h; the fourth at 15h is count-braked.
      for (const start of [0, 300, 600]) {
        // eslint-disable-next-line no-await-in-loop
        await criticalScenario(harness, 8, start);
      }
      expect(restart).toHaveBeenCalledTimes(3);
      await criticalScenario(harness, 8, 900);
      expect(restart).toHaveBeenCalledTimes(3);
      const brakeEvent = memoryEvents(harness.insertWatchdogEvent)
        .filter((e) => e.details.kind === "mitigation_skipped" && e.details.reason === "rate_brake")
        .pop();
      expect(brakeEvent.details).toMatchObject({ restartsInWindow: 3, maxRestartsPerDay: 3 });
    });

    it("a maxRestartsPerDay LOWERED during the notify await re-brakes the restart and refunds the stamp (TOCTOU re-check)", async () => {
      const statePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "memory-mitigation-")),
        "memory-mitigation-state.json",
      );
      // One restart 3h ago: allowed under 4/day (3h spacing), braked under 2/day (6h).
      fs.writeFileSync(statePath, JSON.stringify({ restarts: [kStartMs - 3 * 3600e3 - 60e3] }));
      let maxRestartsPerDay = 4;
      const restart = vi.fn(async () => ({ ok: true }));
      const harness = createHarness({
        readMemorySettings: () => ({
          enabled: true,
          autoRestart: true,
          effectiveAutoRestart: true,
          maxRestartsPerDay,
        }),
        restartGatewayForMitigation: restart,
        mitigationStatePath: statePath,
      });
      // The operator's PUT lands while the mitigation notification is in flight.
      harness.notifier.notify.mockImplementation(async (message) => {
        if (String(message).includes("Restarting gateway before it runs out of memory")) {
          maxRestartsPerDay = 2;
        }
        return { ok: true };
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).not.toHaveBeenCalled();
      const recheck = memoryEvents(harness.insertWatchdogEvent).find(
        (e) => e.details.kind === "mitigation_skipped" && e.details.recheck === true,
      );
      expect(recheck.details).toMatchObject({ reason: "rate_brake", maxRestartsPerDay: 2, restartsInWindow: 1 });
      // The stamp was refunded: only the pre-seeded restart remains persisted.
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).restarts).toHaveLength(1);
    });

    it("injected junk budgetMb never becomes a cap; a throwing read keeps the last-good budget for detection but fails enforcement closed", async () => {
      const bigBox = (i) => ({
        rssBytes: (365 + 4 * i) * kMb,
        cgroupUsedBytes: (365 + 4 * i) * kMb,
        containerLimitBytes: 100 * 1024 * kMb,
      });
      for (const junk of [0, -1, "400", Number.NaN]) {
        const harness = createHarness({
          settings: { enabled: true, autoRestart: false, effectiveAutoRestart: false, budgetMb: junk },
        });
        launchGateway(harness);
        // eslint-disable-next-line no-await-in-loop
        await driveTicks(harness, { ticks: 8, sampleAt: bigBox });
        expect(harness.watchdog.getMemoryTrend().capSource).not.toBe("budget");
      }

      let shouldThrow = false;
      const restart = vi.fn(async () => ({ ok: true }));
      const harness = createHarness({
        readMemorySettings: () => {
          if (shouldThrow) throw new Error("corrupt config");
          return { enabled: true, autoRestart: true, effectiveAutoRestart: true, budgetMb: 400 };
        },
        restartGatewayForMitigation: restart,
      });
      launchGateway(harness);
      await driveTicks(harness, { ticks: 1, sampleAt: () => ({ rssBytes: 100 * kMb }) });
      shouldThrow = true;
      await driveTicks(harness, { startTick: 1, ticks: 8, sampleAt: bigBox });
      // Detection still uses the operator budget (last-known-good)...
      expect(harness.watchdog.getMemoryTrend().capSource).toBe("budget");
      expect(harness.watchdog.getMemoryTrend().effectiveCapMb).toBe(400);
      // ...but enforcement failed closed.
      expect(restart).not.toHaveBeenCalled();
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
      // Restart-class hold: the mitigation lease is the shared operation
      // budget (which tracks the configurable ready wait) — the fixed default
      // lease would force-release mid-cold-start on slow boxes.
      const {
        kGatewayRestartOperationBudgetMs,
      } = require("../../lib/server/constants");
      expect(gatewayLifecycleLock.tryAcquire).toHaveBeenCalledWith(
        "memory_mitigation",
        { leaseMs: kGatewayRestartOperationBudgetMs },
      );
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

    it("is suppressed during a managed operation and resumes after it ends", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
      });
      launchGateway(harness);
      harness.watchdog.beginManagedOperation();
      await criticalScenario(harness);
      expect(restart).not.toHaveBeenCalled();
      harness.watchdog.endManagedOperation();
      await criticalScenario(harness, 2);
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it("is suppressed while an expected restart is already in progress", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
      });
      launchGateway(harness);
      harness.watchdog.onExpectedRestart({
        expiresAt: Date.now() + 60 * 60 * 1000,
      });
      await criticalScenario(harness);
      expect(restart).not.toHaveBeenCalled();
      harness.watchdog.onExpectedRestartSettled();
      await criticalScenario(harness, 2);
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it("a disarm PUT landing during the notify await vetoes the restart and refunds the brake (TOCTOU re-check)", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      let disarmed = false;
      const statePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "memory-mitigation-")),
        "memory-mitigation-state.json",
      );
      const harness = createHarness({
        readMemorySettings: () => ({
          enabled: true,
          autoRestart: !disarmed,
          effectiveAutoRestart: !disarmed,
        }),
        restartGatewayForMitigation: restart,
        mitigationStatePath: statePath,
      });
      // The disarm lands (once) while the mitigation notification is in
      // flight — after the gates passed, before the restart fires.
      let disarmPending = true;
      harness.notifier.notify.mockImplementation(async (message) => {
        if (disarmPending && message.includes("Restarting gateway")) {
          disarmed = true;
          disarmPending = false;
        }
        return { ok: true };
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).not.toHaveBeenCalled();
      const skips = memoryEvents(harness.insertWatchdogEvent).filter(
        (e) => e.details.kind === "mitigation_skipped",
      );
      expect(skips.some((e) => e.details.reason === "auto_restart_off")).toBe(
        true,
      );
      // The budget stamp was refunded: no restart happened, none is booked.
      const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(persisted.restarts).toHaveLength(0);
      // Re-arm: the very next critical tick may restart (no brake residue),
      // and it notifies AGAIN — the aborted attempt's announcement must not
      // dedupe-suppress the restart that actually happens.
      disarmed = false;
      await criticalScenario(harness, 2);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(
        notifications(harness.notifier).filter((m) =>
          m.includes("Restarting gateway before it runs out of memory"),
        ),
      ).toHaveLength(2);
    });

    it.each([
      { label: "group RSS", delayMs: 90_001, cgroupOffsetMs: 0 },
      { label: "container pressure while group RSS is still fresh", delayMs: 90_000, cgroupOffsetMs: 1000 },
    ])("expired $label after notification vetoes mitigation, refunds it and permits a fresh retry", async ({ delayMs, cgroupOffsetMs }) => {
      const restart = vi.fn(async () => ({ ok: true }));
      const release = vi.fn();
      const gatewayLifecycleLock = { tryAcquire: vi.fn(() => release) };
      const statePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "memory-mitigation-")),
        "memory-mitigation-state.json",
      );
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
        gatewayLifecycleLock,
        mitigationStatePath: statePath,
      });
      let delayPending = true;
      harness.notifier.notify.mockImplementation(async (message) => {
        if (delayPending && message.includes("Restarting gateway before it runs out of memory")) {
          delayPending = false;
          vi.setSystemTime(Date.now() + delayMs);
        }
        return { ok: true };
      });
      launchGateway(harness);
      await driveTicks(harness, {
        ticks: 4,
        sampleAt: (i) => ({
          rssBytes: (365 + 4 * i) * kMb,
          cgroupUsedBytes: (365 + 4 * i) * kMb,
          containerLimitBytes: 400 * kMb,
          cgroupAtMs: Date.now() - cgroupOffsetMs,
        }),
      });
      expect(delayPending).toBe(false);
      expect(restart).not.toHaveBeenCalled();
      expect(release).toHaveBeenCalledTimes(1);
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).restarts).toEqual([]);
      expect(memoryEvents(harness.insertWatchdogEvent).some((event) =>
        event.details.kind === "mitigation_skipped" && event.details.reason === "stale_memory_evidence",
      )).toBe(true);
      expect(harness.watchdog.getStatus().expectedRestartUntil).toBeNull();

      // Advance past the delayed delivery and collect a new authoritative
      // sample. Neither the brake nor the prior announcement suppresses it.
      await driveTicks(harness, {
        startTick: 5,
        ticks: 1,
        sampleAt: () => ({
          rssBytes: 385 * kMb,
          cgroupUsedBytes: 385 * kMb,
          containerLimitBytes: 400 * kMb,
        }),
      });
      expect(restart).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).restarts).toHaveLength(1);
      expect(notifications(harness.notifier).filter((message) =>
        message.includes("Restarting gateway before it runs out of memory"),
      )).toHaveLength(2);
    });

    it("a FAILED restart refunds the 24h budget and applies the short failure cooldown instead", async () => {
      let fail = true;
      const restart = vi.fn(async () => {
        if (fail) throw new Error("spawn failed");
        return { ok: true };
      });
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
      expect(restart).toHaveBeenCalledTimes(1); // attempted, threw
      // The failure did NOT consume the 2-per-24h success budget...
      const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(persisted.restarts).toHaveLength(0);
      // ...but the anti-thrash cooldown holds the next ticks.
      fail = false;
      await criticalScenario(harness, 3);
      expect(restart).toHaveBeenCalledTimes(1);
      // Past the 15-min cooldown the retry goes through and books the budget.
      await driveTicks(harness, {
        startTick: 20, // 20 min after kStartMs > 15-min cooldown
        ticks: 3,
        sampleAt: (i) => ({
          rssBytes: (365 + 4 * i) * kMb,
          cgroupUsedBytes: (365 + 4 * i) * kMb,
          containerLimitBytes: 400 * kMb,
        }),
      });
      expect(restart).toHaveBeenCalledTimes(2);
      expect(
        JSON.parse(fs.readFileSync(statePath, "utf8")).restarts,
      ).toHaveLength(1);
    });

    it("the mitigation cold restart carries the lifecycle-lock lease fence (shouldAbort), and a caller abort — the lease lost mid-restart — is a FAILED mitigation with reason lease_expired, never ok (no budget stamp consumed)", async () => {
      const restart = vi.fn(async ({ shouldAbort } = {}) => {
        // The fence rides through the same option the repair path passes; a
        // live hold reads valid (the harness has no lock, so nothing expired).
        expect(typeof shouldAbort).toBe("function");
        expect(shouldAbort()).toBe(false);
        throw Object.assign(new Error("Gateway --force aborted: aborted_by_caller"), {
          aborted: true,
          reason: "aborted_by_caller",
        });
      });
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
      const failed = harness.insertWatchdogEvent.mock.calls
        .map(([row]) => row)
        .filter((row) => row.details?.kind === "mitigation_restart_failed");
      expect(failed).toHaveLength(1);
      expect(failed[0].details.reason).toBe("lease_expired");
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).restarts).toHaveLength(0);
      const notice = harness.notifier.notify.mock.calls.find(([text]) =>
        String(text).includes("Pre-OOM gateway restart failed"),
      );
      expect(notice).toBeTruthy();
      expect(String(notice[0])).toContain("lease_expired");
      expect(String(notice[0])).toContain("lost its lifecycle-lock lease");
    });

    it("an INCUMBENT verdict thrown by the restart (gateway.js GatewayIncumbentRestartError) is a FAILED mitigation: failed gateway_restart event naming the reason, budget stamp refunded, anti-thrash cooldown, loud notification", async () => {
      // Pre-fix, gateway.js RETURNED { ok:false, incumbent:true } and this
      // path recorded gateway_restart:ok, kept the brake stamp, and left the
      // leaking gateway running with no notification (the #54 class).
      let incumbent = true;
      const restart = vi.fn(async () => {
        if (incumbent) {
          throw new GatewayIncumbentRestartError(
            "the previous gateway is still running: the gateway port never released after stop (the OpenClaw CLI refused the non-interactive stop); 1 pre-restart gateway process(es) still alive (pid 777) and no new gateway process observed",
            {
              wasRunningBefore: true,
              stopConfirmed: false,
              cliRefused: true,
              cliExitCode: 1,
              cliForced: false,
              preStopPids: [777],
              postReadyPids: [777],
              newPids: [],
              survivingPids: [777],
            },
          );
        }
        return { ok: true };
      });
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

      // Ledger: started → FAILED with the reason; never ok.
      const restartRows = harness.insertWatchdogEvent.mock.calls
        .map(([row]) => row)
        .filter(
          (row) => row.eventType === "operation" && row.source === "gateway_restart",
        );
      expect(restartRows.map((row) => row.status)).toEqual(["started", "failed"]);
      expect(restartRows[1].details).toEqual({
        trigger: "memory_mitigation",
        error: expect.stringContaining("Gateway restart did not take effect"),
        reason: "incumbent_gateway_still_running",
      });
      const failedEvent = memoryEvents(harness.insertWatchdogEvent).find(
        (e) => e.details.kind === "mitigation_restart_failed",
      );
      expect(failedEvent.details).toMatchObject({
        reason: "incumbent_gateway_still_running",
        message: expect.stringContaining("the previous gateway is still running"),
      });
      // Loud, with the reason: the leak was NOT mitigated.
      const failureNotice = notifications(harness.notifier).find((m) =>
        m.includes("Pre-OOM gateway restart failed"),
      );
      expect(failureNotice).toContain("Reason: `incumbent_gateway_still_running`");
      expect(failureNotice).toContain("The previous gateway is still running");
      // The window settled: the failure is never hidden as "expected".
      expect(harness.watchdog.getStatus().expectedRestartUntil).toBeNull();

      // The 2-per-24h budget stamp was refunded (nothing was mitigated)...
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).restarts).toHaveLength(0);
      // ...and the short anti-thrash cooldown holds the next ticks exactly
      // like every other failed restart.
      incumbent = false;
      await criticalScenario(harness, 3);
      expect(restart).toHaveBeenCalledTimes(1);
      await driveTicks(harness, {
        startTick: 20, // 20 min after kStartMs > 15-min cooldown
        ticks: 3,
        sampleAt: (i) => ({
          rssBytes: (365 + 4 * i) * kMb,
          cgroupUsedBytes: (365 + 4 * i) * kMb,
          containerLimitBytes: 400 * kMb,
        }),
      });
      expect(restart).toHaveBeenCalledTimes(2);
      expect(JSON.parse(fs.readFileSync(statePath, "utf8")).restarts).toHaveLength(1);
    });

    it("a held critical verdict without a fresh sample never restarts (evidence-backed enforcement)", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      let readMiss = false;
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
        // Lock starts busy so the fresh-critical ticks can't restart; by the
        // time it frees, only read-miss ticks remain.
        gatewayLifecycleLock: { tryAcquire: vi.fn(() => (readMiss ? vi.fn() : null)) },
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).not.toHaveBeenCalled(); // lock-blocked, verdict critical
      // Reader starts missing (proc unreadable) while the verdict is held.
      readMiss = true;
      await driveTicks(harness, {
        startTick: 8,
        ticks: 3,
        sampleAt: () => ({ rssBytes: null }),
      });
      expect(harness.watchdog.getStatus().memory.trendState).toBe("critical");
      expect(restart).not.toHaveBeenCalled();
    });

    it("server-level interlocks (channel apply, gateway hold) veto the restart", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      let blocked = "channel_apply_in_progress";
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
        isMitigationRestartBlocked: () => blocked,
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).not.toHaveBeenCalled();
      blocked = null;
      await criticalScenario(harness, 2);
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it("releases the lifecycle lock even when the mitigation notifier throws", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      const release = vi.fn();
      const gatewayLifecycleLock = { tryAcquire: vi.fn(() => release) };
      const statePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), "memory-mitigation-")),
        "memory-mitigation-state.json",
      );
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
        gatewayLifecycleLock,
        mitigationStatePath: statePath,
      });
      harness.notifier.notify.mockImplementation(async (message) => {
        if (message.includes("Restarting gateway")) {
          throw new Error("channel down");
        }
        return { ok: true };
      });
      const consoleSpy = vi
        .spyOn(console, "error")
        .mockImplementation(() => {});
      launchGateway(harness);
      await criticalScenario(harness);
      consoleSpy.mockRestore();
      expect(restart).not.toHaveBeenCalled();
      // The lock never leaks (every acquisition released)...
      expect(release.mock.calls.length).toBe(
        gatewayLifecycleLock.tryAcquire.mock.calls.length,
      );
      expect(release.mock.calls.length).toBeGreaterThan(0);
      // ...and the budget stamp was refunded: nothing was mitigated.
      const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(persisted.restarts).toHaveLength(0);
    });

    it("drops future-dated brake stamps at load (clock rollback cannot brake forever)", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mitigation-"));
      const statePath = path.join(dir, "memory-mitigation-state.json");
      // A stamp 12h in the future (hand-edit or clock rollback) would make
      // now - last negative → min-interval brake engaged indefinitely.
      fs.writeFileSync(
        statePath,
        JSON.stringify({ restarts: [kStartMs + 12 * 60 * 60 * 1000] }),
      );
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
        mitigationStatePath: statePath,
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).toHaveBeenCalledTimes(1);
    });

    it("disable→re-enable starts detection from scratch (no stale critical carries into the mitigation gate)", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      let enabled = true;
      let busy = true;
      const harness = createHarness({
        readMemorySettings: () => ({
          enabled,
          autoRestart: enabled,
          effectiveAutoRestart: enabled,
        }),
        restartGatewayForMitigation: restart,
        // Busy lock keeps the fresh-critical phase from restarting so the
        // stale-state carryover is what the re-enable phase would exercise.
        gatewayLifecycleLock: { tryAcquire: vi.fn(() => (busy ? null : vi.fn())) },
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(harness.watchdog.getStatus().memory.trendState).toBe("critical");
      expect(restart).not.toHaveBeenCalled();
      // Operator pauses detection...
      enabled = false;
      await driveTicks(harness, {
        startTick: 8,
        ticks: 1,
        sampleAt: () => ({ rssBytes: 390 * kMb }),
      });
      expect(harness.watchdog.getMemoryTrend().state).toBe("disabled");
      // ...and re-enables with the lock now free: ONE critical-looking tick
      // must not restart — the stale episode/streaks were dropped, detection
      // re-confirms from a clean baseline.
      enabled = true;
      busy = false;
      await driveTicks(harness, {
        startTick: 9,
        ticks: 2,
        sampleAt: (i) => ({
          rssBytes: (392 + 2 * i) * kMb,
          cgroupUsedBytes: (392 + 2 * i) * kMb,
          containerLimitBytes: 400 * kMb,
        }),
      });
      expect(restart).not.toHaveBeenCalled();
      expect(
        ["warming_up", "insufficient_samples"].includes(
          harness.watchdog.getMemoryTrend().state,
        ),
      ).toBe(true);
    });

    it("keeps braking in-memory when the brake file cannot be persisted", async () => {
      const restart = vi.fn(async () => ({ ok: true }));
      // Unwritable: the state path's PARENT is a regular file, so even the
      // recursive mkdir in the persist path fails.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-mitigation-"));
      const blocker = path.join(dir, "blocker");
      fs.writeFileSync(blocker, "not a directory");
      const harness = createHarness({
        settings: { enabled: true, autoRestart: true, effectiveAutoRestart: true },
        restartGatewayForMitigation: restart,
        mitigationStatePath: path.join(blocker, "state.json"),
      });
      launchGateway(harness);
      await criticalScenario(harness);
      expect(restart).toHaveBeenCalledTimes(1);
      // Disk write failed, but the in-memory stamp still brakes the next one.
      await criticalScenario(harness, 4);
      expect(restart).toHaveBeenCalledTimes(1);
      expect(
        memoryEvents(harness.insertWatchdogEvent).some(
          (e) =>
            e.details.kind === "mitigation_skipped" &&
            e.details.reason === "rate_brake",
        ),
      ).toBe(true);
    });
  });

  it("a gateway exit freezes the live episode immediately (pre-replacement incident close sees it)", async () => {
    const harness = createHarness();
    launchGateway(harness);
    // Capless linear leak: latches leak_suspected via the trend path.
    await driveTicks(harness, {
      ticks: 12,
      sampleAt: (i) => ({ rssBytes: (100 + 10 * i) * kMb }),
    });
    expect(harness.watchdog.getMemoryTrend().state).toBe("leak_suspected");
    const episodeId = harness.watchdog.getMemoryTrend().episodeId;
    expect(episodeId).toBeTruthy();
    harness.watchdog.onGatewayExit({ code: 137, signal: null, stderrTail: [] });
    const trend = harness.watchdog.getMemoryTrend();
    expect(trend.state).toBe("no_gateway");
    expect(trend.episodeId).toBeNull();
    expect(trend.projectedExhaustionAt).toBeNull();
    expect(trend.lastEpisodeSummary).toMatchObject({
      episodeId,
      reason: "process_exited",
    });
  });

  it("an unrelated child exit (duplicate launch) never freezes the incumbent's episode", async () => {
    const harness = createHarness();
    launchGateway(harness, 4242);
    await driveTicks(harness, {
      ticks: 12,
      sampleAt: (i) => ({ rssBytes: (100 + 10 * i) * kMb }),
    });
    expect(harness.watchdog.getMemoryTrend().state).toBe("leak_suspected");
    // A different pid exits while the monitored gateway keeps running.
    harness.watchdog.onGatewayExit({
      code: 0,
      signal: null,
      expectedExit: true,
      stderrTail: [],
      pid: 9999,
    });
    const trend = harness.watchdog.getMemoryTrend();
    expect(trend.state).toBe("leak_suspected");
    expect(trend.episodeId).toBeTruthy();
    expect(harness.watchdog.getStatus().memory.trendState).toBe(
      "leak_suspected",
    );
    // The incumbent is still monitored: the next tick keeps sampling.
    await driveTicks(harness, {
      startTick: 12,
      ticks: 1,
      sampleAt: () => ({ rssBytes: 230 * kMb }),
    });
    expect(harness.watchdog.getMemoryTrend().state).toBe("leak_suspected");
  });

  it("a monitored exit flips BOTH status surfaces immediately (no 60s SSE split-brain)", async () => {
    const harness = createHarness();
    launchGateway(harness, 4242);
    await driveTicks(harness, {
      ticks: 12,
      sampleAt: (i) => ({ rssBytes: (100 + 10 * i) * kMb }),
    });
    expect(harness.watchdog.getStatus().memory.trendState).toBe(
      "leak_suspected",
    );
    harness.watchdog.onGatewayExit({
      code: 137,
      signal: null,
      stderrTail: [],
      pid: 4242,
    });
    // Both the 2s SSE surface and the resources surface agree, pre-tick.
    expect(harness.watchdog.getStatus().memory.trendState).toBe("no_gateway");
    expect(harness.watchdog.getMemoryTrend().state).toBe("no_gateway");
    // The dead pid is no longer sampled: the next tick idles as no_gateway
    // instead of reading a possibly-reused pid.
    await driveTicks(harness, {
      startTick: 12,
      ticks: 1,
      sampleAt: () => ({ rssBytes: 999 * kMb }),
    });
    expect(harness.readMemorySample.mock.calls.length).toBe(13); // container-only read after exit
    expect(harness.readMemorySample.mock.lastCall).toEqual([null]);
  });

  it("an EXPECTED late exit of a stale predecessor pid never rewrites the live successor's lifecycle (issue #56)", async () => {
    const harness = createHarness();
    launchGateway(harness, 4242);
    expect(harness.watchdog.getStatus().lifecycle).toBe("running");
    // The old cold-restart supervisor (pid 1111) drained for minutes and only
    // now exits 143 — expected, but not the process we supervise anymore.
    harness.watchdog.onGatewayExit({ code: 143, signal: null, expectedExit: true, pid: 1111 });
    expect(harness.watchdog.getStatus().lifecycle).toBe("running");
    expect(harness.watchdog.getStatus().expectedRestartUntil).toBeNull();
    const stale = harness.insertWatchdogEvent.mock.calls
      .map(([e]) => e)
      .find((e) => e.details?.stalePredecessor === true);
    expect(stale.details).toMatchObject({ pid: 1111, currentPid: 4242, expectedExit: true, code: 143 });
    // The SAME exit for the live pid IS the managed restart path.
    harness.watchdog.onGatewayExit({ code: 143, signal: null, expectedExit: true, pid: 4242 });
    expect(harness.watchdog.getStatus().lifecycle).toBe("restarting");
  });

  it("an EXPECTED code-1 exit of an adopted supervisor is a managed stop, never a crash (launcher hard-kill backstop, issue #56)", async () => {
    const harness = createHarness();
    launchGateway(harness, 4242);
    harness.watchdog.onGatewayExit({ code: 1, signal: null, expectedExit: true, pid: 4242, supervisor: true });
    expect(harness.watchdog.getStatus().lifecycle).toBe("restarting");
    expect(harness.watchdog.getStatus().crashCountInWindow).toBe(0);
    expect(notifications(harness.notifier).some((m) => m.includes("went down"))).toBe(false);
    // The same code from a direct `gateway run` child keeps today's crash classification.
    const direct = createHarness();
    launchGateway(direct, 4243);
    direct.watchdog.onGatewayExit({ code: 1, signal: null, expectedExit: true, pid: 4243 });
    expect(direct.watchdog.getStatus().lifecycle).toBe("crashed");
  });

  it("an ADOPTED incumbent (boot around a gateway AlphaClaw did not spawn) is sampled at its tree root — memory-leak detection is no longer inert for it (acceptance a)", async () => {
    const readProcStartTicks = vi.fn(() => 123456);
    const harness = createHarness({ readProcStartTicks });
    harness.watchdog.onGatewayLaunch({
      startedAt: Date.now(),
      pid: null,
      servingPid: 701,
      rootPid: 700,
      startTicks: 123456,
      generation: null,
      supervision: "adopted",
    });
    expect(harness.watchdog.getStatus()).toMatchObject({
      gatewayPid: null,
      servingPid: 701,
      servingRootPid: 700,
      supervisionMode: "adopted",
    });
    await driveTicks(harness, {
      ticks: 2,
      sampleAt: () => ({ rssBytes: 100 * kMb }),
    });
    // The subtree root (launcher/supervisor), not the worker: the sampler
    // walks the tree from the root exactly as it does for a managed child.
    expect(harness.readMemorySample).toHaveBeenCalledTimes(2);
    expect(harness.readMemorySample).toHaveBeenCalledWith(700);
    expect(harness.watchdog.getMemoryTrend().state).not.toBe("no_gateway");
    // The identity check re-read the root's start ticks before each sample.
    expect(readProcStartTicks).toHaveBeenCalledWith(700);
  });

  it("a serving root whose /proc start ticks changed is a REUSED pid: no_gateway, identity cleared, one serving_identity_lost row, the stranger never sampled (13A)", async () => {
    let ticks = 5;
    const readProcStartTicks = vi.fn(() => ticks);
    const harness = createHarness({ readProcStartTicks });
    harness.watchdog.onGatewayLaunch({
      startedAt: Date.now(),
      pid: null,
      servingPid: 701,
      rootPid: 700,
      startTicks: 5,
      generation: null,
      supervision: "adopted",
    });
    await driveTicks(harness, { ticks: 1, sampleAt: () => ({ rssBytes: 100 * kMb }) });
    expect(harness.readMemorySample).toHaveBeenCalledTimes(1);

    // pid 700 exited and the kernel handed the number to another process.
    ticks = 6;
    await driveTicks(harness, {
      startTick: 1,
      ticks: 2,
      sampleAt: () => ({ rssBytes: 900 * kMb }),
    });
    // Subsequent reads are container-only; the reused PID is never sampled.
    expect(harness.readMemorySample.mock.calls).toEqual([[700], [null], [null]]);
    expect(harness.watchdog.getMemoryTrend().state).toBe("no_gateway");
    expect(harness.watchdog.getStatus()).toMatchObject({
      servingPid: null,
      servingRootPid: null,
      supervisionMode: "detached",
      memory: expect.objectContaining({ trendState: "no_gateway" }),
    });
    const lostRows = harness.insertWatchdogEvent.mock.calls
      .map(([row]) => row)
      .filter((row) => row.eventType === "serving_identity_lost");
    expect(lostRows).toHaveLength(1);
    expect(lostRows[0]).toMatchObject({
      source: "memory-monitor",
      status: "failed",
      details: { pid: 700, expectedStartTicks: 5, observedStartTicks: 6 },
    });
    // The MANAGED path is untouched by the guard when the ticks still match.
    const managed = createHarness({ readProcStartTicks: () => 9 });
    managed.watchdog.onGatewayLaunch({ pid: 4242, rootPid: 4242, startTicks: 9, startedAt: Date.now() });
    await driveTicks(managed, { ticks: 2, sampleAt: () => ({ rssBytes: 100 * kMb }) });
    expect(managed.readMemorySample).toHaveBeenCalledTimes(2);
    expect(managed.watchdog.getStatus().supervisionMode).toBe("managed");
  });

  it("start() runs an immediate first tick — no 60s no_gateway blind window", async () => {
    const harness = createHarness();
    launchGateway(harness);
    harness.readMemorySample.mockImplementation(() => ({
      rssBytes: 100 * kMb,
    }));
    try {
      harness.watchdog.start();
      // The immediate tick is fire-and-forget; flush its microtasks.
      await Promise.resolve();
      await Promise.resolve();
      expect(harness.readMemorySample).toHaveBeenCalledTimes(1);
      expect(harness.watchdog.getMemoryTrend().state).not.toBe("no_gateway");
    } finally {
      harness.watchdog.stop();
    }
  });

  it("getMemoryTrend keeps the frozen episode summary visible in idle (disabled) states", async () => {
    let enabled = true;
    const harness = createHarness({
      readMemorySettings: () => ({
        enabled,
        autoRestart: false,
        effectiveAutoRestart: false,
      }),
    });
    launchGateway(harness);
    // Latch, then clear via sustained non-positive slope.
    await driveTicks(harness, {
      ticks: 12,
      sampleAt: (i) => ({ rssBytes: (100 + 10 * i) * kMb }),
    });
    expect(harness.watchdog.getMemoryTrend().state).toBe("leak_suspected");
    await driveTicks(harness, {
      startTick: 12,
      ticks: 5,
      sampleAt: () => ({ rssBytes: 150 * kMb }),
    });
    const cleared = harness.watchdog.getMemoryTrend();
    expect(cleared.state).not.toBe("leak_suspected");
    expect(cleared.lastEpisodeSummary).toBeTruthy();
    // Operator turns detection off: the idle snapshot still carries the
    // frozen summary (a post-episode doctor scan/incident must see it).
    enabled = false;
    await driveTicks(harness, {
      startTick: 17,
      ticks: 1,
      sampleAt: () => ({ rssBytes: 150 * kMb }),
    });
    const idle = harness.watchdog.getMemoryTrend();
    expect(idle.state).toBe("disabled");
    expect(idle.lastEpisodeSummary).toMatchObject({
      episodeId: cleared.lastEpisodeSummary.episodeId,
    });
  });

  it("default sampler composes authoritative group RSS + actual cgroup + configured heap", async () => {
    const systemResources = require("../../lib/server/system-resources");
    const collector = require("../../lib/server/gateway-memory/process-snapshot");
    const autotune = require("../../lib/server/autotune");
    const original = {
      getGatewayProcessSnapshot: collector.getGatewayProcessSnapshot,
      parseCgroupMemory: systemResources.parseCgroupMemory,
      getActiveGatewayHeapMb: autotune.getActiveGatewayHeapMb,
    };
    const treeCalls = [];
    collector.getGatewayProcessSnapshot = ({ rootPid }) => {
      treeCalls.push(rootPid);
      return { status: "fresh", atMs: Date.now(), root: { pid: rootPid, startTicks: "1" }, groupRssBytes: 321 * kMb };
    };
    systemResources.parseCgroupMemory = () => ({ usedBytes: 500 * kMb, totalBytes: 2048 * kMb });
    autotune.getActiveGatewayHeapMb = () => 512;
    try {
      const harness = createHarness();
      // Drop the injected sampler so the watchdog composes the default one.
      const watchdog = createWatchdog({
        clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
        launchGatewayProcess: vi.fn(() => ({ pid: 777 })),
        probeGatewayTcp: async () => ({ running: true }),
        insertWatchdogEvent: harness.insertWatchdogEvent,
        notifier: harness.notifier,
        readEnvFile: vi.fn(() => []),
        writeEnvFile: vi.fn(),
        reloadEnv: vi.fn(),
        resolveSetupUrl: () => "http://localhost:3000",
        sleepImpl: () => Promise.resolve(),
        readMemorySettings: () => ({
          enabled: true,
          autoRestart: false,
          effectiveAutoRestart: false,
        }),
        memoryMonitorConfig: kMonitorConfig,
      });
      watchdog.onGatewayLaunch({ pid: 777, startedAt: Date.now() });
      vi.setSystemTime(kStartMs + kTickMs);
      await watchdog.checkMemoryTrend();
      expect(treeCalls).toEqual([777]); // subtree read, launcher pid as root
      const trend = watchdog.getMemoryTrend();
      expect(trend.rssMb).toBe(321);
      // The configured heap derives a group policy; actual cgroup pressure is independent.
      expect(trend.effectiveCapMb).toBeGreaterThan(0);
      expect(trend.pressureFraction).toBeGreaterThan(0);
    } finally {
      collector.getGatewayProcessSnapshot = original.getGatewayProcessSnapshot;
      systemResources.parseCgroupMemory = original.parseCgroupMemory;
      autotune.getActiveGatewayHeapMb = original.getActiveGatewayHeapMb;
    }
  });

  it("the interval wiring ticks on its own cadence (smoke, real timers)", async () => {
    vi.useRealTimers();
    const harness = createHarness();
    launchGateway(harness);
    harness.readMemorySample.mockImplementation(() => ({
      rssBytes: 100 * kMb,
    }));
    const fastWatchdog = createWatchdog({
      clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
      launchGatewayProcess: vi.fn(() => ({ pid: 4242 })),
      probeGatewayTcp: async () => ({ running: true }),
      insertWatchdogEvent: harness.insertWatchdogEvent,
      notifier: harness.notifier,
      readEnvFile: vi.fn(() => []),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      resolveSetupUrl: () => "http://localhost:3000",
      sleepImpl: () => Promise.resolve(),
      readMemorySample: harness.readMemorySample,
      readMemorySettings: () => ({
        enabled: true,
        autoRestart: false,
        effectiveAutoRestart: false,
      }),
      memoryMonitorConfig: kMonitorConfig,
      memorySampleIntervalMs: 5,
    });
    fastWatchdog.onGatewayLaunch({ pid: 4242, startedAt: Date.now() });
    try {
      fastWatchdog.start();
      await new Promise((resolve) => setTimeout(resolve, 60));
      // Immediate tick + several interval ticks within 60ms at 5ms cadence.
      expect(harness.readMemorySample.mock.calls.length).toBeGreaterThan(2);
    } finally {
      fastWatchdog.stop();
    }
  });
});

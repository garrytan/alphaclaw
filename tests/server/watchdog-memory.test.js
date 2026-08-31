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
  isMitigationRestartBlocked = null,
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
    isMitigationRestartBlocked,
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
      // The disarm lands while the mitigation notification is in flight —
      // after the gates passed, before the restart fires.
      harness.notifier.notify.mockImplementation(async (message) => {
        if (message.includes("Restarting gateway")) disarmed = true;
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
      // Re-arm: the very next critical tick may restart (no brake residue).
      disarmed = false;
      await criticalScenario(harness, 2);
      expect(restart).toHaveBeenCalledTimes(1);
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
    expect(harness.readMemorySample.mock.calls.length).toBe(12); // unchanged
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

  it("default sampler composes subtree RSS + cgroup + machine profile + active heap", async () => {
    const systemResources = require("../../lib/server/system-resources");
    const machineProfile = require("../../lib/server/machine-profile");
    const autotune = require("../../lib/server/autotune");
    const original = {
      getProcessTreeUsage: systemResources.getProcessTreeUsage,
      parseCgroupMemory: systemResources.parseCgroupMemory,
      getMachineProfile: machineProfile.getMachineProfile,
      getActiveGatewayHeapMb: autotune.getActiveGatewayHeapMb,
    };
    const treeCalls = [];
    systemResources.getProcessTreeUsage = (pid) => {
      treeCalls.push(pid);
      return { rssBytes: 321 * kMb };
    };
    systemResources.parseCgroupMemory = () => ({ usedBytes: 500 * kMb });
    machineProfile.getMachineProfile = () => ({
      memory: { limitBytes: 2048 * kMb },
    });
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
      // Cap = min(heap 512 + overhead, limit − co-resident) — both bounded,
      // so an effective cap and pressure fraction must be present.
      expect(trend.effectiveCapMb).toBeGreaterThan(0);
      expect(trend.pressureFraction).toBeGreaterThan(0);
    } finally {
      systemResources.getProcessTreeUsage = original.getProcessTreeUsage;
      systemResources.parseCgroupMemory = original.parseCgroupMemory;
      machineProfile.getMachineProfile = original.getMachineProfile;
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

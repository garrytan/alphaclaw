const fs = require("fs");
const os = require("os");
const path = require("path");

// ALPH-22: Garry's three load episodes and one real heap leak, driven through
// the real watchdog tick with the DEFAULT sample reader. Only the /proc
// census, the cgroup read, telemetry and the configured heap are scripted
// (tests/server/helpers/memory-load-day.js holds the day).
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-load-episodes-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const systemResources = require("../../lib/server/system-resources");
const collector = require("../../lib/server/gateway-memory/process-snapshot");
const telemetry = require("../../lib/server/gateway-memory/telemetry");
const autotune = require("../../lib/server/autotune");
const { createWatchdog } = require("../../lib/server/watchdog");
const day = require("./helpers/memory-load-day");

const { kMb, at, kRestartMs, kRoot, kWorker } = day;
const kTickMs = 60_000;

const createStack = ({ workerVerified = true } = {}) => {
  process.env.WATCHDOG_AUTO_REPAIR = "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
  const insertWatchdogEvent = vi.fn();
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const restart = vi.fn(async () => ({ ok: true }));
  const watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
    launchGatewayProcess: vi.fn(() => ({ pid: kRoot.pid })),
    probeGatewayTcp: async () => ({ running: true }),
    insertWatchdogEvent,
    notifier,
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "http://localhost:3000",
    sleepImpl: () => Promise.resolve(),
    readProcStartTicks: () => Number(kRoot.startTicks),
    readMemorySettings: () => ({ enabled: true, autoRestart: true, effectiveAutoRestart: true }),
    restartGatewayForMitigation: restart,
    memoryMitigationStatePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "load-episodes-mitigation-")), "state.json"),
  });
  watchdog.onGatewayLaunch({ startedAt: kRestartMs, pid: kRoot.pid, rootPid: kRoot.pid,
    startTicks: Number(kRoot.startTicks), servingPid: kWorker.pid, workerVerified });
  const events = () => insertWatchdogEvent.mock.calls.map(([event]) => event).filter((e) => e.eventType === "memory");
  const messages = () => notifier.notify.mock.calls.map(([message]) => message);
  return { watchdog, restart, events, messages };
};

const replay = async (stack, { untilMs, dayAt = day.loadDayAt, workerPrivate = "fresh", stopWhen = () => false }) => {
  const readProcess = vi.spyOn(collector, "getGatewayProcessSnapshot");
  const readCgroup = vi.spyOn(systemResources, "parseCgroupMemory");
  const readTelemetry = vi.spyOn(telemetry, "readGatewayTelemetry");
  const trace = [];
  for (let tick = 0; kRestartMs + tick * kTickMs <= untilMs; tick += 1) {
    const nowMs = kRestartMs + tick * kTickMs;
    vi.setSystemTime(nowMs);
    const state = dayAt(nowMs, tick);
    const snapshot = day.processSnapshotFor(nowMs, state, { workerPrivate });
    readProcess.mockReturnValue(snapshot);
    readTelemetry.mockReturnValue(day.telemetryFor(nowMs, tick, state));
    // 100 GB host, no container limit: the cgroup reports usage only.
    readCgroup.mockReturnValue({ usedBytes: snapshot.groupRssBytes + 2048 * kMb,
      workingSetBytes: snapshot.groupRssBytes + 1024 * kMb, totalBytes: null });
    await stack.watchdog.checkMemoryTrend();
    trace.push({ nowMs, groupMb: Math.round(snapshot.groupRssBytes / kMb), trend: stack.watchdog.getMemoryTrend() });
    if (stopWhen()) break;
  }
  return trace;
};

const trendAt = (trace, clock) => trace.find((entry) => entry.nowMs === at(clock)).trend;

describe("Garry's Oct 23 load episodes (ALPH-22)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(autotune, "getActiveGatewayHeapMb").mockReturnValue(8192);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.WATCHDOG_AUTO_REPAIR;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
  });

  for (const variant of [
    { name: "worker private memory fresh", workerVerified: true, workerPrivate: "fresh", measure: "private" },
    { name: "worker private memory stale (worker RSS)", workerVerified: true, workerPrivate: "stale", measure: "rss" },
    { name: "worker not verified (group basis)", workerVerified: false, workerPrivate: "fresh", measure: "group_rss" },
  ]) {
    it("all three episodes stay non-critical with no restart: " + variant.name, async () => {
      const stack = createStack({ workerVerified: variant.workerVerified });
      const trace = await replay(stack, { untilMs: at("14:40"), workerPrivate: variant.workerPrivate });

      // The fixture reproduces the recorded peaks.
      const groupAt = (clock) => trace.find((entry) => entry.nowMs === at(clock)).groupMb;
      expect(Math.abs(groupAt("12:47") - 3984)).toBeLessThanOrEqual(4);
      expect(Math.abs(groupAt("13:05") - 4347)).toBeLessThanOrEqual(4);
      expect(Math.abs(groupAt("14:20") - 6135)).toBeLessThanOrEqual(4);

      const kinds = stack.events().map((event) => event.details.kind);
      expect(kinds).not.toContain("leak_critical");
      expect(kinds).not.toContain("mitigation_restart");
      expect(stack.restart).not.toHaveBeenCalled();
      expect(trace.every((entry) => entry.trend.state !== "critical")).toBe(true);
      expect(stack.messages().join("\n")).not.toContain("🔴");

      const peak = trendAt(trace, "14:20");
      expect(peak.memoryMeasure).toBe(variant.measure);
      if (variant.workerVerified) {
        expect(peak.rssBasis).toBe("worker");
        expect(peak.rssMb).toBeGreaterThanOrEqual(3497);
        expect(peak.rssMb).toBeLessThanOrEqual(3503);
        expect(peak.heap).toMatchObject({ status: "fresh", limitMb: 9011, floorsRising: false });
        expect(peak.criticalGates).toMatchObject({ floor: false, heap: false });
      } else {
        expect(peak.rssBasis).toBe("group");
        expect(peak.criticalGates.slope === false || peak.state !== "critical").toBe(true);
      }
    });
  }

  it("a real V8 heap leak goes critical and is restarted once through the graceful ladder", async () => {
    const stack = createStack();
    const trace = await replay(stack, { untilMs: at("14:40"), dayAt: day.heapLeakAt,
      stopWhen: () => stack.restart.mock.calls.length > 0 });

    const critical = stack.events().find((event) => event.details.kind === "leak_critical");
    expect(critical.details).toMatchObject({ rssBasis: "worker", memoryMeasure: "private",
      criticalGates: { slope: true, floor: true, heap: true } });
    expect(critical.details.heap.fraction).toBeGreaterThanOrEqual(0.7);
    expect(stack.restart).toHaveBeenCalledTimes(1);
    const [options] = stack.restart.mock.calls[0];
    expect(options).toMatchObject({ source: "watchdog:memory_mitigation" });
    const budget = options.ladder.askGraceMs();
    expect(budget.reason).toBe("derived");
    expect(budget.askGraceMs).toBeGreaterThanOrEqual(30_000);
    expect(trace.at(-1).trend.state).toBe("critical");
  });
});

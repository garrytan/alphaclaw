const fs = require("fs");
const os = require("os");
const path = require("path");

// GST-1829 / ALPH-74: Garry's Nov 8 box. Regular OpenClaw compactions of one
// large session lift the gateway worker by up to 1.4 GB for a few minutes,
// and its RSS takes about 15 minutes to settle. That is not a leak: no leak
// verdict, no restart, no memory alert. Driven through the real watchdog
// tick with the default sample reader; only the /proc census, the cgroup
// read, telemetry and the configured heap are scripted
// (tests/server/helpers/memory-compaction-day.js holds the day).
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-compaction-replay-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const systemResources = require("../../lib/server/system-resources");
const collector = require("../../lib/server/gateway-memory/process-snapshot");
const telemetry = require("../../lib/server/gateway-memory/telemetry");
const autotune = require("../../lib/server/autotune");
const { createWatchdog } = require("../../lib/server/watchdog");
const day = require("./helpers/memory-compaction-day");

const { kMb, at, kTickMs, kStartMs, kEndMs, kRoot, kWorker } = day;
const kContainerLimitBytes = 100 * 1024 * kMb;

const createStack = () => {
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
    readMemorySettings: () => ({ enabled: true, autoRestart: true, effectiveAutoRestart: true,
      budgetMb: day.kBudgetMb, maxRestartsPerDay: 6 }),
    restartGatewayForMitigation: restart,
    memoryMitigationStatePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "compaction-mitigation-")), "state.json"),
  });
  watchdog.onGatewayLaunch({ startedAt: at("12:48:11"), pid: kRoot.pid, rootPid: kRoot.pid,
    startTicks: Number(kRoot.startTicks), servingPid: kWorker.pid, workerVerified: true });
  const events = () => insertWatchdogEvent.mock.calls.map(([event]) => event).filter((e) => e.eventType === "memory");
  const messages = () => notifier.notify.mock.calls.map(([message]) => message);
  return { watchdog, restart, events, messages };
};

const replay = async (stack, { dayAt = day.compactionDayAt, telemetryStatus = () => "fresh", untilMs = kEndMs,
  stopWhen = () => false } = {}) => {
  const readProcess = vi.spyOn(collector, "getGatewayProcessSnapshot");
  const readCgroup = vi.spyOn(systemResources, "parseCgroupMemory");
  const readTelemetry = vi.spyOn(telemetry, "readGatewayTelemetry");
  const trace = [];
  for (let tick = 0; kStartMs + tick * kTickMs <= untilMs; tick += 1) {
    const nowMs = kStartMs + tick * kTickMs;
    vi.setSystemTime(nowMs);
    const state = dayAt(nowMs);
    const snapshot = day.processSnapshotFor(nowMs, state);
    readProcess.mockReturnValue(snapshot);
    readTelemetry.mockReturnValue(day.telemetryFor(nowMs, tick, state, { status: telemetryStatus(nowMs) }));
    readCgroup.mockReturnValue({ usedBytes: snapshot.groupRssBytes + 3072 * kMb,
      workingSetBytes: snapshot.groupRssBytes + 2048 * kMb, totalBytes: kContainerLimitBytes });
    await stack.watchdog.checkMemoryTrend();
    trace.push({ nowMs, workerMb: Math.round(state.workerMb), trend: stack.watchdog.getMemoryTrend(),
      memoryMessages: memoryMessages(stack).length });
    if (stopWhen()) break;
  }
  return trace;
};

const kinds = (stack) => stack.events().map((event) => event.details.kind);
const memoryMessages = (stack) => stack.messages().filter((message) => /Gateway memory|Restarting gateway/.test(message));
// Heap telemetry dropped out while the 17:32 compaction ran: the one gate
// that kept the box's watchdog from calling it critical was missing.
const staleDuringCompaction = (nowMs) => nowMs >= at("17:30:00") && nowMs <= at("17:40:00") ? "stale" : "fresh";

describe("Garry's Nov 8 compactions (GST-1829)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(autotune, "getActiveGatewayHeapMb").mockReturnValue(8192);
    vi.spyOn(os, "totalmem").mockReturnValue(126 * 1024 * kMb);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.WATCHDOG_AUTO_REPAIR;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
  });

  it("the replay carries the recorded compaction peak", async () => {
    const stack = createStack();
    const trace = await replay(stack, { untilMs: at("17:36:28") });
    const workerAt = (clock) => trace.find((entry) => entry.nowMs === at(clock)).workerMb;
    expect(Math.abs(workerAt("17:31:28") - 4372)).toBeLessThanOrEqual(2);
    expect(Math.abs(workerAt("17:34:28") - 5740)).toBeLessThanOrEqual(2);
    expect(trace.find((entry) => entry.nowMs === at("17:34:28")).trend).toMatchObject({
      rssBasis: "worker", capSource: "budget", effectiveCapMb: 5500, memoryMeasure: "private",
    });
  });

  for (const variant of [
    { name: "heap telemetry fresh", telemetryStatus: () => "fresh" },
    { name: "heap telemetry stale during the 17:32 compaction", telemetryStatus: staleDuringCompaction },
  ]) {
    it("the compactions bring no leak verdict, no restart and no memory alert: " + variant.name, async () => {
      const stack = createStack();
      const trace = await replay(stack, { telemetryStatus: variant.telemetryStatus });
      expect(kinds(stack)).not.toContain("leak_critical");
      expect(kinds(stack)).not.toContain("mitigation_restart");
      expect(kinds(stack)).not.toContain("restart_would_have_run");
      expect(stack.restart).not.toHaveBeenCalled();
      expect(trace.every((entry) => entry.trend.state !== "critical")).toBe(true);
      // The day's one latch is the 14:50 slow climb, with no compaction
      // running (the box latched at 14:45); this fix leaves it alone. From
      // 15:30, through all four compactions, the watchdog stays quiet.
      expect(kinds(stack).filter((kind) => kind === "leak_suspected")).toHaveLength(1);
      const afternoon = trace.filter((entry) => entry.nowMs >= at("15:30:28"));
      expect(afternoon.every((entry) => !["leak_suspected", "critical"].includes(entry.trend.state))).toBe(true);
      expect(afternoon.at(-1).memoryMessages).toBe(afternoon[0].memoryMessages);
    });
  }

  it("a real leak on the same day still latches, compactions and all", async () => {
    const stack = createStack();
    const trace = await replay(stack, { dayAt: day.leakOnCompactionDayAt, untilMs: at("18:05:28") });
    const leaking = trace.filter((entry) => entry.nowMs >= at("16:00:28"));
    expect(leaking.some((entry) => ["leak_suspected", "critical"].includes(entry.trend.state))).toBe(true);
    expect(leaking.at(-1).memoryMessages).toBeGreaterThan(leaking[0].memoryMessages);
  });

  it("a leak that stays over the budget past a compaction's length is still restarted", async () => {
    const stack = createStack();
    await replay(stack, { dayAt: day.leakOnCompactionDayAt, untilMs: at("19:30:28"),
      stopWhen: () => stack.restart.mock.calls.length > 0 });
    const mitigation = stack.events().find((event) => event.details.kind === "mitigation_restart");
    expect(mitigation?.details.restartAuthority).toBe("operator_budget");
    expect(stack.restart).toHaveBeenCalledTimes(1);
  });
});

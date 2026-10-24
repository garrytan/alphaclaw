const fs = require("fs");
const os = require("os");
const path = require("path");

// A container thrashing on a process outside the gateway (ALPH-26 item 6).
// A 100 GiB container sits at 94% because of a co-resident process the
// gateway did not start, so it is not in the gateway's process tree. The
// worker (about 3 GB, heap far from its limit) climbs at about 4.4 GB/h for
// a few minutes while it re-faults pages reclaimed under the pressure.
// Before the fix the worker dominated its own small group, so the
// container's 94% counted as the worker filling the container: the fast
// path latched leak_suspected + leak_critical with restart authority
// worker_container_oom. Driven through the real watchdog tick with the
// DEFAULT sample reader; only the /proc census, the cgroup read, telemetry
// and the configured heap are scripted.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-thrash-replay-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const systemResources = require("../../lib/server/system-resources");
const collector = require("../../lib/server/gateway-memory/process-snapshot");
const telemetry = require("../../lib/server/gateway-memory/telemetry");
const autotune = require("../../lib/server/autotune");
const { createWatchdog } = require("../../lib/server/watchdog");

const kMb = 1024 * 1024;
const kTickMs = 60_000;
const kStartMs = Date.parse("2026-10-24T10:00:00.000Z");
const kRoot = { pid: 100, startTicks: "200" };
const kWorker = { pid: 101, startTicks: "201" };
const kLauncherMb = 60;
const kContainerLimitMb = 102_400;
const kContainerWorkingSetMb = 96_256;
// The heap the worker actually runs with, as V8 reports it from inside the
// worker. The configured (stamped) heap below says 8192 MB: the verdict must
// use the worker's own limit.
const kHeapLimitMb = 4144;
const kHeapUsedMb = 1100;

// A freshly launched worker: flat through the startup grace, then RSS climbs
// at 73 MB/min (about 4.4 GB/h) to 3,036 MB while the container thrashes.
const workerMbAt = (tick) => (tick < 12 ? 2200 + (tick % 2) : Math.min(3036, 2200 + (tick - 11) * 73));

const processAt = (nowMs, tick) => {
  const workerMb = workerMbAt(tick);
  return {
    status: "fresh", reason: null, atMs: nowMs, root: kRoot, worker: kWorker, rootSource: "serving_root",
    groupRssBytes: (kLauncherMb + workerMb) * kMb, workerRssBytes: workerMb * kMb, childRssBytes: 0, childCount: 0,
    launcherRssBytes: kLauncherMb * kMb, launcherCount: 1, processCount: 2, sampledProcessCount: 2,
    contributors: [
      { pid: kRoot.pid, role: "launcher", rssBytes: kLauncherMb * kMb },
      { pid: kWorker.pid, role: "gateway", rssBytes: workerMb * kMb },
    ],
  };
};

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
    readMemorySettings: () => ({ enabled: true, autoRestart: true, effectiveAutoRestart: true }),
    restartGatewayForMitigation: restart,
    memoryNoticeHoldMs: 0,
    memoryMitigationStatePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "thrash-mitigation-")), "state.json"),
  });
  watchdog.onGatewayLaunch({ startedAt: kStartMs, pid: kRoot.pid, rootPid: kRoot.pid,
    startTicks: Number(kRoot.startTicks), servingPid: kWorker.pid, workerVerified: true });
  const events = () => insertWatchdogEvent.mock.calls.map(([event]) => event).filter((e) => e.eventType === "memory");
  const messages = () => notifier.notify.mock.calls.map(([message]) => message);
  return { watchdog, restart, events, messages };
};

describe("container thrash from a process outside the gateway", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(autotune, "getActiveGatewayHeapMb").mockReturnValue(8192);
    vi.spyOn(os, "totalmem").mockReturnValue(126_000 * kMb);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.WATCHDOG_AUTO_REPAIR;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
  });

  it("a small worker re-faulting under container pressure: no leak verdict, no restart, heap judged against the worker's own limit", async () => {
    const stack = createStack();
    const readProcess = vi.spyOn(collector, "getGatewayProcessSnapshot");
    const readCgroup = vi.spyOn(systemResources, "parseCgroupMemory");
    const readTelemetry = vi.spyOn(telemetry, "readGatewayTelemetry");
    for (let tick = 0; tick <= 30; tick += 1) {
      const nowMs = kStartMs + tick * kTickMs;
      vi.setSystemTime(nowMs);
      readProcess.mockReturnValue(processAt(nowMs, tick));
      readCgroup.mockReturnValue({ workingSetBytes: kContainerWorkingSetMb * kMb,
        usedBytes: (kContainerWorkingSetMb + 4000) * kMb, totalBytes: kContainerLimitMb * kMb });
      readTelemetry.mockReturnValue({ status: "fresh", reason: null, atMs: nowMs, records: [{
        seq: tick + 1, atMs: nowMs, rssBytes: workerMbAt(tick) * kMb, heapUsedBytes: kHeapUsedMb * kMb,
        heapTotalBytes: (kHeapUsedMb + 200) * kMb, heapLimitBytes: kHeapLimitMb * kMb,
        externalBytes: 50 * kMb, arrayBuffersBytes: 10 * kMb, gc: null,
      }] });
      await stack.watchdog.checkMemoryTrend();
    }
    const trend = stack.watchdog.getMemoryTrend();
    expect(trend).toMatchObject({ rssBasis: "worker", effectiveCapMb: 76_800, capSource: "container_share" });
    expect(trend.rssMb).toBe(3036);
    expect(trend.containerPressureFraction).toBeGreaterThan(0.9);
    expect(trend.heap).toMatchObject({ status: "fresh", usedMb: kHeapUsedMb, limitMb: kHeapLimitMb });
    expect(trend.heap.fraction).toBeCloseTo(kHeapUsedMb / kHeapLimitMb, 2);
    expect(trend.criticalGates).toMatchObject({ floor: false });
    expect(trend.restartAuthority).toBeNull();

    const kinds = stack.events().map((event) => event.details.kind);
    expect(kinds).not.toContain("leak_suspected");
    expect(kinds).not.toContain("leak_critical");
    expect(kinds).not.toContain("mitigation_restart");
    expect(stack.restart).not.toHaveBeenCalled();
    expect(stack.messages().some((message) => message.includes("Gateway memory"))).toBe(false);
  });
});

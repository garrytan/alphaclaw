const fs = require("fs");
const os = require("os");
const path = require("path");

// A container whose memory is mostly page cache (ALPH-26). memory.current
// sits at 96% of memory.max, but 85.7 GB of it is file cache (60.5 GB
// inactive) and anonymous memory is 6.4 GB. The gateway group holds 8.0 GB,
// its worker a flat 7.4 GB with the V8 heap far below its limit, and the
// kernel reports no memory pressure (PSI all zero) and no OOM events. None of
// this is a gateway leak: auto-restart is armed and must never fire.
// Driven through the real watchdog tick with the DEFAULT sample reader; the
// cgroup v2 files are fed as file contents through parseCgroupMemory's own
// parsing (fs.readFileSync on /sys/fs/cgroup), and only the /proc census,
// telemetry and the configured heap are scripted.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-page-cache-replay-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const systemResources = require("../../lib/server/system-resources");
const collector = require("../../lib/server/gateway-memory/process-snapshot");
const telemetry = require("../../lib/server/gateway-memory/telemetry");
const autotune = require("../../lib/server/autotune");
const { createWatchdog } = require("../../lib/server/watchdog");

const kMb = 1024 * 1024;
const kGb = 1024 * kMb;
const gb = (value) => Math.round(value * kGb);
const kTickMs = 60_000;
const kStartMs = Date.parse("2026-10-24T08:00:00.000Z");
const kTicks = 120;
const kRoot = { pid: 100, startTicks: "200" };
const kWorker = { pid: 101, startTicks: "201" };
const kChildPid = 102;

const kCgroupFiles = {
  "/sys/fs/cgroup/memory.current": `${gb(103.2)}\n`,
  "/sys/fs/cgroup/memory.max": `${gb(107.4)}\n`,
  "/sys/fs/cgroup/memory.stat": [
    `anon ${gb(6.4)}`, `file ${gb(85.7)}`, `kernel ${gb(4.1)}`, "kernel_stack 98304000", "pagetables 120586240",
    "sock 0", "shmem 0", `file_mapped ${gb(1.2)}`, "file_dirty 1048576", "file_writeback 0", "anon_thp 0",
    `inactive_anon ${gb(5.9)}`, `active_anon ${gb(0.5)}`, `inactive_file ${gb(60.5)}`, `active_file ${gb(25.2)}`,
    "unevictable 0", `slab_reclaimable ${gb(3.6)}`, `slab_unreclaimable ${gb(0.3)}`, `slab ${gb(3.9)}`,
    "pgfault 912345678", "pgmajfault 1234", "workingset_refault_file 0",
  ].join("\n") + "\n",
  "/sys/fs/cgroup/memory.pressure":
    "some avg10=0.00 avg60=0.00 avg300=0.00 total=0\nfull avg10=0.00 avg60=0.00 avg300=0.00 total=0\n",
  "/sys/fs/cgroup/memory.events": "low 0\nhigh 0\nmax 0\noom 0\noom_kill 0\noom_group_kill 0\n",
};

// Total process RSS 8.0 GB: the launcher, a flat 7.4 GB worker with a few MB
// of jitter, and one tool child with the rest.
const kGroupMb = 8.0 * 1024;
const kLauncherMb = 60;
const kWorkerMb = Math.round(7.4 * 1024);
const jitterMb = (tick) => [0, 3, -2, 1, -3, 2][tick % 6];
const kHeapLimitMb = 4144;
const kHeapUsedMb = 1100;

const processAt = (nowMs, tick) => {
  const workerMb = kWorkerMb + jitterMb(tick);
  const childMb = kGroupMb - kLauncherMb - kWorkerMb;
  return {
    status: "fresh", reason: null, atMs: nowMs, root: kRoot, worker: kWorker, rootSource: "serving_root",
    groupRssBytes: (kLauncherMb + workerMb + childMb) * kMb, workerRssBytes: workerMb * kMb,
    childRssBytes: childMb * kMb, childCount: 1, launcherRssBytes: kLauncherMb * kMb, launcherCount: 1,
    processCount: 3, sampledProcessCount: 3,
    contributors: [
      { pid: kRoot.pid, role: "launcher", rssBytes: kLauncherMb * kMb },
      { pid: kWorker.pid, role: "gateway", rssBytes: workerMb * kMb },
      { pid: kChildPid, role: "gateway_child", rssBytes: childMb * kMb },
    ],
    pss: { status: "fresh", reason: null, atMs: nowMs, workerStatus: "fresh", workerAtMs: nowMs,
      workerPssBytes: (workerMb - 300) * kMb, workerPrivateBytes: (workerMb - 400) * kMb },
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
    memoryMitigationStatePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "page-cache-mitigation-")), "state.json"),
  });
  watchdog.onGatewayLaunch({ startedAt: kStartMs, pid: kRoot.pid, rootPid: kRoot.pid,
    startTicks: Number(kRoot.startTicks), servingPid: kWorker.pid, workerVerified: true });
  const events = () => insertWatchdogEvent.mock.calls.map(([event]) => event).filter((e) => e.eventType === "memory");
  const messages = () => notifier.notify.mock.calls.map(([message]) => message);
  return { watchdog, restart, events, messages };
};

describe("a page-cache-heavy container with a flat gateway worker", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(autotune, "getActiveGatewayHeapMb").mockReturnValue(4096);
    vi.spyOn(os, "totalmem").mockReturnValue(gb(126));
    const readFileSync = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...rest) => {
      if (typeof filePath === "string" && filePath.startsWith("/sys/fs/cgroup/")) {
        if (Object.hasOwn(kCgroupFiles, filePath)) return kCgroupFiles[filePath];
        throw Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
      }
      return readFileSync.call(fs, filePath, ...rest);
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.WATCHDOG_AUTO_REPAIR;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
  });

  it("two hours armed: no leak verdict, no restart, no gateway memory notice", async () => {
    // The fixture parses to the working set (current minus inactive_file) and
    // the non-reclaimable usage (current minus all file pages plus shmem).
    expect(systemResources.parseCgroupMemory()).toEqual({
      usedBytes: gb(103.2), workingSetBytes: gb(103.2) - gb(60.5), totalBytes: gb(107.4),
      nonReclaimableBytes: gb(103.2) - gb(85.7),
    });
    const stack = createStack();
    const readProcess = vi.spyOn(collector, "getGatewayProcessSnapshot");
    const readTelemetry = vi.spyOn(telemetry, "readGatewayTelemetry");
    const readCgroup = vi.spyOn(systemResources, "parseCgroupMemory");
    for (let tick = 0; tick < kTicks; tick += 1) {
      const nowMs = kStartMs + tick * kTickMs;
      vi.setSystemTime(nowMs);
      readProcess.mockReturnValue(processAt(nowMs, tick));
      readTelemetry.mockReturnValue({ status: "fresh", reason: null, atMs: nowMs, records: [{
        seq: tick + 1, atMs: nowMs, rssBytes: (kWorkerMb + jitterMb(tick)) * kMb, heapUsedBytes: (kHeapUsedMb + jitterMb(tick)) * kMb,
        heapTotalBytes: (kHeapUsedMb + 200) * kMb, heapLimitBytes: kHeapLimitMb * kMb,
        externalBytes: 50 * kMb, arrayBuffersBytes: 10 * kMb, gc: null,
      }] });
      await stack.watchdog.checkMemoryTrend();
    }
    expect(readCgroup).toHaveBeenCalledTimes(kTicks);
    expect(readProcess).toHaveBeenLastCalledWith({ rootPid: kRoot.pid, workerPid: kWorker.pid, rootSource: "serving_root" });

    const trend = stack.watchdog.getMemoryTrend();
    expect(trend).toMatchObject({ state: "normal", rssBasis: "worker", capSource: "container_share",
      memoryMeasure: "private", restartAuthority: null });
    expect(Math.abs(trend.rssMb - kWorkerMb)).toBeLessThanOrEqual(3);
    expect(Math.abs(trend.groupRssMb - kGroupMb)).toBeLessThanOrEqual(3);
    expect(trend.containerPressureFraction).toBeCloseTo((103.2 - 85.7) / 107.4, 2);
    expect(trend.heap).toMatchObject({ status: "fresh", limitMb: kHeapLimitMb });
    expect(trend.heap.fraction).toBeLessThan(0.3);

    const kinds = stack.events().map((event) => event.details.kind);
    expect(kinds).not.toContain("leak_suspected");
    expect(kinds).not.toContain("leak_critical");
    expect(kinds).not.toContain("mitigation_restart");
    expect(stack.restart).not.toHaveBeenCalled();
    expect(stack.messages().some((message) => /Gateway memory|Restarting gateway/.test(message))).toBe(false);
  });
});

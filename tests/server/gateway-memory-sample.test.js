const systemResources = require("../../lib/server/system-resources");
const collector = require("../../lib/server/gateway-memory/process-snapshot");
const telemetry = require("../../lib/server/gateway-memory/telemetry");
const autotune = require("../../lib/server/autotune");
const { readGatewayMemorySample } = require("../../lib/server/gateway-memory/sample");
const { createGatewayMemoryMonitor } = require("../../lib/server/gateway-memory-monitor");

const kMb = 1024 * 1024;

describe("default gateway memory sample failure isolation", () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it("keeps proc/cgroup protection available when the telemetry reader throws", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const root = { pid: 100, startTicks: "200" };
    const worker = { pid: 101, startTicks: "201" };
    const target = { rootPid: root.pid, workerPid: worker.pid,
      rootSource: "serving_root", stateDir: "/unused/gateway-memory-test" };
    vi.spyOn(systemResources, "parseCgroupMemory").mockReturnValue({
      usedBytes: 950 * kMb, totalBytes: 1000 * kMb,
    });
    const readProcess = vi.spyOn(collector, "getGatewayProcessSnapshot");
    const readTelemetry = vi.spyOn(telemetry, "readGatewayTelemetry").mockImplementation(() => {
      throw Object.assign(new Error("telemetry reader unavailable"), { code: "EIO" });
    });
    vi.spyOn(autotune, "getActiveGatewayHeapMb").mockReturnValue(1024);
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    let trend;
    for (let tick = 0; tick < 3; tick += 1) {
      const nowMs = 1_700_000_000_000 + tick * 60_000;
      vi.setSystemTime(nowMs);
      const processSnapshot = { status: "fresh", atMs: nowMs, root, worker,
        groupRssBytes: (500 + tick * 50) * kMb };
      readProcess.mockReturnValue(processSnapshot);
      const sample = readGatewayMemorySample(target);
      expect(sample).toMatchObject({
        atMs: nowMs, cgroupAtMs: nowMs, sampleStatus: "fresh", identityToken: root.startTicks,
        rssBytes: processSnapshot.groupRssBytes, cgroupUsedBytes: 950 * kMb,
        containerLimitBytes: 1000 * kMb, activeHeapMb: 1024,
        process: processSnapshot, telemetry: null,
      });
      monitor.addSample({ ...sample, pid: root.pid });
      trend = monitor.evaluate(nowMs).snapshot;
    }
    expect(readProcess).toHaveBeenLastCalledWith({
      rootPid: root.pid, workerPid: worker.pid, rootSource: target.rootSource,
    });
    expect(readTelemetry).toHaveBeenLastCalledWith({ identity: worker, stateDir: target.stateDir });
    expect(trend).toMatchObject({ state: "critical", sampleStatus: "fresh", rssMb: 600,
      effectiveCapMb: 1216, pressureSource: "container", containerPressureFraction: 0.95 });
  });
});

describe("enforcement basis (ALPH-17)", () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const root = { pid: 100, startTicks: "200" };
  const worker = { pid: 101, startTicks: "201" };
  const target = { rootPid: root.pid, workerPid: worker.pid, rootSource: "serving_root", stateDir: "/unused/gateway-memory-test" };
  const census = (overrides = {}) => ({
    status: "fresh", reason: null, atMs: 1_700_000_000_000, root, worker,
    groupRssBytes: 7239 * kMb, workerRssBytes: 3837 * kMb, childRssBytes: 2754 * kMb, childCount: 2,
    contributors: [
      { pid: 100, role: "launcher", rssBytes: 648 * kMb },
      { pid: 101, role: "gateway", rssBytes: 3837 * kMb },
      { pid: 300, role: "gateway_child", rssBytes: 54 * kMb },
      { pid: 301, role: "gateway_child", rssBytes: 2700 * kMb },
    ],
    ...overrides,
  });
  const stub = (snapshot) => {
    vi.spyOn(systemResources, "parseCgroupMemory").mockReturnValue(null);
    vi.spyOn(telemetry, "readGatewayTelemetry").mockReturnValue(null);
    vi.spyOn(autotune, "getActiveGatewayHeapMb").mockReturnValue(8192);
    vi.spyOn(collector, "getGatewayProcessSnapshot").mockReturnValue(snapshot);
  };

  it("enforces the verified worker's own RSS and reports the group and children beside it", () => {
    stub(census());
    expect(readGatewayMemorySample({ ...target, workerVerified: true })).toMatchObject({
      rssBasis: "worker", rssBytes: 3837 * kMb, sampleStatus: "fresh", identityToken: "200:101:201",
      groupRssBytes: 7239 * kMb, workerRssBytes: 3837 * kMb, childRssBytes: 2754 * kMb, childCount: 2,
      largestChild: { pid: 301, rssBytes: 2700 * kMb },
    });
  });

  it("keeps a worker sample when the census went partial after the root and worker reads", () => {
    stub(census({ status: "partial", reason: "scan_deadline" }));
    expect(readGatewayMemorySample({ ...target, workerVerified: true })).toMatchObject({
      rssBasis: "worker", rssBytes: 3837 * kMb, sampleStatus: "fresh", groupRssBytes: null,
    });
  });

  it("falls back to the group, labelled, when the worker is not verified", () => {
    stub(census());
    expect(readGatewayMemorySample({ ...target, workerVerified: false })).toMatchObject({
      rssBasis: "group", rssBytes: 7239 * kMb, sampleStatus: "fresh", identityToken: "200",
    });
  });

  it("an inconsistent tree is not a worker sample", () => {
    stub(census({ status: "partial", reason: "invalid_sample" }));
    expect(readGatewayMemorySample({ ...target, workerVerified: true })).toMatchObject({
      rssBasis: "group", rssBytes: null, sampleStatus: "partial",
    });
  });
});

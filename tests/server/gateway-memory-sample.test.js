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

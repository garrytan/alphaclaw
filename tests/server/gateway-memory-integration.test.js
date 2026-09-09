const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// This fixture crosses the real process collector, the full one-hour
// attribution window, watchdog policy/notifications, public evidence projection
// and Doctor cards. Only proc bytes and gateway-reported telemetry are fake.
const kRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-attribution-integration-"));
process.env.ALPHACLAW_ROOT_DIR = kRoot;
const { createWatchdog } = require("../../lib/server/watchdog");
const { createGatewayProcessCollector } = require("../../lib/server/gateway-memory/process-snapshot");
const { withGatewayMemoryDetails } = require("../../lib/server/gateway-memory/resources");
const telemetryModule = require("../../lib/server/gateway-memory/telemetry");
const { buildDeterministicCards } = require("../../lib/server/doctor/deterministic-checks");
const { kStableProfile } = require("../../lib/server/doctor/context-profiles");

const kMb = 1024 * 1024;
const kStart = Date.parse("2026-09-09T00:00:00.000Z");
const kMinute = 60_000;
const kPssUnavailable = { status: "unavailable", reason: "unsupported", pssBytes: null, privateBytes: null };

const createProcFixture = () => {
  let processes = new Map();
  const handles = new Map();
  let nextFd = 0;
  const fsModule = {
    readdirSync: () => [...processes.keys()].map(String),
    openSync: (filePath) => {
      const match = /^\/proc\/(\d+)\/(stat|status)$/.exec(filePath);
      const proc = processes.get(Number(match?.[1]));
      if (!match || !proc) throw Object.assign(new Error("proc missing"), { code: "ENOENT" });
      const content = match[2] === "status"
        ? `Name:\tprivate-process-title\nPPid:\t${proc.parentPid}\nVmRSS:\t${proc.rssMb * 1024} kB\n`
        : `${match[1]} (private title) ${["S", proc.parentPid, ...new Array(17).fill(0), "100", 0, 0].join(" ")}\n`;
      const fd = ++nextFd;
      handles.set(fd, Buffer.from(content));
      return fd;
    },
    readSync: (fd, buffer, offset, length, position) => handles.get(fd).copy(buffer, offset, position, position + length),
    closeSync: (fd) => handles.delete(fd),
  };
  const collector = createGatewayProcessCollector({ fsModule, monotonicNowFn: () => 0,
    pssSampler: { read: () => ({ ...kPssUnavailable }), reset: () => {} } });
  return {
    sample: (tick, { rootPid = 100, workerPid = 200, growChildren = true } = {}) => {
      processes = new Map([
        [rootPid, { parentPid: 1, rssMb: 50 }],
        [workerPid, { parentPid: rootPid, rssMb: 1500 }],
        [500, { parentPid: rootPid, rssMb: 30 }],
      ]);
      for (let i = 0; i <= (growChildren ? tick : 0); i += 1) {
        processes.set(1000 + i, { parentPid: workerPid, rssMb: 20 });
      }
      return collector.getSnapshot({ rootPid, workerPid, rootSource: "serving_root", nowMs: Date.now() });
    },
    reset: collector.reset,
  };
};

const telemetryAt = (tick, { heapUsedMb = 500, heapLimitMb = 3500 } = {}) => ({
  status: "fresh", reason: null, atMs: Date.now(), records: [{
    seq: tick + 1, atMs: Date.now(), rssBytes: 1500 * kMb,
    heapUsedBytes: heapUsedMb * kMb, heapTotalBytes: Math.max(heapUsedMb, 600) * kMb,
    heapLimitBytes: heapLimitMb * kMb, externalBytes: 100 * kMb, arrayBuffersBytes: 20 * kMb,
    gc: { atMs: Date.now(), heapUsedBytes: Math.min(heapUsedMb, 300) * kMb, count: 1 },
  }],
});

const liveHarnesses = [];
const createHarness = () => {
  const source = createProcFixture();
  let currentSample = {};
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const insertWatchdogEvent = vi.fn();
  const restart = vi.fn(async () => ({ ok: true }));
  const watchdog = createWatchdog({
    clawCmd: async () => ({ ok: true, stdout: "{}" }),
    launchGatewayProcess: () => ({ pid: 100 }),
    probeGatewayTcp: async () => ({ running: true }),
    readProcStartTicks: () => 100,
    notifier, insertWatchdogEvent,
    readEnvFile: () => [], writeEnvFile: () => {}, reloadEnv: () => {},
    resolveSetupUrl: () => "http://localhost:3000",
    sleepImpl: () => Promise.resolve(),
    readMemorySettings: () => ({ enabled: true, autoRestart: false, effectiveAutoRestart: false }),
    readMemorySample: () => currentSample,
    restartGatewayForMitigation: restart,
  });
  watchdog.onGatewayLaunch({ pid: 100, workerPid: 200, startedAt: Date.now() });
  const harness = {
    source, watchdog, notifier, insertWatchdogEvent, restart,
    current: () => currentSample,
    tick: async (tick, { rootPid = 100, workerPid = 200, growChildren = true,
      containerCritical = false, activeHeapMb = 4808, heapUsedMb = 500, heapLimitMb = 3500 } = {}) => {
      vi.setSystemTime(kStart + tick * kMinute);
      const processSnapshot = source.sample(tick, { rootPid, workerPid, growChildren });
      currentSample = {
        atMs: processSnapshot.atMs, cgroupAtMs: Date.now(), sampleStatus: processSnapshot.status,
        identityToken: processSnapshot.root.startTicks,
        rssBytes: processSnapshot.status === "fresh" ? processSnapshot.groupRssBytes : null,
        cgroupUsedBytes: (containerCritical ? 9500 : 4000) * kMb,
        containerLimitBytes: 10000 * kMb, activeHeapMb,
        process: processSnapshot, telemetry: telemetryAt(tick, { heapUsedMb, heapLimitMb }),
      };
      await watchdog.checkMemoryTrend();
      return watchdog.getMemoryTrend();
    },
  };
  liveHarnesses.push(harness);
  return harness;
};

const doctorCards = (memoryTrend) => buildDeterministicCards({
  workspaceRoot: kRoot, managedRoot: kRoot, profile: kStableProfile,
  memoryTrend, onboarded: true, releaseChannel: "stable", readLatestDoctorRun: () => null,
});
const messages = (harness) => harness.notifier.notify.mock.calls.map(([message]) => message);

describe("gateway memory attribution across operational surfaces", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(kStart);
    process.env.WATCHDOG_AUTO_REPAIR = "false";
    process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
  });
  afterEach(() => {
    for (const harness of liveHarnesses.splice(0)) { harness.watchdog.stop(); harness.source.reset(); }
    delete process.env.WATCHDOG_AUTO_REPAIR;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(() => fs.rmSync(kRoot, { recursive: true, force: true }));

  it("attributes growing children, alerts for actual container pressure, and preserves the explanation after restart", async () => {
    const harness = createHarness();
    for (let tick = 0; tick < 80; tick += 1) await harness.tick(tick, { containerCritical: tick >= 70 });
    const trend = harness.watchdog.getMemoryTrend();
    expect(trend.state).toBe("critical");
    expect(trend.container.state).toBe("critical");
    expect(trend.evidence.attribution.causes).toContain("child_accumulation");
    expect(trend.evidence.attribution.causes).not.toContain("possible_heap_retention");
    expect(trend.evidence.process.workerRssBytes).toBe(1500 * kMb);
    expect(trend.evidence.telemetry.heapUsedBytes).toBe(500 * kMb);
    expect(trend.evidence.process.launcherRssBytes).toBe(80 * kMb);
    const notices = messages(harness);
    expect(notices.some((message) => /container memory critical/i.test(message))).toBe(true);
    expect(notices.some((message) => message.includes("child-process count and RSS grew"))).toBe(true);
    expect(notices.join("\n")).not.toMatch(/confirmed (heap )?leak|exhaustion imminent|will be killed by V8/i);
    expect(harness.restart).not.toHaveBeenCalled();

    // This is the actual public resources projection used by the route;
    // telemetry is injected at its reader boundary, never pre-projected.
    vi.spyOn(telemetryModule, "readGatewayTelemetry").mockImplementation(() => harness.current().telemetry);
    const resources = withGatewayMemoryDetails({ gatewayMemory: harness.current().process }, trend);
    expect(resources.gatewayMemory.process.groupRssBytes).toBe(3180 * kMb);
    expect(resources.gatewayMemory.process.pss.pssBytes).toBeNull();
    expect(resources.gatewayMemory.attribution.causes).toContain("child_accumulation");
    expect(resources.gatewayMemory.telemetry).not.toHaveProperty("records");
    expect(JSON.stringify(resources)).not.toContain("private-process-title");
    const critical = doctorCards(trend).find((card) => card.sourceKey.startsWith("det:gateway-memory-leak-critical:"));
    expect(critical.priority).toBe("P0");
    expect(critical.summary).toContain("child-process count and RSS grew");

    const episodeId = trend.episodeId;
    vi.setSystemTime(kStart + 80 * kMinute);
    harness.watchdog.onGatewayLaunch({ pid: 101, workerPid: 201, startedAt: Date.now() });
    const replacement = await harness.tick(80, { rootPid: 101, workerPid: 201, growChildren: false });
    expect(replacement.state).toBe("warming_up");
    expect(replacement.lastEpisodeSummary).toMatchObject({ episodeId, reason: "process_exited", capSource: "derived_group_budget" });
    expect(replacement.lastEpisodeSummary.evidence.attribution.causes).toContain("child_accumulation");
    const recent = doctorCards(replacement).find((card) => card.sourceKey.startsWith("det:gateway-memory-leak-recent:"));
    expect(recent.priority).toBe("P2");
    expect(recent.summary).toContain("child-process count and RSS grew");
  });

  it("gateway-reported high heap pressure cannot force group protection on a flat process tree", async () => {
    const harness = createHarness();
    for (let tick = 0; tick < 75; tick += 1) {
      await harness.tick(tick, { growChildren: false, heapUsedMb: 3000, heapLimitMb: 3100 });
    }
    const trend = harness.watchdog.getMemoryTrend();
    expect(trend.state).toBe("normal");
    expect(trend.container.state).toBe("normal");
    expect(messages(harness).some((message) => /memory critical/i.test(message))).toBe(false);
    expect(harness.restart).not.toHaveBeenCalled();
  });

  it("gateway-reported low heap pressure cannot mute actual process-group budget pressure", async () => {
    const harness = createHarness();
    for (let tick = 0; tick < 75; tick += 1) {
      await harness.tick(tick, { activeHeapMb: 1808, heapUsedMb: 1, heapLimitMb: 100000 });
    }
    const trend = harness.watchdog.getMemoryTrend();
    expect(trend.state).toBe("critical");
    expect(trend.capSource).toBe("derived_group_budget");
    expect(trend.effectiveCapMb).toBe(2000);
    expect(trend.container.state).toBe("normal");
    expect(trend.evidence.attribution.causes).toContain("child_accumulation");
    expect(messages(harness).some((message) => /gateway memory critical/i.test(message))).toBe(true);
  });
});

const fs = require("fs");
const os = require("os");
const path = require("path");

const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-disk-space-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const { createWatchdog } = require("../../lib/server/watchdog");

const kGb = 1024 ** 3;

const createHarness = (diskSpace) => {
  process.env.WATCHDOG_AUTO_REPAIR = "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
  const insertWatchdogEvent = vi.fn();
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
    launchGatewayProcess: vi.fn(() => null),
    probeGatewayTcp: async () => ({ running: false }),
    insertWatchdogEvent,
    notifier,
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "http://localhost:3000",
    sleepImpl: () => Promise.resolve(),
    readMemorySample: vi.fn(() => ({})),
    readMemorySettings: () => ({ enabled: false, autoRestart: false, effectiveAutoRestart: false }),
    memoryMitigationStatePath: path.join(kTempRoot, `mitigation-${Math.random()}.json`),
    pidAlive: () => false,
    readProcStartTicks: () => null,
    resolvePidVerdict: () => "gone",
    ...(diskSpace ? { diskSpace } : {}),
  });
  const diskEvents = () => insertWatchdogEvent.mock.calls.map(([event]) => event).filter((event) => event.eventType === "disk");
  return { watchdog, notifier, diskEvents };
};

describe("watchdog: disk-space wiring", () => {
  afterEach(() => {
    delete process.env.WATCHDOG_AUTO_REPAIR;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
  });
  afterAll(() => fs.rmSync(kTempRoot, { recursive: true, force: true }));

  it("is off without options: no sampling and no snapshot", async () => {
    const { watchdog } = createHarness(null);
    try {
      watchdog.start();
      expect(watchdog.getDiskSpace()).toBeNull();
    } finally {
      await watchdog.stop();
    }
  });

  it("samples on start, logs and notifies through the watchdog, exposes getDiskSpace, and stops with it", async () => {
    const readVolumes = vi.fn(() => [{
      id: "state", path: "/data/.openclaw", mountPath: "/data", dev: 2, status: "fresh", freeBytes: 2 * kGb, sizeBytes: 100 * kGb,
    }]);
    const runCensus = vi.fn(async () => ({ atMs: Date.now(), truncated: false, dirs: [{ path: "/data/.openclaw", bytes: 90 * kGb, rootDev: 2 }] }));
    const { watchdog, notifier, diskEvents } = createHarness({ stateDir: "/data/.openclaw", env: {}, readVolumes, runCensus, sampleIntervalMs: 20 });
    try {
      watchdog.start();
      await vi.waitFor(() => expect(notifier.notify.mock.calls.some(([, opts]) => opts?.eventType === "disk")).toBe(true));
      const [message, opts] = notifier.notify.mock.calls.find(([, o]) => o?.eventType === "disk");
      expect(message).toContain("🐺 *AlphaClaw Watchdog*\n🔴 Disk almost full on /data - [View logs](http://localhost:3000/#/watchdog)");
      expect(opts).toMatchObject({ eventType: "disk", verbose: false, audit: false });
      expect(diskEvents()[0]).toMatchObject({ source: "disk-monitor", status: "warning", details: { kind: "disk_critical", volume: "state" } });
      const snapshot = watchdog.getDiskSpace();
      expect(snapshot.volumes[0]).toMatchObject({ id: "state", state: "critical", freeBytes: 2 * kGb });
      expect(snapshot.volumes[0].episodeId).toMatch(/^disk-state-\d+$/);
      await vi.waitFor(() => expect(readVolumes.mock.calls.length).toBeGreaterThan(1));
    } finally {
      await watchdog.stop();
    }
    const calls = readVolumes.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(readVolumes.mock.calls.length).toBe(calls);
    expect(notifier.notify.mock.calls.filter(([, o]) => o?.eventType === "disk")).toHaveLength(1);
  });
});

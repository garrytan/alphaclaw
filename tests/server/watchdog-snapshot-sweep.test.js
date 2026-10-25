const fs = require("fs");
const os = require("os");
const path = require("path");

const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-snapshot-sweep-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const { createWatchdog } = require("../../lib/server/watchdog");

const createHarness = (options) => {
  process.env.WATCHDOG_AUTO_REPAIR = "false";
  const watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
    launchGatewayProcess: vi.fn(() => null),
    probeGatewayTcp: async () => ({ running: false }),
    insertWatchdogEvent: vi.fn(),
    notifier: { notify: vi.fn(async () => ({ ok: true })) },
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
    ...options,
  });
  return { watchdog };
};

describe("watchdog: periodic snapshot sweep", () => {
  afterEach(() => {
    delete process.env.WATCHDOG_AUTO_REPAIR;
  });
  afterAll(() => fs.rmSync(kTempRoot, { recursive: true, force: true }));

  it("defaults to the 30-minute cadence", () => {
    expect(require("../../lib/server/openclaw-snapshot-sweep").kSnapshotSweepIntervalMs).toBe(30 * 60 * 1000);
  });

  it("sweeps on its interval between start() and stop(), never at start itself", async () => {
    const sweepSnapshotCopies = vi.fn();
    const { watchdog } = createHarness({ sweepSnapshotCopies, snapshotSweepIntervalMs: 20 });
    try {
      watchdog.start();
      expect(sweepSnapshotCopies).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(sweepSnapshotCopies.mock.calls.length).toBeGreaterThan(1));
    } finally {
      await watchdog.stop();
    }
    const calls = sweepSnapshotCopies.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sweepSnapshotCopies.mock.calls.length).toBe(calls);
  });

  it("keeps ticking after a sweep throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const sweepSnapshotCopies = vi.fn(() => {
      throw new Error("boom");
    });
    const { watchdog } = createHarness({ sweepSnapshotCopies, snapshotSweepIntervalMs: 20 });
    try {
      watchdog.start();
      await vi.waitFor(() => expect(sweepSnapshotCopies.mock.calls.length).toBeGreaterThan(1));
      expect(error).toHaveBeenCalledWith("[watchdog] snapshot sweep failed: boom");
    } finally {
      await watchdog.stop();
      error.mockRestore();
    }
  });
  it("reports its runs and its interval to the box schedule list (ALPH-40)", async () => {
    const { createScheduleRegistry } = require("../../lib/server/box-status/schedule-registry");
    const scheduleRegistry = createScheduleRegistry();
    const sweepSnapshotCopies = vi.fn(() => ({ candidates: 3, removed: 2 }));
    const { watchdog } = createHarness({ sweepSnapshotCopies, snapshotSweepIntervalMs: 20, scheduleRegistry });
    try {
      watchdog.start();
      await vi.waitFor(() => expect(sweepSnapshotCopies).toHaveBeenCalled());
      const byId = Object.fromEntries(scheduleRegistry.list().map((entry) => [entry.id, entry]));
      expect(byId["watchdog.snapshot_sweep"]).toMatchObject({ active: true, lastOutcome: "ok", lastDetail: "removed 2 of 3" });
      expect(byId["watchdog.snapshot_sweep"].nextRunAt).not.toBeNull();
      expect(byId["watchdog.memory"]).toMatchObject({ active: true });
      expect(byId["watchdog.memory"].runs).toBeGreaterThan(0);
    } finally {
      await watchdog.stop();
    }
    const byId = Object.fromEntries(scheduleRegistry.list().map((entry) => [entry.id, entry]));
    expect(byId["watchdog.snapshot_sweep"]).toMatchObject({ active: false, nextRunAt: null });
    expect(byId["watchdog.memory"]).toMatchObject({ active: false });
  });
});

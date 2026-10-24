const fs = require("fs");
const os = require("os");
const path = require("path");

const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "watchdog-container-restart-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const { createWatchdog } = require("../../lib/server/watchdog");
const { resetProcessBootIdForTests } = require("../../lib/server/boot-id");
const containerCensus = require("../../lib/server/gateway-memory/container-census");
const processCommand = require("../../lib/server/gateway-memory/process-command");

// ALPH-25 end to end through the watchdog: a process outside the gateway
// fills a Render-style container (no kernel kill, memory.events max rising),
// the owner gets the notice, the process dies without a clean shutdown, and
// the next process's watchdog records container_restarted_at_limit and tells
// the owner once.
const kGb = 1024 ** 3;
const kLimit = 100 * kGb;
const kStartMs = Date.parse("2026-10-24T07:00:00.000Z");
const kTickMs = 60_000;

const createHarness = ({ recordPath, processStartedAtMs }) => {
  process.env.WATCHDOG_AUTO_REPAIR = "false";
  process.env.WATCHDOG_NOTIFICATIONS_DISABLED = "false";
  const insertWatchdogEvent = vi.fn();
  const notifier = { notify: vi.fn(async () => ({ ok: true })) };
  const readMemorySample = vi.fn(() => ({}));
  const watchdog = createWatchdog({
    clawCmd: vi.fn(async () => ({ ok: true, stdout: "{}" })),
    launchGatewayProcess: vi.fn(() => ({ pid: 4242 })),
    probeGatewayTcp: async () => ({ running: true }),
    insertWatchdogEvent,
    notifier,
    readEnvFile: vi.fn(() => []),
    writeEnvFile: vi.fn(),
    reloadEnv: vi.fn(),
    resolveSetupUrl: () => "http://localhost:3000",
    sleepImpl: () => Promise.resolve(),
    readMemorySample,
    readMemorySettings: () => ({ enabled: true, autoRestart: false, effectiveAutoRestart: false }),
    memoryNoticeHoldMs: 0,
    memoryMitigationStatePath: path.join(kTempRoot, `mitigation-${Math.random()}.json`),
    containerPressureRecordPath: recordPath,
    readProcessStartedAtMs: () => processStartedAtMs,
  });
  const memoryEvents = () => insertWatchdogEvent.mock.calls.map(([event]) => event).filter((event) => event.eventType === "memory");
  const messages = () => notifier.notify.mock.calls.map(([message]) => message);
  return { watchdog, readMemorySample, memoryEvents, messages, notifier };
};

const containerSample = (atMs, usedGb, max) => ({
  cgroupAtMs: atMs, cgroupUsedBytes: usedGb * kGb, containerLimitBytes: kLimit, cgroupUsageBasis: "non_reclaimable",
  cgroupPressure: { psi: { some: { avg10: 40, avg60: 31, avg300: 10 }, full: { avg10: 20, avg60: 14, avg300: 4 } },
    events: { source: "memory.events", high: 0, max, oom: 0, oomKill: 0 } },
});

describe("watchdog: container restarted at its memory limit (ALPH-25)", () => {
  const priorRender = process.env.RENDER;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    process.env.RENDER = "true";
    resetProcessBootIdForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetProcessBootIdForTests();
    if (priorRender === undefined) delete process.env.RENDER; else process.env.RENDER = priorRender;
    delete process.env.WATCHDOG_AUTO_REPAIR;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
  });

  it("notifies before the restart, then records and tells the boot cause once after it", async () => {
    const recordPath = path.join(fs.mkdtempSync(path.join(kTempRoot, "record-")), "container-pressure.json");
    const census = vi.spyOn(containerCensus, "readLargestContainerProcess");
    vi.spyOn(processCommand, "readProcessCommand").mockReturnValue("bun");

    vi.setSystemTime(kStartMs);
    const first = createHarness({ recordPath, processStartedAtMs: kStartMs - 3_600_000 });
    const ticks = [[80, 0, 40], [93, 1500, 60], [97, 4100, 64]];
    for (const [i, [usedGb, max, rssGb]] of ticks.entries()) {
      const atMs = kStartMs + i * kTickMs;
      vi.setSystemTime(atMs);
      census.mockReturnValue({ status: "fresh", largest: { pid: 7001, startTicks: "5", rssBytes: rssGb * kGb } });
      first.readMemorySample.mockReturnValue(containerSample(atMs, usedGb, max));
      await first.watchdog.checkMemoryTrend();
    }
    await Promise.resolve();
    await Promise.resolve();
    const alert = first.messages().find((message) => message.includes("Container memory critical"));
    // No gateway is running in this harness, so the process is not called outside the gateway.
    expect(alert).toContain("The largest process in the container is `bun`, at 64.0 GB and growing at 4.0 GB/min.");
    expect(alert).toContain("Render will restart the whole container when it reaches its limit, and the gateway goes down with it.");
    expect(alert).toContain("Memory pressure over the last minute (PSI avg60): some 31.0%, full 14.0%.");
    expect(first.memoryEvents().find((event) => event.details.kind === "container_critical").details)
      .toMatchObject({ limitBehavior: { kind: "instance_restart", platform: "render", oomKills: 0 } });

    // The platform kills the container: no stop(), so no clean-shutdown mark.
    resetProcessBootIdForTests();
    const restartedAtMs = kStartMs + 2 * kTickMs + 75_000;
    vi.setSystemTime(restartedAtMs);
    const second = createHarness({ recordPath, processStartedAtMs: restartedAtMs - 5_000 });
    second.readMemorySample.mockReturnValue({});
    try {
      second.watchdog.start();
      await Promise.resolve();
    } finally {
      second.watchdog.stop();
    }
    const restarted = second.memoryEvents().filter((event) => event.details.kind === "container_restarted_at_limit");
    expect(restarted).toHaveLength(1);
    expect(restarted[0]).toMatchObject({ status: "warning", details: {
      scope: "container", lastSampleAt: new Date(kStartMs + 2 * kTickMs).toISOString(),
      usedBytes: 97 * kGb, limitBytes: kLimit, largestProcess: { rssBytes: 64 * kGb },
    } });
    expect(JSON.stringify(restarted[0].details)).not.toContain("bun");
    const notice = second.messages().find((message) => message.includes("Restarted at the container's memory limit"));
    expect(notice).toContain("AlphaClaw restarted after the container hit its memory limit; the largest process was `bun` at 64.0 GB.");
    expect(notice).toContain("97.0 GB of its 100.0 GB limit (97%, last sampled at 07:02 UTC)");
    expect(second.notifier.notify.mock.calls.find(([message]) => message === notice)[1])
      .toMatchObject({ eventType: "memory", id: `container-restart-at-limit-${kStartMs + 2 * kTickMs}` });

    // A third boot does not repeat it.
    resetProcessBootIdForTests();
    const third = createHarness({ recordPath, processStartedAtMs: restartedAtMs + 60_000 });
    third.readMemorySample.mockReturnValue({});
    try { third.watchdog.start(); } finally { third.watchdog.stop(); }
    expect(third.memoryEvents().some((event) => event.details.kind === "container_restarted_at_limit")).toBe(false);
  });

  it("a clean shutdown while the container is full is not a restart at the limit", async () => {
    const recordPath = path.join(fs.mkdtempSync(path.join(kTempRoot, "record-")), "container-pressure.json");
    vi.spyOn(containerCensus, "readLargestContainerProcess").mockReturnValue({ status: "unavailable", largest: null });
    vi.setSystemTime(kStartMs);
    const first = createHarness({ recordPath, processStartedAtMs: kStartMs - 3_600_000 });
    first.readMemorySample.mockReturnValue(containerSample(kStartMs, 97, 10));
    await first.watchdog.checkMemoryTrend();
    first.watchdog.stop();
    resetProcessBootIdForTests();
    const second = createHarness({ recordPath, processStartedAtMs: kStartMs + 30_000 });
    second.readMemorySample.mockReturnValue({});
    try { second.watchdog.start(); } finally { second.watchdog.stop(); }
    expect(second.memoryEvents().some((event) => event.details.kind === "container_restarted_at_limit")).toBe(false);
  });
});

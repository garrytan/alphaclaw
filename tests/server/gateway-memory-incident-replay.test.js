const fs = require("fs");
const os = require("os");
const path = require("path");

// Oct 22 incident replay (ALPH-17): a `bun add -g` child the gateway started
// grew to 2754 MB at ~2021 MB/h while the gateway worker sat flat at
// 3837 MB. The process group (7239 MB at 11:14Z) was judged against the
// single-process budget (8192 MB heap + 192 MiB = 8384 MB): leak verdict,
// mitigation restart, the agent's turn killed mid-run. Driven through the
// real watchdog tick with the DEFAULT sample reader; only the /proc census,
// the cgroup read, telemetry and the configured heap are scripted.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-incident-replay-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;

const systemResources = require("../../lib/server/system-resources");
const collector = require("../../lib/server/gateway-memory/process-snapshot");
const processCommand = require("../../lib/server/gateway-memory/process-command");
const containerCensus = require("../../lib/server/gateway-memory/container-census");
const telemetry = require("../../lib/server/gateway-memory/telemetry");
const autotune = require("../../lib/server/autotune");
const { createWatchdog } = require("../../lib/server/watchdog");

const kMb = 1024 * 1024;
const kTickMs = 60_000;
const kStartMs = Date.parse("2026-10-22T10:00:00.000Z");
const kIncidentMs = Date.parse("2026-10-22T11:14:00.000Z");
const kRoot = { pid: 100, startTicks: "200" };
const kWorker = { pid: 101, startTicks: "201" };
const kChildPid = 4242;
const kWorkerMb = 3837;
const kLauncherMb = 7239 - 3837 - 2754;
const kChildSlopeMbPerMs = 2021 / 3_600_000;
// Not in the incident record: the container limit and the page cache beside
// the group. Chosen so the container crosses 90% during the replay, which is
// when the child alert is due.
const kContainerLimitMb = 8192;
const kContainerOtherMb = 400;
// Also chosen (ALPH-25): the kernel has killed a process in this container
// before and is reclaiming, so the alert is due and says the kernel kills.
const kContainerPressure = {
  psi: { some: { avg10: 15, avg60: 12, avg300: 4 }, full: { avg10: 4, avg60: 3, avg300: 1 } },
  events: { source: "memory.events", high: 0, max: 120, oom: 1, oomKill: 1 },
};

const childMbAt = (nowMs) => 2754 + (nowMs - kIncidentMs) * kChildSlopeMbPerMs;
// Deterministic ±3 MB jitter: a flat worker is never perfectly flat.
const jitterMb = (tick) => [0, 3, -2, 1, -3, 2][tick % 6];

const processAt = (nowMs, tick, { workerMb = kWorkerMb + jitterMb(tick), childMb = childMbAt(nowMs) } = {}) => {
  const groupMb = kLauncherMb + workerMb + childMb;
  return {
    status: "fresh", reason: null, atMs: nowMs, root: kRoot, worker: kWorker, rootSource: "serving_root",
    groupRssBytes: groupMb * kMb, workerRssBytes: workerMb * kMb, childRssBytes: childMb * kMb, childCount: 1,
    launcherRssBytes: kLauncherMb * kMb, launcherCount: 1, processCount: 3, sampledProcessCount: 3,
    contributors: [
      { pid: kRoot.pid, role: "launcher", rssBytes: kLauncherMb * kMb },
      { pid: kWorker.pid, role: "gateway", rssBytes: workerMb * kMb },
      { pid: kChildPid, role: "gateway_child", rssBytes: childMb * kMb },
    ],
  };
};

const createStack = ({ workerVerified }) => {
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
    memoryMitigationStatePath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "incident-mitigation-")), "state.json"),
  });
  watchdog.onGatewayLaunch({ startedAt: kStartMs, pid: kRoot.pid, rootPid: kRoot.pid,
    startTicks: Number(kRoot.startTicks), servingPid: kWorker.pid, workerVerified });
  const events = () => insertWatchdogEvent.mock.calls.map(([event]) => event).filter((e) => e.eventType === "memory");
  const messages = () => notifier.notify.mock.calls.map(([message]) => message);
  return { watchdog, restart, events, messages };
};

const replay = async (stack, { untilMs, processFor = processAt }) => {
  const readProcess = vi.spyOn(collector, "getGatewayProcessSnapshot");
  const readCgroup = vi.spyOn(systemResources, "parseCgroupMemory");
  vi.spyOn(systemResources, "parseCgroupPressure").mockReturnValue(kContainerPressure);
  vi.spyOn(containerCensus, "readLargestContainerProcess").mockReturnValue({ status: "unavailable", largest: null });
  for (let tick = 0; kStartMs + tick * kTickMs <= untilMs; tick += 1) {
    const nowMs = kStartMs + tick * kTickMs;
    vi.setSystemTime(nowMs);
    const snapshot = processFor(nowMs, tick);
    readProcess.mockReturnValue(snapshot);
    readCgroup.mockReturnValue({ workingSetBytes: snapshot.groupRssBytes + kContainerOtherMb * kMb,
      usedBytes: snapshot.groupRssBytes + kContainerOtherMb * kMb, totalBytes: kContainerLimitMb * kMb });
    await stack.watchdog.checkMemoryTrend();
  }
  return readProcess;
};

describe("Oct 22 memory incident replay", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.spyOn(telemetry, "readGatewayTelemetry").mockReturnValue(null);
    vi.spyOn(autotune, "getActiveGatewayHeapMb").mockReturnValue(8192);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete process.env.WATCHDOG_AUTO_REPAIR;
    delete process.env.WATCHDOG_NOTIFICATIONS_DISABLED;
  });

  it("a growing tool child with a flat verified worker: no leak verdict, no restart, one alert naming the child", async () => {
    const readCommand = vi.spyOn(processCommand, "readProcessCommand").mockReturnValue("bun");
    const stack = createStack({ workerVerified: true });
    // Through 11:30Z: the group crosses 90% of the 8384 MB budget at ~11:23Z.
    const readProcess = await replay(stack, { untilMs: Date.parse("2026-10-22T11:30:00.000Z") });
    expect(readProcess).toHaveBeenLastCalledWith({ rootPid: kRoot.pid, workerPid: kWorker.pid, rootSource: "serving_root" });

    const kinds = stack.events().map((event) => event.details.kind);
    expect(kinds).not.toContain("leak_suspected");
    expect(kinds).not.toContain("leak_critical");
    expect(kinds).not.toContain("mitigation_restart");
    expect(stack.restart).not.toHaveBeenCalled();
    const trend = stack.watchdog.getMemoryTrend();
    expect(trend).toMatchObject({ state: "normal", rssBasis: "worker" });
    expect(trend.rssMb).toBeGreaterThanOrEqual(kWorkerMb - 3);
    expect(trend.rssMb).toBeLessThanOrEqual(kWorkerMb + 3);

    const alerts = stack.messages().filter((message) => message.includes("Container memory critical"));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("a tool process, not the gateway");
    expect(alerts[0]).toMatch(/`bun`, a process the gateway started, is using \d+ MB\. The container is using \d+ MB of its 8192 MB limit \(\d+%, not counting inactive page cache\), and the gateway worker is 38\d\d MB\./);
    expect(alerts[0]).toContain("the kernel will kill it when the container runs out of memory");
    expect(alerts[0]).toContain("will not restart the gateway");
    expect(alerts[0]).not.toContain(String(kChildPid));
    expect(readCommand).toHaveBeenCalledWith(kChildPid);
    const critical = stack.events().find((event) => event.details.kind === "container_critical");
    expect(critical.details).toMatchObject({ childDriven: true, largestChild: { pid: kChildPid } });
  });

  it("the same replay when the worker is only the first-child guess warns about the group, labelled, and never goes critical", async () => {
    const stack = createStack({ workerVerified: false });
    const readProcess = await replay(stack, { untilMs: Date.parse("2026-10-22T11:30:00.000Z") });
    expect(readProcess).toHaveBeenLastCalledWith({ rootPid: kRoot.pid, workerPid: kWorker.pid, rootSource: "serving_root" });

    const kinds = stack.events().map((event) => event.details.kind);
    expect(kinds).toContain("leak_suspected");
    expect(kinds).not.toContain("leak_critical");
    expect(kinds).not.toContain("mitigation_restart");
    const trend = stack.watchdog.getMemoryTrend();
    expect(trend.rssBasis).toBe("group");
    expect(trend.state).not.toBe("critical");
    expect(stack.restart).not.toHaveBeenCalled();
    expect(stack.messages().some((message) => message.includes("Group RSS (gateway plus its tool children)"))).toBe(true);
  });

  it("a later launch redelivery that proves the worker switches the reader to the worker basis", async () => {
    const stack = createStack({ workerVerified: false });
    await replay(stack, { untilMs: kStartMs + 2 * kTickMs });
    expect(stack.watchdog.getMemoryTrend().rssBasis).toBe("group");
    stack.watchdog.onGatewayLaunch({ startedAt: kStartMs, pid: kRoot.pid, rootPid: kRoot.pid,
      startTicks: Number(kRoot.startTicks), servingPid: kWorker.pid, workerVerified: true });
    vi.setSystemTime(kStartMs + 3 * kTickMs);
    await stack.watchdog.checkMemoryTrend();
    expect(stack.watchdog.getMemoryTrend()).toMatchObject({ rssBasis: "worker" });
  });

  it("a verified worker that is itself leaking still latches and is mitigated", async () => {
    const stack = createStack({ workerVerified: true });
    const leakStartMs = kStartMs;
    // Worker from 6000 MB at ~2021 MB/h: crosses 90% of 8384 MB (7546 MB)
    // ~46 minutes in; the child stays small and flat.
    await replay(stack, {
      untilMs: Date.parse("2026-10-22T11:10:00.000Z"),
      processFor: (nowMs, tick) => processAt(nowMs, tick, {
        workerMb: 6000 + (nowMs - leakStartMs) * kChildSlopeMbPerMs, childMb: 150,
      }),
    });
    const kinds = stack.events().map((event) => event.details.kind);
    expect(kinds).toContain("leak_critical");
    expect(kinds).toContain("mitigation_restart");
    expect(stack.restart).toHaveBeenCalledTimes(1);
  });
});

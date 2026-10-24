const { createContainerPressureTracker } = require("../../lib/server/gateway-memory/container-alerts");
const processCommand = require("../../lib/server/gateway-memory/process-command");
const containerCensus = require("../../lib/server/gateway-memory/container-census");

const kMb = 1024 * 1024;
const childEvidence = ({ workerMb = 600, childMb = 3046, childPid = 1392 } = {}) => ({
  process: {
    status: "fresh", workerRssBytes: workerMb * kMb, childRssBytes: childMb * kMb, childCount: 1, processCount: 2,
    groupRssBytes: (workerMb + childMb) * kMb,
    contributors: [
      { pid: 101, role: "gateway", rssBytes: workerMb * kMb },
      { pid: childPid, role: "gateway_child", rssBytes: childMb * kMb },
    ],
  },
  attribution: { state: "attributed", causes: ["child_growth"] },
});

// A container where the kernel has already killed a process: memory.events
// oom_kill > 0, with reclaim pressure on the PSI line.
const kernelKillPressure = {
  psi: { some: { avg10: 30, avg60: 22.5, avg300: 8 }, full: { avg10: 12, avg60: 9.25, avg300: 3 } },
  events: { source: "memory.events", high: 0, max: 840, oom: 3, oomKill: 2 },
};

const setup = (notifyOnce) => {
  const logEvent = vi.fn();
  const forgetEpisode = vi.fn();
  const tracker = createContainerPressureTracker({
    logEvent, forgetEpisode, notifyOnce,
    createCorrelationId: () => "correlation", withViewLogsSuffix: (text) => text,
  });
  let atMs = 1000;
  return { tracker, logEvent, forgetEpisode, sample(usedBytes = 95) {
    atMs += 1000;
    return tracker.sample({ cgroupAtMs: atMs, cgroupUsedBytes: usedBytes, containerLimitBytes: 100 }, atMs);
  } };
};

describe("container alert delivery is independent of memory enforcement", () => {
  beforeEach(() => {
    vi.spyOn(containerCensus, "readLargestContainerProcess").mockReturnValue({ status: "unavailable", largest: null });
  });
  afterEach(() => vi.restoreAllMocks());

  it("returns pressure immediately while one pending notification is bounded", async () => {
    let finish;
    const notifyOnce = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const fixture = setup(notifyOnce);
    fixture.sample();
    expect(fixture.sample().state).toBe("critical");
    await Promise.resolve();
    expect(notifyOnce).toHaveBeenCalledOnce();
    expect(fixture.sample().state).toBe("critical");
    expect(fixture.sample().state).toBe("critical");
    await Promise.resolve();
    expect(notifyOnce).toHaveBeenCalledOnce();
    expect(fixture.sample(20).state).toBe("critical");
    fixture.sample(20);
    expect(fixture.sample(20).state).toBe("normal");
    expect(fixture.forgetEpisode).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
  });

  it("a child-driven critical tells the owner the child's command and RSS against the limit, never its pid", async () => {
    const readCommand = vi.spyOn(processCommand, "readProcessCommand").mockReturnValue("python3");
    const notifyOnce = vi.fn().mockResolvedValue(true);
    const logEvent = vi.fn();
    const tracker = createContainerPressureTracker({
      logEvent, notifyOnce, forgetEpisode: vi.fn(),
      createCorrelationId: () => "correlation", withViewLogsSuffix: (text) => text,
    });
    const limit = 5120 * kMb;
    tracker.sample({ cgroupAtMs: 1000, cgroupUsedBytes: 4874 * kMb, containerLimitBytes: limit, cgroupPressure: kernelKillPressure }, 1000, childEvidence());
    tracker.sample({ cgroupAtMs: 2000, cgroupUsedBytes: 4874 * kMb, containerLimitBytes: limit, cgroupPressure: kernelKillPressure }, 2000, childEvidence());
    await Promise.resolve();
    expect(notifyOnce).toHaveBeenCalledOnce();
    const [episodeId, kind, message] = notifyOnce.mock.calls[0];
    expect(episodeId).toBe("container-2000");
    expect(kind).toBe("container_critical");
    expect(readCommand).toHaveBeenCalledWith(1392);
    expect(message).toContain("Container memory critical: a tool process, not the gateway");
    expect(message).toContain("`python3`, a process the gateway started, is using 3046 MB.");
    expect(message).toContain("The container is using 4874 MB of its 5120 MB limit (95%), and the gateway worker is 600 MB.");
    expect(message).toContain("If it keeps growing, the kernel will kill it when the container runs out of memory.");
    expect(message).toContain("will not restart the gateway or stop the process");
    expect(message).not.toMatch(/pid|1392/);
    const critical = logEvent.mock.calls.find(([, , , details]) => details.kind === "container_critical")[3];
    expect(critical).toMatchObject({ childDriven: true, largestChild: { pid: 1392, rssBytes: 3046 * kMb } });
    expect(JSON.stringify(critical)).not.toContain("python3");
  });

  it("says the name could not be read when the child is gone or its name is withheld", async () => {
    vi.spyOn(processCommand, "readProcessCommand").mockReturnValue(null);
    const notifyOnce = vi.fn().mockResolvedValue(true);
    const tracker = createContainerPressureTracker({
      logEvent: vi.fn(), notifyOnce, forgetEpisode: vi.fn(),
      createCorrelationId: () => "correlation", withViewLogsSuffix: (text) => text,
    });
    for (const atMs of [1000, 2000])
      tracker.sample({ cgroupAtMs: atMs, cgroupUsedBytes: 95, containerLimitBytes: 100 }, atMs, childEvidence());
    await Promise.resolve();
    expect(notifyOnce.mock.calls[0][2]).toContain("A process the gateway started (its name could not be read) is using 3046 MB.");
  });

  it("contains notification failures and retries on a later tick", async () => {
    const notifyOnce = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(true);
    const fixture = setup(notifyOnce);
    fixture.sample();
    fixture.sample();
    // Drain the rejection/finally chain without real timers or a hung promise.
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    expect(fixture.sample().state).toBe("critical");
    await Promise.resolve();
    expect(notifyOnce).toHaveBeenCalledTimes(2);
  });
});

// ALPH-25: what happens at the limit, the culprit anywhere in the container,
// and reclaim evidence. Generic sizes; a 100 GB limit.
describe("container alerts name the culprit and say what happens at the limit", () => {
  const kGb = 1024 * kMb;
  const kLimit = 100 * kGb;
  // The gateway's own tree is small: worker 3 GB, one 1 GB tool child.
  const smallGateway = childEvidence({ workerMb: 3 * 1024, childMb: 1024 });
  smallGateway.attribution = { state: "attributed", causes: [] };
  const outside = (rssGb) => ({ status: "fresh", largest: { pid: 7001, startTicks: "900", rssBytes: rssGb * kGb } });
  const noKillRising = (max) => ({ psi: { some: { avg10: 0, avg60: 0, avg300: 0 }, full: { avg10: 0, avg60: 0, avg300: 0 } },
    events: { source: "memory.events", high: 0, max, oom: 0, oomKill: 0 } });
  const run = ({ env = {}, pressures, usedGb = [93, 96], largestGb = [60, 63.5], evidence = smallGateway, record = null }) => {
    const census = vi.spyOn(containerCensus, "readLargestContainerProcess");
    for (const gb of largestGb) census.mockReturnValueOnce(outside(gb));
    vi.spyOn(processCommand, "readProcessCommand").mockReturnValue("bun");
    const notifyOnce = vi.fn().mockResolvedValue(true);
    const logEvent = vi.fn();
    const tracker = createContainerPressureTracker({ logEvent, notifyOnce, forgetEpisode: vi.fn(), env, record,
      createCorrelationId: () => "correlation", withViewLogsSuffix: (text) => text });
    const states = usedGb.map((gb, i) => tracker.sample({ cgroupAtMs: 60_000 * (i + 1), cgroupUsedBytes: gb * kGb,
      containerLimitBytes: kLimit, cgroupUsageBasis: "non_reclaimable", cgroupPressure: pressures[i] }, 60_000 * (i + 1), evidence).state);
    const critical = logEvent.mock.calls.map(([, , , details]) => details).find((details) => details.kind === "container_critical");
    return { states, notifyOnce, critical };
  };

  it("Render-style limit (oom_kill 0, max rising): names the outside process with its growth and says the whole container restarts", async () => {
    // The first sample is the counters' baseline (the box below 90%).
    const { states, notifyOnce, critical } = run({ env: { RENDER: "true" }, usedGb: [80, 93, 96],
      pressures: [noKillRising(0), noKillRising(1200), noKillRising(2600)] });
    expect(states).toEqual(["normal", "normal", "critical"]);
    await Promise.resolve();
    const message = notifyOnce.mock.calls[0][2];
    expect(message).toContain("Container memory critical: a process outside the gateway");
    expect(message).toContain("`bun`, a process outside the gateway, is using 63.5 GB and growing at 3.5 GB/min.");
    expect(message).toContain("The container is using 96.0 GB of its 100.0 GB limit (96%, not counting reclaimable page cache).");
    expect(message).toContain("Memory pressure over the last minute (PSI avg60): some 0.0%, full 0.0%.");
    expect(message).toContain("memory.events max rose by 1400 since the previous sample.");
    expect(message).toContain("At the current rate the container reaches its limit in about 1 minute.");
    expect(message).toContain("Render will restart the whole container when it reaches its limit, and the gateway goes down with it.");
    expect(message).toContain("The kernel has not killed any process in this container, though usage has reached the limit 2600 times.");
    expect(message).not.toContain("kernel will kill");
    expect(message).not.toMatch(/pid|7001/);
    expect(critical).toMatchObject({
      pressureBasis: "reclaim_evidence", usageBasis: "non_reclaimable",
      pressureEvidence: { status: "confirmed", counters: [{ source: "memory.events", counter: "max", delta: 1400 }] },
      limitBehavior: { kind: "instance_restart", platform: "render", limitHits: 2600, oomKills: 0 },
      largestProcess: { pid: 7001, rssBytes: 63.5 * kGb, placement: "outside" },
    });
    expect(critical.largestProcess.growthBytesPerMin).toBeCloseTo(3.5 * kGb);
    expect(critical.etaToLimitMs).toBe(80_000);
    expect(JSON.stringify(critical)).not.toContain("bun");
  });

  it("a kernel-kill container (oom_kill > 0) says the kernel will kill a process", async () => {
    const { notifyOnce, critical } = run({ env: { RENDER: "true" }, pressures: [kernelKillPressure, kernelKillPressure] });
    await Promise.resolve();
    const message = notifyOnce.mock.calls[0][2];
    expect(message).toContain("the kernel will kill a process when the container runs out of memory, as it already has 2 times in this container.");
    expect(message).toContain("Memory pressure over the last minute (PSI avg60): some 22.5%, full 9.3%.");
    expect(message).not.toContain("restart the whole container");
    expect(critical.limitBehavior).toMatchObject({ kind: "kernel_kills", oomKills: 2 });
  });

  it("no platform marker and no kill: the whole container is likely to restart", async () => {
    const { notifyOnce } = run({ usedGb: [80, 93, 96], pressures: [noKillRising(0), noKillRising(10), noKillRising(25)] });
    await Promise.resolve();
    expect(notifyOnce.mock.calls[0][2]).toContain("If usage keeps growing, the whole container, gateway included, is likely to restart when it reaches its limit.");
  });

  it("Railway and Fly.io markers say the platform is likely to restart the container", async () => {
    for (const [env, label] of [[{ RAILWAY_ENVIRONMENT: "production" }, "Railway"], [{ FLY_APP_NAME: "app" }, "Fly.io"]]) {
      const { notifyOnce } = run({ env, usedGb: [80, 93, 96], pressures: [noKillRising(0), noKillRising(10), noKillRising(25)] });
      await Promise.resolve();
      expect(notifyOnce.mock.calls[0][2]).toContain(`${label} is likely to restart the whole container when it reaches its limit`);
      vi.restoreAllMocks();
    }
  });

  it("a full container whose kernel is idle (PSI 0, counters flat) does not latch", () => {
    const { states, notifyOnce } = run({ usedGb: [95, 95, 95], largestGb: [60, 60, 60],
      pressures: [noKillRising(0), noKillRising(0), noKillRising(0)] });
    expect(states).toEqual(["normal", "normal", "normal"]);
    expect(notifyOnce).not.toHaveBeenCalled();
  });

  it("PSI alone confirms, and unreadable evidence falls back to the fraction and says so", async () => {
    const psiOnly = { psi: { some: { avg10: 9, avg60: 6.5, avg300: 2 }, full: null }, events: null };
    const psi = run({ pressures: [psiOnly, psiOnly] });
    expect(psi.states).toEqual(["unknown", "critical"]);
    expect(psi.critical.pressureEvidence).toMatchObject({ status: "confirmed", psiFired: true, counters: [] });
    vi.restoreAllMocks();
    const blind = run({ pressures: [{ psi: null, events: null }, null] });
    expect(blind.states).toEqual(["unknown", "critical"]);
    expect(blind.critical).toMatchObject({ pressureBasis: "fraction_only", pressureEvidence: { status: "unavailable" } });
    await Promise.resolve();
    expect(blind.notifyOnce.mock.calls[0][2]).toContain("this alert rests on usage alone");
  });

  it("when the gateway's own tree explains the pressure, no outside process is named", async () => {
    const bigGateway = childEvidence({ workerMb: 80 * 1024, childMb: 1024 });
    bigGateway.attribution = { state: "attributed", causes: [] };
    const { notifyOnce, critical } = run({ evidence: bigGateway, usedGb: [80, 93, 96], pressures: [noKillRising(0), noKillRising(1), noKillRising(2)] });
    await Promise.resolve();
    expect(notifyOnce.mock.calls[0][2]).toContain("Inspect gateway and co-resident load.");
    expect(critical.largestProcess.placement).toBe("gateway_or_explained");
  });

  it("a small outside process is named beside the generic alert, not as its subject", async () => {
    const { notifyOnce } = run({ usedGb: [80, 93, 96], largestGb: [8, 8], pressures: [noKillRising(0), noKillRising(1), noKillRising(2)] });
    await Promise.resolve();
    const message = notifyOnce.mock.calls[0][2];
    expect(message).toContain("🔴 Container memory critical\n");
    expect(message).toContain("The largest process outside the gateway is `bun`, at 8192 MB.");
  });

  it("without a complete gateway census the largest process is named without claiming it is outside the gateway", async () => {
    for (const evidence of [null, { ...smallGateway, process: { ...smallGateway.process, status: "partial" } },
      { ...smallGateway, process: { ...smallGateway.process, processCount: 500 } }]) {
      const { notifyOnce, critical } = run({ evidence, usedGb: [80, 93, 96], pressures: [noKillRising(0), noKillRising(1), noKillRising(2)] });
      await Promise.resolve();
      const message = notifyOnce.mock.calls[0][2];
      expect(message).toContain("🔴 Container memory critical\n");
      expect(message).toContain("The largest process in the container is `bun`, at 63.5 GB and growing at 3.5 GB/min.");
      expect(message).not.toContain("outside the gateway");
      expect(critical.largestProcess.placement).toBe("unknown");
      vi.restoreAllMocks();
    }
  });

  it("keeps the last full sample on disk while full and clears it once pressure drops", () => {
    const record = { recordFull: vi.fn(), recordClear: vi.fn() };
    run({ record, usedGb: [93, 96, 50], largestGb: [60, 63.5], pressures: [noKillRising(1), noKillRising(2), noKillRising(2)] });
    expect(record.recordFull).toHaveBeenCalledTimes(2);
    expect(record.recordFull.mock.calls[0][0].limitHit).toBe(false);
    expect(record.recordFull).toHaveBeenLastCalledWith({ atMs: 120_000, usedBytes: 96 * kGb, limitBytes: kLimit,
      limitHit: true, largest: { command: "bun", rssBytes: 63.5 * kGb } });
    expect(record.recordClear).toHaveBeenCalledWith(180_000);
  });
});

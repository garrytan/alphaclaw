const {
  createGatewayMemoryMonitor,
  buildIdleMemoryTrendSnapshot,
  kMemoryTrendStates,
  fitSlope,
  bucketMinima,
  computeEffectiveCap,
  projectExhaustion,
} = require("../../lib/server/gateway-memory-monitor");

const kMb = 1024 * 1024;
const kStartMs = 1_000_000_000;
const kTickMs = 60_000;

// Drives a synthetic scenario: rssAt(tick) returns bytes (or null for a read
// miss); capAt(tick) returns the cap inputs. Collects every transition and
// the final snapshot.
const drive = (
  monitor,
  {
    ticks,
    rssAt,
    pid = 100,
    capAt = () => ({}),
    startMs = kStartMs,
    intervalMs = kTickMs,
  },
) => {
  const transitions = [];
  let snapshot = null;
  for (let i = 0; i < ticks; i += 1) {
    const atMs = startMs + i * intervalMs;
    monitor.addSample({ atMs, pid, rssBytes: rssAt(i), ...capAt(i) });
    const result = monitor.evaluate(atMs);
    snapshot = result.snapshot;
    for (const t of result.transitions) transitions.push({ ...t, tick: i });
  }
  return { transitions, snapshot };
};

const mb = (n) => n * kMb;

describe("pure helpers", () => {
  it("fitSlope returns null for <2 samples and zero time span", () => {
    expect(fitSlope([])).toBeNull();
    expect(fitSlope([{ atMs: 1, rssBytes: 10 }])).toBeNull();
    expect(
      fitSlope([
        { atMs: 5, rssBytes: 10 },
        { atMs: 5, rssBytes: 20 },
      ]),
    ).toBeNull();
  });

  it("fitSlope recovers a linear slope", () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({
      atMs: i * 1000,
      rssBytes: 100 + 5 * i * 1000,
    }));
    expect(fitSlope(samples)).toBeCloseTo(5, 6);
  });

  it("bucketMinima returns null when any bucket is empty", () => {
    const samples = [
      { atMs: 0, rssBytes: 1 },
      { atMs: 999, rssBytes: 2 },
    ];
    expect(bucketMinima(samples, 0, 6000, 6)).toBeNull();
  });

  it("computeEffectiveCap subtracts co-resident usage from the container limit", () => {
    const { capBytes, capSource } = computeEffectiveCap({
      rssBytes: mb(300),
      cgroupUsedBytes: mb(400),
      containerLimitBytes: mb(1024),
      activeHeapMb: null,
      overheadMb: 192,
    });
    // non-gateway usage = 400-300 = 100MB → cap = 1024-100 = 924MB.
    expect(capBytes).toBe(mb(924));
    expect(capSource).toBe("container");
  });

  it("computeEffectiveCap picks the tighter of heap+overhead vs container", () => {
    const heapBound = computeEffectiveCap({
      rssBytes: mb(100),
      cgroupUsedBytes: mb(100),
      containerLimitBytes: mb(4096),
      activeHeapMb: 512,
      overheadMb: 192,
    });
    expect(heapBound.capBytes).toBe(mb(704));
    expect(heapBound.capSource).toBe("heap");
    const containerBound = computeEffectiveCap({
      rssBytes: mb(100),
      cgroupUsedBytes: mb(100),
      containerLimitBytes: mb(512),
      activeHeapMb: 2048,
      overheadMb: 192,
    });
    expect(containerBound.capSource).toBe("container");
    expect(containerBound.capBytes).toBe(mb(512));
  });

  it("computeEffectiveCap reports none when no bound exists", () => {
    expect(
      computeEffectiveCap({
        rssBytes: mb(100),
        cgroupUsedBytes: null,
        containerLimitBytes: null,
        activeHeapMb: null,
        overheadMb: 192,
      }),
    ).toEqual({ capBytes: null, capSource: "none" });
  });

  it("projectExhaustion handles null slope, positive slope, and exhausted caps", () => {
    expect(
      projectExhaustion({ rssBytes: 1, capBytes: 10, slopeBytesPerMs: null, nowMs: 0 }),
    ).toBeNull();
    expect(
      projectExhaustion({ rssBytes: 1, capBytes: 10, slopeBytesPerMs: -1, nowMs: 0 }),
    ).toBeNull();
    expect(
      projectExhaustion({ rssBytes: mb(100), capBytes: mb(200), slopeBytesPerMs: mb(1), nowMs: 5 }),
    ).toBe(5 + 100);
    // Already at/over the cap: exhaustion is now, not in the past.
    expect(
      projectExhaustion({ rssBytes: mb(300), capBytes: mb(200), slopeBytesPerMs: 1, nowMs: 42 }),
    ).toBe(42);
  });

  it("exports the closed state enum and idle snapshot builder", () => {
    expect(kMemoryTrendStates).toContain("critical");
    expect(buildIdleMemoryTrendSnapshot("disabled").state).toBe("disabled");
    expect(buildIdleMemoryTrendSnapshot("no_gateway").state).toBe("no_gateway");
  });
});

describe("trend detection (default constants, synthetic hours)", () => {
  it("latches a linear capless leak exactly once via the trend path", () => {
    const monitor = createGatewayMemoryMonitor();
    // +1.2MB per 60s tick = 72MB/h ≥ the 64MB/h capless threshold.
    const { transitions, snapshot } = drive(monitor, {
      ticks: 90,
      rssAt: (i) => mb(200 + 1.2 * i),
    });
    const latches = transitions.filter((t) => t.type === "latched");
    expect(latches).toHaveLength(1);
    expect(latches[0].via).toBe("trend");
    expect(latches[0].episodeId).toMatch(/^\d+-\d+$/);
    expect(latches[0].capSource).toBe("none");
    expect(snapshot.state).toBe("leak_suspected");
    expect(snapshot.slopeMbPerHour).toBeGreaterThan(64);
  });

  it("latches a capped leak via projection and carries cap metadata", () => {
    const monitor = createGatewayMemoryMonitor();
    const { transitions, snapshot } = drive(monitor, {
      ticks: 90,
      rssAt: (i) => mb(200 + 1.5 * i),
      capAt: () => ({
        containerLimitBytes: mb(4096),
        cgroupUsedBytes: mb(300),
        activeHeapMb: 512,
      }),
    });
    const latches = transitions.filter((t) => t.type === "latched");
    expect(latches).toHaveLength(1);
    expect(latches[0].effectiveCapMb).toBe(704); // 512 + 192 overhead
    expect(latches[0].capSource).toBe("heap");
    expect(latches[0].projectedExhaustionAt).toBeTruthy();
    expect(snapshot.state).toBe("leak_suspected");
  });

  it("a plateau never latches", () => {
    const monitor = createGatewayMemoryMonitor();
    const { transitions, snapshot } = drive(monitor, {
      ticks: 90,
      rssAt: () => mb(500),
    });
    expect(transitions).toHaveLength(0);
    expect(snapshot.state).toBe("normal");
  });

  it("GC sawtooth without drift never latches", () => {
    const monitor = createGatewayMemoryMonitor();
    const { transitions, snapshot } = drive(monitor, {
      ticks: 90,
      rssAt: (i) => mb(300 + 50 * ((i % 5) / 5)),
    });
    expect(transitions).toHaveLength(0);
    expect(snapshot.state).toBe("normal");
  });

  it("sawtooth WITH slow drift latches (rising minima see through the noise)", () => {
    const monitor = createGatewayMemoryMonitor();
    const { transitions } = drive(monitor, {
      ticks: 90,
      rssAt: (i) => mb(300 + 40 * ((i % 5) / 5) + 1.5 * i),
    });
    expect(transitions.filter((t) => t.type === "latched")).toHaveLength(1);
  });

  it("oscillation aligned to bucket boundaries never latches (equal minima)", () => {
    const monitor = createGatewayMemoryMonitor();
    // Default bucket span = 10 min = 10 ticks; every bucket contains one
    // sample at the 300MB floor, so minima are equal, never strictly rising.
    const { transitions, snapshot } = drive(monitor, {
      ticks: 90,
      rssAt: (i) => mb(i % 10 === 0 ? 300 : 340),
    });
    expect(transitions).toHaveLength(0);
    expect(snapshot.state).toBe("normal");
  });

  it("slow growth under the 48MB window floor never latches", () => {
    const monitor = createGatewayMemoryMonitor();
    // +0.5MB/tick = 30MB/h → window growth ~30MB < 48MB floor.
    const { transitions, snapshot } = drive(monitor, {
      ticks: 90,
      rssAt: (i) => mb(200 + 0.5 * i),
    });
    expect(transitions).toHaveLength(0);
    expect(snapshot.state).toBe("normal");
  });

  it("holds warming_up through the startup grace and insufficient_samples before coverage", () => {
    const monitor = createGatewayMemoryMonitor();
    const { snapshot: early } = drive(monitor, {
      ticks: 5,
      rssAt: (i) => mb(200 + 2 * i),
    });
    expect(early.state).toBe("warming_up");
    const monitor2 = createGatewayMemoryMonitor();
    const { snapshot: mid } = drive(monitor2, {
      ticks: 20,
      rssAt: (i) => mb(200 + 2 * i),
    });
    expect(mid.state).toBe("insufficient_samples");
    expect(mid.sampleCount).toBeGreaterThan(0);
    expect(mid.requiredSamples).toBe(24);
  });
});

describe("fast high-pressure path", () => {
  const cap = () => ({
    containerLimitBytes: mb(1100),
    cgroupUsedBytes: mb(0),
    activeHeapMb: null,
  });

  it("two rising post-grace evals at ≥90% of cap jump straight to critical", () => {
    const monitor = createGatewayMemoryMonitor({
      config: { startupGraceMs: 0 },
    });
    const { transitions, snapshot } = drive(monitor, {
      ticks: 4,
      rssAt: (i) => mb(980 + 10 * i),
      capAt: cap,
    });
    const latch = transitions.find((t) => t.type === "latched");
    expect(latch?.via).toBe("fast_pressure");
    expect(transitions.some((t) => t.type === "escalated_critical")).toBe(true);
    expect(snapshot.state).toBe("critical");
    expect(snapshot.criticalEvalStreak).toBeGreaterThanOrEqual(1);
  });

  it("a stable gateway sitting flat at 92% never restarts-eligible (no latch)", () => {
    const monitor = createGatewayMemoryMonitor({
      config: { startupGraceMs: 0 },
    });
    const { transitions, snapshot } = drive(monitor, {
      ticks: 10,
      rssAt: () => mb(1012), // 92% of 1100, flat
      capAt: cap,
    });
    expect(transitions).toHaveLength(0);
    expect(snapshot.state).not.toBe("critical");
  });

  it("the fast path never fires inside the startup grace", () => {
    const monitor = createGatewayMemoryMonitor(); // 10-min grace
    const { transitions, snapshot } = drive(monitor, {
      ticks: 6,
      rssAt: (i) => mb(980 + 10 * i),
      capAt: cap,
    });
    expect(transitions).toHaveLength(0);
    expect(snapshot.state).toBe("warming_up");
  });

  it("treats a computed cap at/below current RSS as maximal pressure (no clamped headroom)", () => {
    const monitor = createGatewayMemoryMonitor({
      config: { startupGraceMs: 0 },
    });
    // containerLimit 400, non-gateway 150 → cap 250MB ≤ rss 300MB.
    const { snapshot, transitions } = drive(monitor, {
      ticks: 3,
      rssAt: (i) => mb(300 + i),
      capAt: () => ({
        containerLimitBytes: mb(400),
        cgroupUsedBytes: mb(450),
        activeHeapMb: null,
      }),
    });
    expect(snapshot.pressureFraction).toBe(1);
    // Rising at pressure 1.0 → fast path latches critical.
    expect(transitions.some((t) => t.type === "escalated_critical")).toBe(true);
  });
});

// Small-config scenarios: same machine, faster loops for edge-case precision.
const kSmallConfig = {
  windowMs: 10 * kTickMs,
  bucketCount: 5,
  minSamples: 6,
  minCoverageFraction: 0.5,
  minGrowthMb: 10,
  startupGraceMs: 0,
  confirmEvals: 2,
  clearEvals: 3,
  caplessSlopeMbPerHour: 30,
};

describe("episode lifecycle (small config)", () => {
  const leakThenPlateau = (plateauFrom) => (i) =>
    i < plateauFrom ? mb(100 + 5 * i) : mb(100 + 5 * plateauFrom);

  it("de-latches after sustained non-positive slope and freezes the summary", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    const { transitions, snapshot } = drive(monitor, {
      ticks: 60,
      rssAt: leakThenPlateau(20),
    });
    const latched = transitions.filter((t) => t.type === "latched");
    const cleared = transitions.filter((t) => t.type === "cleared");
    expect(latched).toHaveLength(1);
    expect(cleared).toHaveLength(1);
    expect(cleared[0].episodeId).toBe(latched[0].episodeId);
    expect(cleared[0].durationMs).toBeGreaterThan(0);
    expect(cleared[0].peakRssMb).toBe(200);
    expect(snapshot.state).toBe("normal");
    expect(snapshot.lastEpisodeSummary?.reason).toBe("recovered");
    expect(snapshot.lastEpisodeSummary?.episodeId).toBe(latched[0].episodeId);
  });

  it("a drop ≥10% below the episode peak clears immediately", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    const { transitions } = drive(monitor, {
      ticks: 25,
      rssAt: (i) => (i < 20 ? mb(100 + 5 * i) : mb(150)), // peak 195 → 150 < 175.5
    });
    expect(transitions.some((t) => t.type === "cleared")).toBe(true);
  });

  it("a new episode after a clear mints a new episodeId and re-notifiable latch", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    const rssAt = (i) => {
      if (i < 15) return mb(100 + 5 * i); // leak 1
      if (i < 30) return mb(100); // recovered
      return mb(100 + 5 * (i - 30)); // leak 2
    };
    const { transitions } = drive(monitor, { ticks: 60, rssAt });
    const latches = transitions.filter((t) => t.type === "latched");
    expect(latches).toHaveLength(2);
    expect(latches[0].episodeId).not.toBe(latches[1].episodeId);
  });

  it("pid change resets the buffer and freezes lastEpisodeSummary as process_exited", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    drive(monitor, { ticks: 15, rssAt: (i) => mb(100 + 5 * i), pid: 100 });
    expect(monitor.getTrend().state).toBe("leak_suspected");
    // The replacement process reports fresh, low RSS.
    const atMs = kStartMs + 100 * kTickMs;
    monitor.addSample({ atMs, pid: 200, rssBytes: mb(90) });
    const { snapshot } = monitor.evaluate(atMs);
    expect(["warming_up", "insufficient_samples"]).toContain(snapshot.state);
    expect(snapshot.episodeId).toBeNull();
    expect(snapshot.lastEpisodeSummary?.reason).toBe("process_exited");
    expect(snapshot.lastEpisodeSummary?.pid).toBe(100);
    expect(snapshot.lastEpisodeSummary?.peakRssMb).toBeGreaterThan(0);
  });

  it("escalates to critical exactly once, de-escalates when the cap rises mid-episode", () => {
    const config = { ...kSmallConfig, pressureFraction: 0.5 };
    const monitor = createGatewayMemoryMonitor({ config });
    let heapMb = 130; // cap = 130+192 = 322MB
    const capAt = () => ({ activeHeapMb: heapMb });
    // Rise to >90% of 322MB.
    const { transitions } = drive(monitor, {
      ticks: 40,
      rssAt: (i) => mb(100 + 5 * i),
      capAt,
    });
    const escalations = transitions.filter(
      (t) => t.type === "escalated_critical",
    );
    expect(escalations).toHaveLength(1);
    expect(monitor.getTrend().state).toBe("critical");
    // Operator raises the heap: caps re-read per evaluation, pressure falls,
    // the episode de-escalates without clearing.
    heapMb = 2048;
    const atMs = kStartMs + 41 * kTickMs;
    monitor.addSample({ atMs, pid: 100, rssBytes: mb(305), activeHeapMb: heapMb });
    const { snapshot } = monitor.evaluate(atMs);
    expect(snapshot.state).toBe("leak_suspected");
    expect(snapshot.criticalEvalStreak).toBe(0);
  });

  it("noteMitigation counts into the cleared summary", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    drive(monitor, { ticks: 15, rssAt: (i) => mb(100 + 5 * i) });
    expect(monitor.getTrend().state).toBe("leak_suspected");
    monitor.noteMitigation();
    // Drop below 90% of peak → immediate clear.
    const atMs = kStartMs + 30 * kTickMs;
    monitor.addSample({ atMs, pid: 100, rssBytes: mb(90) });
    const { transitions } = monitor.evaluate(atMs);
    const cleared = transitions.find((t) => t.type === "cleared");
    expect(cleared?.mitigationCount).toBe(1);
  });

  it("read misses never arm and enough consecutive misses reset a pending watch", () => {
    const monitor = createGatewayMemoryMonitor({
      config: { ...kSmallConfig, confirmEvals: 2 },
    });
    // Reach exactly one confirming watch evaluation.
    let tick = 0;
    const step = (rssBytes) => {
      const atMs = kStartMs + tick * kTickMs;
      monitor.addSample({ atMs, pid: 100, rssBytes });
      const out = monitor.evaluate(atMs);
      tick += 1;
      return out;
    };
    let lastState = "";
    while (lastState !== "watch" && tick < 30) {
      lastState = step(mb(100 + 5 * tick)).snapshot.state;
    }
    expect(lastState).toBe("watch");
    // 5 consecutive misses clear the pending arm; miss evals hold the prior
    // verdict and never advance the streak off stale data.
    for (let i = 0; i < 5; i += 1) {
      const missEval = step(null);
      expect(missEval.transitions).toHaveLength(0);
      expect(["watch", "normal"]).toContain(missEval.snapshot.state);
    }
    // The first post-outage sample must NOT latch: the arm was reset, and the
    // 5-minute gap also degrades bucket coverage — either way, no episode.
    const afterMiss = step(mb(100 + 5 * tick));
    expect(afterMiss.transitions).toHaveLength(0);
    expect(["watch", "normal", "insufficient_samples"]).toContain(
      afterMiss.snapshot.state,
    );
  });
});

describe("getTrend caching", () => {
  it("returns the cached snapshot (copy) without recomputation and an idle shape before any eval", () => {
    const monitor = createGatewayMemoryMonitor();
    expect(monitor.getTrend().state).toBe("no_gateway");
    const atMs = kStartMs;
    monitor.addSample({ atMs, pid: 1, rssBytes: mb(100) });
    const { snapshot } = monitor.evaluate(atMs);
    const cached = monitor.getTrend();
    expect(cached).toEqual(snapshot);
    cached.state = "mutated";
    expect(monitor.getTrend().state).toBe(snapshot.state);
  });

  it("reset returns the monitor to a pristine idle state", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    drive(monitor, { ticks: 15, rssAt: (i) => mb(100 + 5 * i) });
    monitor.reset();
    expect(monitor.getTrend().state).toBe("no_gateway");
    expect(monitor.getTrend().lastEpisodeSummary).toBeNull();
  });
});

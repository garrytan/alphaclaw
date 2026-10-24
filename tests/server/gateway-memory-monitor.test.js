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
// miss); capAt(tick) returns the cap inputs. Samples are worker-basis unless
// capAt says otherwise (a group series never goes critical). Collects every transition and
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
    monitor.addSample({ atMs, pid, rssBytes: rssAt(i), rssBasis: "worker", ...capAt(i) });
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

  it("with no operator budget the cap is a share of min(container limit, host MemTotal) (ALPH-22)", () => {
    expect(computeEffectiveCap({ containerLimitBytes: mb(4096), hostTotalBytes: mb(102_400) }))
      .toEqual({ capBytes: mb(3072), capSource: "container_share", capPhysicalBytes: mb(4096) });
    expect(computeEffectiveCap({ containerLimitBytes: null, hostTotalBytes: mb(102_400) }))
      .toEqual({ capBytes: mb(76_800), capSource: "host_share", capPhysicalBytes: mb(102_400) });
    // A container limit above the host (an unenforced cgroup value) loses to the host.
    expect(computeEffectiveCap({ containerLimitBytes: mb(200_000), hostTotalBytes: mb(102_400) }).capSource).toBe("host_share");
    expect(computeEffectiveCap({ containerLimitBytes: mb(1000), shareFraction: 0.5 }).capBytes).toBe(mb(500));
  });

  it("configured heap plus 192 MiB never sets the cap", () => {
    expect(computeEffectiveCap({ activeHeapMb: 8192, hostTotalBytes: mb(102_400) }).capBytes).toBe(mb(76_800));
    expect(computeEffectiveCap({ activeHeapMb: 8192 })).toEqual({ capBytes: null, capSource: "none", capPhysicalBytes: null });
  });

  it("computeEffectiveCap honors an operator budget whether it is above or below the derived share (issue #56)", () => {
    const base = { containerLimitBytes: mb(4096), hostTotalBytes: mb(102_400) };
    expect(computeEffectiveCap({ ...base, budgetBytes: mb(600) }))
      .toEqual({ capBytes: mb(600), capSource: "budget", capPhysicalBytes: null });
    expect(computeEffectiveCap({ ...base, budgetBytes: mb(24_000) }).capBytes).toBe(mb(24_000));
    expect(computeEffectiveCap({ budgetBytes: mb(2800) }).capSource).toBe("budget");
    for (const junk of [0, -1, Number.NaN, null, undefined]) {
      expect(computeEffectiveCap({ ...base, budgetBytes: junk }).capSource).toBe("container_share");
    }
  });

  it("computeEffectiveCap reports none when no bound exists", () => {
    expect(computeEffectiveCap({ containerLimitBytes: null, hostTotalBytes: null, budgetBytes: null }))
      .toEqual({ capBytes: null, capSource: "none", capPhysicalBytes: null });
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
        hostTotalBytes: mb(940),
        activeHeapMb: 512,
      }),
    });
    const latches = transitions.filter((t) => t.type === "latched");
    expect(latches).toHaveLength(1);
    expect(latches[0].effectiveCapMb).toBe(705); // 75% of the host's 940 MB
    expect(latches[0].capSource).toBe("host_share");
    expect(latches[0]).toMatchObject({ capPhysicalMb: 940, capFraction: 0.75, expectedSizeMb: 704 });
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
    budgetBytes: mb(1100),
    activeHeapMb: null,
  });

  it("three rising post-grace evals with every critical gate jump straight to critical; two are not enough", () => {
    const early = drive(createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } }), {
      ticks: 3,
      rssAt: (i) => mb(980 + 10 * i),
      capAt: cap,
    });
    expect(early.transitions).toHaveLength(0);
    expect(early.snapshot.state).not.toBe("critical");
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

  it("two rising jitter ticks with a NEGATIVE window slope never latch (slope-gated)", () => {
    const monitor = createGatewayMemoryMonitor({
      config: { startupGraceMs: 0 },
    });
    // High plateau, dip, then two tiny consecutive rises: per-tick rssRising
    // is true twice in a row, but the fitted slope over the window is
    // negative — noise at 92% pressure is not growth.
    const shape = [1012, 1012, 1012, 1012, 1012, 1000, 1001, 1002];
    const { transitions, snapshot } = drive(monitor, {
      ticks: shape.length,
      rssAt: (i) => mb(shape[i]),
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
      ticks: 4,
      rssAt: (i) => mb(300 + i),
      capAt: () => ({
        budgetBytes: mb(250),
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
    monitor.addSample({ rssBasis: "worker", atMs, pid: 200, rssBytes: mb(90) });
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
    let capMb = 322;
    const capAt = () => ({ budgetBytes: mb(capMb) });
    // Rise to >90% of 322MB and hold there for three evaluations.
    const { transitions } = drive(monitor, {
      ticks: 41,
      rssAt: (i) => mb(100 + 5 * i),
      capAt,
    });
    const escalations = transitions.filter(
      (t) => t.type === "escalated_critical",
    );
    expect(escalations).toHaveLength(1);
    expect(monitor.getTrend().state).toBe("critical");
    // Operator raises the budget: caps re-read per evaluation, pressure
    // falls, the episode de-escalates without clearing.
    capMb = 2240;
    const atMs = kStartMs + 41 * kTickMs;
    monitor.addSample({ rssBasis: "worker", atMs, pid: 100, rssBytes: mb(305), budgetBytes: mb(capMb) });
    const { snapshot } = monitor.evaluate(atMs);
    expect(snapshot.state).toBe("leak_suspected");
    expect(snapshot.criticalEvalStreak).toBe(0);
  });

  it("noteProcessExited freezes the live episode NOW without waiting for the replacement pid", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    drive(monitor, { ticks: 15, rssAt: (i) => mb(100 + 5 * i), pid: 100 });
    const live = monitor.getTrend();
    expect(live.state).toBe("leak_suspected");
    const exitAtMs = kStartMs + 16 * kTickMs;
    monitor.noteProcessExited(exitAtMs);
    // The frozen summary is visible immediately (incident close between the
    // exit and the replacement's first sample must see the episode).
    const trend = monitor.getTrend();
    expect(trend.state).toBe("no_gateway");
    expect(trend.episodeId).toBeNull();
    expect(trend.projectedExhaustionAt).toBeNull();
    expect(trend.pressureFraction).toBeNull();
    expect(trend.lastEpisodeSummary).toMatchObject({
      episodeId: live.episodeId,
      pid: 100,
      reason: "process_exited",
      endedAt: new Date(exitAtMs).toISOString(),
    });
    // Idempotent: a second call (or one with no live episode) is a no-op.
    monitor.noteProcessExited(exitAtMs + kTickMs);
    expect(monitor.getTrend().lastEpisodeSummary.endedAt).toBe(
      new Date(exitAtMs).toISOString(),
    );
    // The replacement pid starts a clean baseline.
    const atMs = kStartMs + 20 * kTickMs;
    monitor.addSample({ rssBasis: "worker", atMs, pid: 200, rssBytes: mb(90) });
    const { snapshot } = monitor.evaluate(atMs);
    expect(["warming_up", "insufficient_samples"]).toContain(snapshot.state);
    expect(snapshot.lastEpisodeSummary?.episodeId).toBe(live.episodeId);
  });

  it("emits escalated_critical ONCE per episode even when pressure oscillates around the threshold", () => {
    const config = { ...kSmallConfig, pressureFraction: 0.5 };
    const monitor = createGatewayMemoryMonitor({ config });
    // Latch via the trend path against a heap cap (130+192 = 322MB), then
    // hover: above 90% (rising) → dip below → above again.
    const capAt = () => ({ budgetBytes: mb(322) });
    const shape = (i) => {
      if (i < 38) return mb(100 + 5 * i); // climb to ~290 → escalates near 90%
      if (i === 38) return mb(280); // dip: de-escalates, streak resets
      return mb(292 + (i - 39)); // back above 90%, rising again
    };
    const { transitions } = drive(monitor, {
      ticks: 44,
      rssAt: shape,
      capAt,
    });
    const escalations = transitions.filter(
      (t) => t.type === "escalated_critical",
    );
    expect(escalations).toHaveLength(1);
    // The live flag still tracks honestly (re-escalated at the end).
    expect(monitor.getTrend().state).toBe("critical");
  });

  it("noteDetectionDisabled freezes honestly and clears everything except the summary", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    drive(monitor, { ticks: 15, rssAt: (i) => mb(100 + 5 * i), pid: 100 });
    expect(monitor.getTrend().state).toBe("leak_suspected");
    const atMs = kStartMs + 16 * kTickMs;
    monitor.noteDetectionDisabled(atMs);
    const trend = monitor.getTrend();
    expect(trend.state).toBe("disabled");
    expect(trend.episodeId).toBeNull();
    expect(trend.lastEpisodeSummary).toMatchObject({
      pid: 100,
      reason: "detection_disabled",
    });
    // Re-enable with the SAME pid: detection starts from scratch — no stale
    // samples, no retained streaks, full warm-up before any verdict.
    const backAt = kStartMs + 20 * kTickMs;
    monitor.addSample({ rssBasis: "worker", atMs: backAt, pid: 100, rssBytes: mb(290) });
    const { snapshot, transitions } = monitor.evaluate(backAt);
    expect(["warming_up", "insufficient_samples"]).toContain(snapshot.state);
    expect(transitions).toHaveLength(0);
    expect(snapshot.criticalEvalStreak).toBe(0);
  });

  it("same-pid reuse after noteProcessExited starts a clean baseline (buffers cleared)", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    drive(monitor, { ticks: 15, rssAt: (i) => mb(100 + 5 * i), pid: 100 });
    monitor.noteProcessExited(kStartMs + 16 * kTickMs, 100);
    // The OS hands the replacement the SAME numeric pid: without the buffer
    // clear, addSample would skip the pid-change reset and blend old samples
    // into the new process's trend with no startup grace.
    const backAt = kStartMs + 17 * kTickMs;
    monitor.addSample({ rssBasis: "worker", atMs: backAt, pid: 100, rssBytes: mb(500) });
    const { snapshot, transitions } = monitor.evaluate(backAt);
    expect(["warming_up", "insufficient_samples"]).toContain(snapshot.state);
    expect(transitions).toHaveLength(0);
  });

  it("noteProcessExited with a foreign pid is a no-op (episode survives an unrelated child exit)", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    drive(monitor, { ticks: 15, rssAt: (i) => mb(100 + 5 * i), pid: 100 });
    expect(monitor.getTrend().state).toBe("leak_suspected");
    monitor.noteProcessExited(kStartMs + 16 * kTickMs, 9999);
    const trend = monitor.getTrend();
    expect(trend.state).toBe("leak_suspected");
    expect(trend.episodeId).toBeTruthy();
    expect(trend.lastEpisodeSummary).toBeNull();
  });

  it("noteMitigation counts into the cleared summary", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    drive(monitor, { ticks: 15, rssAt: (i) => mb(100 + 5 * i) });
    expect(monitor.getTrend().state).toBe("leak_suspected");
    monitor.noteMitigation();
    // Drop below 90% of peak → immediate clear.
    const atMs = kStartMs + 30 * kTickMs;
    monitor.addSample({ rssBasis: "worker", atMs, pid: 100, rssBytes: mb(90) });
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
      monitor.addSample({ rssBasis: "worker", atMs, pid: 100, rssBytes });
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
    monitor.addSample({ rssBasis: "worker", atMs, pid: 1, rssBytes: mb(100) });
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

describe("previewCap", () => {
  it("answers the cap the next evaluation would use, from the newest limits, kept across a process change", () => {
    const monitor = createGatewayMemoryMonitor();
    expect(monitor.previewCap(null)).toEqual({ effectiveCapMb: null, capSource: "none", capPhysicalMb: null, capFraction: null });
    expect(monitor.previewCap(mb(4500))).toMatchObject({ effectiveCapMb: 4500, capSource: "budget" });
    monitor.addSample({ rssBasis: "worker", atMs: kStartMs, pid: 1, rssBytes: mb(100),
      containerLimitBytes: mb(5120), hostTotalBytes: mb(16_384) });
    expect(monitor.previewCap(null)).toEqual({ effectiveCapMb: 3840, capSource: "container_share", capPhysicalMb: 5120, capFraction: 0.75 });
    // Above the derived share: still the cap, never clamped to it.
    expect(monitor.previewCap(mb(4500))).toEqual({ effectiveCapMb: 4500, capSource: "budget", capPhysicalMb: null, capFraction: null });
    monitor.addSample({ rssBasis: "worker", atMs: kStartMs + kTickMs, pid: 2, rssBytes: mb(100) });
    expect(monitor.previewCap(null)).toMatchObject({ effectiveCapMb: 3840, capSource: "container_share" });
  });
});

describe("scoped policy, freshness and retained explanations", () => {
  it("container pressure cannot make a flat process group restart eligible", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { snapshot, transitions } = drive(monitor, {
      ticks: 8, rssAt: () => mb(100),
      capAt: (i) => ({ cgroupUsedBytes: mb(950 + i), containerLimitBytes: mb(1000) }),
    });
    expect(snapshot.containerPressureFraction).toBeGreaterThan(0.9);
    expect(snapshot.effectiveCapMb).toBe(750);
    expect(snapshot.capSource).toBe("container_share");
    expect(snapshot.pressureFraction).toBeCloseTo(100 / 750, 3);
    expect(snapshot.state).not.toBe("critical");
    expect(transitions).toEqual([]);
  });

  it("rising group RSS never uses container pressure and never goes critical (ALPH-22)", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { snapshot, transitions } = drive(monitor, {
      ticks: 8, rssAt: (i) => mb(900 + 10 * i),
      capAt: (i) => ({ rssBasis: "group", groupRssBytes: mb(900 + 10 * i),
        cgroupUsedBytes: mb(950 + i), containerLimitBytes: mb(1000), budgetBytes: mb(960) }),
    });
    expect(snapshot.rssBasis).toBe("group");
    expect(snapshot.containerPressureFraction).toBeGreaterThan(0.9);
    expect(snapshot.pressureFraction).toBe(1);
    expect(snapshot.state).not.toBe("critical");
    expect(snapshot.criticalEvalStreak).toBe(0);
    expect(transitions.some((t) => t.type === "escalated_critical")).toBe(false);
  });

  it("a summed group RSS above the container limit (shared pages counted twice) never goes critical", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { snapshot, transitions } = drive(monitor, {
      ticks: 6, rssAt: (i) => mb(4900 + i),
      capAt: () => ({ rssBasis: "group", cgroupUsedBytes: mb(2600), containerLimitBytes: mb(4096) }),
    });
    expect(snapshot.containerPressureFraction).toBeCloseTo(2600 / 4096, 3);
    expect(snapshot.state).not.toBe("critical");
    expect(transitions.some((t) => t.type === "escalated_critical")).toBe(false);
  });

  it("stale or repeated cgroup evidence cannot confirm the pressure side", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { snapshot, transitions } = drive(monitor, {
      ticks: 5, rssAt: (i) => mb(100 + i),
      capAt: () => ({ cgroupUsedBytes: mb(950), containerLimitBytes: mb(1000), cgroupAtMs: kStartMs }),
    });
    expect(snapshot.state).not.toBe("critical");
    expect(snapshot.containerPressureFraction).toBeNull();
    expect(transitions).toEqual([]);
  });

  it("forged diagnostic measurements cannot set, widen, clear or suppress a group policy", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { snapshot } = drive(monitor, {
      ticks: 4, rssAt: (i) => mb(300 + 5 * i),
      capAt: () => ({ budgetBytes: mb(320), activeHeapMb: 128, evidence: {
        telemetry: { status: "fresh", rssBytes: 0, heapUsedBytes: 0, heapLimitBytes: mb(100_000) },
        attribution: { state: "transient", causes: [] },
      } }),
    });
    expect(snapshot.state).toBe("critical");
    expect(snapshot.capSource).toBe("budget");
    expect(snapshot.effectiveCapMb).toBe(320);
    expect(snapshot.projectedBudgetCrossingAt).toBe(snapshot.projectedExhaustionAt);
  });

  it("duplicates, partial scans and aged samples hold the verdict without fresh enforcement evidence", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { snapshot } = drive(monitor, {
      ticks: 4, rssAt: (i) => mb(300 + 5 * i), capAt: () => ({ budgetBytes: mb(320) }),
    });
    const when = kStartMs + 3 * kTickMs;
    monitor.addSample({ rssBasis: "worker", atMs: when, pid: 100, rssBytes: mb(316), budgetBytes: mb(320) });
    const duplicate = monitor.evaluate(when);
    expect(duplicate.snapshot.sampleStatus).toBe("stale");
    expect(duplicate.snapshot.criticalEvalStreak).toBe(snapshot.criticalEvalStreak);
    expect(duplicate.transitions).toEqual([]);
    monitor.addSample({ rssBasis: "worker", atMs: when + kTickMs, pid: 100, rssBytes: mb(10), sampleStatus: "partial" });
    const partial = monitor.evaluate(when + kTickMs);
    expect(partial.snapshot.sampleStatus).toBe("partial");
    expect(partial.snapshot.episodeId).toBe(snapshot.episodeId);
    expect(partial.snapshot.state).toBe("critical");
    expect(monitor.evaluate(when + 3 * kTickMs).snapshot.sampleStatus).toBe("stale");
  });

  it("a root identity-token change freezes predecessor evidence despite numeric PID reuse", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    const { snapshot } = drive(monitor, {
      ticks: 15, rssAt: (i) => mb(100 + 5 * i), capAt: () => ({ identityToken: "root-generation-1" }),
    });
    const nowMs = kStartMs + 16 * kTickMs;
    monitor.addSample({ rssBasis: "worker", atMs: nowMs, pid: 100, identityToken: "root-generation-2", rssBytes: mb(100) });
    const next = monitor.evaluate(nowMs).snapshot;
    expect(next.episodeId).toBeNull();
    expect(next.lastEpisodeSummary.episodeId).toBe(snapshot.episodeId);
    expect(next.lastEpisodeSummary.reason).toBe("process_exited");
  });

  it("freezes bounded root/worker evidence through telemetry outage and protects nested copies", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    const evidence = {
      process: { status: "fresh", root: { pid: 100, startTicks: "1" }, worker: { pid: 101, startTicks: "2" },
        groupRssBytes: mb(200), contributors: Array.from({ length: 150 }, (_, i) => ({ pid: 100 + i, role: "gateway_child", rssBytes: mb(1) })) },
      telemetry: { status: "fresh", heapUsedBytes: mb(50), heapLimitBytes: mb(1000), records: [{ rssBytes: mb(50), secret: "never" }] },
      attribution: { state: "attributed", causes: ["child_accumulation"] },
    };
    const { snapshot, transitions } = drive(monitor, {
      ticks: 15, rssAt: (i) => mb(100 + 5 * i), capAt: () => ({ evidence }),
    });
    expect(transitions[0].evidence.attribution.causes).toEqual(["child_accumulation"]);
    expect(snapshot.evidence.process.contributors).toHaveLength(8);
    expect(JSON.stringify(snapshot.evidence)).not.toContain("secret");
    snapshot.evidence.process.worker.pid = 999;
    expect(monitor.getTrend().evidence.process.worker.pid).toBe(101);
    monitor.addSample({ rssBasis: "worker", atMs: kStartMs + 15 * kTickMs, pid: 100, rssBytes: mb(180),
      evidence: { attribution: { state: "unknown" }, telemetry: { status: "unavailable" } } });
    monitor.evaluate(kStartMs + 15 * kTickMs);
    monitor.addSample({ rssBasis: "worker", atMs: kStartMs + 16 * kTickMs, pid: 100, rssBytes: mb(185),
      evidence: { attribution: { state: "observing", causes: [] }, telemetry: { status: "fresh" } } });
    monitor.evaluate(kStartMs + 16 * kTickMs);
    monitor.noteProcessExited(kStartMs + 17 * kTickMs, 100);
    const frozen = monitor.getTrend().lastEpisodeSummary;
    expect(frozen.evidence.attribution.causes).toEqual(["child_accumulation"]);
    expect(frozen.evidence.process.worker).toEqual({ pid: 101, startTicks: "2" });
    frozen.evidence.attribution.causes[0] = "edited";
    expect(monitor.getTrend().lastEpisodeSummary.evidence.attribution.causes).toEqual(["child_accumulation"]);
  });
});

describe("enforcement basis (ALPH-17)", () => {
  const fullContainer = () => ({ containerLimitBytes: mb(1100), cgroupUsedBytes: mb(1050), activeHeapMb: null });

  it("container pressure cannot escalate a worker-basis verdict while tool children dominate the group", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    // The worker rises fast (600 MB/h) but holds only 40% of the group.
    const { transitions, snapshot } = drive(monitor, {
      ticks: 8,
      rssAt: (i) => mb(400 + 10 * i),
      capAt: (i) => ({ ...fullContainer(), rssBasis: "worker", groupRssBytes: mb(1000 + 10 * i) }),
    });
    expect(transitions).toHaveLength(0);
    expect(snapshot).toMatchObject({ rssBasis: "worker", pressureSource: "container_share" });
    expect(snapshot.state).not.toBe("critical");
    expect(snapshot.containerPressureFraction).toBeGreaterThan(0.9);
  });

  it("container pressure cannot escalate a flat worker that dominates the group", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const jitter = [0, 3, -2, 1, -3, 2, 0, 3, -1, 2];
    const { transitions, snapshot } = drive(monitor, {
      ticks: jitter.length,
      rssAt: (i) => mb(900 + jitter[i]),
      capAt: (i) => ({ ...fullContainer(), rssBasis: "worker", groupRssBytes: mb(1000 + jitter[i]) }),
    });
    expect(transitions).toHaveLength(0);
    expect(snapshot.state).not.toBe("critical");
  });

  it("container pressure still escalates a dominant, growing worker", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { transitions, snapshot } = drive(monitor, {
      ticks: 4,
      rssAt: (i) => mb(900 + 10 * i),
      capAt: (i) => ({ ...fullContainer(), rssBasis: "worker", groupRssBytes: mb(950 + 10 * i) }),
    });
    expect(transitions.find((t) => t.type === "latched")).toMatchObject({ via: "fast_pressure", rssBasis: "worker" });
    expect(snapshot).toMatchObject({ state: "critical", capSource: "container_share" });
  });

  it("a container thrashing on a process outside the gateway never pushes a small worker into critical", () => {
    // 100 GiB container at 94% from a co-resident process. The gateway tree
    // is the worker plus a small launcher, so the worker dominates its own
    // group. Worker RSS re-faults after reclaim: 2,900 MB flat, then a burst
    // at about 4.4 GB/h to 3,046 MB. Heap far from its limit, cap 76,800 MB.
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const rssMbAt = (i) => (i < 20 ? 2754 + (i % 2) : 2754 + (i - 19) * 73);
    const heapAt = (i) => ({ status: "fresh", atMs: kStartMs + i * kTickMs, usedBytes: mb(1100), limitBytes: mb(4144) });
    const { transitions, snapshot } = drive(monitor, {
      ticks: 23,
      rssAt: (i) => mb(rssMbAt(i)),
      capAt: (i) => ({ rssBasis: "worker", groupRssBytes: mb(rssMbAt(i) + 60), containerLimitBytes: mb(102_400),
        cgroupUsedBytes: mb(96_256), hostTotalBytes: mb(126_000), heap: heapAt(i) }),
    });
    expect(snapshot).toMatchObject({ effectiveCapMb: 76_800, capSource: "container_share" });
    expect(snapshot.containerPressureFraction).toBeGreaterThan(0.9);
    expect(snapshot.slopeMbPerHour).toBeGreaterThan(64);
    expect(transitions).toHaveLength(0);
    expect(snapshot.state).not.toBe("critical");
    expect(snapshot.restartAuthority).toBeNull();
    expect(snapshot.criticalGates).toMatchObject({ floor: false });
  });

  it("without a complete census (no group RSS) the container does not count toward a worker verdict", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { transitions } = drive(monitor, {
      ticks: 4,
      rssAt: (i) => mb(600 + 10 * i),
      capAt: () => ({ ...fullContainer(), rssBasis: "worker", groupRssBytes: null }),
    });
    expect(transitions).toHaveLength(0);
  });

  it("a basis change resets the series and freezes the episode as basis_changed instead of reading the step as growth", () => {
    const monitor = createGatewayMemoryMonitor({ config: kSmallConfig });
    const cap = () => ({ activeHeapMb: 1000 });
    // Group basis climbs into a leak_suspected episode (cap 1192 MB): it can
    // warn, never go critical.
    const first = drive(monitor, { ticks: 15, rssAt: (i) => mb(1000 + 10 * i),
      capAt: () => ({ ...cap(), rssBasis: "group" }) });
    expect(first.snapshot.state).toBe("leak_suspected");
    // The worker is identified: 500 MB on the worker basis. No growth step,
    // a fresh series, and the frozen summary says why the episode ended.
    const second = drive(monitor, { ticks: 3, startMs: kStartMs + 15 * kTickMs,
      rssAt: () => mb(500), capAt: () => ({ ...cap(), rssBasis: "worker", groupRssBytes: mb(1150) }) });
    expect(second.transitions).toHaveLength(0);
    expect(second.snapshot).toMatchObject({ rssBasis: "worker", rssMb: 500, episodeId: null });
    expect(second.snapshot.lastEpisodeSummary).toMatchObject({ reason: "basis_changed", rssBasis: "group" });
  });

  it("a read miss does not flip the basis", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    drive(monitor, { ticks: 3, rssAt: (i) => mb(500 + i), capAt: () => ({ rssBasis: "worker", groupRssBytes: mb(600) }) });
    monitor.addSample({ atMs: kStartMs + 3 * kTickMs, pid: 100, rssBytes: null, rssBasis: "group", sampleStatus: "partial" });
    monitor.addSample({ atMs: kStartMs + 4 * kTickMs, pid: 100, rssBytes: mb(504), rssBasis: "worker", groupRssBytes: mb(600) });
    const { snapshot } = monitor.evaluate(kStartMs + 4 * kTickMs);
    expect(snapshot.sampleCount).toBe(4);
    expect(snapshot.lastEpisodeSummary).toBeNull();
  });
});

describe("critical gates: slope, floor, heap (ALPH-22)", () => {
  const heapAt = (i, { usedMb, limitMb = 9011, floorsRising = false, status = "fresh" }) => ({
    status, atMs: kStartMs + i * kTickMs, usedBytes: mb(typeof usedMb === "function" ? usedMb(i) : usedMb),
    limitBytes: mb(limitMb), floorsRising,
  });
  const rising = (i) => mb(1000 + 10 * i);
  const budget = { budgetBytes: mb(1100) };

  it("fresh heap telemetry with a roomy heap and flat post-GC floors vetoes critical at 90%+ of the cap", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { transitions, snapshot } = drive(monitor, {
      ticks: 8, rssAt: rising, capAt: (i) => ({ ...budget, heap: heapAt(i, { usedMb: 789 }) }),
    });
    expect(snapshot.pressureFraction).toBeGreaterThan(0.9);
    expect(snapshot.criticalGates).toEqual({ slope: true, floor: true, heap: false });
    expect(snapshot.heap).toMatchObject({ status: "fresh", usedMb: 789, limitMb: 9011, fraction: 0.088 });
    expect(snapshot.state).not.toBe("critical");
    expect(transitions.some((t) => t.type === "escalated_critical")).toBe(false);
  });

  it("stale or missing heap telemetry leaves the heap gate open", () => {
    for (const heap of [(i) => heapAt(i, { usedMb: 789, status: "stale" }),
      (i) => ({ ...heapAt(i, { usedMb: 789 }), atMs: kStartMs + i * kTickMs - 5 * kTickMs }), () => null]) {
      const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
      const { snapshot } = drive(monitor, { ticks: 5, rssAt: rising, capAt: (i) => ({ ...budget, heap: heap(i) }) });
      expect(snapshot.state).toBe("critical");
      expect(snapshot.criticalGates.heap).toBe(true);
    }
  });

  it("rising post-GC heap floors satisfy the heap gate", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { snapshot } = drive(monitor, {
      ticks: 5, rssAt: rising, capAt: (i) => ({ ...budget, heap: heapAt(i, { usedMb: 789, floorsRising: true }) }),
    });
    expect(snapshot.state).toBe("critical");
  });

  it("a heap at 70% of its limit is the floor even when worker memory is far below the cap", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { snapshot } = drive(monitor, {
      ticks: 5, rssAt: (i) => mb(6800 + 30 * i),
      capAt: (i) => ({ budgetBytes: mb(80_000), heap: heapAt(i, { usedMb: (t) => 6300 + 30 * t }) }),
    });
    expect(snapshot.pressureFraction).toBeLessThan(0.1);
    expect(snapshot.criticalGates).toEqual({ slope: true, floor: true, heap: true });
    expect(snapshot.state).toBe("critical");
  });

  it("the floor reads the worker's private memory when it is fresh, not its RSS", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { snapshot } = drive(monitor, {
      ticks: 8, rssAt: rising, capAt: (i) => ({ ...budget, workerPrivateBytes: mb(600 + 10 * i) }),
    });
    expect(snapshot).toMatchObject({ memoryMeasure: "private", memoryMb: 670, rssMb: 1070 });
    expect(snapshot.criticalGates.floor).toBe(false);
    expect(snapshot.state).not.toBe("critical");
  });

  it("a group series ignores a private-memory reading", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { snapshot } = drive(monitor, {
      ticks: 3, rssAt: rising, capAt: () => ({ rssBasis: "group", workerPrivateBytes: mb(10) }),
    });
    expect(snapshot).toMatchObject({ memoryMeasure: "group_rss", memoryMb: 1020 });
  });

  it("a dominant, growing worker filling the container opens the heap gate", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const { snapshot } = drive(monitor, {
      ticks: 5, rssAt: (i) => mb(900 + 10 * i),
      capAt: (i) => ({ rssBasis: "worker", groupRssBytes: mb(950 + 10 * i), containerLimitBytes: mb(1100),
        cgroupUsedBytes: mb(1050), heap: heapAt(i, { usedMb: 200 }) }),
    });
    expect(snapshot).toMatchObject({ state: "critical", criticalGates: { heap: true } });
  });

  it("a burst that meets every gate for two evaluations and recovers never goes critical", () => {
    const monitor = createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } });
    const shape = [900, 905, 910, 1000, 1010, 905, 900, 900];
    const { transitions, snapshot } = drive(monitor, {
      ticks: shape.length, rssAt: (i) => mb(shape[i]), capAt: () => budget,
    });
    expect(transitions.some((t) => t.type === "escalated_critical")).toBe(false);
    expect(snapshot.state).not.toBe("critical");
  });
});


describe("restart authority (ALPH-22)", () => {
  const heapAt = (i, usedMb, floorsRising = false) => ({ status: "fresh", atMs: kStartMs + i * kTickMs,
    usedBytes: mb(usedMb), limitBytes: mb(1000), floorsRising });
  const run = (capAt, rssAt = (i) => mb(1000 + 10 * i)) =>
    drive(createGatewayMemoryMonitor({ config: { startupGraceMs: 0 } }), { ticks: 5, rssAt, capAt }).snapshot;

  it("the V8 heap at 85% of its limit authorizes a restart", () => {
    const snapshot = run((i) => ({ hostTotalBytes: mb(1400), heap: heapAt(i, 860) }));
    expect(snapshot).toMatchObject({ state: "critical", restartAuthority: "heap_near_limit" });
  });

  it("a critical with the heap below 85% and no other authority does not", () => {
    const snapshot = run((i) => ({ hostTotalBytes: mb(1400), heap: heapAt(i, 200, true) }));
    expect(snapshot).toMatchObject({ state: "critical", restartAuthority: null });
  });

  it("a dominant, growing worker filling the container authorizes a restart", () => {
    const snapshot = run((i) => ({ groupRssBytes: mb(1050 + 10 * i), containerLimitBytes: mb(1150),
      cgroupUsedBytes: mb(1080 + 10 * i), heap: heapAt(i, 200) }), (i) => mb(1000 + 10 * i));
    expect(snapshot).toMatchObject({ state: "critical", restartAuthority: "worker_container_oom" });
  });

  it("the operator's own budget authorizes a restart (issue #56 fast-leak profile)", () => {
    const snapshot = run(() => ({ budgetBytes: mb(1100) }));
    expect(snapshot).toMatchObject({ state: "critical", restartAuthority: "operator_budget" });
  });

  it("there is no authority without critical", () => {
    const snapshot = run((i) => ({ hostTotalBytes: mb(100_000), heap: heapAt(i, 200) }));
    expect(snapshot.state).not.toBe("critical");
    expect(snapshot.restartAuthority).toBeNull();
  });
});


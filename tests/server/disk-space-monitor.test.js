const {
  createDiskSpaceMonitor,
  computeThresholds,
  computeTrend,
} = require("../../lib/server/disk-space/monitor");

const kGb = 1024 ** 3;
const kMin = 60_000;
const kStartMs = Date.parse("2026-10-24T07:00:00.000Z");

const reading = (freeGb, sizeGb, extra = {}) => ({
  id: "state", path: "/data/.openclaw", mountPath: "/data", dev: 1, status: "fresh",
  freeBytes: freeGb * kGb, sizeBytes: sizeGb * kGb, ...extra,
});

const feed = (monitor, frees, sizeGb, { startMs = kStartMs, stepMs = kMin } = {}) => {
  const transitions = [];
  frees.forEach((freeGb, index) => {
    transitions.push(...monitor.observe([reading(freeGb, sizeGb)], startMs + index * stepMs));
  });
  return transitions;
};

describe("disk-space monitor", () => {
  it("uses the smaller of the percentage and the absolute cap", () => {
    expect(computeThresholds(100 * kGb)).toEqual({ lowBytes: 10 * kGb, criticalBytes: 5 * kGb });
    expect(computeThresholds(40 * kGb)).toEqual({ lowBytes: 4 * kGb, criticalBytes: 2 * kGb });
    expect(computeThresholds(4096 * kGb)).toEqual({ lowBytes: 20 * kGb, criticalBytes: 5 * kGb });
  });

  it("opens low, escalates to critical once, and never de-escalates inside an episode", () => {
    const monitor = createDiskSpaceMonitor();
    const transitions = feed(monitor, [50, 9.5, 9, 4, 4.5, 9, 9], 100);
    expect(transitions.map((t) => [t.kind, t.tier, t.trigger])).toEqual([
      ["opened", "low", "level"],
      ["escalated", "critical", "level"],
    ]);
    expect(transitions[0].episodeId).toBe(`disk-state-${kStartMs + kMin}`);
    expect(transitions[1].episodeId).toBe(transitions[0].episodeId);
    const [volume] = monitor.getSnapshot().volumes;
    expect(volume).toMatchObject({ state: "critical", currentTier: "low", freePercent: 9, mountPath: "/data" });
  });

  it("opens directly as critical", () => {
    const monitor = createDiskSpaceMonitor();
    expect(feed(monitor, [3], 100).map((t) => [t.kind, t.tier])).toEqual([["opened", "critical"]]);
  });

  it("clears only above 1.25x the low threshold held for two consecutive samples", () => {
    const monitor = createDiskSpaceMonitor();
    // low = 10 GB, clear line = 12.5 GB.
    const transitions = feed(monitor, [9, 11, 12, 13, 11, 13, 9.9, 13, 13], 100);
    expect(transitions.map((t) => t.kind)).toEqual(["opened", "cleared"]);
    expect(transitions[1]).toMatchObject({ tier: "low", durationMs: 8 * kMin });
    expect(monitor.getSnapshot().volumes[0]).toMatchObject({ state: "ok", episodeId: null });
    // A later dip is a new episode.
    const next = monitor.observe([reading(9, 100)], kStartMs + 20 * kMin);
    expect(next).toMatchObject([{ kind: "opened", episodeId: `disk-state-${kStartMs + 20 * kMin}` }]);
  });

  it("never alerts on an unknown volume and never clears an episode on one", () => {
    const monitor = createDiskSpaceMonitor();
    const unknown = { id: "diagnostic", path: "/missing", status: "unknown", reason: "missing" };
    expect(monitor.observe([unknown], kStartMs)).toEqual([]);
    expect(monitor.observe([{ ...unknown, status: "fresh", freeBytes: NaN, sizeBytes: 0 }], kStartMs + kMin)).toEqual([]);
    expect(monitor.getSnapshot().volumes[0]).toMatchObject({ id: "diagnostic", sampleStatus: "unknown", state: "ok", unknownReason: "missing" });

    feed(monitor, [9, 13], 100);
    monitor.observe([{ id: "state", path: "/data/.openclaw", status: "unknown", reason: "statfs_failed" }], kStartMs + 2 * kMin);
    expect(monitor.observe([reading(13, 100)], kStartMs + 3 * kMin)).toEqual([]);
    const state = monitor.getSnapshot().volumes.find((v) => v.id === "state");
    expect(state).toMatchObject({ state: "low" });
    expect(monitor.observe([reading(13, 100)], kStartMs + 4 * kMin)).toMatchObject([{ kind: "cleared" }]);
  });

  describe("growth trigger", () => {
    const samples = (spanMin, consumedGb, points = 10) => Array.from({ length: points }, (_, i) => ({
      atMs: kStartMs + (spanMin * kMin * i) / (points - 1),
      usedBytes: 100 * kGb + (consumedGb * kGb * i) / (points - 1),
    }));

    it("needs 30 minutes of samples and 1 GB consumed", () => {
      expect(computeTrend(samples(20, 40), 50 * kGb)).toMatchObject({ sustained: false, etaMs: null, tier: "ok" });
      expect(computeTrend(samples(45, 0.9), 2 * kGb)).toMatchObject({ sustained: false, etaMs: null, tier: "ok" });
      const trend = computeTrend(samples(60, 30), 90 * kGb);
      expect(trend).toMatchObject({ sustained: true, tier: "low" });
      expect(trend.growthBytesPerHour).toBeCloseTo(30 * kGb, -3);
      expect(trend.etaMs).toBeCloseTo(3 * 3_600_000, -3);
      expect(computeTrend(samples(60, 120), 100 * kGb)).toMatchObject({ sustained: true, tier: "critical" });
    });

    it("ignores a brief download that was deleted again", () => {
      const spike = [0, 0, 5, 5, 5, 0, 0, 0, 0, 0].map((gb, i) => ({ atMs: kStartMs + i * 5 * kMin, usedBytes: (100 + gb) * kGb }));
      expect(computeTrend(spike, 21 * kGb)).toMatchObject({ sustained: false, tier: "ok" });
    });

    it("opens low hours before the level threshold on a large disk, then escalates on the projection", () => {
      const monitor = createDiskSpaceMonitor();
      // 1 TB disk filling at 30 GB/h from 120 GB free: low threshold (20 GB) is 3+ hours away.
      const frees = Array.from({ length: 40 }, (_, i) => 120 - 0.5 * i);
      const transitions = feed(monitor, frees, 1024);
      expect(transitions).toHaveLength(1);
      expect(transitions[0]).toMatchObject({ kind: "opened", tier: "low", trigger: "eta" });
      // Opens exactly when the window first spans 30 minutes.
      expect(transitions[0].episodeId).toBe(`disk-state-${kStartMs + 30 * kMin}`);
      expect(transitions[0].volume.freeBytes).toBeGreaterThan(100 * kGb);

      // The rate quadruples: under an hour to full.
      const fast = Array.from({ length: 40 }, (_, i) => frees[39] - 2.5 * (i + 1));
      const later = feed(monitor, fast, 1024, { startMs: kStartMs + 40 * kMin });
      expect(later.map((t) => [t.kind, t.tier, t.trigger])).toEqual([["escalated", "critical", "eta"]]);
    });

    it("keeps an episode open while the projection still fires, even above the clear line", () => {
      const monitor = createDiskSpaceMonitor();
      const frees = Array.from({ length: 45 }, (_, i) => 120 - 0.5 * i);
      const transitions = feed(monitor, frees, 1024);
      expect(transitions.map((t) => t.kind)).toEqual(["opened"]);
      expect(monitor.getSnapshot().volumes[0]).toMatchObject({ state: "low", trendSustained: true });
    });
  });

  it("drops the trend window when the volume is resized", () => {
    const monitor = createDiskSpaceMonitor();
    feed(monitor, Array.from({ length: 35 }, (_, i) => 120 - 0.5 * i), 1024);
    monitor.observe([reading(600, 2048)], kStartMs + 36 * kMin);
    expect(monitor.getSnapshot().volumes[0]).toMatchObject({ trendSustained: false, growthBytesPerHour: null });
  });

  it("attaches growers only to the episode they were taken for", () => {
    const monitor = createDiskSpaceMonitor();
    const [opened] = feed(monitor, [9], 100);
    monitor.setGrowers("state", "disk-state-1", { basis: "largest", entries: [] });
    expect(monitor.getSnapshot().volumes[0].growers).toBeNull();
    monitor.setGrowers("state", opened.episodeId, { basis: "largest", entries: [] });
    expect(monitor.getSnapshot().volumes[0].growers).toEqual({ basis: "largest", entries: [] });
  });
});

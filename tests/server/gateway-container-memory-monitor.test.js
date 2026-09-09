const { createContainerMemoryMonitor } = require("../../lib/server/gateway-memory-monitor");
const kStart = 1_700_000_000_000;
const at = (tick) => kStart + tick * 60_000;
const step = (monitor, tick, usedBytes = 95, extra = {}) => {
  monitor.addSample({ atMs: at(tick), usedBytes, limitBytes: 100, ...extra });
  return monitor.evaluate(at(tick));
};

describe("direct container memory pressure", () => {
  it("alerts on two actual high readings even with no gateway or growth", () => {
    const monitor = createContainerMemoryMonitor();
    expect(step(monitor, 0).state).toBe("unknown");
    const critical = step(monitor, 1);
    expect(critical.state).toBe("critical");
    expect(critical.pressureFraction).toBe(0.95);
    expect(critical.episodeId).toMatch(/^container-\d+$/);
  });

  it("clears only after three fresh subcritical readings and retains its summary", () => {
    const monitor = createContainerMemoryMonitor();
    step(monitor, 0);
    const { episodeId } = step(monitor, 1);
    expect(step(monitor, 2, 85).state).toBe("critical");
    expect(step(monitor, 3, 85).state).toBe("critical");
    const clear = step(monitor, 4, 85);
    expect(clear.state).toBe("normal");
    expect(clear.episodeId).toBeNull();
    expect(clear.lastEpisodeSummary).toMatchObject({ episodeId, reason: "recovered" });
  });

  it("missing data holds an episode and interrupts recovery confirmation", () => {
    const monitor = createContainerMemoryMonitor();
    step(monitor, 0);
    const critical = step(monitor, 1);
    step(monitor, 2, 85);
    const missing = step(monitor, 3, null);
    expect(missing.state).toBe("critical");
    expect(missing.episodeId).toBe(critical.episodeId);
    expect(missing.sampleStatus).toBe("unavailable");
    expect(step(monitor, 4, 85).state).toBe("critical");
    expect(step(monitor, 5, 85).state).toBe("critical");
    expect(step(monitor, 6, 85).state).toBe("normal");
  });

  it("duplicate and out-of-order timestamps cannot confirm pressure", () => {
    const monitor = createContainerMemoryMonitor();
    step(monitor, 0);
    expect(step(monitor, 0).state).toBe("unknown");
    expect(step(monitor, 1, 95, { atMs: at(0) - 1 }).state).toBe("unknown");
    expect(step(monitor, 2).state).toBe("unknown");
    expect(step(monitor, 3).state).toBe("critical");
  });

  it("does not manufacture confirmations by evaluating one sample repeatedly", () => {
    const monitor = createContainerMemoryMonitor();
    step(monitor, 0);
    for (let i = 0; i < 10; i += 1) expect(monitor.evaluate(at(0)).state).toBe("unknown");
  });

  it("marks held pressure stale by age without clearing history", () => {
    const monitor = createContainerMemoryMonitor();
    step(monitor, 0);
    const critical = step(monitor, 1);
    const stale = monitor.evaluate(at(4));
    expect(stale.state).toBe("critical");
    expect(stale.sampleStatus).toBe("stale");
    expect(stale.episodeId).toBe(critical.episodeId);
  });

  it("rejects future observations until they can supply fresh evidence", () => {
    const monitor = createContainerMemoryMonitor();
    monitor.addSample({ atMs: at(2), usedBytes: 95, limitBytes: 100 });
    expect(monitor.evaluate(at(0)).state).toBe("unknown");
    expect(monitor.getSnapshot().sampleStatus).toBe("stale");
  });

  it("disabling preserves history and re-enabling requires new confirmations", () => {
    const monitor = createContainerMemoryMonitor();
    step(monitor, 0);
    const critical = step(monitor, 1);
    const disabled = monitor.disable(at(2));
    expect(disabled.state).toBe("disabled");
    expect(disabled.lastEpisodeSummary).toMatchObject({ episodeId: critical.episodeId, reason: "detection_disabled" });
    expect(step(monitor, 3).state).toBe("unknown");
    const next = step(monitor, 4);
    expect(next.state).toBe("critical");
    expect(next.episodeId).not.toBe(critical.episodeId);
  });

  it("uses the current limit and inclusive critical threshold", () => {
    const monitor = createContainerMemoryMonitor();
    step(monitor, 0, 90);
    expect(step(monitor, 1, 90).state).toBe("critical");
    step(monitor, 2, 90, { limitBytes: 200 });
    step(monitor, 3, 90, { limitBytes: 200 });
    expect(step(monitor, 4, 90, { limitBytes: 200 }).state).toBe("normal");
  });

  it("defensively copies frozen history", () => {
    const monitor = createContainerMemoryMonitor();
    step(monitor, 0);
    step(monitor, 1);
    const disabled = monitor.disable(at(2));
    disabled.lastEpisodeSummary.reason = "edited";
    expect(monitor.getSnapshot().lastEpisodeSummary.reason).toBe("detection_disabled");
  });
});

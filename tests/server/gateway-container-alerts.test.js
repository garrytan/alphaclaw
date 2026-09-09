const { createContainerPressureTracker } = require("../../lib/server/gateway-memory/container-alerts");

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

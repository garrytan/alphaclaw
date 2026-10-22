const { createContainerPressureTracker } = require("../../lib/server/gateway-memory/container-alerts");
const processCommand = require("../../lib/server/gateway-memory/process-command");

const kMb = 1024 * 1024;
const childEvidence = ({ workerMb = 600, childMb = 3046, childPid = 1392 } = {}) => ({
  process: {
    status: "fresh", workerRssBytes: workerMb * kMb, childRssBytes: childMb * kMb, childCount: 1,
    groupRssBytes: (workerMb + childMb) * kMb,
    contributors: [
      { pid: 101, role: "gateway", rssBytes: workerMb * kMb },
      { pid: childPid, role: "gateway_child", rssBytes: childMb * kMb },
    ],
  },
  attribution: { state: "attributed", causes: ["child_growth"] },
});

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
    tracker.sample({ cgroupAtMs: 1000, cgroupUsedBytes: 4874 * kMb, containerLimitBytes: limit }, 1000, childEvidence());
    tracker.sample({ cgroupAtMs: 2000, cgroupUsedBytes: 4874 * kMb, containerLimitBytes: limit }, 2000, childEvidence());
    await Promise.resolve();
    expect(notifyOnce).toHaveBeenCalledOnce();
    const [episodeId, kind, message] = notifyOnce.mock.calls[0];
    expect(episodeId).toBe("container-2000");
    expect(kind).toBe("container_critical");
    expect(readCommand).toHaveBeenCalledWith(1392);
    expect(message).toContain("Container memory critical: a tool process, not the gateway");
    expect(message).toContain("`python3`, a process the gateway started, is using 3046 MB.");
    expect(message).toContain("The container working set is 4874 MB of its 5120 MB limit (95%), and the gateway worker is 600 MB.");
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

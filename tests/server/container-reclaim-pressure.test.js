const fs = require("fs");
const { getSystemResources, parseCgroupPressure } = require("../../lib/server/system-resources");
const { readGatewayMemorySample } = require("../../lib/server/gateway-memory/sample");
const { createContainerPressureTracker } = require("../../lib/server/gateway-memory/container-alerts");
const containerCensus = require("../../lib/server/gateway-memory/container-census");
const processCommand = require("../../lib/server/gateway-memory/process-command");

// ALPH-25: container pressure is non-reclaimable memory (usage minus all page
// cache plus shmem), and critical needs reclaim evidence (PSI or a rising
// limit counter). Generic figures.
const kGb = 1024 ** 3;
const gb = (value) => Math.round(value * kGb);
const kLimit = gb(107.4);

const mockCgroup = (files) => {
  const real = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
    const key = String(filePath);
    if (!key.startsWith("/sys/fs/cgroup") && !key.startsWith("/proc/")) return real(filePath, ...args);
    if (Object.prototype.hasOwnProperty.call(files, key)) return files[key];
    throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
  });
};
const psi = (some, full = 0) => [
  `some avg10=${some.toFixed(2)} avg60=${some.toFixed(2)} avg300=${some.toFixed(2)} total=0`,
  `full avg10=${full.toFixed(2)} avg60=${full.toFixed(2)} avg300=${full.toFixed(2)} total=0`,
  "",
].join("\n");
const cgroupFiles = ({ current, anon, file, inactiveFile, activeFile, shmem = 0, some = 0, full = 0, max = 0, oomKill = 0 }) => ({
  "/sys/fs/cgroup/memory.current": `${current}\n`,
  "/sys/fs/cgroup/memory.max": `${kLimit}\n`,
  "/sys/fs/cgroup/memory.stat": [
    `anon ${anon}`, `file ${file}`, `kernel ${gb(4.1)}`, `slab ${gb(3.9)}`, `shmem ${shmem}`,
    `inactive_anon 0`, `active_anon ${anon}`, `inactive_file ${inactiveFile}`, `active_file ${activeFile}`, "",
  ].join("\n"),
  "/sys/fs/cgroup/memory.pressure": psi(some, full),
  "/sys/fs/cgroup/memory.events": `low 0\nhigh 0\nmax ${max}\noom ${oomKill ? 1 : 0}\noom_kill ${oomKill}\noom_group_kill 0\n`,
});

// A page-cache-heavy box: 96% of its limit used, but 85.7 GB of it is
// file cache (60.5 GB inactive, 25.2 GB active), anon 6.4 GB, kernel 4.1 GB,
// processes 8.0 GB in all; PSI all zero and no limit events.
const kCacheHeavy = { current: gb(103.2), anon: gb(6.4), file: gb(85.7), inactiveFile: gb(60.5), activeFile: gb(25.2) };
// The counterpart: anon has grown near the limit and the cgroup keeps
// hitting memory.max.
const kAnonNearLimit = { current: gb(104.5), anon: gb(98.0), file: gb(3.0), inactiveFile: gb(1.0), activeFile: gb(2.0) };

const drive = (steps, largestGb = 5.0) => {
  vi.spyOn(containerCensus, "readLargestContainerProcess").mockReturnValue({ status: "fresh",
    largest: { pid: 9100, startTicks: "1", rssBytes: gb(5.0) } });
  vi.spyOn(processCommand, "readProcessCommand").mockReturnValue("worker");
  const notifyOnce = vi.fn().mockResolvedValue(true);
  const logEvent = vi.fn();
  const tracker = createContainerPressureTracker({ logEvent, notifyOnce, forgetEpisode: vi.fn(), env: {},
    createCorrelationId: () => "correlation", withViewLogsSuffix: (text) => text });
  const states = [];
  let sample = null;
  steps.forEach((files, i) => {
    vi.restoreAllMocks();
    vi.spyOn(containerCensus, "readLargestContainerProcess").mockReturnValue({ status: "fresh",
      largest: { pid: 9100, startTicks: "1", rssBytes: gb(largestGb) } });
    vi.spyOn(processCommand, "readProcessCommand").mockReturnValue("worker");
    mockCgroup(files);
    sample = readGatewayMemorySample({});
    states.push(tracker.sample({ ...sample, cgroupAtMs: 60_000 * (i + 1) }, 60_000 * (i + 1)).state);
  });
  return { states, notifyOnce, logEvent, sample };
};

describe("container pressure ignores reclaimable page cache and needs reclaim evidence (ALPH-25)", () => {
  afterEach(() => vi.restoreAllMocks());

  it("the page-cache-heavy box does not alert, and Resources shows the same 16% the watchdog judges", async () => {
    const files = cgroupFiles(kCacheHeavy);
    const { states, notifyOnce, sample } = drive([files, files, files]);
    expect(states).toEqual(["normal", "normal", "normal"]);
    await Promise.resolve();
    expect(notifyOnce).not.toHaveBeenCalled();
    expect(sample).toMatchObject({
      cgroupUsedBytes: gb(103.2) - gb(85.7), cgroupUsageBasis: "non_reclaimable",
      cgroupRawUsedBytes: gb(103.2), cgroupWorkingSetBytes: gb(103.2) - gb(60.5), containerLimitBytes: kLimit,
      cgroupPressure: {
        psi: { some: { avg10: 0, avg60: 0, avg300: 0 }, full: { avg10: 0, avg60: 0, avg300: 0 } },
        events: { source: "memory.events", high: 0, max: 0, oom: 0, oomKill: 0 },
      },
    });
    mockCgroup(files);
    const memory = getSystemResources({}).memory;
    expect(memory).toMatchObject({ usedBytes: sample.cgroupUsedBytes, totalBytes: kLimit, basis: "non_reclaimable",
      rawUsedBytes: gb(103.2), workingSetBytes: gb(103.2) - gb(60.5) });
    expect(memory.percent).toBe(Math.round((sample.cgroupUsedBytes / kLimit) * 1000) / 10);
    expect(memory.percent).toBe(16.3);
  });

  it("even at 96% raw usage with the old working-set basis over 90%, an idle kernel keeps it quiet", () => {
    const files = cgroupFiles({ ...kCacheHeavy, inactiveFile: gb(5.0), activeFile: gb(80.7) });
    const { states, sample } = drive([files, files, files]);
    expect(sample.cgroupWorkingSetBytes / kLimit).toBeGreaterThan(0.9);
    expect(states).toEqual(["normal", "normal", "normal"]);
  });

  it("anon grown near the limit with memory.events max rising alerts, naming the counter and showing PSI", async () => {
    const { states, notifyOnce, logEvent } = drive([
      cgroupFiles({ ...kAnonNearLimit, max: 0, some: 0.5 }),
      cgroupFiles({ ...kAnonNearLimit, max: 1500, some: 0.5 }),
      cgroupFiles({ ...kAnonNearLimit, max: 3100, some: 0.5 }),
    ], 92.0);
    expect(states).toEqual(["normal", "normal", "critical"]);
    await Promise.resolve();
    const message = notifyOnce.mock.calls[0][2];
    expect(message).toContain("The container is using 101.5 GB of its 107.4 GB limit (95%, not counting reclaimable page cache).");
    expect(message).toContain("Memory pressure over the last minute (PSI avg60): some 0.5%, full 0.0%.");
    expect(message).toContain("memory.events max rose by 1600 since the previous sample.");
    expect(message).toContain("The largest process in the container is `worker`, at 92.0 GB.");
    const critical = logEvent.mock.calls.map(([, , , details]) => details).find((details) => details.kind === "container_critical");
    expect(critical).toMatchObject({ usageBasis: "non_reclaimable", pressureBasis: "reclaim_evidence",
      pressureEvidence: { status: "confirmed", psiFired: false, psiSomeAvg60: 0.5, counters: [{ counter: "max", delta: 1600 }] } });
  });

  it("shmem counts as non-reclaimable even though memory.stat files it under file", () => {
    mockCgroup(cgroupFiles({ ...kCacheHeavy, shmem: gb(10) }));
    expect(readGatewayMemorySample({}).cgroupUsedBytes).toBe(gb(103.2) - gb(85.7) + gb(10));
  });

  it("reads v1 limit counters from memory.failcnt and memory.oom_control", () => {
    mockCgroup({
      "/sys/fs/cgroup/memory/memory.failcnt": "42\n",
      "/sys/fs/cgroup/memory/memory.oom_control": "oom_kill_disable 0\nunder_oom 0\noom_kill 3\n",
    });
    expect(parseCgroupPressure()).toEqual({ psi: null,
      events: { source: "memory.failcnt", high: null, max: 42, oom: null, oomKill: 3 } });
  });
});

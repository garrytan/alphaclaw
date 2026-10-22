const fs = require("fs");
const { parseCgroupMemory } = require("../../lib/server/system-resources");
const { readGatewayMemorySample } = require("../../lib/server/gateway-memory/sample");
const { createContainerMemoryMonitor } = require("../../lib/server/gateway-memory/container-monitor");

// #125: one live cgroup v2 reading where raw usage is 93.8% of the limit and the
// working set (`docker stats`) is 54.3%.
const kLimit = 6_442_450_944;
const kCurrent = 6_043_295_744;
const kInactive = 2_545_434_624;
const v2Stat = (inactive) => `anon 2790506496\nfile 2805374976\ninactive_anon 0\ninactive_file ${inactive}\nactive_file 259940352\n`;

const mockCgroup = (files) => {
  const real = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
    const key = String(filePath);
    if (!key.startsWith("/sys/fs/cgroup") && !key.startsWith("/proc/")) return real(filePath, ...args);
    if (Object.prototype.hasOwnProperty.call(files, key)) return files[key];
    throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
  });
};

const v2 = (stat) => ({
  "/sys/fs/cgroup/memory.current": `${kCurrent}\n`,
  "/sys/fs/cgroup/memory.max": `${kLimit}\n`,
  ...(stat == null ? {} : { "/sys/fs/cgroup/memory.stat": stat }),
});

const containerStateAfterTwoReads = () => {
  const monitor = createContainerMemoryMonitor();
  for (const atMs of [1_000, 2_000]) {
    const sample = readGatewayMemorySample({});
    monitor.addSample({ atMs, usedBytes: sample.cgroupUsedBytes, limitBytes: sample.containerLimitBytes });
    monitor.evaluate(atMs);
  }
  return monitor.getSnapshot();
};

describe("container working set excludes inactive page cache (#125)", () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("subtracts inactive_file on cgroup v2 and keeps raw usage alongside", () => {
    mockCgroup(v2(v2Stat(kInactive)));
    expect(parseCgroupMemory()).toEqual({
      usedBytes: kCurrent, workingSetBytes: kCurrent - kInactive, totalBytes: kLimit,
    });
  });

  it("subtracts total_inactive_file on cgroup v1", () => {
    mockCgroup({
      "/sys/fs/cgroup/memory/memory.usage_in_bytes": "1000",
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2000",
      "/sys/fs/cgroup/memory/memory.stat": "cache 500\ninactive_file 1\ntotal_inactive_file 400\n",
    });
    expect(parseCgroupMemory()).toEqual({ usedBytes: 1000, workingSetBytes: 600, totalBytes: 2000 });
  });

  it("marks the working set unavailable (null, never zero) when memory.stat is missing or malformed", () => {
    mockCgroup(v2(null));
    expect(parseCgroupMemory().workingSetBytes).toBeNull();
    vi.restoreAllMocks();
    mockCgroup(v2("inactive_file nope\n"));
    expect(parseCgroupMemory().workingSetBytes).toBeNull();
  });

  it("keeps raw usage when inactive_file is not below usage", () => {
    mockCgroup(v2(v2Stat(kCurrent + 1)));
    expect(parseCgroupMemory().workingSetBytes).toBe(kCurrent);
  });

  it("does not latch container_critical on page cache, but still latches on raw usage without memory.stat", () => {
    mockCgroup(v2(v2Stat(kInactive)));
    const cached = containerStateAfterTwoReads();
    expect(cached.state).toBe("normal");
    expect(cached.usedBytes).toBe(kCurrent - kInactive);

    vi.restoreAllMocks();
    mockCgroup(v2(null));
    expect(containerStateAfterTwoReads().state).toBe("critical");
  });

  it("still latches when the working set itself is above 90%", () => {
    mockCgroup(v2(v2Stat(100 * 1024 * 1024)));
    expect(containerStateAfterTwoReads().state).toBe("critical");
  });
});

const fs = require("fs");
const os = require("os");

const {
  getMachineProfile,
  refreshMachineProfile,
  whenGpuEnriched,
  hasCapacityChanged,
  resolveTier,
  resetMachineProfileForTests,
} = require("../../lib/server/machine-profile");

// machine-profile reuses system-resources' cgroup primitives, which read
// through the shared fs singleton — same fs-spy pattern as
// system-resources.test.js. machine-profile's own reads (container markers,
// /proc/1/cgroup, GPU device nodes) go through an injected fsModule.

const kCgroupPrefix = "/sys/fs/cgroup";

const spyCgroupFiles = (files = {}) => {
  const realReadFileSync = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((filePath, ...args) => {
    const key = String(filePath);
    if (key.startsWith(kCgroupPrefix)) {
      if (Object.prototype.hasOwnProperty.call(files, key)) {
        const value = files[key];
        if (value instanceof Error) throw value;
        return value;
      }
      throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
    }
    return realReadFileSync(filePath, ...args);
  });
};

// Injected fsModule for machine-profile's own reads. `existing` lists paths
// existsSync answers true for; `files` maps readFileSync paths to content.
const makeFsModule = ({ existing = [], files = {} } = {}) => ({
  existsSync: (p) => existing.includes(String(p)),
  readFileSync: (p) => {
    const key = String(p);
    if (Object.prototype.hasOwnProperty.call(files, key)) {
      const value = files[key];
      if (value instanceof Error) throw value;
      return value;
    }
    throw Object.assign(new Error(`ENOENT: ${key}`), { code: "ENOENT" });
  },
});

const kGb = 1024 * 1024 * 1024;

describe("server/machine-profile", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetMachineProfileForTests();
  });

  it("resolves tiers at the documented memory boundaries", () => {
    expect(resolveTier(512 * 1024 * 1024)).toBe("micro");
    expect(resolveTier(640 * 1024 * 1024)).toBe("micro");
    expect(resolveTier(640 * 1024 * 1024 + 1)).toBe("small");
    expect(resolveTier(2 * kGb)).toBe("small");
    expect(resolveTier(4 * kGb)).toBe("medium");
    expect(resolveTier(8 * kGb)).toBe("large");
    expect(resolveTier(8 * kGb + 1)).toBe("xl");
    // Garbage input falls back to the conservative small tier.
    expect(resolveTier(null)).toBe("small");
    expect(resolveTier(-5)).toBe("small");
  });

  it("builds a cgroup-v2 profile with sources, tier, and container detection", () => {
    spyCgroupFiles({
      "/sys/fs/cgroup/memory.max": `${2 * kGb}\n`,
      "/sys/fs/cgroup/cpu.max": "200000 100000",
    });
    vi.spyOn(fs, "statfsSync").mockReturnValue({
      bsize: 4096,
      blocks: 1_000_000,
      bfree: 400_000,
    });
    vi.spyOn(os, "cpus").mockReturnValue(new Array(8).fill({ model: "x" }));
    resetMachineProfileForTests({
      fsModule: makeFsModule({ existing: ["/.dockerenv"] }),
    });

    const profile = getMachineProfile();
    expect(profile.memory).toEqual({ limitBytes: 2 * kGb, source: "cgroup-v2" });
    expect(profile.cpu).toEqual({ cores: 2, hostCores: 8, source: "cpu.max" });
    expect(profile.disk.totalBytes).toBe(4096 * 1_000_000);
    expect(profile.tier).toBe("small");
    expect(profile.environment).toBe("container");
    expect(profile.gpu).toEqual({ present: false });
    // Memoized: identical object on re-read.
    expect(getMachineProfile()).toBe(profile);
  });

  it("treats the v1 unlimited sentinel and empty files as host fallback", () => {
    spyCgroupFiles({
      "/sys/fs/cgroup/memory/memory.limit_in_bytes": "9223372036854771712\n",
      "/sys/fs/cgroup/cpu.max": "max 100000",
    });
    vi.spyOn(os, "totalmem").mockReturnValue(16 * kGb);
    vi.spyOn(os, "cpus").mockReturnValue(new Array(4).fill({ model: "x" }));
    resetMachineProfileForTests({
      fsModule: makeFsModule({ files: { "/proc/1/cgroup": "0::/init.scope\n" } }),
    });

    const profile = getMachineProfile();
    expect(profile.memory).toEqual({ limitBytes: 16 * kGb, source: "host" });
    expect(profile.cpu).toEqual({ cores: 4, hostCores: 4, source: "host" });
    expect(profile.environment).toBe("bare-metal");
    expect(profile.tier).toBe("xl");

    // Empty-string cgroup content is garbage, not a limit.
    spyCgroupFiles({ "/sys/fs/cgroup/memory.max": "" });
    const refreshed = refreshMachineProfile();
    expect(refreshed.memory.source).toBe("host");
  });

  it("falls back to cpuset counting and reads v1 cfs quotas", () => {
    spyCgroupFiles({
      "/sys/fs/cgroup/cpuset.cpus.effective": "0-2,7",
    });
    resetMachineProfileForTests({ fsModule: makeFsModule() });
    expect(getMachineProfile().cpu).toMatchObject({ cores: 4, source: "cpuset" });

    spyCgroupFiles({
      "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "150000",
      "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000",
    });
    resetMachineProfileForTests({ fsModule: makeFsModule() });
    expect(getMachineProfile().cpu).toMatchObject({ cores: 1.5, source: "cfs-v1" });
  });

  it("detects containers via /run/.containerenv and /proc/1/cgroup markers", () => {
    spyCgroupFiles({});
    resetMachineProfileForTests({
      fsModule: makeFsModule({ existing: ["/run/.containerenv"] }),
    });
    expect(getMachineProfile().environment).toBe("container");

    resetMachineProfileForTests({
      fsModule: makeFsModule({
        files: {
          "/proc/1/cgroup":
            "0::/kubepods.slice/kubepods-burstable.slice/kubepods-pod1.slice\n",
        },
      }),
    });
    expect(getMachineProfile().environment).toBe("container");

    // Unreadable /proc on non-darwin: unknown (suppression treats it as a
    // container — conservative).
    resetMachineProfileForTests({ fsModule: makeFsModule() });
    const env = getMachineProfile().environment;
    expect(env).toBe(process.platform === "darwin" ? "bare-metal" : "unknown");
  });

  it("keeps presence-only GPU details when nvidia-smi fails, enriches on success", async () => {
    spyCgroupFiles({});
    const failingExec = vi.fn((cmd, args, opts, cb) => cb(new Error("boom")));
    resetMachineProfileForTests({
      fsModule: makeFsModule({ existing: ["/dev/nvidia0"] }),
      execFileFn: failingExec,
    });
    let profile = getMachineProfile();
    await whenGpuEnriched();
    expect(profile.gpu).toMatchObject({
      present: true,
      vendor: "nvidia",
      source: "device-node",
    });
    expect(failingExec).toHaveBeenCalledTimes(1);

    const okExec = vi.fn((cmd, args, opts, cb) =>
      cb(null, "NVIDIA L4, 23034, 550.54.15\nNVIDIA L4, 23034, 550.54.15\n"),
    );
    resetMachineProfileForTests({
      fsModule: makeFsModule({ existing: ["/proc/driver/nvidia/version"] }),
      execFileFn: okExec,
    });
    profile = getMachineProfile();
    await whenGpuEnriched();
    expect(profile.gpu.source).toBe("nvidia-smi");
    expect(profile.gpu.devices).toHaveLength(2);
    expect(profile.gpu.devices[0]).toEqual({
      name: "NVIDIA L4",
      vramBytes: 23034 * 1024 * 1024,
    });
    expect(profile.gpu.driverVersion).toBe("550.54.15");
  });

  it("resolves whenGpuEnriched even when nvidia-smi hangs", async () => {
    vi.useFakeTimers();
    spyCgroupFiles({});
    const hangingExec = vi.fn(); // never calls back
    resetMachineProfileForTests({
      fsModule: makeFsModule({ existing: ["/dev/nvidiactl"] }),
      execFileFn: hangingExec,
    });
    const pending = whenGpuEnriched();
    await vi.advanceTimersByTimeAsync(3600);
    await expect(pending).resolves.toBeUndefined();
    // Presence survives; enrichment never landed.
    expect(getMachineProfile().gpu.source).toBe("device-node");
  });

  it("detects AMD GPUs via /dev/kfd without shelling out", async () => {
    spyCgroupFiles({});
    const exec = vi.fn();
    resetMachineProfileForTests({
      fsModule: makeFsModule({ existing: ["/dev/kfd"] }),
      execFileFn: exec,
    });
    const profile = getMachineProfile();
    await whenGpuEnriched();
    expect(profile.gpu).toMatchObject({ present: true, vendor: "amd" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("hasCapacityChanged compares capacity fields only and never throws", () => {
    const files = {
      "/sys/fs/cgroup/memory.max": `${2 * kGb}\n`,
      "/sys/fs/cgroup/cpu.max": "100000 100000",
    };
    spyCgroupFiles(files);
    resetMachineProfileForTests({ fsModule: makeFsModule() });
    getMachineProfile();
    expect(hasCapacityChanged()).toBe(false);

    // Platform resize: the limit file changes under a running process.
    files["/sys/fs/cgroup/memory.max"] = `${8 * kGb}\n`;
    expect(hasCapacityChanged()).toBe(true);

    // Refresh adopts the new capacity; no longer "changed".
    const refreshed = refreshMachineProfile();
    expect(refreshed.memory.limitBytes).toBe(8 * kGb);
    expect(refreshed.tier).toBe("large");
    expect(hasCapacityChanged()).toBe(false);

    // Files vanishing mid-flight is a fallback shift, handled without throwing.
    delete files["/sys/fs/cgroup/memory.max"];
    delete files["/sys/fs/cgroup/cpu.max"];
    expect(typeof hasCapacityChanged()).toBe("boolean");
  });
});

const fs = require("fs");
const os = require("os");
const { execFile } = require("child_process");
const {
  getAllocatedCpuInfo,
  getMemoryLimitInfo,
  readDiskUsage,
} = require("./system-resources");

// Boot-computed, memoized CAPACITY profile of the container this process runs
// in. Capacity (memory limit, CPU quota, disk size, GPU presence) changes only
// across container reboots or platform resizes, and several consumers must be
// event-loop-cheap and deterministic within one boot: the 2s status snapshot
// loop, gatewayEnv() on every spawn, and skill/prompt generation. Live USAGE
// stays in getSystemResources() — this module never reports usage.
//
//   getMachineProfile()  ──▶ memo ──▶ { detectedAt, memory, cpu, disk, gpu,
//                                       tier, environment }
//   refreshMachineProfile()  clears the memo (reapply / resize paths)
//   hasCapacityChanged()     cheap re-read of the capacity fields vs the memo
//   whenGpuEnriched()        bounded (~3s) promise the boot apply awaits so
//                            prompt artifacts never bake a stale "no GPU"
//
// The core profile is fully synchronous; only GPU details (name/VRAM/driver
// via nvidia-smi) arrive asynchronously and mutate the memo's gpu in place.

const kGpuProbeTimeoutMs = 3000;

// Memory-driven tiers: memory is the binding constraint on the boxes this app
// ships to (512MB Render starter → multi-GB hosts).
const kTierThresholds = [
  { tier: "micro", maxBytes: 640 * 1024 * 1024 },
  { tier: "small", maxBytes: 2 * 1024 * 1024 * 1024 },
  { tier: "medium", maxBytes: 4 * 1024 * 1024 * 1024 },
  { tier: "large", maxBytes: 8 * 1024 * 1024 * 1024 },
];

const resolveTier = (memBytes) => {
  if (!Number.isFinite(memBytes) || memBytes <= 0) return "small";
  for (const { tier, maxBytes } of kTierThresholds) {
    if (memBytes <= maxBytes) return tier;
  }
  return "xl";
};

// Container markers beyond /.dockerenv: /run/.containerenv (Podman) and the
// cgroup path of pid 1 (kubepods/containerd/docker) — /.dockerenv alone misses
// common Kubernetes/Podman configurations. "unknown" is treated like a
// container by the autotune suppression rule (conservative: an unrecognized
// runtime with unreadable limits must not be tuned on host totals).
const kContainerCgroupPattern = /kubepods|docker|containerd|podman|libpod|ecs/i;

const detectEnvironment = (fsModule) => {
  try {
    if (
      fsModule.existsSync("/.dockerenv") ||
      fsModule.existsSync("/run/.containerenv")
    ) {
      return "container";
    }
  } catch {}
  try {
    const cgroup = fsModule.readFileSync("/proc/1/cgroup", "utf8");
    if (kContainerCgroupPattern.test(cgroup)) return "container";
    // cgroup-namespaced containers (Kubernetes/containerd default) read
    // exactly "0::/" — a bare-metal systemd host reads "0::/init.scope" (or
    // multi-line v1 paths). The bare "0::/" is a container signature; missing
    // it here would tune a limitless pod on the NODE's total RAM.
    if (cgroup.trim() === "0::/") return "container";
    return "bare-metal";
  } catch {
    // No /proc: macOS dev boxes ARE the host they report.
    return process.platform === "darwin" ? "bare-metal" : "unknown";
  }
};

const detectGpuPresence = (fsModule) => {
  const exists = (p) => {
    try {
      return fsModule.existsSync(p);
    } catch {
      return false;
    }
  };
  if (
    exists("/proc/driver/nvidia/version") ||
    exists("/dev/nvidiactl") ||
    exists("/dev/nvidia0")
  ) {
    return {
      present: true,
      vendor: "nvidia",
      devices: [],
      driverVersion: null,
      source: "device-node",
    };
  }
  if (exists("/dev/kfd")) {
    return {
      present: true,
      vendor: "amd",
      devices: [],
      driverVersion: null,
      source: "device-node",
    };
  }
  return { present: false };
};

// nvidia-smi emits one CSV row per device; the profile carries all of them
// (multi-GPU boxes exist) and the UI decides how to summarize.
const parseNvidiaSmiOutput = (stdout) => {
  const devices = [];
  let driverVersion = null;
  for (const line of String(stdout || "").split("\n")) {
    const parts = line.split(",").map((part) => part.trim());
    if (parts.length < 3 || !parts[0]) continue;
    const vramMib = Number.parseInt(parts[1], 10);
    devices.push({
      name: parts[0],
      vramBytes: Number.isNaN(vramMib) ? null : vramMib * 1024 * 1024,
    });
    if (!driverVersion && parts[2]) driverVersion = parts[2];
  }
  return { devices, driverVersion };
};

const state = {
  deps: { fsModule: fs, execFileFn: execFile, osModule: os },
  profile: null,
  gpuEnrichment: null, // promise: resolves when enrichment settles (or immediately)
};

const computeProfile = () => {
  const { fsModule, osModule } = state.deps;
  const hostCores = (() => {
    try {
      return osModule.cpus().length || 1;
    } catch {
      return 1;
    }
  })();
  let memoryInfo;
  try {
    memoryInfo = getMemoryLimitInfo();
  } catch {
    memoryInfo = { limitBytes: null, source: "host" };
  }
  let cpuInfo;
  try {
    cpuInfo = getAllocatedCpuInfo();
  } catch {
    cpuInfo = { cores: null, source: "host" };
  }
  let disk;
  try {
    disk = readDiskUsage();
  } catch {
    disk = { totalBytes: null, path: null };
  }
  const hostTotalMem = (() => {
    try {
      return osModule.totalmem();
    } catch {
      return null;
    }
  })();
  const limitBytes = memoryInfo.limitBytes ?? hostTotalMem;
  return {
    detectedAt: Date.now(),
    memory: { limitBytes, source: memoryInfo.source },
    cpu: {
      cores: cpuInfo.cores ?? hostCores,
      hostCores,
      source: cpuInfo.cores != null ? cpuInfo.source : "host",
    },
    disk: { totalBytes: disk.totalBytes ?? null, path: disk.path ?? null },
    gpu: detectGpuPresence(fsModule),
    tier: resolveTier(limitBytes),
    environment: detectEnvironment(fsModule),
  };
};

const startGpuEnrichment = (profile) => {
  if (!profile.gpu?.present || profile.gpu.vendor !== "nvidia") {
    state.gpuEnrichment = Promise.resolve();
    return;
  }
  const { execFileFn } = state.deps;
  state.gpuEnrichment = new Promise((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    // Safety net over the execFile timeout: the boot apply awaits this promise
    // and must never hang on a wedged probe.
    const guard = setTimeout(settle, kGpuProbeTimeoutMs + 500);
    if (typeof guard.unref === "function") guard.unref();
    try {
      execFileFn(
        "nvidia-smi",
        [
          "--query-gpu=name,memory.total,driver_version",
          "--format=csv,noheader,nounits",
        ],
        { encoding: "utf8", timeout: kGpuProbeTimeoutMs },
        (err, stdout) => {
          if (!err) {
            const { devices, driverVersion } = parseNvidiaSmiOutput(stdout);
            if (devices.length && state.profile === profile) {
              profile.gpu = {
                ...profile.gpu,
                devices,
                driverVersion,
                source: "nvidia-smi",
              };
            }
          }
          clearTimeout(guard);
          settle();
        },
      );
    } catch {
      clearTimeout(guard);
      settle();
    }
  });
};

const getMachineProfile = () => {
  if (!state.profile) {
    state.profile = computeProfile();
    startGpuEnrichment(state.profile);
  }
  return state.profile;
};

const refreshMachineProfile = () => {
  state.profile = null;
  state.gpuEnrichment = null;
  return getMachineProfile();
};

// Bounded promise (≤ kGpuProbeTimeoutMs + 500) that resolves once GPU details
// are as complete as they will get for this boot.
const whenGpuEnriched = () => {
  getMachineProfile();
  return state.gpuEnrichment || Promise.resolve();
};

// The capacity view of a profile: the fields a platform resize changes —
// never detectedAt or GPU enrichment. The ONE comparator shared by the
// watchdog tick and autotune's apply path (a field added to one but not the
// other would make resize detection inconsistent between them).
const capacityOf = (profile) => ({
  memoryLimitBytes: profile?.memory?.limitBytes ?? null,
  cpuCores: profile?.cpu?.cores ?? null,
  diskTotalBytes: profile?.disk?.totalBytes ?? null,
});

const sameCapacity = (a, b) =>
  !!a &&
  !!b &&
  a.memoryLimitBytes === b.memoryLimitBytes &&
  a.cpuCores === b.cpuCores &&
  (a.diskTotalBytes ?? null) === (b.diskTotalBytes ?? null);

// Lean capacity-only read for the watchdog tick: just the three limit reads —
// no os.cpus() allocation, GPU/environment probes, or /proc/1/cgroup read
// whose results a comparison would throw away.
const readCurrentCapacity = () => {
  const { osModule } = state.deps;
  let memory;
  try {
    memory = getMemoryLimitInfo();
  } catch {
    memory = { limitBytes: null };
  }
  let cpu;
  try {
    cpu = getAllocatedCpuInfo();
  } catch {
    cpu = { cores: null };
  }
  let disk;
  try {
    disk = readDiskUsage();
  } catch {
    disk = { totalBytes: null };
  }
  const hostTotalMem = (() => {
    try {
      return osModule.totalmem();
    } catch {
      return null;
    }
  })();
  const hostCores = (() => {
    try {
      return osModule.cpus().length || 1;
    } catch {
      return 1;
    }
  })();
  return {
    memoryLimitBytes: memory.limitBytes ?? hostTotalMem,
    cpuCores: cpu.cores ?? hostCores,
    diskTotalBytes: disk.totalBytes ?? null,
  };
};

// Cheap capacity re-read for the watchdog's live-resize check. Never throws.
const hasCapacityChanged = () => {
  try {
    const profile = getMachineProfile();
    return !sameCapacity(readCurrentCapacity(), capacityOf(profile));
  } catch {
    return false;
  }
};

const resetMachineProfileForTests = ({
  fsModule = fs,
  execFileFn = execFile,
  osModule = os,
} = {}) => {
  state.deps = { fsModule, execFileFn, osModule };
  state.profile = null;
  state.gpuEnrichment = null;
};

module.exports = {
  getMachineProfile,
  refreshMachineProfile,
  whenGpuEnriched,
  hasCapacityChanged,
  capacityOf,
  sameCapacity,
  resolveTier,
  resetMachineProfileForTests,
};

const os = require("os");
const fs = require("fs");
const { execFile } = require("child_process");
const { monitorEventLoopDelay } = require("perf_hooks");
const {
  kRootDir,
  kEventLoopLagWarnMs,
  kEventLoopLagWarnIntervalMs,
  kPsStatsMemoMs,
} = require("./constants");

const readCgroupFile = (filePath) => {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return null;
  }
};

const readFirstCgroupFile = (paths) => {
  for (const filePath of paths) {
    const value = readCgroupFile(filePath);
    if (value != null) return value;
  }
  return null;
};

const countCpuSet = (cpuSet) => {
  if (!cpuSet) return null;
  let count = 0;
  const parts = String(cpuSet)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const part of parts) {
    const [startRaw, endRaw] = part.split("-");
    const start = Number.parseInt(startRaw, 10);
    const end = endRaw == null ? start : Number.parseInt(endRaw, 10);
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    count += Math.max(0, end - start + 1);
  }
  return count > 0 ? count : null;
};

const parseCgroupMemory = () => {
  const current = readFirstCgroupFile([
    "/sys/fs/cgroup/memory.current",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes",
  ]);
  const max = readFirstCgroupFile([
    "/sys/fs/cgroup/memory.max",
    "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  ]);
  if (!current) return null;
  const usedBytes = Number.parseInt(current, 10);
  if (Number.isNaN(usedBytes)) return null;
  const parsedLimit =
    max && max !== "max" ? Number.parseInt(max, 10) : null;
  const limitBytes = Number.isNaN(parsedLimit) ? null : parsedLimit;
  // Cgroup v1 uses huge sentinel values to mean "no limit".
  const unlimited =
    limitBytes == null ||
    limitBytes <= 0 ||
    limitBytes >= 9_000_000_000_000_000_000;
  return {
    usedBytes,
    totalBytes: unlimited ? null : limitBytes,
  };
};

const parseCgroupCpu = () => {
  const stat = readCgroupFile("/sys/fs/cgroup/cpu.stat");
  if (!stat) return null;
  const lines = stat.split("\n");
  const map = {};
  for (const line of lines) {
    const [key, val] = line.split(/\s+/);
    if (key && val) map[key] = Number.parseInt(val, 10);
  }
  return {
    usageUsec: map.usage_usec ?? null,
    userUsec: map.user_usec ?? null,
    systemUsec: map.system_usec ?? null,
  };
};

const parseCgroupCpuV1 = () => {
  const usageNs = readFirstCgroupFile([
    "/sys/fs/cgroup/cpuacct/cpuacct.usage",
    "/sys/fs/cgroup/cpu/cpuacct.usage",
  ]);
  if (!usageNs) return null;
  const usageNsParsed = Number.parseInt(usageNs, 10);
  if (Number.isNaN(usageNsParsed)) return null;
  return {
    usageUsec: Math.floor(usageNsParsed / 1000),
    userUsec: null,
    systemUsec: null,
  };
};

const getAllocatedCpuCores = () => {
  const cpuMax = readCgroupFile("/sys/fs/cgroup/cpu.max");
  if (cpuMax) {
    const [quotaRaw, periodRaw] = cpuMax.split(/\s+/);
    const quota = Number.parseInt(quotaRaw, 10);
    const period = Number.parseInt(periodRaw, 10);
    if (quotaRaw !== "max" && !Number.isNaN(quota) && !Number.isNaN(period) && period > 0) {
      return quota / period;
    }
  }

  const quotaV1 = readFirstCgroupFile([
    "/sys/fs/cgroup/cpu/cpu.cfs_quota_us",
    "/sys/fs/cgroup/cpuacct/cpu.cfs_quota_us",
  ]);
  const periodV1 = readFirstCgroupFile([
    "/sys/fs/cgroup/cpu/cpu.cfs_period_us",
    "/sys/fs/cgroup/cpuacct/cpu.cfs_period_us",
  ]);
  if (quotaV1 && periodV1) {
    const quota = Number.parseInt(quotaV1, 10);
    const period = Number.parseInt(periodV1, 10);
    if (!Number.isNaN(quota) && !Number.isNaN(period) && quota > 0 && period > 0) {
      return quota / period;
    }
  }

  const cpuSet =
    readCgroupFile("/sys/fs/cgroup/cpuset.cpus.effective") ||
    readCgroupFile("/sys/fs/cgroup/cpuset.cpus");
  return countCpuSet(cpuSet);
};

const readProcStatus = (pid) => {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, "utf8");
    const vmRss = status.match(/VmRSS:\s+(\d+)\s+kB/);
    return { rssBytes: vmRss ? Number.parseInt(vmRss[1], 10) * 1024 : null };
  } catch {
    return null;
  }
};

// The `ps` fallback (macOS — no /proc) is a shell-out; doing it synchronously
// blocked the event loop on every resources poll. Polls serve a memo that a
// background execFile refreshes at most every kPsStatsMemoMs.
const psStatsCache = new Map(); // pid -> { value, fetchedAt, inFlight }

const readPsStats = (pid) => {
  // Evict pids nobody asked about recently — on macOS every gateway restart
  // mints a new pid and the map would grow for the life of the process.
  const evictBefore = Date.now() - kPsStatsMemoMs * 10;
  for (const [cachedPid, cached] of psStatsCache) {
    if (cachedPid !== pid && cached.fetchedAt < evictBefore && !cached.inFlight) {
      psStatsCache.delete(cachedPid);
    }
  }
  let entry = psStatsCache.get(pid);
  if (!entry) {
    entry = { value: null, fetchedAt: 0, inFlight: false };
    psStatsCache.set(pid, entry);
  }
  const stale = Date.now() - entry.fetchedAt >= kPsStatsMemoMs;
  if (stale && !entry.inFlight) {
    entry.inFlight = true;
    try {
      execFile(
        "ps",
        ["-o", "rss=,pcpu=", "-p", String(pid)],
        { encoding: "utf8", timeout: 2000 },
        (err, stdout) => {
          entry.inFlight = false;
          entry.fetchedAt = Date.now();
          if (err) {
            entry.value = null;
            return;
          }
          const [rss, pcpu] = String(stdout || "").trim().split(/\s+/);
          entry.value = {
            rssBytes: rss ? Number.parseInt(rss, 10) * 1024 : null,
            cpuPercent: pcpu ? Number.parseFloat(pcpu) : null,
          };
        },
      );
    } catch {
      entry.inFlight = false;
      entry.fetchedAt = Date.now();
      entry.value = null;
    }
  }
  return entry.value;
};

const getProcessUsage = (pid) => {
  if (!pid) return null;
  const proc = readProcStatus(pid);
  if (proc) return { rssBytes: proc.rssBytes };
  const ps = readPsStats(pid);
  if (ps) return { rssBytes: ps.rssBytes };
  return null;
};

const readDiskUsage = () => {
  const paths = [kRootDir, "/data", "/"];
  for (const diskPath of paths) {
    try {
      const stat = fs.statfsSync(diskPath);
      return {
        usedBytes: stat.bsize * (stat.blocks - stat.bfree),
        totalBytes: stat.bsize * stat.blocks,
        path: diskPath,
      };
    } catch {
      // Try next path.
    }
  }
  return { usedBytes: null, totalBytes: null, path: null };
};

let prevCpuSnapshot = null;
let prevCpuSnapshotAt = 0;

// Event-loop lag is the direct measure of "the server froze itself" — the
// failure mode behind every slow-UI complaint. Started explicitly (never at
// import time — an import-time side effect would leave every test that
// touches this module with an untearable histogram interval) and lazily on
// first read. Two consumers, each on its own histogram so their resets never
// race:
//  - readEventLoopLag: read-and-reset per poll, so each reading covers the
//    window since the last one;
//  - a fixed sampling window whose sustained-lag warning fires even when
//    nobody is polling the resources endpoint.
const kLoopLagSampleWindowMs = 5000;
const kLoopLagWarnThresholdMs = 500;
const kLoopLagWarnConsecutiveWindows = 3;
const kLoopLagWarnIntervalMs = 60000;

const loopLagState = {
  pollHistogram: null,
  windowHistogram: null,
  timer: null,
  lastWindow: { p50Ms: null, p99Ms: null, maxMs: null },
  consecutiveHighWindows: 0,
  lastWarnAt: 0,
};
let lastLagWarnAt = 0;

const nsToMs = (ns) =>
  Number.isFinite(ns) ? Math.round(ns / 100_000) / 10 : null;

const sampleLoopLagWindow = () => {
  const histogram = loopLagState.windowHistogram;
  if (!histogram) return;
  loopLagState.lastWindow = {
    p50Ms: nsToMs(histogram.percentile(50)),
    p99Ms: nsToMs(histogram.percentile(99)),
    maxMs: nsToMs(histogram.max),
  };
  histogram.reset();
  const p99Ms = loopLagState.lastWindow.p99Ms;
  if (p99Ms != null && p99Ms > kLoopLagWarnThresholdMs) {
    loopLagState.consecutiveHighWindows += 1;
  } else {
    loopLagState.consecutiveHighWindows = 0;
  }
  const now = Date.now();
  if (
    loopLagState.consecutiveHighWindows >= kLoopLagWarnConsecutiveWindows &&
    now - loopLagState.lastWarnAt >= kLoopLagWarnIntervalMs
  ) {
    loopLagState.lastWarnAt = now;
    console.warn(
      `[alphaclaw] Event-loop lag sustained above ${kLoopLagWarnThresholdMs}ms (p99 ${p99Ms}ms over ${loopLagState.consecutiveHighWindows} windows) — check /api/watchdog/resources, recent gateway restarts, and workspace size`,
    );
  }
};

// Idempotent explicit start (routes/watchdog.js calls this when the server
// wires its routes); also invoked lazily by the readers below.
const startLoopLagMonitor = () => {
  if (loopLagState.pollHistogram) return;
  try {
    loopLagState.pollHistogram = monitorEventLoopDelay({ resolution: 20 });
    loopLagState.pollHistogram.enable();
    loopLagState.windowHistogram = monitorEventLoopDelay({ resolution: 20 });
    loopLagState.windowHistogram.enable();
    loopLagState.timer = setInterval(sampleLoopLagWindow, kLoopLagSampleWindowMs);
    if (typeof loopLagState.timer.unref === "function") loopLagState.timer.unref();
  } catch {
    loopLagState.pollHistogram = null;
    loopLagState.windowHistogram = null;
    if (loopLagState.timer) {
      clearInterval(loopLagState.timer);
      loopLagState.timer = null;
    }
  }
};

// Poll-window read: covers the interval since the previous call. `p50Ms` is
// grafted from upstream's telemetry alongside the original shape.
const readEventLoopLag = ({ warn = console.warn } = {}) => {
  startLoopLagMonitor();
  const histogram = loopLagState.pollHistogram;
  if (!histogram) return { meanMs: null, p50Ms: null, p99Ms: null, maxMs: null };
  const meanMs = nsToMs(histogram.mean);
  const p50Ms = nsToMs(histogram.percentile(50));
  const p99Ms = nsToMs(histogram.percentile(99));
  const maxMs = nsToMs(histogram.max);
  histogram.reset();
  if (p99Ms != null && p99Ms > kEventLoopLagWarnMs) {
    const now = Date.now();
    if (now - lastLagWarnAt > kEventLoopLagWarnIntervalMs) {
      lastLagWarnAt = now;
      warn(
        `[system-resources] event-loop lag p99 ${p99Ms}ms exceeds ${kEventLoopLagWarnMs}ms — the server is blocking on synchronous work`,
      );
    }
  }
  return { meanMs, p50Ms, p99Ms, maxMs };
};

// Fixed-window read for the resources payload: values are from the most
// recently completed sampling window (null until the first one lands).
const getEventLoopLag = () => {
  startLoopLagMonitor();
  return { ...loopLagState.lastWindow };
};

const getSystemResources = ({ gatewayPid = null } = {}) => {
  const hostCores = os.cpus().length || 1;
  const allocatedCores = getAllocatedCpuCores() || hostCores;
  const cgroupMem = parseCgroupMemory();
  const mem = {
    usedBytes: cgroupMem?.usedBytes ?? process.memoryUsage().rss,
    totalBytes: cgroupMem?.totalBytes ?? os.totalmem(),
  };

  const diskUsage = readDiskUsage();

  const cgroupCpu = parseCgroupCpu() || parseCgroupCpuV1();
  let cpuPercent = null;
  if (cgroupCpu?.usageUsec != null) {
    const now = Date.now();
    if (prevCpuSnapshot && prevCpuSnapshotAt) {
      const elapsedMs = now - prevCpuSnapshotAt;
      if (elapsedMs > 0) {
        const usageDeltaUs = cgroupCpu.usageUsec - prevCpuSnapshot.usageUsec;
        const elapsedUs = elapsedMs * 1000;
        const rawPercent = (usageDeltaUs / elapsedUs) * 100;
        cpuPercent = Math.min(100, Math.max(0, rawPercent / allocatedCores));
      }
    }
    prevCpuSnapshot = cgroupCpu;
    prevCpuSnapshotAt = now;
  } else {
    const load = os.loadavg();
    cpuPercent = Math.min(100, Math.max(0, (load[0] / allocatedCores) * 100));
  }

  const alphaclawRss = process.memoryUsage().rss;
  const gatewayUsage = getProcessUsage(gatewayPid);
  const gatewayRss = gatewayUsage?.rssBytes ?? null;

  return {
    memory: {
      usedBytes: mem.usedBytes,
      totalBytes: mem.totalBytes,
      percent: mem.totalBytes
        ? Math.round((mem.usedBytes / mem.totalBytes) * 1000) / 10
        : null,
    },
    disk: {
      usedBytes: diskUsage.usedBytes,
      totalBytes: diskUsage.totalBytes,
      path: diskUsage.path,
      percent: diskUsage.totalBytes
        ? Math.round((diskUsage.usedBytes / diskUsage.totalBytes) * 1000) / 10
        : null,
    },
    cpu: {
      percent: cpuPercent != null ? Math.round(cpuPercent * 10) / 10 : null,
      cores: Math.round(allocatedCores * 10) / 10,
      hostCores,
    },
    processes: {
      alphaclaw: { rssBytes: alphaclawRss },
      gateway: { rssBytes: gatewayRss, pid: gatewayPid },
    },
    // The resources payload carries the fixed-window telemetry (upstream's
    // route contract: { p50Ms, p99Ms, maxMs }, null until the first window).
    eventLoop: getEventLoopLag(),
  };
};

module.exports = { getSystemResources, readEventLoopLag, startLoopLagMonitor };

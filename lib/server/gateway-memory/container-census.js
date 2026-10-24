const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const { getProcessIdentity } = require("./process-identity");

// Bounded census of every process in the container's memory cgroup (ALPH-25),
// for a container that is full while the gateway's own tree is small. The
// pids come from cgroup.procs of the cgroup root this container sees and its
// descendants (v2, then v1's memory hierarchy); /proc is the fallback when
// those files are unreadable. A pid outside this pid namespace reads as 0 and
// is skipped. Only the largest process by RSS leaves this module, as a pid,
// its start ticks (to compare two samples of the same process) and its RSS.
const kMaxPids = 8192;
const kMaxCgroupDirs = 256;
const kScanBudgetMs = 50;
const kCgroupRoots = ["/sys/fs/cgroup", "/sys/fs/cgroup/memory"];

const listCgroupPids = (fsModule, expired) => {
  for (const root of kCgroupRoots) {
    let pids = null;
    const queue = [root];
    for (let i = 0; i < queue.length && !expired(); i += 1) {
      let text;
      try { text = String(fsModule.readFileSync(`${queue[i]}/cgroup.procs`, "utf8")); }
      catch { if (i === 0) break; continue; }
      pids ||= new Set();
      for (let start = 0; start < text.length && pids.size < kMaxPids; ) {
        if ((pids.size & 255) === 0 && expired()) break;
        const end = text.indexOf("\n", start);
        const pid = Number(text.slice(start, end < 0 ? text.length : end));
        if (Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
        start = end < 0 ? text.length : end + 1;
      }
      if (pids.size >= kMaxPids) break;
      try {
        for (const entry of fsModule.readdirSync(queue[i], { withFileTypes: true })) {
          if (entry.isDirectory() && queue.length < kMaxCgroupDirs) queue.push(`${queue[i]}/${entry.name}`);
        }
      } catch {}
    }
    if (pids) return { source: "cgroup", pids: [...pids], truncated: queue.length >= kMaxCgroupDirs || pids.size >= kMaxPids };
  }
  let names;
  try { names = fsModule.readdirSync("/proc"); } catch { return null; }
  const pids = [];
  let truncated = false;
  for (const name of names) {
    if (!/^\d+$/.test(String(name))) continue;
    if (pids.length >= kMaxPids) { truncated = true; break; }
    pids.push(Number(name));
  }
  return { source: "proc", pids, truncated };
};

const readRssBytes = (pid, fsModule) => {
  try {
    const match = /^VmRSS:\s+(\d+)\s+kB\s*$/m.exec(String(fsModule.readFileSync(`/proc/${pid}/status`, "utf8")));
    return match ? Number(match[1]) * 1024 : null;
  } catch {
    return null;
  }
};

const readLargestContainerProcess = ({ fsModule = fs, monotonicNowFn = () => performance.now(),
  scanBudgetMs = kScanBudgetMs } = {}) => {
  const started = monotonicNowFn();
  const expired = () => monotonicNowFn() - started >= scanBudgetMs;
  const listing = listCgroupPids(fsModule, expired);
  if (!listing) return { status: "unavailable", source: null, scanned: 0, largest: null };
  let complete = !listing.truncated;
  let scanned = 0;
  let largest = null;
  for (const pid of listing.pids) {
    if (expired()) { complete = false; break; }
    scanned += 1;
    const rssBytes = readRssBytes(pid, fsModule);
    if (Number.isSafeInteger(rssBytes) && rssBytes > 0 && (!largest || rssBytes > largest.rssBytes)) largest = { pid, rssBytes };
  }
  const identity = largest ? getProcessIdentity(largest.pid, { fsModule }) : null;
  return {
    status: !identity ? "unavailable" : complete ? "fresh" : "partial",
    source: listing.source, scanned,
    largest: identity ? { pid: largest.pid, startTicks: identity.startTicks, rssBytes: largest.rssBytes } : null,
  };
};

module.exports = { readLargestContainerProcess, kMaxPids, kMaxCgroupDirs, kScanBudgetMs };

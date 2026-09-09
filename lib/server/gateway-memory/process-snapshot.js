const fs = require("node:fs");
const { performance } = require("node:perf_hooks");
const { getProcessIdentity, parseProcessStat } = require("./process-identity");
const { createProcessPssSampler } = require("./process-pss");

const kProcTreeMemoMs = 5000;
const kMaxProcScan = 8192;
const kProcScanBudgetMs = 50;
const kMaxContributors = 128;
const kRootSources = new Set(["serving_root", "managed_root", "serving_pid", "unknown"]);
const kStatusBytes = 16 * 1024;

const readProcText = (pid, file, fsModule) => {
  let fd;
  try {
    fd = fsModule.openSync(`/proc/${pid}/${file}`, "r");
    const buffer = Buffer.alloc(kStatusBytes + 1);
    const bytes = fsModule.readSync(fd, buffer, 0, buffer.length, 0);
    return bytes <= kStatusBytes ? buffer.toString("utf8", 0, bytes) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fsModule.closeSync(fd); } catch {} }
  }
};

const readStatus = (pid, fsModule) => {
  const raw = readProcText(pid, "status", fsModule);
  if (raw === null) return null;
  const parent = /^PPid:\s+(\d+)\s*$/m.exec(raw);
  const rss = /^VmRSS:\s+(\d+)\s+kB\s*$/m.exec(raw);
  const parentPid = Number(parent?.[1]);
  const rssBytes = rss ? Number(rss[1]) * 1024 : null;
  if (!Number.isSafeInteger(parentPid) || parentPid < 0) return null;
  return { pid, parentPid, rssBytes: Number.isSafeInteger(rssBytes) && rssBytes >= 0 ? rssBytes : null };
};

const sameIdentity = (left, right) => left?.pid === right?.pid &&
  left?.startTicks === right?.startTicks && !!left;

const emptySnapshot = ({ nowMs, root, worker, rootSource, reason }) => ({
  atMs: nowMs, status: "unavailable", reason, root, worker, rootSource,
  groupRssBytes: null, workerRssBytes: null, childRssBytes: null, childCount: 0,
  launcherRssBytes: null, launcherCount: 0, processCount: 0, contributors: [],
});

// The /proc census is shared by Resources and the detector. RSS/PPid come
// from one status read; identity checks fence the asynchronous PSS work.
//
// managed root ─┬─ serving worker ─ descendants  => gateway / gateway_child
//              └─ other branches               => launcher / launcher_child
// No argv, executable paths, or free-form process names leave this module.
const createGatewayProcessCollector = ({
  fsModule = fs,
  monotonicNowFn = () => performance.now(),
  maxProcScan = kMaxProcScan,
  scanBudgetMs = kProcScanBudgetMs,
  pssSampler = createProcessPssSampler({ fsModule }),
} = {}) => {
  let memo = null;
  const identity = (pid) => getProcessIdentity(pid, { fsModule });

  const collect = ({ rootPid, workerPid, root, worker, rootSource, nowMs }) => {
    const empty = (reason) => ({ snapshot: emptySnapshot({ nowMs, root, worker, rootSource, reason }), members: [] });
    if (!root) return empty("process_unavailable");
    let names;
    try { names = fsModule.readdirSync("/proc"); }
    catch { return empty("proc_unavailable"); }

    const started = monotonicNowFn();
    const records = new Map();
    let reason = worker ? null : "worker_unavailable";
    // Sample the two authoritative processes even if a host's census is
    // truncated. The result is still partial, never a fabricated whole tree.
    for (const pid of new Set(worker ? [rootPid, workerPid] : [rootPid])) {
      const status = readStatus(pid, fsModule);
      if (!status) return empty("process_unavailable");
      records.set(pid, status);
    }
    let scanned = 0;
    for (const name of names) {
      if (!/^\d+$/.test(String(name))) continue;
      if (scanned++ >= maxProcScan) { reason = "scan_limit"; break; }
      if (monotonicNowFn() - started >= scanBudgetMs) { reason = "scan_deadline"; break; }
      const pid = Number(name);
      if (!Number.isSafeInteger(pid) || pid <= 0 || records.has(pid)) continue;
      const status = readStatus(pid, fsModule);
      if (status) records.set(pid, status);
      else reason ||= "incomplete_tree";
    }
    const children = new Map();
    for (const record of records.values()) {
      if (!children.has(record.parentPid)) children.set(record.parentPid, []);
      children.get(record.parentPid).push(record.pid);
    }
    const walk = (start) => {
      const seen = new Set([start]);
      const queue = [start];
      for (let i = 0; i < queue.length; i += 1) {
        for (const child of children.get(queue[i]) || []) {
          if (!seen.has(child)) { seen.add(child); queue.push(child); }
        }
      }
      return seen;
    };
    const group = walk(rootPid);
    if (worker && !group.has(workerPid)) return empty("worker_outside_tree");
    const workerTree = worker ? walk(workerPid) : new Set();
    if (rootPid !== workerPid && workerTree.has(rootPid)) reason ||= "invalid_sample";
    const members = [];
    const contributors = [];
    let groupRssBytes = 0;
    let childRssBytes = 0;
    let launcherRssBytes = 0;
    let childCount = 0;
    let launcherCount = 0;
    let measuredChildCount = 0;
    let measuredLauncherCount = 0;
    let measuredCount = 0;
    for (const pid of group) {
      const status = records.get(pid);
      const role = !worker ? "unknown" : pid === workerPid ? "gateway" : pid === rootPid ? "launcher" :
        workerTree.has(pid) ? "gateway_child" : "launcher_child";
      // The census and identity pass share one scheduling budget. RSS
      // subtotals remain visible when it expires; enforcement sees partial.
      const expired = monotonicNowFn() - started >= scanBudgetMs;
      const stat = expired ? null : parseProcessStat(readProcText(pid, "stat", fsModule));
      if (expired) reason = "scan_deadline";
      if (stat?.pid !== pid || stat.parentPid !== status?.parentPid) reason ||= "identity_changed";
      else members.push({ ...stat, role });
      if (status?.rssBytes === null || status?.rssBytes === undefined) reason ||= "incomplete_tree";
      else {
        measuredCount += 1;
        groupRssBytes += status.rssBytes;
        if (role === "gateway_child") { childRssBytes += status.rssBytes; measuredChildCount += 1; }
        if (role === "launcher" || role === "launcher_child") { launcherRssBytes += status.rssBytes; measuredLauncherCount += 1; }
      }
      if (role === "gateway_child") childCount += 1;
      if (role === "launcher" || role === "launcher_child") launcherCount += 1;
      if (contributors.length < kMaxContributors) contributors.push({ pid, role, rssBytes: status?.rssBytes ?? null });
    }
    if (!sameIdentity(root, identity(rootPid)) || (worker && !sameIdentity(worker, identity(workerPid)))) {
      return empty("identity_changed");
    }
    return {
      snapshot: {
        atMs: nowMs, status: reason ? "partial" : "fresh", reason,
        root, worker, rootSource,
        groupRssBytes: measuredCount ? groupRssBytes : null,
        workerRssBytes: worker ? records.get(workerPid)?.rssBytes ?? null : null,
        childRssBytes: measuredChildCount || (!childCount && !reason) ? childRssBytes : null,
        childCount,
        launcherRssBytes: measuredLauncherCount || (!launcherCount && !reason) ? launcherRssBytes : null,
        launcherCount,
        processCount: group.size,
        sampledProcessCount: measuredCount,
        contributors,
      },
      members,
    };
  };

  const getSnapshot = ({ rootPid = null, workerPid = rootPid,
    rootSource = "unknown", nowMs = Date.now() } = {}) => {
    rootSource = kRootSources.has(rootSource) ? rootSource : "unknown";
    const root = identity(rootPid);
    const worker = rootPid === workerPid ? root : identity(workerPid);
    const key = `${root?.pid}:${root?.startTicks}/${worker?.pid}:${worker?.startTicks}/${rootSource}`;
    if (!memo || memo.key !== key || nowMs - memo.snapshot.atMs >= kProcTreeMemoMs ||
        nowMs < memo.snapshot.atMs || !root || !worker) {
      memo = { key, ...collect({ rootPid, workerPid, root, worker, rootSource, nowMs }) };
    }
    // Cached snapshots are immutable from a caller's perspective. PSS can
    // complete between two reads without forcing another /proc census.
    const snapshot = { ...memo.snapshot,
      root: memo.snapshot.root ? { ...memo.snapshot.root } : null,
      worker: memo.snapshot.worker ? { ...memo.snapshot.worker } : null,
      contributors: memo.snapshot.contributors.map((value) => ({ ...value })),
    };
    snapshot.pss = pssSampler.read(snapshot, memo.members);
    return snapshot;
  };
  return { getSnapshot, reset: () => { memo = null; pssSampler.reset(); } };
};

const collector = createGatewayProcessCollector();
const getGatewayProcessSnapshot = (options) => collector.getSnapshot(options);
const resetGatewayProcessSnapshotForTests = () => collector.reset();

module.exports = { getGatewayProcessSnapshot, resetGatewayProcessSnapshotForTests,
  getProcessIdentity, createGatewayProcessCollector, kProcTreeMemoMs, kMaxProcScan,
  kProcScanBudgetMs, kMaxContributors };

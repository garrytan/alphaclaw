// Optional diagnostic sources fail independently. In particular, a broken
// telemetry file cannot make a readable /proc or cgroup measurement disappear.
//
// Enforcement basis (ALPH-17): the leak verdict judges the gateway WORKER,
// the process the heap + 192 MiB cap describes and the only one a gateway
// restart can fix. A tool child (an exec'd `bun add -g`) is reported beside
// it and never enters the enforced series. The worker basis needs a VERIFIED
// worker identity (the watchdog resolved the serving worker from /proc), never
// the `servingPid ?? pid` fallback, and only the root and worker records,
// which the census reads first: a partial census still yields a worker
// sample. Without a verified worker the group RSS is used and the basis says
// so; the watchdog does not restart on a group-basis verdict.
const kWorkerBasisPartialReasons = new Set(["scan_limit", "scan_deadline", "incomplete_tree", "identity_changed"]);

const resolveBasis = (processSnapshot, workerVerified) => {
  const worker = processSnapshot?.worker;
  const workerRss = processSnapshot?.workerRssBytes;
  const usable = processSnapshot?.status === "fresh" ||
    (processSnapshot?.status === "partial" && kWorkerBasisPartialReasons.has(processSnapshot.reason));
  if (workerVerified && worker && usable && Number.isFinite(workerRss) && workerRss > 0) {
    return { rssBasis: "worker", rssBytes: workerRss, sampleStatus: "fresh",
      identityToken: `${processSnapshot.root?.startTicks ?? "none"}:${worker.pid}:${worker.startTicks ?? "none"}` };
  }
  return { rssBasis: "group",
    rssBytes: processSnapshot?.status === "fresh" ? processSnapshot.groupRssBytes : null,
    sampleStatus: processSnapshot?.status ?? "unavailable",
    identityToken: processSnapshot?.root?.startTicks ?? null };
};

const largestGatewayChild = (processSnapshot) => {
  let largest = null;
  for (const entry of processSnapshot?.contributors || []) {
    if (entry?.role !== "gateway_child" || !Number.isFinite(entry.rssBytes)) continue;
    if (!largest || entry.rssBytes > largest.rssBytes) largest = { pid: entry.pid, rssBytes: entry.rssBytes };
  }
  return largest;
};

const readGatewayMemorySample = ({ rootPid, workerPid, rootSource, stateDir, workerVerified = false } = {}) => {
  let cgroup = null;
  let processSnapshot = null;
  let telemetry = null;
  let activeHeapMb = null;
  try { cgroup = require("../system-resources").parseCgroupMemory(); } catch {}
  const cgroupAtMs = Date.now();
  try {
    processSnapshot = require("./process-snapshot").getGatewayProcessSnapshot({ rootPid, workerPid, rootSource });
  } catch {}
  try {
    telemetry = require("./telemetry").readGatewayTelemetry({ identity: processSnapshot?.worker, stateDir });
  } catch {}
  try { activeHeapMb = require("../autotune").getActiveGatewayHeapMb(); } catch {}
  const finite = (value) => Number.isFinite(value) ? value : null;
  return {
    atMs: processSnapshot?.atMs ?? Date.now(), cgroupAtMs,
    ...resolveBasis(processSnapshot, workerVerified),
    // Only a complete census can say whether the worker dominates the group
    // (the monitor's container-pressure rule); a partial sum would not.
    groupRssBytes: processSnapshot?.status === "fresh" ? finite(processSnapshot.groupRssBytes) : null,
    workerRssBytes: finite(processSnapshot?.workerRssBytes),
    childRssBytes: finite(processSnapshot?.childRssBytes),
    childCount: Number.isSafeInteger(processSnapshot?.childCount) ? processSnapshot.childCount : null,
    largestChild: largestGatewayChild(processSnapshot),
    // Pressure uses the working set (usage minus inactive page cache, #125);
    // raw usage only when memory.stat is unavailable.
    cgroupUsedBytes: cgroup?.workingSetBytes ?? cgroup?.usedBytes ?? null,
    containerLimitBytes: cgroup?.totalBytes ?? null,
    activeHeapMb, process: processSnapshot, telemetry,
  };
};
module.exports = { readGatewayMemorySample };

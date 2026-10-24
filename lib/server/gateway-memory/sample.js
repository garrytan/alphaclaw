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
  let cgroupPressure = null;
  let processSnapshot = null;
  let telemetry = null;
  let activeHeapMb = null;
  const systemResources = require("../system-resources");
  try { cgroup = systemResources.parseCgroupMemory(); } catch {}
  try { cgroupPressure = systemResources.parseCgroupPressure(); } catch {}
  const pressureBasis = systemResources.resolveContainerPressureBasis(cgroup);
  const cgroupAtMs = Date.now();
  try {
    processSnapshot = require("./process-snapshot").getGatewayProcessSnapshot({ rootPid, workerPid, rootSource });
  } catch {}
  try {
    telemetry = require("./telemetry").readGatewayTelemetry({ identity: processSnapshot?.worker, stateDir });
  } catch {}
  try { activeHeapMb = require("../autotune").getActiveGatewayHeapMb(); } catch {}
  let hostTotalBytes = null;
  try { hostTotalBytes = require("node:os").totalmem(); } catch {}
  const finite = (value) => Number.isFinite(value) ? value : null;
  const basis = resolveBasis(processSnapshot, workerVerified);
  const latestTelemetry = Array.isArray(telemetry?.records) ? telemetry.records.at(-1) : null;
  return {
    atMs: processSnapshot?.atMs ?? Date.now(), cgroupAtMs,
    ...basis,
    // The worker's own private memory (USS) from its smaps_rollup, only for a
    // worker-basis sample and only while that read is fresh.
    workerPrivateBytes: basis.rssBasis === "worker" && processSnapshot?.pss?.workerStatus === "fresh"
      ? finite(processSnapshot.pss.workerPrivateBytes) : null,
    heap: latestTelemetry ? {
      status: telemetry.status, atMs: finite(latestTelemetry.atMs),
      usedBytes: finite(latestTelemetry.heapUsedBytes), limitBytes: finite(latestTelemetry.heapLimitBytes),
    } : null,
    // Only a complete census can say whether the worker dominates the group
    // (the monitor's container-pressure rule); a partial sum would not.
    groupRssBytes: processSnapshot?.status === "fresh" ? finite(processSnapshot.groupRssBytes) : null,
    workerRssBytes: finite(processSnapshot?.workerRssBytes),
    childRssBytes: finite(processSnapshot?.childRssBytes),
    childCount: Number.isSafeInteger(processSnapshot?.childCount) ? processSnapshot.childCount : null,
    largestChild: largestGatewayChild(processSnapshot),
    // Pressure uses non-reclaimable memory (usage minus all page cache plus
    // shmem, ALPH-25), else the working set (#125), else raw usage; the basis
    // is named and the other two figures ride along for display.
    cgroupUsedBytes: pressureBasis.bytes,
    cgroupUsageBasis: pressureBasis.basis,
    cgroupRawUsedBytes: finite(cgroup?.usedBytes),
    cgroupWorkingSetBytes: finite(cgroup?.workingSetBytes),
    // PSI (memory.pressure) and the limit counters (memory.events, or v1's
    // failcnt/oom_control), read beside usage; each part null when unreadable.
    cgroupPressure,
    containerLimitBytes: cgroup?.totalBytes ?? null,
    hostTotalBytes: Number.isFinite(hostTotalBytes) && hostTotalBytes > 0 ? hostTotalBytes : null,
    activeHeapMb, process: processSnapshot, telemetry,
  };
};
module.exports = { readGatewayMemorySample };

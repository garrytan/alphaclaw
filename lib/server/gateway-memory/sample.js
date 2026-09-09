// Optional diagnostic sources fail independently. In particular, a broken
// telemetry file cannot make a readable /proc or cgroup measurement disappear.
const readGatewayMemorySample = ({ rootPid, workerPid, rootSource, stateDir } = {}) => {
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
  return {
    atMs: processSnapshot?.atMs ?? Date.now(), cgroupAtMs,
    sampleStatus: processSnapshot?.status ?? "unavailable",
    identityToken: processSnapshot?.root?.startTicks ?? null,
    rssBytes: processSnapshot?.status === "fresh" ? processSnapshot.groupRssBytes : null,
    cgroupUsedBytes: cgroup?.usedBytes ?? null,
    containerLimitBytes: cgroup?.totalBytes ?? null,
    activeHeapMb, process: processSnapshot, telemetry,
  };
};
module.exports = { readGatewayMemorySample };

const { projectMemoryEvidence } = require("./evidence");
const { kTelemetryStaleMs, isIdentity } = require("./telemetry-protocol");

// One target selection for live Resources and frozen incident snapshots.
const resolveGatewayMemoryTarget = (status = {}) => ({
  gatewayRootPid: status?.servingRootPid ?? status?.gatewayPid ?? status?.servingPid ?? null,
  gatewayPid: status?.servingPid ?? status?.gatewayPid ?? null,
  rootSource: status?.servingRootPid ? "serving_root" : status?.gatewayPid ? "managed_root" : "serving_pid",
});

const sameIdentity = (left, right) => isIdentity(left) && isIdentity(right) &&
  left.pid === right.pid && left.startTicks === right.startTicks;

const currentAttribution = (current, previous, attribution, nowMs) => {
  if (!sameIdentity(current?.root, previous?.root) ||
      !sameIdentity(current?.worker, previous?.worker)) {
    return { state: "unknown", reason: "process_changed" };
  }
  if (current.status !== "fresh" || previous.status !== "fresh") {
    return { state: "unknown", reason: "process_unavailable" };
  }
  if (!Number.isFinite(previous.atMs) || previous.atMs > nowMs ||
      nowMs - previous.atMs > kTelemetryStaleMs) {
    return { state: "unknown", reason: "stale_process" };
  }
  return attribution;
};

const withGatewayMemoryDetails = (resources, trend, { stateDir, nowMs = Date.now() } = {}) => {
  let telemetry = null;
  try {
    telemetry = require("./telemetry").readGatewayTelemetry({
      identity: resources?.gatewayMemory?.worker,
      stateDir,
      nowMs,
    });
  } catch {}
  return {
    ...resources,
    gatewayMemory: projectMemoryEvidence({
      process: resources?.gatewayMemory,
      telemetry,
      attribution: currentAttribution(resources?.gatewayMemory, trend?.evidence?.process,
        trend?.evidence?.attribution, nowMs),
    }),
    gatewayMemoryTrend: trend ?? null,
  };
};

module.exports = { resolveGatewayMemoryTarget, withGatewayMemoryDetails };

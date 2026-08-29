// Canonical watchdog phase derivation — a PURE function over a snapshot of
// the watchdog's existing latches. Called from getStatus() so the phase rides
// the 2s SSE status stream; the Watchdog tab's narrative card maps each phase
// to operator-facing copy client-side.
//
// Precedence is the order of the checks below (first match wins), mirroring
// the guard order in runHealthCheck()/onGatewayExit(): hard latches first
// (config error, managed operation, stopped), then transient windows
// (expected restart, safe mode), then the crash family, then startup grace,
// then the repair/degraded family, then steady states.
//
// This module deliberately holds NO state and changes NO transition logic —
// it only names the state the watchdog is already in. The client keeps a
// mirrored copy of kWatchdogPhases for its copy map; a sync test on each side
// pins the two lists together (lib/server is CJS, lib/public is browser ESM —
// no shared constants module exists between them).

const kWatchdogPhases = [
  "config_error_latched",
  "managed_operation",
  "stopped",
  "expected_restart",
  "safe_mode",
  "crash_loop_rollback",
  "crash_loop_repair_ladder",
  "crash_backoff",
  "startup_grace",
  "awaiting_repair_recovery",
  "degraded_repairing",
  "degraded_pre_rollback",
  "degraded_retrying",
  "healthy",
  "unknown_bootstrap",
];

const deriveWatchdogPhase = (snapshot = {}, now = Date.now()) => {
  const {
    lifecycle = "stopped",
    health = "unknown",
    configurationErrorActive = false,
    managedOperationActive = false,
    expectedRestartInProgress = false,
    expectedRestartUntilMs = 0,
    safeMode = false,
    channelRollbackRequested = false,
    crashRecoveryActive = false,
    gatewayStartedAt = null,
    startupGraceMs = 0,
    awaitingAutoRepairRecovery = false,
    operationInProgress = false,
    rollbackEligible = false,
  } = snapshot;

  if (configurationErrorActive || lifecycle === "configuration_error") {
    return "config_error_latched";
  }
  if (managedOperationActive) return "managed_operation";
  if (lifecycle === "stopped") return "stopped";
  if (
    (expectedRestartInProgress && now < Number(expectedRestartUntilMs)) ||
    lifecycle === "restarting"
  ) {
    return "expected_restart";
  }
  if (safeMode) return "safe_mode";
  if (lifecycle === "crash_loop") {
    return channelRollbackRequested
      ? "crash_loop_rollback"
      : "crash_loop_repair_ladder";
  }
  if (lifecycle === "crashed") return "crash_backoff";
  const withinStartupGrace =
    health === "unknown" &&
    lifecycle === "running" &&
    !crashRecoveryActive &&
    Number.isFinite(Number(gatewayStartedAt)) &&
    Number(gatewayStartedAt) > 0 &&
    now - Number(gatewayStartedAt) < Number(startupGraceMs);
  if (withinStartupGrace) return "startup_grace";
  if (awaitingAutoRepairRecovery) return "awaiting_repair_recovery";
  if (health === "degraded" && operationInProgress) return "degraded_repairing";
  if (health === "degraded" && rollbackEligible) return "degraded_pre_rollback";
  if (health === "degraded") return "degraded_retrying";
  if (health === "healthy") return "healthy";
  if (health === "unknown") return "unknown_bootstrap";
  // health === "unhealthy" with lifecycle "running": between failed repair
  // attempts the regular tick will re-probe and re-repair — "retrying" is the
  // truthful label. The function is total: no input renders an unknown phase.
  return "degraded_retrying";
};

module.exports = { deriveWatchdogPhase, kWatchdogPhases };

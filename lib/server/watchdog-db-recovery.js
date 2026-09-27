const { isDeepStrictEqual } = require("node:util");

const isDatabaseVerificationHold = (hold) =>
  ["state_db_unverified", "state_db_unreadable"].includes(hold?.reason);

const createDatabaseRecoveryController = ({
  readState,
  tryAcquire,
  verify,
  beforeLaunch,
  launch,
  onResult = () => {},
  now = Date.now,
  intervalMs = 60_000,
  leaseMs = 600_000,
}) => {
  let running = false;
  let lastStartedAt = null;
  let lastResult = null;
  let lastLoggedKey = null;
  let lastEligibility = "not_checked";
  const eligibility = (state) => {
    if (state.stopped || state.shuttingDown) return "stopped";
    if (!state.autoRepair || state.managed === false) return "automatic_repair_disabled";
    if (state.busy || state.relaunching) return "operation_in_progress";
    if (state.stateCorrupted) return "gateway_hold_unreadable";
    if (state.unrelatedConfigurationError) return "unrelated_configuration_error";
    if (!isDatabaseVerificationHold(state.gatewayHold)) return "no_database_verification_hold";
    if (state.pause && (!isDatabaseVerificationHold(state.pause) || state.pause.reason !== state.gatewayHold.reason)) {
      return "unrelated_repair_pause";
    }
    return null;
  };
  const describe = () => {
    const reason = running ? "verification_in_progress" : lastEligibility;
    return { running, eligible: !reason, reason,
      lastStartedAt, nextEligibleAt: reason ? null : lastStartedAt === null ? now() : lastStartedAt + intervalMs,
      lastResult };
  };
  const tick = async () => {
    if (running) return { ok: false, skipped: true, code: "verification_in_progress" };
    let captured;
    try { captured = readState(); } catch {
      lastEligibility = "gateway_hold_unreadable";
      return { ok: false, skipped: true, code: lastEligibility };
    }
    const reason = eligibility(captured);
    lastEligibility = reason;
    if (reason) return { ok: false, skipped: true, code: reason };
    if (lastStartedAt !== null && now() - lastStartedAt < intervalMs) {
      return { ok: false, skipped: true, code: "verification_cadence" };
    }
    const hold = tryAcquire("database_verification", { leaseMs });
    if (!hold) {
      lastEligibility = "operation_in_progress";
      return { ok: false, skipped: true, code: lastEligibility };
    }
    running = true;
    const isCurrent = () => {
      if (hold.isValid?.() === false) return false;
      let current;
      try { current = readState(); } catch { return false; }
      return !current.stopped && !current.shuttingDown && current.autoRepair && current.managed !== false &&
        !current.busy && !current.relaunching && !current.stateCorrupted &&
        current.epoch === captured.epoch && current.generation === captured.generation &&
        isDeepStrictEqual(current.pause, captured.pause);
    };
    try {
      if (!isCurrent()) return { ok: false, skipped: true, code: "recovery_source_changed" };
      lastStartedAt = now();
      const result = await verify({ hold, expectedHold: captured.gatewayHold,
        expectedPending: captured.databaseRecoveryPending || null, isCurrent, manual: false });
      if (!result?.ok) {
        lastResult = { ok: false, code: result?.code || "database_verification_failed", at: now() };
      } else if (!isCurrent()) {
        lastResult = { ok: false, code: "recovery_source_changed", at: now() };
      } else {
        if (beforeLaunch({ captured, result }) === false) {
          throw Object.assign(new Error("Database recovery was superseded"), { code: "recovery_source_changed" });
        }
        const cleared = readState();
        const outcome = await launch({ hold, recoveryId: result.recoveryId, isCurrent: () => {
          let current;
          try { current = readState(); } catch { return false; }
          return hold.isValid?.() !== false && !current.stopped && !current.shuttingDown &&
            current.autoRepair && current.managed !== false && current.epoch === captured.epoch &&
            current.configurationGeneration === cleared.configurationGeneration &&
            isDeepStrictEqual(current.pause, cleared.pause);
        } });
        lastResult = { ok: outcome?.ok === true, code: outcome?.code || outcome?.verdict || "launch_requested",
          recoveryId: result.recoveryId, at: now() };
        lastEligibility = "recovery_pending";
      }
    } catch (error) {
      lastResult = { ok: false, code: error?.code || "database_verification_failed", at: now() };
    } finally {
      hold();
      running = false;
    }
    const key = `${captured.gatewayHold.reason}:${captured.gatewayHold.at}:${captured.gatewayHold.operationId}:${lastResult?.code}`;
    if (key !== lastLoggedKey) {
      lastLoggedKey = key;
      onResult({ ...lastResult, elapsedMs: Math.max(0, now() - lastStartedAt),
        hold: { reason: captured.gatewayHold.reason, at: captured.gatewayHold.at,
          operationId: captured.gatewayHold.operationId || null, buildId: captured.gatewayHold.installed || null } });
    }
    return lastResult;
  };
  return { tick, describe };
};

module.exports = { createDatabaseRecoveryController, isDatabaseVerificationHold };

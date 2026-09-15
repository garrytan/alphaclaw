import { formatDurationLongMs } from "../../lib/format.js";

const kRecoveryBlockers = {
  operation_in_progress: "another operation is finishing",
  lifecycle_operation_in_progress: "another operation holds the gateway lifecycle lock",
  replacement_pending: "a replacement gateway is warming up",
  expected_restart: "the expected restart window is still open",
  crash_backoff: "the crash backoff delay has not elapsed",
  lease_expired: "the previous restart lost ownership before launching",
  dispatch_failed: "the previous restart attempt failed before completion",
  launch_failed: "the previous attempt could not launch the gateway",
  launch_aborted: "the previous attempt was interrupted before launch",
  child_retained: "the previously tracked gateway process is still present",
  incumbent_unhealthy: "another gateway is present but has not become healthy",
};

// These states take precedence over the health phase: an old health sample
// must not hide the owner preventing recovery from proceeding.
export const buildRecoveryNarrative = (status, nowMs) => {
  const operation = status.lifecycleOperation;
  const base = { phase: status.phase, tone: "warning", emoji: "⏳",
    countdowns: [], chips: [], budgets: [] };
  if (operation?.phase === "cleanup_blocked" || operation?.phase === "cleanup") {
    const pids = (operation.processes || []).map(({ pid }) => Number(pid))
      .filter((pid) => Number.isInteger(pid) && pid > 1);
    const tracked = pids.length ? ` Tracked process groups: ${pids.join(", ")}.` : "";
    return {
      ...base,
      headline: operation.phase === "cleanup_blocked"
        ? "Repair cleanup needs attention" : "Stopping repair processes",
      detail: operation.phase === "cleanup_blocked"
        ? `Cleanup has not confirmed that every repair writer has stopped. Other gateway operations remain queued.${tracked} Use the rescue session to inspect and stop remaining writers; confirm they have exited before restarting AlphaClaw. Ownership will not be released automatically.`
        : `Waiting for repair processes to stop and configuration restoration to finish. Other gateway operations remain queued.${tracked}`,
    };
  }
  const recovery = status.recoveryPending;
  if (!recovery) return null;
  const sinceMs = Date.parse(recovery.createdAt);
  const age = Number.isFinite(sinceMs)
    ? ` Waiting for ${formatDurationLongMs(Math.max(0, nowMs - sinceMs))}.` : "";
  const dispatching = recovery.reason === "dispatching";
  return {
    ...base,
    headline: dispatching ? "Restarting after a gateway crash" : "Crash recovery is pending",
    detail: dispatching
      ? `The watchdog is checking and launching the replacement gateway.${age}`
      : `Recovery will retry because ${kRecoveryBlockers[recovery.reason] || "restart admission is temporarily unavailable"}.${age}`,
    countdowns: !dispatching && Number.isFinite(Date.parse(recovery.nextAttemptAt))
      ? [{ key: "recovery", label: "Next recovery check", endsAt: recovery.nextAttemptAt }] : [],
  };
};

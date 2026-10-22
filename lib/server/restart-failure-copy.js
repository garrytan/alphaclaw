// The user-facing gateway restart failure vocabulary: one sentence and hint
// per failure class, the upgrade-retry and stop-failed sentences, the human
// phase labels and the recovery clause. Pure; routes/system.js owns the
// routes that render it.
// User-facing failure classes. gateway.js names WHICH half failed
// (`err.code` on a GatewayStopError, `err.evidence.code` otherwise); the
// route turns that into the one sentence the card and the notification
// show. Everything else (stderr tails, pids) stays behind View logs.
// One meaning per code, shared by the card (`describeRestartFailure`),
// the notification and the runbook (bug #137 copy matrix):
//   stop_refused   NOTHING was stopped (the old gateway is still serving)
//   stop_failed    N gateway processes could not be verified gone; the
//                  gateway is DOWN and automatic recovery owns it (the
//                  recovery clause says what it will do)
//   launch_failed  the old gateway stopped, the new one did not start
//   ready_timeout  the new gateway is up but not ready; the watchdog's
//                  readiness ladder owns it
//   aborted        cancelled — after a stop when `signalled` says so
// No "restart the container" hints: the watchdog's recovery is the
// remedy, and the Watchdog tab holds the evidence.
const kRestartFailureCopy = {
  stop_refused: {
    error: "Couldn't safely identify the running gateway, so nothing was stopped and your changes are not live yet.",
    hint: "The old gateway is still running. Open View logs to see what holds the gateway port, then try again.",
  },
  stop_failed: {
    error: "Couldn't confirm the old gateway stopped, so your changes are not live yet.",
    hint: "Automatic recovery is checking now. If the gateway is not back in about two minutes, open View logs.",
  },
  launch_failed: {
    error: "The old gateway stopped, but OpenClaw didn't start.",
    hint: "Automatic recovery is checking now. If the gateway is not back in about two minutes, open View logs for OpenClaw's error.",
  },
  ready_timeout: {
    error: "OpenClaw started but wasn't ready in time.",
    hint: "AlphaClaw keeps watching it. If it is not Running in about two minutes, open View logs.",
  },
  aborted: {
    error: "The restart was cancelled before it finished.",
    hint: "AlphaClaw is shutting down or another operation took over. Try again in a moment.",
  },
};
const kKnownRestartFailureCodes = new Set(Object.keys(kRestartFailureCopy));
// Retry upgrade's sentences: the Doctor's verdict decides what failed and
// where Try again leads (the card reads retryTarget, never guesses).
//   Doctor not run (stop refused/failed, aborted) → retry the upgrade
//   Doctor ok, launch/ready failed               → plain Restart
//   Doctor failed, launch/ready failed           → retry the upgrade
const describeUpgradeRetryFailure = ({ code, doctor, held, fallback }) => {
  if (held) return "AlphaClaw's settings check after the upgrade didn't finish safely, so OpenClaw was left stopped.";
  if (doctor?.doctor === "ok") return "Data upgraded, but OpenClaw didn't start.";
  if (doctor?.doctor === "failed") {
    const reason = String(doctor.sentence || "").replace(/\.$/, "");
    return `The data upgrade didn't finish, and OpenClaw didn't start again: ${/^[A-Z][a-z]/.test(reason) ? reason.charAt(0).toLowerCase() + reason.slice(1) : reason}.`;
  }
  if (code === "stop_refused") return "Couldn't safely identify the running gateway, so nothing was stopped and the upgrade didn't run.";
  if (code === "aborted") return "The upgrade retry was cancelled before it finished.";
  return `${String(fallback || "The gateway didn't stop").replace(/, so your changes are not live yet\.?$/, "").replace(/\.$/, "")}, so the upgrade didn't run.`;
};
// The stop_failed sentence names a COUNT; pids, states and commands live
// in the evidence only.
const describeStopFailed = (evidence) => {
  const survivors = Array.isArray(evidence?.stopEvidence?.survivors) ? evidence.stopEvidence.survivors : [];
  const n = survivors.length;
  if (n === 0) return kRestartFailureCopy.stop_failed.error;
  const noun = n === 1 ? "gateway process" : "gateway processes";
  return evidence?.unverified
    ? `Couldn't verify that ${n} ${noun} exited after SIGKILL, so your changes are not live yet.`
    : `${n} ${noun} did not exit after SIGKILL, so your changes are not live yet.`;
};
// Human phase labels — the only vocabulary a user reads for "where it
// broke": asking / stopping / forcing / starting.
const kHumanPhases = { asking: "asking", terminating: "stopping", stop: "stopping", sigterm: "stopping", forcing: "forcing", sigkill: "forcing", launch: "starting", starting: "starting", prelaunch_hook: "preparing" };
// The recovery clause the card appends to a failure (bug #137 D): what
// the watchdog's admission says it WILL do, never a promise it may refuse.
const describeRecovery = (admission) => {
  if (!admission) return { status: "unknown", reason: null, text: "" };
  if (admission.ok) return { status: "will_check", reason: null, text: "Automatic recovery is checking now." };
  const reason = String(admission.reason || "blocked");
  const text =
    reason === "auto_repair_paused"
      ? "Automatic recovery is paused — press Resume repair once to let it run."
      : reason === "auto_repair_disabled"
        ? "Automatic recovery is off — press Repair to run it."
        : reason === "repair_attempts_exhausted"
          ? "Automatic recovery has used all its attempts — press Repair to run it."
          : reason === "operation_in_progress" || reason === "replacement_pending"
            ? "Another gateway operation is already in progress; it will take over."
            : `Automatic recovery is blocked: ${reason.replace(/_/g, " ")}.`;
  return { status: reason, reason, text };
};

const classifyRestartFailure = (err) => {
  const code = kKnownRestartFailureCodes.has(err?.code)
    ? err.code
    : kKnownRestartFailureCodes.has(err?.evidence?.code)
      ? err.evidence.code
      : err?.evidence?.aborted === true
        ? "aborted"
        : "restart_failed";
  return { code, ...(kRestartFailureCopy[code] || {
    error: "Restart failed.",
    hint: "Try again, run Repair, or open View logs.",
  }) };
};

module.exports = {
  kRestartFailureCopy,
  describeUpgradeRetryFailure,
  describeStopFailed,
  kHumanPhases,
  describeRecovery,
  classifyRestartFailure,
};

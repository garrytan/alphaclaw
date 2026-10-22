// What a non-zero exit of the stop ladder's graceful ask means (pure — no
// timers, no I/O). `openclaw gateway restart --wait` sends
// gateway.restart.request with a hard 10 s ack timeout (2026.10.4–10.6,
// dist/lifecycle-*.mjs signalGatewayRestart: callGatewayCli timeoutMs 1e4).
// Under load the ack can miss that window after the gateway already closed
// admission, and the CLI exits 1 with "gateway timeout after 10000ms … The
// request was already sent to the gateway … its outcome is unknown." The CLI's
// exit code alone therefore cannot tell "refused" from "accepted, reply lost":
// 2026.10.4 rolled such a stalled request back (admission reopened, /readyz
// 200) while 2026.10.6 applied it and drained. So the ladder decides from the
// gateway's own state, observed through a SERIES of /readyz probes after the
// exit, and treats the CLI as refused only when OpenClaw actually rejected
// the request (or the gateway is confirmed to be admitting work again).

// The CLI's explicit refusals (server errorShape INVALID_REQUEST/UNAVAILABLE
// and the CLI's own pre-dispatch checks in dist/lifecycle-*.mjs and
// dist/restart-*.mjs server-methods/restart).
const kAskRejectionPatterns = Object.freeze([
  /target gateway no longer owns the active lock/i,
  /invalid targeted gateway restart/i,
  /invalid gateway\.restart\.request params/i,
  /target gateway restart delivery failed/i,
  /Gateway restart is disabled/i,
  /multiple gateway processes are listening/i,
  /lock identity does not match/i,
  /lock owner changed before the restart request/i,
  /Gateway listener changed before restart/i,
  /predates targeted restart ownership/i,
  /No verified gateway process is listening/i,
]);
// Transport uncertainty after dispatch (dist/transport-error-*.mjs).
const kAskUnknownPatterns = Object.freeze([
  /outcome is unknown/i,
  /gateway timeout after \d+ms/i,
  /gateway closed \(\d+/i,
]);

const kAskExitClasses = Object.freeze({
  // OpenClaw said no: escalate unless the gateway is visibly draining anyway.
  REJECTED: "rejected",
  // The request may or may not have been applied: the gateway decides.
  UNKNOWN: "unknown",
  // Any other non-zero exit: escalate only when the gateway is admitting
  // (or cannot be judged and the CLI could not even run).
  FAILED: "failed",
});

const classifyAskExit = ({ code = null, signal = null, error = null, lines = [] } = {}) => {
  if (error) return kAskExitClasses.FAILED;
  const text = (Array.isArray(lines) ? lines : []).join("\n");
  if (kAskRejectionPatterns.some((pattern) => pattern.test(text))) return kAskExitClasses.REJECTED;
  // A CLI killed by a signal (the OOM killer under memory pressure) exited
  // after dispatch as often as before it: same uncertainty as a timeout.
  if (signal || code === null) return kAskExitClasses.UNKNOWN;
  if (kAskUnknownPatterns.some((pattern) => pattern.test(text))) return kAskExitClasses.UNKNOWN;
  return kAskExitClasses.FAILED;
};

const kAskGatewayStates = Object.freeze({
  ADMITTING: "admitting",
  DRAINING: "draining",
  // /readyz refuses the connection while the gateway pids are still alive:
  // the listener closed during shutdown.
  CLOSED: "closed",
  INCONCLUSIVE: "inconclusive",
});

// One probeGatewayReadiness observation → the gateway's admission state.
const classifyAskProbe = (observation) => {
  if (observation?.ok === true && observation.kind === "ready") return kAskGatewayStates.ADMITTING;
  if (observation?.ok === true && observation.unreadyReason === "draining") return kAskGatewayStates.DRAINING;
  if (observation?.ok === false && observation.kind === "unavailable" && observation.httpStatus == null) {
    return kAskGatewayStates.CLOSED;
  }
  return kAskGatewayStates.INCONCLUSIVE;
};

const kAskDecisions = Object.freeze({ WAIT: "wait", REASK: "reask", ESCALATE: "escalate" });
// "Admitting" counts only when two consecutive probes agree: 2026.10.6
// reopens and re-closes the restart-signal fence within milliseconds when it
// finally processes a stalled request.
const kAskAdmittingConfirmations = 2;

// The decision after a non-zero ask exit, recomputed on every new probe
// (a gateway that reopens admission mid-wait escalates or is re-asked).
// `states` are the probes since this attempt's exit, oldest first.
const decideAfterAskExit = ({ exitClass, states = [], attempt = 1, maxAttempts = 2, graceLeftFraction = 0 } = {}) => {
  const latest = states.at(-1) ?? kAskGatewayStates.INCONCLUSIVE;
  if (latest === kAskGatewayStates.DRAINING || latest === kAskGatewayStates.CLOSED) return kAskDecisions.WAIT;
  const admittingConfirmed =
    states.length >= kAskAdmittingConfirmations &&
    states.slice(-kAskAdmittingConfirmations).every((state) => state === kAskGatewayStates.ADMITTING);
  if (admittingConfirmed) {
    // Not applied (or rolled back). A repeat request folds into a pending
    // restart on the gateway, so re-asking a late-applying gateway is safe.
    if (exitClass === kAskExitClasses.UNKNOWN && attempt < maxAttempts && graceLeftFraction >= 0.5) {
      return kAskDecisions.REASK;
    }
    return kAskDecisions.ESCALATE;
  }
  if (latest === kAskGatewayStates.ADMITTING) return kAskDecisions.WAIT;
  // Inconclusive (probe timed out, starting, components): an explicit
  // rejection is believed; anything else waits, bounded by the ask budget.
  return exitClass === kAskExitClasses.REJECTED ? kAskDecisions.ESCALATE : kAskDecisions.WAIT;
};

module.exports = {
  kAskExitClasses,
  kAskGatewayStates,
  kAskDecisions,
  kAskAdmittingConfirmations,
  classifyAskExit,
  classifyAskProbe,
  decideAfterAskExit,
};

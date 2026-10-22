// Gateway exit / stderr signatures shared by the watchdog's exit handler and
// the pure crash-cause classifier (gateway-crash-cause.js). A leaf module so
// neither side needs the other at require time.
// OpenClaw 2026.7.1+ exits with EX_CONFIG (78, sysexits.h) on fatal
// configuration errors. The contract is "do not restart until the config is
// fixed" — restarting blindly recreates the restart storm the gateway is
// trying to prevent.
const kOpenclawConfigErrorExitCode = 78;

const stderrTailText = (stderrTail) =>
  (Array.isArray(stderrTail) ? stderrTail : [])
    .map((entry) => String(entry || ""))
    .join("\n")
    .toLowerCase();

const isDuplicateGatewayLaunchExit = ({ code, stderrTail = [] } = {}) => {
  if (code !== 1) return false;
  const stderrText = stderrTailText(stderrTail);
  if (!stderrText) return false;
  return (
    stderrText.includes("another gateway instance is already listening") ||
    (stderrText.includes("port") && stderrText.includes("already in use"))
  );
};

// OpenClaw 2026.8.1 overloads EX_CONFIG with a BENIGN case: a NEW gateway
// process that loses the startup lock (or hits EADDRINUSE) probes the
// incumbent's /healthz and, when the incumbent is healthy, deliberately exits
// 78 so a systemd RestartPreventExitStatus=78 unit stops looping — a
// step-aside, not a config error. Signature verified in
// openclaw@2026.8.1-beta.3 dist (SupervisedGatewayLockError): "gateway
// already running under systemd; existing gateway is healthy, exiting with
// code 78 to prevent a systemd Restart=always loop"
// (docs/gateway/gateway-lock.md, "Operational notes"). Both phrases must
// match — the sibling probe-timeout error ("did not become healthy") and the
// Tailscale :443 exit-78 use different wording and must keep latching (and,
// with the startup medic enabled, a false-positive here would cost a medic
// run + notification against a healthy incumbent).
const isHealthyIncumbentStepAsideExit = ({ code, stderrTail = [] } = {}) => {
  if (code !== kOpenclawConfigErrorExitCode) return false;
  const stderrText = stderrTailText(stderrTail);
  if (!stderrText) return false;
  return (
    stderrText.includes("existing gateway is healthy") &&
    stderrText.includes("exiting with code 78")
  );
};

// Stderr signatures shared with the pure crash-cause classifier
// (gateway-crash-cause.js delegates to these — ONE declaration per wording).
//
// openclaw >= 2026.9.1-beta.1 exits EX_CONFIG for pending STATE migrations
// too (state db / agent db / offline media), not just config errors — the
// medic's remove-blamed-keys tier cannot fix those, and telling the
// operator "fix the config" points them at the wrong thing. Visibility
// only: the migration gate / forward-recovery machinery owns the remedy.
const kStateMigrationRefusalPattern =
  /requires state database schema migration|state database schema migration pending|startup migrations did not complete cleanly|requires migration before writing|media library requires migration/i;
// V8's own heap-exhaustion abort text (classifyOomExit below owns the remedy).
const kHeapOomPattern = /JavaScript heap out of memory|Reached heap limit/i;

module.exports = {
  kOpenclawConfigErrorExitCode,
  kStateMigrationRefusalPattern,
  kHeapOomPattern,
  isDuplicateGatewayLaunchExit,
  isHealthyIncumbentStepAsideExit,
};

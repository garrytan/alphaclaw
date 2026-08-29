// Boot runs in the background (the listen callback no longer blocks on it),
// so the status snapshot needs an explicit answer to "is AlphaClaw still
// starting up?" instead of clients inferring it from unresponsiveness.
const kBootPhases = new Set(["starting_gateway", "ready", "failed"]);

let bootPhase = "starting_gateway";
let bootError = null;

const setBootPhase = (phase, { error = null } = {}) => {
  if (!kBootPhases.has(phase)) return;
  bootPhase = phase;
  bootError = phase === "failed" ? String(error?.message || error || "") : null;
};

const getBootPhase = () => ({ phase: bootPhase, error: bootError });

module.exports = { setBootPhase, getBootPhase };

// Imported only by the caught bootstrap in eligible gateway invocations.
// No AlphaClaw server initialization or OpenClaw internals are imported here.
const { isMainThread } = require("node:worker_threads");

const startGatewayTelemetryPreload = ({
  stripOwnOptions = () => {},
  processImpl = process,
  mainThread = isMainThread,
  now = Date.now,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  startSampler = (options) =>
    require("./telemetry-sampler").startGatewayMemorySampler(options),
} = {}) => {
  let timer = null;
  let sampler = null;
  let finished = false;
  const startedAt = now();
  const finishWaiting = () => {
    finished = true;
    if (timer) clearIntervalImpl(timer);
    timer = null;
    stripOwnOptions();
  };
  const check = () => {
    if (finished) return;
    try {
      if (!mainThread || processImpl.platform !== "linux") {
        finishWaiting();
      } else if (processImpl.title === "openclaw-gateway") {
        // Keep our option through compile-cache respawns, then remove it before
        // ordinary gateway tool children inherit a package-file dependency.
        finishWaiting();
        sampler = startSampler({ stateDir: processImpl.env.OPENCLAW_STATE_DIR });
      } else if (now() - startedAt >= 15 * 60 * 1000) {
        finishWaiting();
      }
    } catch {
      finishWaiting();
    }
  };
  check();
  if (!finished) {
    timer = setIntervalImpl(check, 1000);
    timer.unref?.();
  }
  return {
    stop() {
      finishWaiting();
      sampler?.stop?.();
    },
  };
};

module.exports = { startGatewayTelemetryPreload };

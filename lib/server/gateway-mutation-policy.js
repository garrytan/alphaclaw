// Owned gateway mutations (restart and friends): queue → own the lifecycle
// lease → read the policy again → mutate. The restart primitive invokes
// shouldAbort before stop/spawn and while awaiting readiness; those callbacks
// re-read lease ownership after every asynchronous step.

class GatewayMutationBlockedError extends Error {
  constructor(blocker) {
    super(blocker.error);
    this.name = "GatewayMutationBlockedError";
    Object.assign(this, blocker, { blocked: true, restartDeferred: true });
  }
}

const restartDeferredFields = (error) => error instanceof GatewayMutationBlockedError
  ? { configSaved: true, restartDeferred: true, restartRequired: true,
      code: error.code, hint: error.hint }
  : {};

const createGatewayMutationPolicy = ({ lock = null } = {}) => {
  const read = ({ preLock = false, hold = null } = {}) => {
    if (hold && ((typeof hold.isValid === "function" && !hold.isValid()) ||
        (typeof lock?.owns === "function" && !lock.owns(hold)))) {
      return { code: "lease_expired", statusCode: 409,
        error: "This operation no longer owns the gateway lifecycle.",
        hint: "Wait for the current operation to finish, then retry." };
    }
    if (preLock && lock?.getActiveOperation?.()?.kind === "boot") {
      return { code: "booting", statusCode: 409,
        error: "AlphaClaw is still starting the gateway — wait for boot to finish before restarting.",
        hint: "Boot normally finishes within a minute; the card shows Retry if it fails." };
    }
    return null;
  };
  const assert = (options) => {
    const blocker = read(options);
    if (blocker) throw new GatewayMutationBlockedError(blocker);
  };
  const restart = async ({ hold, restartGateway, options = {} }) => {
    let blocker = null;
    assert({ hold });
    try {
      const result = await restartGateway({ ...options, shouldAbort: () => {
        blocker = read({ hold });
        return !!blocker || options.shouldAbort?.() === true;
      } });
      assert({ hold });
      return result;
    } catch (error) {
      if (blocker) throw new GatewayMutationBlockedError(blocker);
      throw error;
    }
  };
  return { read, assert, restart };
};

module.exports = { createGatewayMutationPolicy, GatewayMutationBlockedError, restartDeferredFields };

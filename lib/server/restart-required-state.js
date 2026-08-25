const defaultFlagStore = () => {
  const flag = require("./restart-required-flag");
  return {
    read: () => flag.readRestartRequiredFlag(),
    write: (reason, source) =>
      flag.writeRestartRequiredFlag({ reason, source }),
    clear: () => flag.clearRestartRequiredFlag(),
  };
};

const createRestartRequiredState = ({ isGatewayRunning, flagStore } = {}) => {
  const flags = flagStore || defaultFlagStore();
  const state = {
    restartRequired: false,
    restartInProgress: false,
    sawGatewayDownSincePending: false,
    updatedAt: Date.now(),
    reason: "",
  };

  const touch = () => {
    state.updatedAt = Date.now();
  };

  const markRequired = (reason = "config_changed", { source = "server" } = {}) => {
    state.restartRequired = true;
    state.reason = reason;
    state.sawGatewayDownSincePending = false;
    touch();
    try {
      flags.write(reason, source);
    } catch {}
  };

  // The CLI marks restarts by writing the persisted flag file from its own
  // process; fold it into in-memory state whenever we take a snapshot.
  const adoptPersistedFlag = () => {
    if (state.restartRequired) return;
    let persisted = null;
    try {
      persisted = flags.read();
    } catch {}
    if (!persisted) return;
    state.restartRequired = true;
    state.reason = persisted.reason || "config_changed";
    state.sawGatewayDownSincePending = false;
    touch();
  };

  const markRestartInProgress = () => {
    state.restartInProgress = true;
    touch();
  };

  const markRestartComplete = () => {
    state.restartInProgress = false;
    touch();
  };

  const clearRequired = () => {
    state.restartRequired = false;
    state.reason = "";
    state.sawGatewayDownSincePending = false;
    touch();
    try {
      flags.clear();
    } catch {}
  };

  const checkAndClearIfRecovered = async () => {
    adoptPersistedFlag();
    const gatewayRunning = await isGatewayRunning();
    if (state.restartRequired && !state.restartInProgress) {
      if (!gatewayRunning) {
        state.sawGatewayDownSincePending = true;
        touch();
      } else if (state.sawGatewayDownSincePending) {
        clearRequired();
      }
    }
    return gatewayRunning;
  };

  const getSnapshot = async () => {
    const gatewayRunning = await checkAndClearIfRecovered();
    return {
      restartRequired: state.restartRequired,
      restartInProgress: state.restartInProgress,
      gatewayRunning,
      updatedAt: state.updatedAt,
      reason: state.reason,
    };
  };

  return {
    markRequired,
    markRestartInProgress,
    markRestartComplete,
    clearRequired,
    getSnapshot,
  };
};

const waitForGatewayRunning = async ({
  isGatewayRunning,
  timeoutMs = 25000,
  intervalMs = 400,
}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isGatewayRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return isGatewayRunning();
};

module.exports = {
  createRestartRequiredState,
  waitForGatewayRunning,
};

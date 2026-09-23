const { createGatewayMutationPolicy, GatewayMutationBlockedError } = require("./gateway-mutation-policy");

const rollbackEligibleFrom = (info) => {
  if (!info) return null;
  const inWindow = info.stabilization
    ? Boolean(info.stabilization.inWindow)
    : !info.isPin && Boolean(info.inStabilizationWindow);
  return inWindow ? info : null;
};

const createMedicAdmission = ({ getChannelInfo = null } = {}) => {
  let snapshot = null;
  const policy = createGatewayMutationPolicy({
    getChannelInfo: () => {
      snapshot = typeof getChannelInfo === "function" ? getChannelInfo() : null;
      if (typeof getChannelInfo === "function" && snapshot == null) {
        throw new Error("Channel state unavailable");
      }
      return snapshot;
    },
  });
  const read = ({ doctor = false, allowDoctorFix = true } = {}) => {
    const blocker = policy.read();
    if (blocker) return blocker;
    if (doctor && (!allowDoctorFix || rollbackEligibleFrom(snapshot))) {
      return {
        code: "medic_doctor_prohibited",
        error: "Medic Doctor repair is not permitted while rollback may be pending or the caller has disabled it.",
      };
    }
    return null;
  };
  const assert = (options) => {
    const blocker = read(options);
    if (blocker) throw new GatewayMutationBlockedError(blocker);
  };
  return { read, assert };
};

const medicBlockedOutcome = (error) => error instanceof GatewayMutationBlockedError
  ? { fixed: false, tier: "blocked", skipped: true, reason: error.code, error: error.message }
  : null;

module.exports = { createMedicAdmission, rollbackEligibleFrom, medicBlockedOutcome };

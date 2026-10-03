const { createGatewayMutationPolicy, GatewayMutationBlockedError } = require("./gateway-mutation-policy");

// Whether the startup medic may mutate now: the shared gateway mutation
// policy, plus the caller's own doctor --fix permission.
const createMedicAdmission = () => {
  const policy = createGatewayMutationPolicy();
  const read = ({ doctor = false, allowDoctorFix = true } = {}) => {
    const blocker = policy.read();
    if (blocker) return blocker;
    if (doctor && !allowDoctorFix) {
      return {
        code: "medic_doctor_prohibited",
        error: "Medic Doctor repair is not permitted: the caller has disabled it.",
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

module.exports = { createMedicAdmission, medicBlockedOutcome };

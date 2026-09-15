// Upstream can fail after changing runtime files and migrating state. Report
// only its explicit recovery evidence; an error never proves a rollback.
const reasonCode = (value) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,119}$/.test(value)
  ? value : null;

const readDevUpdateFailureEvidence = (report = {}) => {
  const updaterReason = reasonCode(report.reason);
  const recovery = report.recovery;
  const updaterRecovery = {};
  for (const field of ["serviceRestartSafe", "packageRollbackVerified"]) {
    if (typeof recovery?.[field] === "boolean") updaterRecovery[field] = recovery[field];
  }
  const recoveryReason = reasonCode(recovery?.reason);
  if (recoveryReason) updaterRecovery.reason = recoveryReason;
  return {
    ...(updaterReason ? { updaterReason } : {}),
    ...(Object.keys(updaterRecovery).length ? { updaterRecovery } : {}),
  };
};

const describeDevUpdateFailure = (report = {}) => {
  const evidence = readDevUpdateFailureEvidence(report);
  const { updaterReason, updaterRecovery } = evidence;
  let hint;
  if (updaterReason === "state-migrated-no-rollback") {
    hint = "OpenClaw reports that state was migrated and the update was not rolled back. " +
      "Preserve the backups and inspect the raw update log. Check `openclaw gateway status --deep` " +
      "and resolve the reported blocker through the gateway's service owner before retrying or restarting.";
  } else if (updaterReason === "rollback-state-unverified") {
    hint = "OpenClaw could not verify that state is safe to roll back. " +
      "Preserve the backups and inspect the raw update log before attempting recovery or restarting.";
  } else if (updaterRecovery?.packageRollbackVerified === true) {
    hint = "OpenClaw verified that the previous package was restored. " +
      (updaterRecovery.serviceRestartSafe === true
        ? "Inspect the raw update log, resolve the reported failure, then retry."
        : "The installation has not been verified safe to restart. Inspect the raw update log and resolve the reported blocker before restarting.");
  } else if (updaterRecovery?.serviceRestartSafe === true) {
    hint = "OpenClaw verified that a runnable installation remains, but did not confirm a rollback. " +
      "Inspect the raw update log, resolve the reported failure, then retry.";
  } else {
    hint = "OpenClaw did not confirm recovery of the previous installation. " +
      "Inspect the raw update log and backups before restarting or retrying. " +
      "Use `openclaw update repair` after resolving the reported blocker.";
  }
  return { hint, ...evidence };
};

module.exports = { describeDevUpdateFailure, readDevUpdateFailureEvidence };

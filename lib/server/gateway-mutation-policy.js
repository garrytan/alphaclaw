const { getGatewayHoldCopy, kGatewayHoldCopy } = require("./gateway-state");
const { isMigrationClassHold } = require("./openclaw-release-channel");
const { isDeepStrictEqual } = require("node:util");

// Internal capabilities, never derived from request bodies or reason strings.
const kGatewayMutationIntents = Object.freeze({
  restart: Symbol("restart"),
  reconcile: Symbol("reconcile"),
  apply: Symbol("apply"),
  applyRecovery: Symbol("backed-up apply recovery"),
  // v0.9.81: the standalone "Back up now" run — pauses the gateway under a
  // `backup_quiesce` lease while holding the apply latch, exactly like an
  // apply's backup step; admitted only through this intent.
  backup: Symbol("backup"),
  // An apply may need a backup to recover its ORIGINAL hold. This capability
  // owns only a backup pause; it cannot activate a build or authorize a waiver.
  applyBackup: Symbol("apply backup"),
  // Dev-checkout repair owns its own lease and never bypasses a gateway hold.
  repair: Symbol("dev update repair"),
});

const matchesRecoveryHold = ({ recoveryHold, gatewayHold }) =>
  Boolean(recoveryHold && gatewayHold) &&
  isDeepStrictEqual(recoveryHold, gatewayHold);
const matchesApplyRecoveryHold = ({ intent, recoveryHold, gatewayHold }) =>
  intent === kGatewayMutationIntents.applyRecovery &&
  matchesRecoveryHold({ recoveryHold, gatewayHold });

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

// One fail-closed state read for owned gateway mutations and legacy quiesce
// embeddings. Recovery is decided against the hold read HERE, never a prior
// status response; malformed state cannot be treated as an absent hold.
const readGatewayHoldBlocker = ({ getChannelInfo, describeReadError = () => "", canRecover = () => false }) => {
  let info;
  try {
    info = getChannelInfo();
    if (info?.stateCorrupted) throw new Error("state file corrupted");
  } catch (error) {
    const detail = String(describeReadError(error) || "").replace(/\s+/g, " ").slice(0, 200);
    return { code: "gateway_hold_unreadable", statusCode: 409,
      error: `${kGatewayHoldCopy.unreadableRefusal}${detail ? ` (${detail})` : ""}`,
      hint: kGatewayHoldCopy.unreadableHint };
  }
  const gatewayHold = info?.gatewayHold;
  if (gatewayHold && !canRecover(gatewayHold)) {
    const copy = getGatewayHoldCopy(gatewayHold);
    return { code: "gateway_held", statusCode: 409,
      error: copy.restartRefusal, hint: copy.hint, hold: gatewayHold.reason };
  }
  return null;
};

const assertApplyBackupAdmission = ({ policy, hold, recoveryHold, getChannelInfo }) => {
  if (policy) {
    return policy.assert({ hold, recoveryHold, intent: kGatewayMutationIntents.applyBackup });
  }
  // Older embeddings supply a quiesce seam without the server's mutation
  // policy. That seam owns its lease (runQuiescedBackup checks its validity);
  // the separate local apply lock cannot authenticate its release handle.
  // Still reject a new/replaced hold or corrupt state before pausing again.
  const blocker = readGatewayHoldBlocker({ getChannelInfo,
    canRecover: (gatewayHold) => matchesRecoveryHold({ recoveryHold, gatewayHold }) });
  if (blocker) throw new GatewayMutationBlockedError(blocker);
};

// Queue -> own the lease -> read policy again -> mutate. The restart primitive
// invokes shouldAbort before stop/spawn and while awaiting readiness; those
// callbacks re-read BOTH ownership and external holds after asynchronous work.
const createGatewayMutationPolicy = ({
  lock = null,
  getChannelInfo = () => null,
  isApplyInProgress = () => false,
  describeReadError = () => "",
} = {}) => {
  const read = ({ preLock = false, hold = null, intent = kGatewayMutationIntents.restart, recoveryHold = null } = {}) => {
    if (hold && ((typeof hold.isValid === "function" && !hold.isValid()) ||
        (typeof lock?.owns === "function" && !lock.owns(hold)))) {
      return { code: "lease_expired", statusCode: 409,
        error: "This operation no longer owns the gateway lifecycle.",
        hint: "Wait for the current operation to finish, then retry." };
    }
    const owns = hold && lock?.owns?.(hold) === true;
    if (preLock && lock?.getActiveOperation?.()?.kind === "boot") {
      return { code: "booting", statusCode: 409,
        error: "AlphaClaw is still starting the gateway — wait for boot to finish before restarting.",
        hint: "Boot normally finishes within a minute; the card shows Retry if it fails." };
    }
    const applyOwner = owns && ((hold.kind === "apply_commit" &&
      (intent === kGatewayMutationIntents.apply || intent === kGatewayMutationIntents.applyRecovery)) ||
      (hold.kind === "backup_quiesce" &&
        (intent === kGatewayMutationIntents.backup || intent === kGatewayMutationIntents.applyBackup)) ||
      (hold.kind === "update_repair" && intent === kGatewayMutationIntents.repair));
    if (isApplyInProgress() && !applyOwner) {
      return { code: "apply_in_progress", statusCode: 409,
        error: "A channel update or backup is in progress — wait for it to finish before restarting.",
        hint: "Wait for the update or backup to finish, then restart." };
    }
    return readGatewayHoldBlocker({ getChannelInfo, describeReadError, canRecover: (gatewayHold) => {
      const recoveryOwner = owns && intent === kGatewayMutationIntents.reconcile &&
        hold.kind === "reconcile_installed" && !isMigrationClassHold(gatewayHold);
      const applyRecoveryOwner = applyOwner &&
        (matchesApplyRecoveryHold({ intent, recoveryHold, gatewayHold }) ||
          (intent === kGatewayMutationIntents.applyBackup && matchesRecoveryHold({ recoveryHold, gatewayHold })));
      return recoveryOwner || applyRecoveryOwner;
    } });
  };
  const assert = (options) => {
    const blocker = read(options);
    if (blocker) throw new GatewayMutationBlockedError(blocker);
  };
  const restart = async ({ hold, intent, restartGateway, options = {} }) => {
    let blocker = null;
    assert({ hold, intent });
    try {
      const result = await restartGateway({ ...options, shouldAbort: () => {
        blocker = read({ hold, intent });
        return !!blocker || options.shouldAbort?.() === true;
      } });
      assert({ hold, intent });
      return result;
    } catch (error) {
      if (blocker) throw new GatewayMutationBlockedError(blocker);
      throw error;
    }
  };
  return { read, assert, restart };
};

module.exports = { createGatewayMutationPolicy, kGatewayMutationIntents,
  GatewayMutationBlockedError, restartDeferredFields, matchesApplyRecoveryHold, assertApplyBackupAdmission };

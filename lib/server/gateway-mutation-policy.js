const { getGatewayHoldCopy, kGatewayHoldCopy } = require("./gateway-state");
const { isMigrationClassHold } = require("./openclaw-release-channel");
const { isDeepStrictEqual } = require("node:util");
const databaseRecoveryAuthorizations = new WeakMap();

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
const readGatewayHoldBlocker = ({ getChannelInfo, describeReadError = () => "", canRecover = () => false,
  canRecoverPending = () => false }) => {
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
  if (info?.databaseRecoveryPending && !canRecoverPending(info.databaseRecoveryPending)) {
    return { code: "database_recovery_pending", statusCode: 409,
      error: "Database recovery has not been confirmed ready. Fresh verification is required before another mutation.",
      hint: "Review the database findings, then explicitly confirm Verify and restart.",
      hold: "state_db_unverified" };
  }
  return null;
};

const assertApplyBackupAdmission = ({ policy, hold, recoveryHold, recoveryPending = null, getChannelInfo }) => {
  if (policy) {
    return policy.assert({ hold, recoveryHold, recoveryPending, intent: kGatewayMutationIntents.applyBackup });
  }
  // Older embeddings supply a quiesce seam without the server's mutation
  // policy. That seam owns its lease (runQuiescedBackup checks its validity);
  // the separate local apply lock cannot authenticate its release handle.
  // Still reject a new/replaced hold or corrupt state before pausing again.
  let matchedPending = false;
  const blocker = readGatewayHoldBlocker({ getChannelInfo,
    canRecover: (gatewayHold) => matchesRecoveryHold({ recoveryHold, gatewayHold }),
    canRecoverPending: (pending) => {
      matchedPending = !!recoveryPending && isDeepStrictEqual(recoveryPending, pending);
      return matchedPending;
    } });
  if (blocker) throw new GatewayMutationBlockedError(blocker);
  if (recoveryPending && !matchedPending) throw new GatewayMutationBlockedError({ code: "recovery_source_changed", statusCode: 409,
    error: "The pending database recovery changed.", hint: "Review the current recovery state before continuing." });
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
  const read = ({ preLock = false, hold = null, intent = kGatewayMutationIntents.restart, recoveryHold = null, recoveryPending = null } = {}) => {
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
    let currentInfo = null;
    const blocker = readGatewayHoldBlocker({ getChannelInfo: () => { currentInfo = getChannelInfo(); return currentInfo; }, describeReadError, canRecover: (gatewayHold) => {
      const recoveryOwner = owns && intent === kGatewayMutationIntents.reconcile &&
        hold.kind === "reconcile_installed" && !isMigrationClassHold(gatewayHold);
      const applyRecoveryOwner = applyOwner &&
        (matchesApplyRecoveryHold({ intent, recoveryHold, gatewayHold }) ||
          (intent === kGatewayMutationIntents.applyBackup && matchesRecoveryHold({ recoveryHold, gatewayHold })));
      return recoveryOwner || applyRecoveryOwner;
    }, canRecoverPending: (pending) => {
      if (applyOwner && [kGatewayMutationIntents.applyRecovery, kGatewayMutationIntents.applyBackup].includes(intent) &&
          recoveryPending && isDeepStrictEqual(recoveryPending, pending)) return true;
      if (!owns || intent !== kGatewayMutationIntents.restart) return false;
      const authorization = databaseRecoveryAuthorizations.get(hold);
      if (!authorization || !isDeepStrictEqual(authorization.pending, pending)) return false;
      try { return authorization.isCurrent() === true; } catch { return false; }
    } });
    const authorization = intent === kGatewayMutationIntents.restart && hold
      ? databaseRecoveryAuthorizations.get(hold) : null;
    const expectedPending = recoveryPending || authorization?.pending;
    if (!blocker && expectedPending && !isDeepStrictEqual(expectedPending, currentInfo?.databaseRecoveryPending)) {
      let completed = false;
      if (owns && !recoveryPending && !currentInfo?.databaseRecoveryPending && authorization) {
        try { completed = authorization.isCompleted?.() === true && authorization.isCurrent() === true; } catch {}
      }
      if (!completed) {
        if (hold) databaseRecoveryAuthorizations.delete(hold);
        return { code: "recovery_source_changed", statusCode: 409,
          error: "The pending database recovery changed.", hint: "Review the current recovery state before continuing." };
      }
    }
    if (blocker && hold) databaseRecoveryAuthorizations.delete(hold);
    return blocker;
  };
  const assert = (options) => {
    const blocker = read(options);
    if (blocker) throw new GatewayMutationBlockedError(blocker);
  };
  const assertDatabaseVerification = ({ hold, recoveryHold, recoveryPending = null } = {}) => {
    if (!hold || lock?.owns?.(hold) !== true || hold.isValid?.() === false ||
        !["restart", "database_verification", "boot"].includes(hold.kind)) {
      throw new GatewayMutationBlockedError({ code: "lease_expired", statusCode: 409,
        error: "Database verification no longer owns the gateway lifecycle.",
        hint: "Refresh the current operation and try again." });
    }
    if (isApplyInProgress()) {
      throw new GatewayMutationBlockedError({ code: "apply_in_progress", statusCode: 409,
        error: "An update or backup is in progress.", hint: "Wait for it to finish, then try again." });
    }
    let matched = false;
    let currentInfo = null;
    const blocker = readGatewayHoldBlocker({ getChannelInfo: () => { currentInfo = getChannelInfo(); return currentInfo; }, describeReadError,
      canRecover: (gatewayHold) => {
        matched = ["state_db_unverified", "state_db_unreadable"].includes(gatewayHold.reason) &&
          matchesRecoveryHold({ recoveryHold, gatewayHold });
        return matched;
      }, canRecoverPending: (pending) => {
        const same = !!recoveryPending && isDeepStrictEqual(recoveryPending, pending);
        matched = matched || same;
        return same;
      } });
    if (blocker) throw new GatewayMutationBlockedError(blocker);
    if (!matched || !isDeepStrictEqual(currentInfo?.gatewayHold || null, recoveryHold || null) ||
        !isDeepStrictEqual(currentInfo?.databaseRecoveryPending || null, recoveryPending || null)) {
      throw new GatewayMutationBlockedError({ code: "recovery_source_changed", statusCode: 409,
        error: "The database verification hold changed.",
        hint: "Refresh the findings before requesting another verification." });
    }
  };
  const authorizeDatabaseRecovery = ({ hold, pending, isCurrent, isCompleted } = {}) => {
    if (!hold || lock?.owns?.(hold) !== true || hold.isValid?.() === false ||
        !["restart", "database_verification", "boot"].includes(hold.kind)) {
      throw new GatewayMutationBlockedError({ code: "lease_expired", statusCode: 409,
        error: "Database recovery no longer owns the gateway lifecycle.", hint: "Verify the current findings again." });
    }
    let matched = false;
    const blocker = readGatewayHoldBlocker({ getChannelInfo, describeReadError,
      canRecoverPending: (current) => {
        matched = !!pending && isDeepStrictEqual(pending, current);
        return matched;
      } });
    if (blocker) throw new GatewayMutationBlockedError(blocker);
    if (!matched || typeof isCurrent !== "function" || isCurrent() !== true) throw new GatewayMutationBlockedError({ code: "recovery_source_changed", statusCode: 409,
      error: "The pending database recovery changed.", hint: "Verify the current findings again." });
    databaseRecoveryAuthorizations.set(hold, { pending: structuredClone(pending), isCurrent, isCompleted });
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
  return { read, assert, restart, assertDatabaseVerification, authorizeDatabaseRecovery };
};

module.exports = { createGatewayMutationPolicy, kGatewayMutationIntents,
  GatewayMutationBlockedError, restartDeferredFields, matchesApplyRecoveryHold, assertApplyBackupAdmission };

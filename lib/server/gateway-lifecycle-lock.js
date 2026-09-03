const { kGatewayLifecycleLeaseMs } = require("./constants");

// One gateway lifecycle operation at a time. Manual restarts, watchdog
// repair/auto-restart, channel applies, rollbacks, and the boot sequence all
// mutate the same gateway process; letting two run concurrently is how a
// repair races a restart into two competing launches.
//
// Two acquisition modes, by caller type:
//  - acquire(): user-initiated paths QUEUE behind the active operation
//    (clicking Restart during a repair waits, then runs).
//  - tryAcquire(): watchdog timer paths SKIP when something is already
//    running — a background loop must never park on a lock; a held lock
//    means recovery is already in progress.
//
// A lease bounds every hold: a holder that never releases (hung subprocess,
// programming error) is force-released at lease expiry so the queue cannot
// deadlock. No cancellation or priorities in v1.
const createGatewayLifecycleLock = ({
  leaseMs = kGatewayLifecycleLeaseMs,
  now = () => Date.now(),
  logger = console,
} = {}) => {
  let active = null; // { kind, startedAt, release }
  let queueTail = Promise.resolve();

  const makeHold = (kind, holdLeaseMs = leaseMs) => {
    let settled = false;
    let resolveReleased;
    const released = new Promise((resolve) => {
      resolveReleased = resolve;
    });
    const hold = { kind, startedAt: now(), released, release: null };
    const leaseTimer = setTimeout(() => {
      if (settled) return;
      logger.warn?.(
        `[alphaclaw] gateway lifecycle lease expired for "${kind}" — force-releasing`,
      );
      finish();
    }, holdLeaseMs);
    leaseTimer.unref?.();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(leaseTimer);
      if (active === hold) active = null;
      resolveReleased();
    };
    hold.release = finish;
    return hold;
  };

  // Queue/attach semantics for user paths: resolves with a release() fn once
  // the lock is held. Callers MUST release in a finally block. A caller whose
  // operation legitimately outlives the default lease (the boot reconciler's
  // doctor pass) passes its own {leaseMs}; the override bounds only that hold.
  const acquire = (kind, { leaseMs: holdLeaseMs } = {}) => {
    const prev = queueTail;
    let holdRef;
    const turn = prev.then(async () => {
      // A tryAcquire can slip in during the microtask gap after the previous
      // release; wait it out rather than double-holding.
      while (active) await active.released;
      holdRef = makeHold(kind, holdLeaseMs);
      active = holdRef;
      return holdRef.release;
    });
    queueTail = turn.then(() => holdRef.released);
    return turn;
  };

  // Skip semantics for watchdog timer paths.
  const tryAcquire = (kind, { leaseMs: holdLeaseMs } = {}) => {
    if (active) return null;
    const hold = makeHold(kind, holdLeaseMs);
    active = hold;
    // Keep queued user acquisitions behind this hold too.
    queueTail = queueTail.then(() => hold.released);
    return hold.release;
  };

  const getActiveOperation = () =>
    active ? { kind: active.kind, startedAt: active.startedAt } : null;

  return { acquire, tryAcquire, getActiveOperation };
};

module.exports = { createGatewayLifecycleLock };

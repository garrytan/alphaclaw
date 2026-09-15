const { kGatewayLifecycleLeaseMs } = require("./constants");
const { kRepairCleanupAllowanceMs } = require("./repair-operation");

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
// deadlock. Holders can ask whether they still own the lock (below); there is
// Opt-in repair cleanup invalidates authority on expiry but retains the hold
// until its process group and restore guard have drained. Other holders keep
// the original bounded force-release behavior.
//
// HELD -> expired/release -> CLEANUP -> confirmed -> RELEASED
//                              | 15s, still unconfirmed
//                              v
//                       CLEANUP_BLOCKED (queue remains held)
//
// Hold lifecycle, as seen by the holder through its release() function:
//
//   acquire()/tryAcquire()
//         |
//         v
//   +-----------+  release()          +-----------+
//   |  HELD     | ------------------> | RELEASED  |  isValid() false
//   | isValid() |                     |           |  isExpired() false
//   |   true    |  lease timer fires  +-----------+
//   | isExpired |  (force-release,    +-----------+
//   |   false   | ------------------> | EXPIRED   |  isValid() false
//   +-----------+   warn logged)      |           |  isExpired() true
//                                     +-----------+
//
// isValid() answers "may I still mutate the gateway?" — a holder re-checks it
// after every await and skips the mutation when false, because a successor
// may already hold the lock. isExpired() distinguishes the lease firing from
// the holder's own release(), for ledger rows ("lease_expired" vs a normal
// end). A late release() by an expired holder is a no-op: it never touches
// the successor's hold. holdId is a per-lock monotonic integer so two holds of
// the same kind are never confused.
const createGatewayLifecycleLock = ({
  leaseMs = kGatewayLifecycleLeaseMs,
  now = () => Date.now(),
  logger = console,
} = {}) => {
  let active = null; // { kind, holdId, startedAt, released, release }
  let queueTail = Promise.resolve();
  // Acquires requested but not yet holding the lock. Queue detection lives
  // HERE, not in a caller sampling getActiveOperation() a tick earlier: a
  // pending turn ahead of us while `active` is momentarily null is still a
  // wait, and only the lock can see it.
  let pendingTurns = 0;
  // Monotonic per lock instance; never reused, so a stale holder's id can
  // always be told apart from the successor's in ledger rows.
  let holdSeq = 0;

  const makeHold = (kind, holdLeaseMs = leaseMs, cleanup = null) => {
    let settled = false;
    let expired = false;
    let releasing = false;
    let cleanupTimer = null;
    let resolveReleased;
    const released = new Promise((resolve) => {
      resolveReleased = resolve;
    });
    holdSeq += 1;
    const holdId = holdSeq;
    const startedAt = now();
    const hold = { kind, holdId, startedAt, released, release: null };
    const leaseTimer = setTimeout(() => {
      if (settled) return;
      logger.warn?.(
        `[alphaclaw] gateway lifecycle lease expired for "${kind}" — ${cleanup ? "cancelling and draining writers" : "force-releasing"}`,
      );
      // Flag BEFORE finish() so a holder observing the release settle sees
      // isExpired() already true.
      expired = true;
      try { cleanup?.cancel("lease_expired"); } catch (error) {
        logger.warn?.(`[alphaclaw] lifecycle cancellation failed: ${error.message}`);
      }
      release();
    }, holdLeaseMs);
    leaseTimer.unref?.();
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(leaseTimer);
      clearTimeout(cleanupTimer);
      if (active === hold) active = null;
      resolveReleased();
    };
    const release = () => {
      if (settled || releasing) return released;
      releasing = true;
      clearTimeout(leaseTimer);
      if (!cleanup) {
        finish();
        return released;
      }
      hold.phase = "cleanup";
      hold.cleanupStartedAt = now();
      const blocked = (error) => {
        if (settled) return;
        hold.phase = "cleanup_blocked";
        logger.warn?.(`[alphaclaw] lifecycle cleanup_blocked for "${kind}"; confirm and reap the tracked writer before restarting${error ? `: ${error.message}` : ""}`);
      };
      cleanupTimer = setTimeout(blocked, kRepairCleanupAllowanceMs);
      cleanupTimer.unref?.();
      Promise.resolve().then(() => cleanup.wait()).then(finish, blocked);
      return released;
    };
    // The release function doubles as the holder's ownership handle (see the
    // header diagram). Accessors, not a snapshot: a holder reads them after
    // every await.
    hold.cleanup = cleanup;
    hold.release = Object.assign(release, {
      holdId,
      kind,
      startedAt,
      isValid: () => !settled && !expired && !releasing,
      isExpired: () => expired,
    });
    return hold;
  };

  // Queue/attach semantics for user paths: resolves with a release() fn once
  // the lock is held. Callers MUST release in a finally block. A caller whose
  // operation legitimately outlives the default lease (the boot reconciler's
  // doctor pass) passes its own {leaseMs}; the override bounds only that hold.
  // {onQueued} fires SYNCHRONOUSLY, before this call returns, iff the acquire
  // will actually wait (a holder is active or a turn is pending ahead) — the
  // restart route uses it to surface a "waiting" step only when there is one.
  const acquire = (kind, { leaseMs: holdLeaseMs, onQueued = null, cleanup = null } = {}) => {
    const prev = queueTail;
    if (typeof onQueued === "function" && (active || pendingTurns > 0)) {
      try {
        onQueued(getActiveOperation());
      } catch (err) {
        logger.warn?.(
          `[alphaclaw] gateway lifecycle onQueued handler threw: ${err.message}`,
        );
      }
    }
    pendingTurns += 1;
    let holdRef;
    const turn = prev.then(async () => {
      // A tryAcquire can slip in during the microtask gap after the previous
      // release; wait it out rather than double-holding.
      while (active) await active.released;
      pendingTurns -= 1;
      holdRef = makeHold(kind, holdLeaseMs, cleanup);
      active = holdRef;
      return holdRef.release;
    });
    queueTail = turn.then(() => holdRef.released);
    return turn;
  };

  // Skip semantics for watchdog timer paths.
  const tryAcquire = (kind, { leaseMs: holdLeaseMs, cleanup = null } = {}) => {
    // A queued user acquire (turn pending, holder just released) outranks a
    // background try: skipping here is what "never park a timer path" means.
    if (active || pendingTurns > 0) return null;
    const hold = makeHold(kind, holdLeaseMs, cleanup);
    active = hold;
    // Keep queued user acquisitions behind this hold too.
    queueTail = queueTail.then(() => hold.released);
    return hold.release;
  };

  const getActiveOperation = () =>
    active
      ? {
          kind: active.kind, startedAt: active.startedAt, holdId: active.holdId,
          ...(active.phase ? { phase: active.phase, cleanupStartedAt: active.cleanupStartedAt,
            ...active.cleanup?.describe?.() } : {}),
        }
      : null;

  // Object identity prevents an expired/forged handle borrowing a successor's
  // authority, even if it copies the public holdId and isValid properties.
  const owns = (handle) => !!active && active.release === handle && handle.isValid();
  return { acquire, tryAcquire, getActiveOperation, owns };
};

module.exports = { createGatewayLifecycleLock };

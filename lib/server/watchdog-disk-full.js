// The watchdog's disk-full hold. A gateway that cannot start because its disk
// is full gets nothing from Doctor or quick relaunches: each one fails the
// same way and spends the crash-loop and repair budgets, after which the
// watchdog stops for good. While the hold stands, Doctor and crash relaunches
// wait; free space is measured every poll, and once it is back above the
// resume threshold the hold ends and the watchdog relaunches the gateway with
// a fresh repair budget. A relaunch is still tried on a backoff while the
// disk stays full, in case the space that matters is not the space measured.
//
//   enter() ── free >= resumeAt (poll) ──> onRecovered()   hold ends
//      │
//      └── retry delay elapsed ──> onRetry()   hold stands; a disk-full exit
//                                              re-enters with the next delay
const createDiskFullHold = ({
  measure,
  // Held only below this much free space, and released once free space is
  // back resumeMarginBytes above where the hold started.
  entryFloorBytes,
  resumeMarginBytes,
  pollMs,
  retryDelaysMs,
  onRecovered,
  onRetry,
  now = () => Date.now(),
}) => {
  let hold = null;
  let pollTimer = null;
  let retryTimer = null;

  const clearTimers = () => {
    clearTimeout(pollTimer);
    clearTimeout(retryTimer);
    pollTimer = null;
    retryTimer = null;
  };

  const schedulePoll = () => {
    pollTimer = setTimeout(() => {
      pollTimer = null;
      if (!hold) return;
      const measured = measure();
      if (measured) {
        hold.dir = measured.dir;
        hold.freeBytes = measured.freeBytes;
      }
      if (measured && measured.freeBytes >= hold.resumeAtFreeBytes) {
        const ended = hold;
        hold = null;
        clearTimers();
        onRecovered(ended);
        return;
      }
      schedulePoll();
    }, pollMs);
    pollTimer.unref?.();
  };

  const scheduleRetry = () => {
    clearTimeout(retryTimer);
    const delayMs = retryDelaysMs[Math.min(hold.retries, retryDelaysMs.length - 1)];
    hold.nextRetryAt = now() + delayMs;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!hold) return;
      hold.retries += 1;
      hold.nextRetryAt = null;
      onRetry(hold);
    }, delayMs);
    retryTimer.unref?.();
  };

  // Starts the hold, or re-arms the next backoff retry when it already
  // stands. Null when free space cannot be measured or is above the entry
  // floor: then the disk is not what keeps the gateway down.
  const enter = () => {
    const measured = measure();
    if (!measured) return null;
    if (hold) {
      hold.dir = measured.dir;
      hold.freeBytes = measured.freeBytes;
      scheduleRetry();
      return { ...hold, entered: false };
    }
    if (measured.freeBytes >= entryFloorBytes) return null;
    hold = {
      dir: measured.dir,
      freeBytes: measured.freeBytes,
      entryFreeBytes: measured.freeBytes,
      resumeAtFreeBytes: measured.freeBytes + resumeMarginBytes,
      since: now(),
      retries: 0,
      nextRetryAt: null,
    };
    schedulePoll();
    scheduleRetry();
    return { ...hold, entered: true };
  };

  const clear = () => {
    const ended = hold;
    hold = null;
    clearTimers();
    return ended;
  };

  const describe = () =>
    hold
      ? {
          dir: hold.dir,
          freeBytes: hold.freeBytes,
          resumeAtFreeBytes: hold.resumeAtFreeBytes,
          since: new Date(hold.since).toISOString(),
          retries: hold.retries,
          nextRetryAt: hold.nextRetryAt == null ? null : new Date(hold.nextRetryAt).toISOString(),
        }
      : null;

  return { enter, clear, describe, active: () => hold !== null };
};

module.exports = { createDiskFullHold };

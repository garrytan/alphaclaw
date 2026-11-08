// One process-wide semaphore for every password hash a request can buy
// (sign-in checks, decoy hashes, invite accepts). At most kHashGateSlots
// hashes run, kHashGateReservedSlots of them only for a sign-in with a valid
// known-browser pass, and at most kHashGateQueueLimit wait. Past that, run
// returns null, work never runs, and the route answers 429 at once with
// kHashGateRetryAfterSec. The slot is given back in the finally around work.
const kHashGateSlots = 4;
const kHashGateReservedSlots = 1;
const kHashGateQueueLimit = 16;
const kHashGateRetryAfterSec = 2;

const createHashGate = ({ slots = kHashGateSlots, reservedSlots = kHashGateReservedSlots, queueLimit = kHashGateQueueLimit } = {}) => {
  const queue = [];
  let running = 0;
  const limit = (reserved) => (reserved ? slots : slots - reservedSlots);
  const run = (work, { reserved = false } = {}) => {
    if (running >= limit(reserved) && queue.length >= queueLimit) return null;
    return new Promise((resolve, reject) => {
      const start = async () => {
        running += 1;
        try {
          resolve(await work());
        } catch (err) {
          reject(err);
        } finally {
          running -= 1;
          const next = queue.findIndex((entry) => running < limit(entry.reserved));
          if (next >= 0) queue.splice(next, 1)[0].start();
        }
      };
      if (running < limit(reserved)) start();
      else queue.push({ reserved, start });
    });
  };
  return { run, stats: () => ({ running, queued: queue.length }) };
};

module.exports = {
  createHashGate,
  hashGate: createHashGate(),
  kHashGateSlots,
  kHashGateReservedSlots,
  kHashGateQueueLimit,
  kHashGateRetryAfterSec,
};

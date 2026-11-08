const {
  createHashGate,
  hashGate,
  kHashGateQueueLimit,
  kHashGateReservedSlots,
  kHashGateSlots,
} = require("../../lib/server/utils/hash-gate");

const kSharedSlots = kHashGateSlots - kHashGateReservedSlots;

const stalled = () => {
  let release;
  const promise = new Promise((resolve) => {
    release = resolve;
  });
  return { promise, release };
};

describe("server/utils/hash-gate", () => {
  it("the process-wide gate starts idle", () => {
    expect(hashGate.stats()).toEqual({ running: 0, queued: 0 });
  });

  it("runs at most the shared slots, queues up to the limit and refuses the rest at once without running them", async () => {
    const gate = createHashGate();
    const stall = stalled();
    let started = 0;
    const work = () => {
      started += 1;
      return stall.promise;
    };
    const admitted = [];
    let refused = 0;
    for (let i = 0; i < kHashGateSlots + kHashGateQueueLimit + 10; i += 1) {
      const pending = gate.run(work);
      if (pending) admitted.push(pending);
      else refused += 1;
    }
    expect(started).toBe(kSharedSlots);
    expect(gate.stats()).toEqual({ running: kSharedSlots, queued: kHashGateQueueLimit });
    expect(admitted).toHaveLength(kSharedSlots + kHashGateQueueLimit);
    expect(refused).toBe(kHashGateReservedSlots + 10);

    stall.release();
    await Promise.all(admitted);
    expect(started).toBe(kSharedSlots + kHashGateQueueLimit);
    expect(gate.stats()).toEqual({ running: 0, queued: 0 });
  });

  it("reserved work takes the held-back slot while the shared slots and the queue are full", async () => {
    const gate = createHashGate();
    const stall = stalled();
    const flood = Array.from({ length: kSharedSlots + kHashGateQueueLimit }, () => gate.run(() => stall.promise));
    expect(gate.run(() => stall.promise)).toBeNull();

    const owner = gate.run(async () => "signed in", { reserved: true });
    expect(owner).not.toBeNull();
    await expect(owner).resolves.toBe("signed in");
    expect(gate.stats()).toEqual({ running: kSharedSlots, queued: kHashGateQueueLimit });

    stall.release();
    await Promise.all(flood);
  });

  it("a hash that throws gives its slot back, so the next queued hash runs", async () => {
    const gate = createHashGate();
    const stall = stalled();
    const failing = Array.from({ length: kSharedSlots }, () =>
      gate.run(async () => {
        await stall.promise;
        throw new Error("scrypt failed");
      }),
    );
    let queuedRan = false;
    const queued = gate.run(async () => {
      queuedRan = true;
    });
    expect(gate.stats()).toEqual({ running: kSharedSlots, queued: 1 });

    stall.release();
    for (const pending of failing) await expect(pending).rejects.toThrow("scrypt failed");
    await queued;
    expect(queuedRan).toBe(true);
    expect(gate.stats()).toEqual({ running: 0, queued: 0 });

    const syncThrow = gate.run(() => {
      throw new Error("bad input");
    });
    await expect(syncThrow).rejects.toThrow("bad input");
    expect(gate.stats()).toEqual({ running: 0, queued: 0 });
  });
});

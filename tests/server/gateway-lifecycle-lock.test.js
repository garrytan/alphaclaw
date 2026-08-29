const {
  createGatewayLifecycleLock,
} = require("../../lib/server/gateway-lifecycle-lock");

describe("server/gateway-lifecycle-lock", () => {
  it("force-releases an expired lease and hands the lock to the queued waiter", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const lock = createGatewayLifecycleLock({ leaseMs: 50, logger: { warn } });

      // A holder that never releases (hung subprocess) with a user acquire
      // parked behind it — the exact shape of a queue deadlock.
      const staleRelease = await lock.acquire("restart");
      const queued = lock.acquire("repair");
      expect(lock.getActiveOperation()).toMatchObject({ kind: "restart" });

      await vi.advanceTimersByTimeAsync(51);

      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('lease expired for "restart"'),
      );
      // The expired hold was cleared, so the queued acquire now resolves and
      // becomes the active operation.
      const successorRelease = await queued;
      expect(lock.getActiveOperation()).toMatchObject({ kind: "repair" });

      // A LATE release() by the expired holder must not release the
      // successor's hold out from under it.
      staleRelease();
      expect(lock.getActiveOperation()).toMatchObject({ kind: "repair" });

      successorRelease();
      expect(lock.getActiveOperation()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("grants queued acquirers strictly in FIFO order", async () => {
    const lock = createGatewayLifecycleLock({ logger: { warn: vi.fn() } });
    const order = [];

    const releaseFirst = await lock.acquire("restart");
    const second = lock.acquire("apply").then((release) => {
      order.push("apply");
      return release;
    });
    const third = lock.acquire("rollback").then((release) => {
      order.push("rollback");
      return release;
    });

    await new Promise((resolve) => setImmediate(resolve));
    // Both callers park while the first operation holds the lock.
    expect(order).toEqual([]);

    releaseFirst();
    const releaseSecond = await second;
    await new Promise((resolve) => setImmediate(resolve));
    // The second caller acquired; the third is still parked behind it.
    expect(order).toEqual(["apply"]);
    expect(lock.getActiveOperation()).toMatchObject({ kind: "apply" });

    releaseSecond();
    const releaseThird = await third;
    expect(order).toEqual(["apply", "rollback"]);
    releaseThird();
    expect(lock.getActiveOperation()).toBeNull();
  });

  it("tryAcquire skips while held (or queued behind) and acquires when free", async () => {
    const lock = createGatewayLifecycleLock({ logger: { warn: vi.fn() } });

    // Free: the watchdog path gets a working release function.
    const watchdogRelease = lock.tryAcquire("repair");
    expect(typeof watchdogRelease).toBe("function");
    expect(lock.getActiveOperation()).toMatchObject({ kind: "repair" });

    // Held: timer paths must skip, never park.
    expect(lock.tryAcquire("auto_restart")).toBeNull();

    // A user acquire queued behind the hold still keeps tryAcquire out.
    const queued = lock.acquire("restart");
    expect(lock.tryAcquire("auto_restart")).toBeNull();

    // Queued user acquisitions stay behind a tryAcquire hold: releasing it
    // hands the lock to the waiter, and tryAcquire keeps skipping.
    watchdogRelease();
    const queuedRelease = await queued;
    expect(lock.getActiveOperation()).toMatchObject({ kind: "restart" });
    expect(lock.tryAcquire("auto_restart")).toBeNull();

    queuedRelease();
    const finalRelease = lock.tryAcquire("auto_restart");
    expect(typeof finalRelease).toBe("function");
    finalRelease();
    expect(lock.getActiveOperation()).toBeNull();
  });

  it("reports the current holder's kind across a queue handoff", async () => {
    const lock = createGatewayLifecycleLock({ logger: { warn: vi.fn() } });
    expect(lock.getActiveOperation()).toBeNull();

    const releaseBoot = await lock.acquire("boot");
    expect(lock.getActiveOperation()).toEqual({
      kind: "boot",
      startedAt: expect.any(Number),
    });

    const queued = lock.acquire("restart");
    // A queued operation never shows as active until it actually holds.
    expect(lock.getActiveOperation()).toMatchObject({ kind: "boot" });

    releaseBoot();
    const releaseRestart = await queued;
    expect(lock.getActiveOperation()).toEqual({
      kind: "restart",
      startedAt: expect.any(Number),
    });

    releaseRestart();
    expect(lock.getActiveOperation()).toBeNull();
  });
});

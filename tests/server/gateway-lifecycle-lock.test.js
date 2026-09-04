const {
  createGatewayLifecycleLock,
} = require("../../lib/server/gateway-lifecycle-lock");

describe("server/gateway-lifecycle-lock", () => {
  it("acquire({onQueued}) fires synchronously only when the caller will actually wait", async () => {
    const lock = createGatewayLifecycleLock({ leaseMs: 10_000 });

    // Idle lock: no wait, no callback.
    const idleQueued = vi.fn();
    const release1 = await lock.acquire("restart", { onQueued: idleQueued });
    expect(idleQueued).not.toHaveBeenCalled();

    // Active holder (a user acquire): the second acquire will wait — the
    // callback fires before acquire() returns, naming the active operation.
    const queued = vi.fn();
    const pending = lock.acquire("restart", { onQueued: queued });
    expect(queued).toHaveBeenCalledTimes(1);
    expect(queued).toHaveBeenCalledWith(expect.objectContaining({ kind: "restart" }));
    release1();
    const release2 = await pending;

    // A watchdog tryAcquire holder counts as contention too.
    release2();
    const releaseTry = lock.tryAcquire("crash_restart");
    expect(releaseTry).toBeTypeOf("function");
    const queuedBehindTry = vi.fn();
    const pending2 = lock.acquire("restart", { onQueued: queuedBehindTry });
    expect(queuedBehindTry).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "crash_restart" }),
    );
    releaseTry();
    (await pending2)();
    expect(lock.getActiveOperation()).toBeNull();
  });

  it("acquire({onQueued}) sees a pending turn ahead of it even while `active` is momentarily null", async () => {
    const lock = createGatewayLifecycleLock({ leaseMs: 10_000 });
    const releaseFirst = await lock.acquire("boot");
    const secondQueued = vi.fn();
    const second = lock.acquire("restart", { onQueued: secondQueued });
    expect(secondQueued).toHaveBeenCalledTimes(1);
    // Release the holder: `active` clears, but the second acquire has not
    // taken the lock yet (its turn resolves on a later microtask). A third
    // acquire issued right now still waits — and must know it.
    releaseFirst();
    expect(lock.getActiveOperation()).toBeNull();
    const thirdQueued = vi.fn();
    const third = lock.acquire("repair", { onQueued: thirdQueued });
    expect(thirdQueued).toHaveBeenCalledTimes(1);
    (await second)();
    (await third)();
    expect(lock.getActiveOperation()).toBeNull();
  });

  it("a throwing onQueued handler is contained and logged, never poisoning the queue", async () => {
    const warn = vi.fn();
    const lock = createGatewayLifecycleLock({ leaseMs: 10_000, logger: { warn } });
    const release1 = await lock.acquire("restart");
    const pending = lock.acquire("restart", {
      onQueued: () => {
        throw new Error("boom");
      },
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("onQueued handler threw: boom"));
    release1();
    (await pending)();
    expect(lock.getActiveOperation()).toBeNull();
  });

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

  it("honors a per-acquire {leaseMs} override — the lease fires at the overridden time, not the default", async () => {
    vi.useFakeTimers();
    try {
      const warn = vi.fn();
      const lock = createGatewayLifecycleLock({ leaseMs: 50, logger: { warn } });

      // A boot-style holder whose operation legitimately outlives the
      // default lease: the default expiry must NOT force-release it.
      await lock.acquire("boot", { leaseMs: 500 });
      await vi.advanceTimersByTimeAsync(51);
      expect(warn).not.toHaveBeenCalled();
      expect(lock.getActiveOperation()).toMatchObject({ kind: "boot" });

      // The overridden lease still bounds the hold.
      await vi.advanceTimersByTimeAsync(450);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('lease expired for "boot"'),
      );
      expect(lock.getActiveOperation()).toBeNull();

      // tryAcquire takes the same override.
      warn.mockClear();
      const release = lock.tryAcquire("repair", { leaseMs: 200 });
      expect(typeof release).toBe("function");
      await vi.advanceTimersByTimeAsync(51);
      expect(warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(150);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('lease expired for "repair"'),
      );
      expect(lock.getActiveOperation()).toBeNull();

      // Omitting the option keeps the constructor default.
      warn.mockClear();
      await lock.acquire("restart");
      await vi.advanceTimersByTimeAsync(51);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('lease expired for "restart"'),
      );
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

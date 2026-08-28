const {
  createLifecycleLock,
} = require("../../lib/server/utils/lifecycle-lock");

// Deferred helper: a controllable in-flight operation.
// startNext() launches the op's fn on a microtask, and the in-flight slot is
// cleared one microtask after the op's promise resolves — flush past both.
const settle = () => new Promise((resolve) => setImmediate(resolve));

const createDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe("server/utils/lifecycle-lock", () => {
  it("runs an op and resolves with the fn's return value", async () => {
    const lock = createLifecycleLock();

    const result = await lock.run("start", async () => "the-child");

    expect(result).toBe("the-child");
    await settle();
    expect(lock.isBusy()).toBe(false);
    expect(lock.currentOpName()).toBe(null);
  });

  it("joins a same-named op already in flight (single execution)", async () => {
    const lock = createLifecycleLock();
    const gate = createDeferred();
    const fn = vi.fn(async () => {
      await gate.promise;
      return "restarted";
    });

    const first = lock.run("restart", fn);
    await settle();
    // Second restart while the first is in flight joins it — a double-clicked
    // "Restart gateway" coalesces into ONE restart.
    const second = lock.run("restart", fn);

    expect(lock.isBusy()).toBe(true);
    expect(lock.currentOpName()).toBe("restart");
    expect(fn).toHaveBeenCalledTimes(1);

    gate.resolve();
    await expect(first).resolves.toBe("restarted");
    // Joined callers receive the op's RESULT — a joined launchGatewayProcess
    // must return the child, not undefined (watchdog checks truthiness).
    await expect(second).resolves.toBe("restarted");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("joins a same-named op that is still queued", async () => {
    const lock = createLifecycleLock();
    const gate = createDeferred();
    const syncFn = vi.fn(async () => {});

    void lock.run("restart", async () => gate.promise);
    const firstSync = lock.run("channel-sync", syncFn);
    const secondSync = lock.run("channel-sync", syncFn);

    gate.resolve();
    await Promise.all([firstSync, secondSync]);

    expect(syncFn).toHaveBeenCalledTimes(1);
  });

  it("queues different-named ops and runs them in FIFO order", async () => {
    const lock = createLifecycleLock();
    const gate = createDeferred();
    const events = [];

    const first = lock.run("restart", async () => {
      events.push("restart:start");
      await gate.promise;
      events.push("restart:end");
    });
    const second = lock.run("channel-sync", async () => {
      events.push("channel-sync:start");
      events.push("channel-sync:end");
    });
    const third = lock.run("launch", async () => {
      events.push("launch:start");
      events.push("launch:end");
    });

    expect(lock.currentOpName()).toBe("restart");
    await settle();
    expect(events).toEqual(["restart:start"]);

    gate.resolve();
    await Promise.all([first, second, third]);

    // Strict FIFO and no interleaving: each op fully finishes before the next
    // begins.
    expect(events).toEqual([
      "restart:start",
      "restart:end",
      "channel-sync:start",
      "channel-sync:end",
      "launch:start",
      "launch:end",
    ]);
    await settle();
    expect(lock.isBusy()).toBe(false);
  });

  it("cancel() aborts the in-flight op's signal and rejects queued ops", async () => {
    const lock = createLifecycleLock();
    const gate = createDeferred();
    let observedSignal = null;
    let abortEventFired = false;

    const inFlight = lock.run("restart", async ({ signal }) => {
      observedSignal = signal;
      signal.addEventListener("abort", () => {
        abortEventFired = true;
      });
      await gate.promise;
      return "done-after-abort";
    });
    await settle();
    const queuedFn = vi.fn(async () => {});
    const queued = lock.run("channel-sync", queuedFn);
    // Attach rejection expectation before cancelling so nothing is unhandled.
    const queuedRejection = expect(queued).rejects.toThrow(
      "Lifecycle operation cancelled (shutdown)",
    );

    expect(observedSignal).toBeInstanceOf(AbortSignal);
    expect(observedSignal.aborted).toBe(false);

    const cancelled = lock.cancel();

    expect(observedSignal.aborted).toBe(true);
    expect(abortEventFired).toBe(true);
    await queuedRejection;
    expect(queuedFn).not.toHaveBeenCalled();

    // cancel() hands back the in-flight promise so shutdown can await its
    // termination; the op is allowed to finish its own way.
    gate.resolve();
    await cancelled;
    await expect(inFlight).resolves.toBe("done-after-abort");
  });

  it("cancel() with nothing in flight resolves immediately", async () => {
    const lock = createLifecycleLock();

    await expect(lock.cancel()).resolves.toBeUndefined();
    expect(lock.isBusy()).toBe(false);
  });

  it("a rejecting op propagates its error and releases the lock for later ops", async () => {
    const lock = createLifecycleLock();

    await expect(
      lock.run("restart", async () => {
        throw new Error("cold start failed");
      }),
    ).rejects.toThrow("cold start failed");

    // The lock keeps working after a failure (macrotask boundary lets the
    // in-flight slot clear).
    await new Promise((resolve) => setImmediate(resolve));
    await expect(lock.run("launch", async () => "ok")).resolves.toBe("ok");
  });

  it("reports isBusy/currentOpName through the op lifecycle", async () => {
    const lock = createLifecycleLock();
    const gate = createDeferred();

    expect(lock.isBusy()).toBe(false);
    expect(lock.currentOpName()).toBe(null);

    const running = lock.run("start", async () => gate.promise);
    expect(lock.isBusy()).toBe(true);
    expect(lock.currentOpName()).toBe("start");

    const queued = lock.run("restart", async () => {});
    // Queued work keeps the lock busy but does not change the current op.
    expect(lock.isBusy()).toBe(true);
    expect(lock.currentOpName()).toBe("start");

    gate.resolve();
    await Promise.all([running, queued]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(lock.isBusy()).toBe(false);
    expect(lock.currentOpName()).toBe(null);
  });

  it("sequential awaited same-name runs both execute (stale-JOIN regression)", async () => {
    // Regression: `current` used to be cleared one microtask AFTER callers
    // resumed, so a same-named run() issued right after `await lock.run(...)`
    // joined the completed op and silently never executed.
    const { createLifecycleLock } = require("../../lib/server/utils/lifecycle-lock");
    const lock = createLifecycleLock();
    const fn = vi.fn(async () => {});

    await lock.run("start", fn);
    await lock.run("start", fn);

    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rejects new work after cancel() (shutdown latch)", async () => {
    const { createLifecycleLock } = require("../../lib/server/utils/lifecycle-lock");
    const lock = createLifecycleLock();
    await lock.cancel();
    await expect(lock.run("start", async () => {})).rejects.toThrow(
      /rejected \(shutting down\)/,
    );
  });
});

const { createRepairOperation } = require("../../lib/server/repair-operation");
const { createGatewayLifecycleLock } = require("../../lib/server/gateway-lifecycle-lock");

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

describe("repair cancellation and lifecycle cleanup", () => {
  afterEach(() => vi.useRealTimers());

  it("forced expiry invalidates writes but holds a successor until writer and guard cleanup finish", async () => {
    vi.useFakeTimers();
    const logger = { warn: vi.fn() };
    const lock = createGatewayLifecycleLock({ leaseMs: 50, logger });
    let hold;
    const operation = createRepairOperation({ isCurrent: () => hold?.isValid() });
    hold = await lock.acquire("medic", { cleanup: operation.cleanup });
    operation.start(10_000);
    const child = deferred();
    const guard = deferred();
    const order = [];
    const writing = operation.runWriter(async () => {
      await child.promise;
      order.push("child exited");
      await guard.promise;
      order.push("guard finished");
    });
    await Promise.resolve();
    const next = lock.acquire("restart").then((release) => {
      order.push("successor acquired");
      return release;
    });
    await vi.advanceTimersByTimeAsync(51);
    expect(operation.signal.aborted).toBe(true);
    expect(hold.isValid()).toBe(false);
    expect(lock.getActiveOperation()).toMatchObject({ kind: "medic", phase: "cleanup" });
    expect(() => operation.runWriter(() => {})).toThrow(/cancelled/);
    child.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(order).toEqual(["child exited"]);
    expect(lock.getActiveOperation()).toMatchObject({ kind: "medic", phase: "cleanup_blocked" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("cleanup_blocked"));
    guard.resolve();
    await writing;
    const successor = await next;
    expect(order).toEqual(["child exited", "guard finished", "successor acquired"]);
    await hold(); // Late release cannot alter the successor.
    expect(lock.owns(successor)).toBe(true);
    successor();
  });

  it("an abandoned read neither writes on return nor holds the cleanup barrier", async () => {
    vi.useFakeTimers();
    const operation = createRepairOperation();
    operation.start(20);
    const external = deferred();
    const read = operation.read(() => external.promise).catch((error) => error);
    await vi.advanceTimersByTimeAsync(21);
    expect((await read).code).toBe("operation_timed_out");
    await operation.cleanup.wait();
    external.resolve("late result");
    await Promise.resolve();
    expect(() => operation.assertActive()).toThrow();
  });

  it("normal release drains registered work and a writer-free expiry releases promptly", async () => {
    vi.useFakeTimers();
    const lock = createGatewayLifecycleLock({ leaseMs: 50, logger: { warn() {} } });
    const operation = createRepairOperation();
    const hold = await lock.acquire("repair", { cleanup: operation.cleanup });
    const external = deferred();
    const writing = operation.runWriter(() => external.promise);
    await Promise.resolve();
    const released = hold();
    expect(lock.getActiveOperation().kind).toBe("repair");
    external.resolve();
    await writing;
    await released;
    expect(lock.getActiveOperation()).toBeNull();
    const empty = createRepairOperation();
    await lock.acquire("repair", { cleanup: empty.cleanup });
    await vi.advanceTimersByTimeAsync(51);
    expect(lock.getActiveOperation()).toBeNull();
  });
});

const { createGmailAccountOperations } = require("../../lib/server/gmail-account-operations");

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

describe("Gmail account operation ownership", () => {
  it("joins duplicate running and pending intents and settles replaced pending callers", async () => {
    const operations = createGmailAccountOperations();
    const hold = deferred();
    let owner;
    const first = operations.request({ accountId: "a", kind: "start", run: (token) => { owner = token; return hold.promise; } });
    expect(operations.request({ accountId: "a", kind: "start", run: vi.fn() })).toBe(first);
    const stop = operations.request({ accountId: "a", kind: "stop", run: vi.fn() });
    expect(owner.isCurrent()).toBe(false);
    expect(operations.request({ accountId: "a", kind: "stop", run: vi.fn() })).toBe(stop);
    const run = vi.fn(() => "latest");
    const latest = operations.request({ accountId: "a", kind: "start", run });
    await expect(stop).rejects.toMatchObject({ code: "superseded" });
    expect(run).not.toHaveBeenCalled();
    hold.resolve("obsolete");
    await expect(first).rejects.toMatchObject({ code: "superseded" });
    await expect(latest).resolves.toBe("latest");
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("bounds hundreds of toggles to one active and one final command", async () => {
    const operations = createGmailAccountOperations();
    const hold = deferred();
    const run = vi.fn(() => hold.promise);
    const first = operations.request({ accountId: "a", kind: "start", run });
    const requests = [];
    const pendingRun = vi.fn(() => "stopped");
    for (let i = 0; i < 301; i += 1) requests.push(operations.request({ accountId: "a", kind: i % 2 ? "start" : "stop", run: pendingRun }));
    expect(pendingRun).not.toHaveBeenCalled();
    hold.resolve();
    const outcomes = await Promise.allSettled([first, ...requests]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(pendingRun).toHaveBeenCalledTimes(1);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected").every((outcome) => outcome.reason.code === "superseded")).toBe(true);
  });

  it("disconnect joins duplicates, blocks account starts, and leaves other accounts independent", async () => {
    const operations = createGmailAccountOperations();
    const hold = deferred();
    const first = operations.request({ accountId: "a", kind: "disconnect", run: () => hold.promise });
    expect(operations.request({ accountId: "a", kind: "disconnect", run: vi.fn() })).toBe(first);
    await expect(operations.request({ accountId: "a", kind: "start", run: vi.fn() })).rejects.toMatchObject({ code: "account_disconnecting" });
    await expect(operations.request({ accountId: "b", kind: "start", run: () => "started" })).resolves.toBe("started");
    hold.resolve("disconnected");
    await expect(first).resolves.toBe("disconnected");
  });

  it("shutdown invalidates active work, discards pending work, and waits for cleanup", async () => {
    const operations = createGmailAccountOperations();
    const hold = deferred();
    let owner;
    const first = operations.request({ accountId: "a", kind: "start", run: (token) => { owner = token; return hold.promise; } });
    const pendingRun = vi.fn();
    const pending = operations.request({ accountId: "a", kind: "stop", run: pendingRun });
    const stopped = operations.stop();
    expect(owner.isCurrent()).toBe(false);
    await expect(pending).rejects.toMatchObject({ code: "superseded" });
    await expect(operations.request({ accountId: "a", kind: "start", run: vi.fn() })).rejects.toMatchObject({ code: "service_stopping" });
    hold.resolve();
    await stopped;
    await expect(first).rejects.toMatchObject({ code: "superseded" });
    expect(pendingRun).not.toHaveBeenCalled();
  });
});

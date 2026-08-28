const {
  createStatusSnapshotService,
} = require("../../lib/server/status-snapshot");

const createClient = () => ({ write: vi.fn() });

const statusFramesOf = (client) =>
  client.write.mock.calls
    .map((call) => String(call[0]))
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)));

describe("server/status-snapshot", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("computes once per tick and shares the frame across clients", async () => {
    vi.useFakeTimers();
    const compute = vi.fn(async () => ({ status: { gateway: "running" } }));
    const service = createStatusSnapshotService({ compute });
    const a = createClient();
    const b = createClient();

    await service.addClient(a);
    await service.addClient(b);

    expect(compute).toHaveBeenCalledTimes(1);
    expect(statusFramesOf(a)).toHaveLength(1);
    expect(statusFramesOf(b)).toHaveLength(1);
    expect(statusFramesOf(a)[0].status).toEqual({ gateway: "running" });
  });

  it("starts the interval with the first client and stops with the last", async () => {
    vi.useFakeTimers();
    const compute = vi.fn(async () => ({ status: { gateway: "running" } }));
    const service = createStatusSnapshotService({ compute });
    const client = createClient();

    await service.addClient(client);
    const callsAfterConnect = compute.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(compute.mock.calls.length).toBeGreaterThan(callsAfterConnect);

    service.removeClient(client);
    const callsAfterClose = compute.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10000);
    expect(compute.mock.calls.length).toBe(callsAfterClose);
  });

  it("skips identical frames but heartbeats at least every 10s", async () => {
    vi.useFakeTimers();
    const compute = vi.fn(async () => ({ status: { gateway: "running" } }));
    const service = createStatusSnapshotService({ compute });
    const client = createClient();

    await service.addClient(client);
    expect(statusFramesOf(client)).toHaveLength(1);

    // Unchanged payload: several ticks, no new frames.
    await vi.advanceTimersByTimeAsync(6000);
    expect(statusFramesOf(client)).toHaveLength(1);

    // Heartbeat window elapses: one liveness frame despite no change.
    await vi.advanceTimersByTimeAsync(6000);
    expect(statusFramesOf(client).length).toBeGreaterThanOrEqual(2);
  });

  it("emits immediately when the payload changes", async () => {
    vi.useFakeTimers();
    let gateway = "running";
    const compute = vi.fn(async () => ({ status: { gateway } }));
    const service = createStatusSnapshotService({ compute });
    const client = createClient();

    await service.addClient(client);
    gateway = "starting";
    await vi.advanceTimersByTimeAsync(2000);

    const frames = statusFramesOf(client);
    expect(frames).toHaveLength(2);
    expect(frames[1].status.gateway).toBe("starting");
  });

  it("ignores volatile fields in change detection", async () => {
    vi.useFakeTimers();
    let age = 0;
    const compute = vi.fn(async () => ({
      doctorStatus: { stale: false, lastRunAgeMs: (age += 2000) },
    }));
    const service = createStatusSnapshotService({ compute });
    const client = createClient();

    await service.addClient(client);
    await vi.advanceTimersByTimeAsync(4000);

    // lastRunAgeMs changes every tick but is excluded from the projection.
    expect(statusFramesOf(client)).toHaveLength(1);
  });

  it("serves the last good snapshot when a compute fails", async () => {
    vi.useFakeTimers();
    let fail = false;
    const compute = vi.fn(async () => {
      if (fail) throw new Error("probe failed");
      return { status: { gateway: "running" } };
    });
    const service = createStatusSnapshotService({ compute, logger: { warn: vi.fn() } });
    const client = createClient();

    await service.addClient(client);
    fail = true;
    await vi.advanceTimersByTimeAsync(4000);

    // Failures keep the last good snapshot; no bogus frames are emitted.
    expect(statusFramesOf(client)).toHaveLength(1);
    expect(await service.getSnapshotPayload()).toEqual({
      status: { gateway: "running" },
    });
  });

  it("getSnapshotPayload computes on demand with zero clients and coalesces", async () => {
    let release;
    const compute = vi.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ status: { gateway: "running" } });
        }),
    );
    const service = createStatusSnapshotService({ compute });

    const first = service.getSnapshotPayload();
    const second = service.getSnapshotPayload();
    await Promise.resolve(); // let the deferred compute start
    release();

    expect((await first).status.gateway).toBe("running");
    expect((await second).status.gateway).toBe("running");
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("getSnapshotPayload serves the fresh cache without recomputing", async () => {
    const compute = vi.fn(async () => ({ status: { gateway: "running" } }));
    const service = createStatusSnapshotService({ compute });

    await service.getSnapshotPayload();
    await service.getSnapshotPayload();

    expect(compute).toHaveBeenCalledTimes(1);
  });

  it("rejects getSnapshotPayload when there is no snapshot at all", async () => {
    const compute = vi.fn(async () => {
      throw new Error("cold failure");
    });
    const service = createStatusSnapshotService({ compute, logger: { warn: vi.fn() } });

    await expect(service.getSnapshotPayload()).rejects.toThrow("cold failure");
  });

  it("does not stack computes when one tick outlives the interval", async () => {
    vi.useFakeTimers();
    const resolvers = [];
    const compute = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvers.push(() => resolve({ status: { gateway: "running" } }));
        }),
    );
    const service = createStatusSnapshotService({ compute });
    const client = createClient();

    const connecting = service.addClient(client);
    // Two intervals elapse while the first compute is still in flight.
    await vi.advanceTimersByTimeAsync(5000);
    expect(compute).toHaveBeenCalledTimes(1);
    resolvers[0]();
    await connecting;
  });
});

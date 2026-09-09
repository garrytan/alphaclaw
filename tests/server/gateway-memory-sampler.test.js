const { EventEmitter } = require("node:events");
const { constants } = require("node:perf_hooks");
const { createMajorGcAccumulator, startGatewayMemorySampler } = require("../../lib/server/gateway-memory/telemetry-sampler");

const major = (startTime, duration = 5) => ({ startTime, duration,
  detail: { kind: constants.NODE_PERFORMANCE_GC_MAJOR, flags: 0 } });

describe("gateway natural major-GC observations", () => {
  it("retains the interval minimum's original event time, not publication time", () => {
    let time = 100;
    let used = 900;
    const gc = createMajorGcAccumulator({ now: () => 10000 + time,
      performanceImpl: { timeOrigin: 10000, now: () => time }, readHeap: () => ({ used_heap_size: used }) });
    gc.observe([major(90)]);
    time = 200; used = 400;
    gc.observe([major(180)]);
    time = 300; used = 700;
    gc.observe([major(280)]);
    expect(gc.take()).toEqual({ atMs: 10185, heapUsedBytes: 400, count: 3 });
    expect(gc.take()).toBeNull();
  });

  it("does not fabricate heap evidence for minor, forced, delayed or future GC", () => {
    const readHeap = vi.fn(() => ({ used_heap_size: 100 }));
    const gc = createMajorGcAccumulator({ now: () => 5000,
      performanceImpl: { timeOrigin: 0, now: () => 5000 }, readHeap });
    gc.observe([
      { ...major(4900), detail: { kind: constants.NODE_PERFORMANCE_GC_MINOR } },
      { ...major(4900), detail: { kind: constants.NODE_PERFORMANCE_GC_MAJOR, flags: constants.NODE_PERFORMANCE_GC_FLAGS_FORCED } },
      major(100), major(6000),
    ]);
    expect(readHeap).not.toHaveBeenCalled();
    expect(gc.take()).toBeNull();
  });

  it("uses one heap read for a batched notification and rejects invalid values", () => {
    const readHeap = vi.fn(() => ({ used_heap_size: 150 }));
    const gc = createMajorGcAccumulator({ now: () => 5000,
      performanceImpl: { timeOrigin: 0, now: () => 5000 }, readHeap });
    gc.observe([major(4900), major(4920)]);
    expect(readHeap).toHaveBeenCalledOnce();
    expect(gc.take()).toEqual({ atMs: 4925, heapUsedBytes: 150, count: 2 });
    readHeap.mockReturnValue({ used_heap_size: NaN });
    gc.observe([major(4950)]);
    expect(gc.take()).toBeNull();
  });
});

describe("gateway telemetry sampler", () => {
  const setup = (overrides = {}) => {
    let time = 10000;
    let callback;
    const clock = { now: () => time, advance: (ms) => { time += ms; } };
    const processImpl = new EventEmitter();
    processImpl.pid = 123;
    processImpl.memoryUsage = () => ({ rss: 1000, heapUsed: 100, heapTotal: 200, external: 50, arrayBuffers: 10 });
    const publications = [];
    const writer = { write: vi.fn(async (value) => { publications.push(structuredClone(value)); return true; }),
      stop: vi.fn(), flush: async () => {}, target: "/unused/telemetry.json" };
    class Observer {
      static supportedEntryTypes = ["gc"];
      constructor(fn) { callback = fn; }
      observe = vi.fn();
      disconnect = vi.fn();
    }
    const timer = { unref: vi.fn() };
    const clearIntervalImpl = vi.fn();
    const unlink = vi.fn();
    const sampler = startGatewayMemorySampler({
      stateDir: "/state", processImpl, now: clock.now,
      readIdentity: () => ({ pid: 123, startTicks: "456" }),
      readBootId: () => "11111111-1111-1111-1111-111111111111",
      readHeap: () => ({ heap_size_limit: 10000, used_heap_size: 80 }),
      performanceImpl: { timeOrigin: 0, now: clock.now }, Observer,
      setIntervalImpl: () => timer, clearIntervalImpl,
      writerFactory: () => writer, unlink, ...overrides,
    });
    return { sampler, clock, writer, publications, timer, clearIntervalImpl, processImpl, unlink,
      onGc: (entries) => callback({ getEntries: () => entries }) };
  };

  it("publishes co-sampled values immediately and unrefs the recurring timer", () => {
    const fixture = setup();
    expect(fixture.timer.unref).toHaveBeenCalledOnce();
    expect(fixture.publications[0].records[0]).toEqual({ seq: 1, atMs: 10000,
      rssBytes: 1000, heapUsedBytes: 100, heapTotalBytes: 200, heapLimitBytes: 10000,
      externalBytes: 50, arrayBuffersBytes: 10, gc: null });
    fixture.sampler.stop();
  });

  it("retains 128 distinct original records across skipped publication and never reuses GC", () => {
    const fixture = setup();
    fixture.clock.advance(100);
    fixture.onGc([major(10050)]);
    fixture.clock.advance(29900);
    fixture.writer.write.mockResolvedValueOnce(false);
    fixture.sampler.sample();
    fixture.clock.advance(30000);
    fixture.sampler.sample();
    const rows = fixture.publications.at(-1).records;
    expect(rows[1]).toMatchObject({ seq: 2, atMs: 40000, gc: { atMs: 10055, heapUsedBytes: 80, count: 1 } });
    expect(rows[2].gc).toBeNull();
    for (let i = 0; i < 150; i += 1) { fixture.clock.advance(30000); fixture.sampler.sample(); }
    expect(fixture.sampler.getRecords()).toHaveLength(128);
    expect(fixture.sampler.getRecords().at(-1).seq).toBe(153);
    fixture.sampler.stop();
  });

  it("does not discard pending GC or create duplicate records during clock rollback", () => {
    const fixture = setup();
    fixture.clock.advance(100);
    fixture.onGc([major(10050)]);
    fixture.clock.advance(-100);
    fixture.sampler.sample();
    expect(fixture.sampler.getRecords()).toHaveLength(1);
    fixture.clock.advance(30000);
    fixture.sampler.sample();
    expect(fixture.sampler.getRecords()[1].gc.atMs).toBe(10055);
    fixture.sampler.stop();
  });

  it("drops a clock-adjusted GC outside the interval without poisoning heap history", () => {
    // A GC's monotonic event time remains valid while Date.now moves back.
    const fixture = setup({ performanceImpl: { timeOrigin: 0, now: () => 10200 } });
    fixture.clock.advance(-5000);
    fixture.onGc([major(10100)]);
    fixture.clock.advance(30000);
    fixture.sampler.sample();
    expect(fixture.sampler.getRecords()[1]).toMatchObject({ atMs: 35000, heapUsedBytes: 100, gc: null });
    fixture.sampler.stop();
  });

  it("keeps heap sampling when GC observer is unsupported or fails", () => {
    class BrokenObserver { static supportedEntryTypes = ["gc"]; constructor() { throw new Error("unsupported"); } }
    const fixture = setup({ Observer: BrokenObserver });
    expect(fixture.sampler.getRecords()[0].heapLimitBytes).toBe(10000);
    expect(fixture.sampler.getRecords()[0].gc).toBeNull();
    fixture.sampler.stop();
  });

  it("disconnects an observer whose subscription fails and continues sampling", () => {
    const disconnect = vi.fn();
    class BrokenSubscription {
      static supportedEntryTypes = ["gc"];
      observe() { throw new Error("unsupported"); }
      disconnect = disconnect;
    }
    const fixture = setup({ Observer: BrokenSubscription });
    expect(disconnect).toHaveBeenCalledOnce();
    expect(fixture.sampler.getRecords()[0].heapLimitBytes).toBe(10000);
    fixture.sampler.stop();
  });

  it("fails open on missing process identity and cleans up only its file at exit", () => {
    expect(setup({ readIdentity: () => null }).sampler).toBeNull();
    const fixture = setup();
    fixture.processImpl.emit("exit");
    expect(fixture.writer.stop).toHaveBeenCalledOnce();
    expect(fixture.unlink).toHaveBeenCalledWith("/unused/telemetry.json");
    const count = fixture.publications.length;
    fixture.sampler.sample();
    expect(fixture.publications).toHaveLength(count);
  });
});

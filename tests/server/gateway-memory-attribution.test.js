const { createMemoryAttribution } = require("../../lib/server/gateway-memory/attribution");

const mb = (value) => value * 1024 * 1024;
const kStart = 1_700_000_000_000;
const at = (minute) => kStart + minute * 60_000;
const processAt = (minute, overrides = {}) => ({
  atMs: at(minute), status: "fresh",
  root: { pid: 100, startTicks: "1" }, worker: { pid: 101, startTicks: "2" },
  groupRssBytes: mb(400), childRssBytes: mb(100), childCount: 3,
  ...overrides,
});
const telemetryAt = (minute, recordAt = () => ({})) => ({
  atMs: at(minute), status: "fresh",
  records: Array.from({ length: minute * 2 + 1 }, (_, seq) => ({
    seq, atMs: at(seq / 2), rssBytes: mb(300), heapUsedBytes: mb(80),
    heapLimitBytes: mb(1024), externalBytes: mb(20), arrayBuffersBytes: mb(10),
    gc: seq % 50 === 0 ? { atMs: at(seq / 2), heapUsedBytes: mb(60), count: 1 } : null,
    ...recordAt(seq / 2),
  })).slice(-128),
});
const drive = (monitor, { end = 60, proc = () => ({}), record = () => ({}), telem = (value) => value } = {}) => {
  let snapshot;
  for (let minute = 0; minute <= end; minute += 1) {
    monitor.addSample({ process: processAt(minute, proc(minute)), telemetry: telem(telemetryAt(minute, record), minute) });
    snapshot = monitor.evaluate(at(minute));
  }
  return snapshot;
};

describe("gateway memory attribution", () => {
  it("attributes stepwise child accumulation without a heap-retention claim", () => {
    const snapshot = drive(createMemoryAttribution(), {
      proc: (minute) => ({ groupRssBytes: mb(400 + 2 * minute), childRssBytes: mb(100 + 2 * minute), childCount: 3 + Math.floor(minute / 15) }),
    });
    expect(snapshot.state).toBe("attributed");
    expect(snapshot.causes).toEqual(["child_accumulation"]);
    expect(snapshot.childGrowthMb).toBeGreaterThan(48);
  });

  it("separates growing children at a fixed count from accumulating children", () => {
    const snapshot = drive(createMemoryAttribution(), {
      proc: (minute) => ({ groupRssBytes: mb(400 + 2 * minute), childRssBytes: mb(100 + 2 * minute) }),
    });
    expect(snapshot.causes).toEqual(["child_growth"]);
  });

  it("can attribute measured child growth when gateway telemetry is unavailable", () => {
    const snapshot = drive(createMemoryAttribution(), {
      proc: (minute) => ({ groupRssBytes: mb(400 + 2 * minute), childRssBytes: mb(100 + 2 * minute) }),
      telem: () => ({ status: "unavailable", records: [] }),
    });
    expect(snapshot.causes).toEqual(["child_growth"]);
  });

  it("recognizes sparse genuine major-GC floor growth at 0, 25 and 50 minutes", () => {
    const snapshot = drive(createMemoryAttribution(), {
      record: (minute) => ({
        rssBytes: mb(300 + 3 * minute), heapUsedBytes: mb(150 + 3 * minute),
        gc: minute % 25 === 0 ? { atMs: at(minute), heapUsedBytes: mb(100 + 3 * minute), count: 1 } : null,
      }),
    });
    expect(snapshot.causes).toEqual(["possible_heap_retention"]);
    expect(snapshot.coverage.gcCount).toBe(3);
  });

  it("requires growth relative to the actual diagnostic heap limit", () => {
    const snapshot = drive(createMemoryAttribution(), {
      record: (minute) => ({
        heapLimitBytes: mb(8192), heapUsedBytes: mb(150 + 3 * minute),
        gc: minute % 25 === 0 ? { atMs: at(minute), heapUsedBytes: mb(100 + 3 * minute), count: 1 } : null,
      }),
    });
    expect(snapshot.causes).not.toContain("possible_heap_retention");
  });

  it("keeps a low GC observation from the skipped half-minute publication", () => {
    const snapshot = drive(createMemoryAttribution(), {
      record: (minute) => ({
        heapUsedBytes: mb(150 + 4 * minute),
        gc: minute === 45.5 ? { atMs: at(minute), heapUsedBytes: mb(90), count: 1 }
          : minute % 25 === 0 ? { atMs: at(minute), heapUsedBytes: mb(100 + 4 * minute), count: 1 } : null,
      }),
    });
    expect(snapshot.causes).not.toContain("possible_heap_retention");
    expect(snapshot.coverage.gcCount).toBe(4);
  });

  it("buckets observations by original GC time across a publication boundary", () => {
    const snapshot = drive(createMemoryAttribution(), {
      record: (minute) => ({
        gc: minute === 10 ? { atMs: at(10) - 1000, heapUsedBytes: mb(50), count: 1 }
          : minute % 25 === 0 ? { atMs: at(minute), heapUsedBytes: mb(60 + minute * 3), count: 1 } : null,
      }),
    });
    expect(snapshot.coverage.gcCount).toBe(3);
    expect(snapshot.causes).not.toContain("possible_heap_retention");
    expect(snapshot.reason).toBe("insufficient_gc");
  });

  it("deduplicates a carried-forward GC observation", () => {
    const snapshot = drive(createMemoryAttribution(), {
      record: () => ({ gc: { atMs: at(0), heapUsedBytes: mb(60), count: 1 } }),
    });
    expect(snapshot.coverage.gcCount).toBe(1);
    expect(snapshot.reason).toBe("insufficient_gc");
  });

  it("reports measured external growth with stable heap separately", () => {
    const snapshot = drive(createMemoryAttribution(), {
      record: (minute) => ({ rssBytes: mb(300 + 3 * minute), externalBytes: mb(20 + 3 * minute), arrayBuffersBytes: mb(10 + 3 * minute) }),
    });
    expect(snapshot.causes).toEqual(["external_growth"]);
    expect(snapshot.externalGrowthMb).toBe(150);
  });

  it("retains simultaneous child, heap and external evidence as mixed", () => {
    const snapshot = drive(createMemoryAttribution(), {
      proc: (minute) => ({ groupRssBytes: mb(400 + 6 * minute), childRssBytes: mb(100 + 2 * minute) }),
      record: (minute) => ({
        rssBytes: mb(300 + 4 * minute), heapUsedBytes: mb(150 + 3 * minute), externalBytes: mb(20 + 3 * minute),
        gc: minute % 25 === 0 ? { atMs: at(minute), heapUsedBytes: mb(100 + 3 * minute), count: 1 } : null,
      }),
    });
    expect(snapshot.causes).toEqual(["child_growth", "possible_heap_retention", "external_growth", "mixed"]);
  });

  it("calls jointly covered RSS growth unexplained without diagnosing native allocations", () => {
    const snapshot = drive(createMemoryAttribution(), {
      record: (minute) => ({ rssBytes: mb(300 + 3 * minute) }),
    });
    expect(snapshot.causes).toEqual(["unexplained_process_growth"]);
  });

  it("does not infer an absent heap/external cause from independently incomplete windows", () => {
    const snapshot = drive(createMemoryAttribution(), {
      record: (minute) => ({ rssBytes: mb(300 + 3 * minute), heapUsedBytes: minute > 20 && minute < 40 ? null : mb(80) }),
    });
    expect(snapshot.causes).not.toContain("unexplained_process_growth");
    expect(snapshot.reason).toBe("sample_gap");
  });

  it("repeated polls cannot confirm a cause without new observations", () => {
    const monitor = createMemoryAttribution();
    const proc = (minute) => ({ groupRssBytes: mb(400 + 2 * minute), childRssBytes: mb(100 + 2 * minute) });
    const initial = drive(monitor, { end: 51, proc });
    expect(initial.state).toBe("observing");
    for (let i = 0; i < 5; i += 1) {
      monitor.addSample({ process: processAt(51, proc(51)), telemetry: telemetryAt(51) });
      expect(monitor.evaluate(at(51)).state).toBe("observing");
    }
    monitor.addSample({ process: processAt(52, proc(52)), telemetry: telemetryAt(52) });
    expect(monitor.evaluate(at(52)).state).toBe("attributed");
  });

  it("labels stale, partial and irregular process samples unknown", () => {
    const monitor = createMemoryAttribution();
    drive(monitor);
    expect(monitor.evaluate(at(63)).reason).toBe("stale_process");
    monitor.addSample({ process: processAt(64, { status: "partial" }), telemetry: telemetryAt(64) });
    expect(monitor.evaluate(at(64)).reason).toBe("partial_process");
    monitor.addSample({ process: processAt(65), telemetry: telemetryAt(65) });
    expect(monitor.evaluate(at(65)).reason).toBe("sample_gap");
  });

  it("clears only attribution history on a changed serving-worker identity", () => {
    const monitor = createMemoryAttribution();
    drive(monitor, { record: (minute) => ({ externalBytes: mb(20 + 3 * minute) }) });
    monitor.addSample({ process: processAt(61, { worker: { pid: 101, startTicks: "3" } }), telemetry: { status: "unavailable" } });
    const result = monitor.evaluate(at(61));
    expect(result.causes).toEqual([]);
    expect(result.coverage.sampleCount).toBe(0);
  });

  it("identifies a qualifying excursion that receded without asserting workload ownership", () => {
    const snapshot = drive(createMemoryAttribution(), {
      proc: (minute) => ({ groupRssBytes: mb(minute < 25 ? 200 + 6 * minute : minute < 31 ? 350 : 220) }),
    });
    expect(snapshot.state).toBe("transient");
    expect(snapshot.causes).toEqual([]);
  });

  it("holds unknown when a short sawtooth has no sustained growth", () => {
    const snapshot = drive(createMemoryAttribution(), {
      record: (minute) => ({ heapUsedBytes: mb(80 + 30 * (minute % 5) / 5) }),
    });
    expect(snapshot.causes).toEqual([]);
    expect(snapshot.reason).toBe("no_sustained_growth");
  });
});

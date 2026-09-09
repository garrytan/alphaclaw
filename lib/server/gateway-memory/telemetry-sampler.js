const fs = require("node:fs");
const { getHeapStatistics } = require("node:v8");
const { performance, PerformanceObserver, constants } = require("node:perf_hooks");
const { getProcessIdentity, getLinuxBootId } = require("./process-identity");
const { createTelemetryWriter } = require("./telemetry-writer");
const { kTelemetryVersion, kMaxTelemetryRecords, kTelemetryIntervalMs } = require("./telemetry-protocol");

// PerformanceObserver delivery is asynchronous. This is a sample following an
// observed natural major GC, not V8's exact heap size when that GC ended.
const createMajorGcAccumulator = ({
  now = Date.now,
  performanceImpl = performance,
  readHeap = getHeapStatistics,
} = {}) => {
  let pending = null;
  return {
    observe(entries) {
      try {
        let latest = null;
        let count = 0;
        for (const entry of entries) {
          if (entry.detail?.kind !== constants.NODE_PERFORMANCE_GC_MAJOR ||
              (entry.detail?.flags & constants.NODE_PERFORMANCE_GC_FLAGS_FORCED)) continue;
          const ended = entry.startTime + entry.duration;
          if (!Number.isFinite(ended)) continue;
          const delay = performanceImpl.now() - ended;
          if (delay < 0 || delay > 1000) continue;
          if (!latest || ended > latest.ended) latest = { ended };
          count += 1;
        }
        if (!latest) return;
        const heapUsedBytes = readHeap().used_heap_size;
        const atMs = Math.min(now(), Math.round(performanceImpl.timeOrigin + latest.ended));
        if (!Number.isSafeInteger(heapUsedBytes) || heapUsedBytes < 0 || !Number.isSafeInteger(atMs)) return;
        const totalCount = (pending?.count || 0) + count;
        if (!pending || heapUsedBytes < pending.heapUsedBytes) {
          pending = { atMs, heapUsedBytes, count: totalCount };
        } else {
          pending.count = totalCount;
        }
      } catch {}
    },
    take() {
      const value = pending;
      pending = null;
      return value;
    },
  };
};

const startGatewayMemorySampler = ({
  stateDir,
  processImpl = process,
  now = Date.now,
  readIdentity = getProcessIdentity,
  readBootId = getLinuxBootId,
  readHeap = getHeapStatistics,
  Observer = PerformanceObserver,
  performanceImpl = performance,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  writerFactory = createTelemetryWriter,
  unlink = fs.unlinkSync,
} = {}) => {
  const identity = readIdentity(processImpl.pid);
  const bootId = readBootId();
  if (!identity || !bootId || !stateDir) return null;
  const writer = writerFactory({ stateDir, identity, now });
  const gc = createMajorGcAccumulator({ now, performanceImpl, readHeap });
  let observer = null;
  let timer = null;
  let stopped = false;
  let records = [];
  let sequence = 0;
  const sample = () => {
    if (stopped) return;
    try {
      const atMs = Math.floor(now());
      // A wall-clock rollback cannot mint out-of-order records or duplicate
      // timestamps; preserve GC evidence until the clock catches up.
      if (records.length && atMs <= records.at(-1).atMs) return;
      const usage = processImpl.memoryUsage();
      const heap = readHeap();
      const observedGc = gc.take();
      // A wall-clock correction can put an otherwise timely GC outside this
      // publication interval. Drop only that observation; retaining it would
      // make the reader reject the whole history until the record aged out.
      const gcInInterval = observedGc && observedGc.atMs >= 0 &&
        observedGc.atMs <= atMs &&
        (!records.length || observedGc.atMs >= records.at(-1).atMs - 1000);
      const record = {
        seq: ++sequence, atMs,
        rssBytes: usage.rss, heapUsedBytes: usage.heapUsed,
        heapTotalBytes: usage.heapTotal, heapLimitBytes: heap.heap_size_limit,
        externalBytes: usage.external, arrayBuffersBytes: usage.arrayBuffers,
        gc: gcInInterval ? observedGc : null,
      };
      records.push(record);
      if (records.length > kMaxTelemetryRecords) records = records.slice(-kMaxTelemetryRecords);
      // Records are retained even when publishing misses: the next successful
      // write delivers the original timestamps/GC intervals to the watchdog.
      void writer.write({ version: kTelemetryVersion, ...identity, bootId, records })
        .catch(() => {});
    } catch {}
  };
  const cleanup = () => {
    stop();
    if (writer.target) {
      try { unlink(writer.target); } catch {}
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearIntervalImpl(timer);
    try { observer?.disconnect(); } catch {}
    processImpl.removeListener?.("exit", cleanup);
    writer.stop();
  };
  try {
    if (Observer.supportedEntryTypes?.includes("gc")) {
      observer = new Observer((list) => {
        try { gc.observe(list.getEntries()); } catch {}
      });
      observer.observe({ entryTypes: ["gc"] });
    }
  } catch {
    try { observer?.disconnect(); } catch {}
    observer = null;
  }
  sample();
  timer = setIntervalImpl(sample, kTelemetryIntervalMs);
  timer.unref?.();
  processImpl.once?.("exit", cleanup);
  return { stop, sample, flush: () => writer.flush(), getRecords: () => structuredClone(records) };
};

module.exports = { startGatewayMemorySampler, createMajorGcAccumulator };

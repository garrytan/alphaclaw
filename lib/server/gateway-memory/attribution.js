// Advisory attribution only. No measurement or conclusion in this module
// participates in pressure budgets, episode recovery, or restart admission.
const { fitSlope, bucketMinima, kDefaultMonitorConfig } = require("../gateway-memory-monitor");
const kMb = 1024 * 1024;
const kCauses = Object.freeze([
  "child_growth", "child_accumulation", "possible_heap_retention",
  "external_growth", "unexplained_process_growth", "mixed",
]);
const finiteBytes = (value) => Number.isFinite(value) && value >= 0;
const rising = (values) => values.every((value, i) => i === 0 || value > values[i - 1]);
const toMb = (value) => Number.isFinite(value) ? Math.round(value / kMb * 10) / 10 : null;
const identityKey = (process) => [
  process?.root?.pid, process?.root?.startTicks,
  process?.worker?.pid, process?.worker?.startTicks,
].map((value) => value ?? "none").join(":");

const createMemoryAttribution = ({ config = {} } = {}) => {
  const cfg = { ...kDefaultMonitorConfig, maxSamples: 128, maxGapMs: 90_000, ...config };
  let processSamples = [];
  let telemetrySamples = [];
  let identity = null;
  let lastSequence = -1;
  let processStatus = "unavailable";
  let telemetryStatus = "unavailable";
  let processPending = false;
  let telemetryPending = false;
  let confirmations = new Map();
  let recoveringStreak = 0;
  let snapshot = null;

  const reset = () => {
    processSamples = [];
    telemetrySamples = [];
    identity = null;
    lastSequence = -1;
    processStatus = "unavailable";
    telemetryStatus = "unavailable";
    processPending = false;
    telemetryPending = false;
    confirmations = new Map();
    recoveringStreak = 0;
    snapshot = null;
  };
  const addSample = ({ process, telemetry } = {}) => {
    const nextIdentity = process?.root ? identityKey(process) : null;
    if (identity !== null && nextIdentity !== null && nextIdentity !== identity) reset();
    if (nextIdentity !== null) identity = nextIdentity;
    processStatus = process?.status ?? "unavailable";
    telemetryStatus = telemetry?.status ?? "unavailable";
    const lastProcess = processSamples[processSamples.length - 1];
    if (processStatus === "fresh" && Number.isFinite(process?.atMs) &&
      finiteBytes(process?.groupRssBytes) && (!lastProcess || process.atMs > lastProcess.atMs)) {
      processSamples.push({
        atMs: process.atMs,
        groupRssBytes: process.groupRssBytes,
        childRssBytes: process.childRssBytes,
        childCount: process.childCount,
      });
      processSamples = processSamples.slice(-cfg.maxSamples);
      processPending = true;
    }
    if (telemetryStatus !== "fresh" || !Array.isArray(telemetry?.records)) return;
    for (const record of telemetry.records.slice(-cfg.maxSamples)) {
      if (!Number.isSafeInteger(record?.seq) || record.seq <= lastSequence ||
        !Number.isFinite(record.atMs) || record.atMs > telemetry.atMs) continue;
      const last = telemetrySamples[telemetrySamples.length - 1];
      if (last && record.atMs <= last.atMs) continue;
      const copy = {
        seq: record.seq, atMs: record.atMs,
        rssBytes: record.rssBytes, heapUsedBytes: record.heapUsedBytes,
        heapLimitBytes: record.heapLimitBytes, externalBytes: record.externalBytes,
        gc: record.gc && Number.isFinite(record.gc.atMs) && record.gc.atMs <= record.atMs &&
          finiteBytes(record.gc.heapUsedBytes) && Number.isSafeInteger(record.gc.count) && record.gc.count > 0
          ? { atMs: record.gc.atMs, heapUsedBytes: record.gc.heapUsedBytes } : null,
      };
      telemetrySamples.push(copy);
      lastSequence = copy.seq;
      telemetryPending = true;
    }
    telemetrySamples = telemetrySamples.slice(-cfg.maxSamples);
  };

  const analyze = (records, field, nowMs) => {
    const startMs = nowMs - cfg.windowMs;
    const samples = records.filter((record) => record.atMs >= startMs && record.atMs <= nowMs && finiteBytes(record[field]))
      .map((record) => ({ atMs: record.atMs, rssBytes: record[field] }));
    const spanMs = samples.length > 1 ? samples[samples.length - 1].atMs - samples[0].atMs : 0;
    const gap = samples.some((sample, i) => i > 0 && sample.atMs - samples[i - 1].atMs > cfg.maxGapMs);
    const fresh = samples.length > 0 && nowMs - samples[samples.length - 1].atMs <= cfg.maxSampleAgeMs;
    const minima = bucketMinima(samples, startMs, cfg.windowMs, cfg.bucketCount);
    const covered = fresh && !gap && samples.length >= cfg.minSamples &&
      spanMs >= cfg.windowMs * cfg.minCoverageFraction && minima !== null;
    const growth = minima ? minima[minima.length - 1] - minima[0] : null;
    const slope = fitSlope(samples);
    return {
      samples, spanMs, gap, fresh, minima, covered, growth, slope,
      growing: covered && rising(minima) && growth >= cfg.minGrowthMb * kMb && slope > 0,
    };
  };

  const evaluate = (nowMs) => {
    const group = analyze(processSamples, "groupRssBytes", nowMs);
    const child = analyze(processSamples, "childRssBytes", nowMs);
    const counts = analyze(processSamples, "childCount", nowMs);
    // Conclusions about unexplained RSS require the SAME observations to
    // carry all three measurements, not independently covered time ranges.
    const joint = telemetrySamples.filter((record) => finiteBytes(record.rssBytes) &&
      finiteBytes(record.heapUsedBytes) && finiteBytes(record.externalBytes) &&
      Number.isFinite(record.heapLimitBytes) && record.heapLimitBytes > 0);
    const main = analyze(joint, "rssBytes", nowMs);
    const external = analyze(joint, "externalBytes", nowMs);
    const heap = analyze(joint, "heapUsedBytes", nowMs);
    const telemetryCovered = telemetryStatus === "fresh" && main.covered && external.covered && heap.covered;
    const processCovered = processStatus === "fresh" && group.covered;

    // Observed GC minima keep their ORIGINAL event times, including a low
    // value published in an interval between the watchdog's minute reads.
    const gcByTime = new Map();
    for (const record of joint) {
      const gc = record.gc;
      if (!gc || gc.atMs < nowMs - cfg.windowMs || gc.atMs > nowMs) continue;
      const previous = gcByTime.get(gc.atMs);
      if (previous === undefined || gc.heapUsedBytes < previous) gcByTime.set(gc.atMs, gc.heapUsedBytes);
    }
    const gcBuckets = new Map();
    for (const [atMs, rssBytes] of gcByTime) {
      const index = Math.min(cfg.bucketCount - 1,
        Math.floor((atMs - (nowMs - cfg.windowMs)) / (cfg.windowMs / cfg.bucketCount)));
      const previous = gcBuckets.get(index);
      if (!previous || rssBytes < previous.rssBytes) gcBuckets.set(index, { atMs, rssBytes });
    }
    const gcSamples = [...gcBuckets.values()].sort((a, b) => a.atMs - b.atMs);
    const gcSpan = gcSamples.length > 1 ? gcSamples[gcSamples.length - 1].atMs - gcSamples[0].atMs : 0;
    const gcGrowth = gcSamples.length > 1 ? gcSamples[gcSamples.length - 1].rssBytes - gcSamples[0].rssBytes : null;
    const heapLimit = joint[joint.length - 1]?.heapLimitBytes ?? null;
    const gcCovered = gcSamples.length >= 3 && gcSpan >= cfg.windowMs * cfg.minCoverageFraction;
    const retainedHeap = telemetryCovered && gcCovered && rising(gcSamples.map((sample) => sample.rssBytes)) &&
      fitSlope(gcSamples) > 0 && gcGrowth >= Math.max(cfg.minGrowthMb * kMb, heapLimit * cfg.minGrowthCapFraction);

    const candidates = [];
    if (processCovered && child.growing) {
      const accumulating = counts.covered && counts.minima.every((value, i) => i === 0 || value >= counts.minima[i - 1]) &&
        counts.minima[counts.minima.length - 1] > counts.minima[0] && counts.slope > 0;
      candidates.push(accumulating ? "child_accumulation" : "child_growth");
    }
    if (retainedHeap) candidates.push("possible_heap_retention");
    if (telemetryCovered && external.growing) candidates.push("external_growth");
    if (telemetryCovered && main.growing && !retainedHeap && !external.growing &&
      !heap.growing && gcCovered) candidates.push("unexplained_process_growth");

    for (const cause of kCauses) {
      const fresh = cause.startsWith("child_") ? processPending : telemetryPending;
      if (!candidates.includes(cause)) confirmations.delete(cause);
      else if (fresh) confirmations.set(cause, (confirmations.get(cause) ?? 0) + 1);
    }
    const causes = candidates.filter((cause) => (confirmations.get(cause) ?? 0) >= cfg.confirmEvals);
    if (causes.length > 1) causes.push("mixed");

    const groupValues = group.samples.map((sample) => sample.rssBytes);
    const peak = groupValues.length ? Math.max(...groupValues) : null;
    const recovered = processCovered && !group.growing && peak !== null &&
      peak - groupValues[0] >= cfg.minGrowthMb * kMb &&
      groupValues[groupValues.length - 1] <= peak * (1 - cfg.peakDropFraction) && group.slope <= 0;
    if (!recovered) recoveringStreak = 0;
    else if (processPending) recoveringStreak += 1;

    let state = "unknown";
    let reason = "insufficient_samples";
    if (causes.length) {
      state = "attributed";
      reason = null;
    } else if (candidates.length) {
      state = "observing";
      reason = "growth_confirming";
    } else if (recoveringStreak >= cfg.clearEvals) {
      state = "transient";
      reason = null;
    } else if (processStatus !== "fresh") {
      reason = processStatus === "partial" ? "partial_process" : "missing_process";
    } else if (!group.fresh) {
      reason = "stale_process";
    } else if (group.gap || (telemetryStatus === "fresh" && main.gap)) {
      reason = "sample_gap";
    } else if (processCovered && telemetryStatus !== "fresh") {
      reason = telemetryStatus === "stale" ? "stale_telemetry" : "missing_telemetry";
    } else if (processCovered && !main.fresh) {
      reason = "stale_telemetry";
    } else if (processCovered && telemetryCovered && !gcCovered) {
      reason = "insufficient_gc";
    } else if (processCovered && telemetryCovered) {
      state = group.growing || main.growing || heap.growing ? "unknown" : "observing";
      reason = state === "unknown" ? "unattributed_growth" : "no_sustained_growth";
    }
    const sameVerdict = snapshot?.state === state && snapshot.causes.join(",") === causes.join(",");
    snapshot = {
      state, causes, reason,
      since: sameVerdict ? snapshot.since : new Date(nowMs).toISOString(),
      coverage: { sampleCount: main.samples.length, spanMs: main.spanMs, gcCount: gcSamples.length },
      childGrowthMb: toMb(child.growth), externalGrowthMb: toMb(external.growth),
      heapGrowthMb: toMb(gcGrowth), processGrowthMb: toMb(main.growth),
    };
    processPending = false;
    telemetryPending = false;
    return structuredClone(snapshot);
  };
  return { addSample, evaluate, reset };
};

module.exports = { createMemoryAttribution, kMemoryAttributionCauses: kCauses };

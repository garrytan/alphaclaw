// Gateway memory-leak trend detector (pure — no timers, no fs, no imports
// from the watchdog). The watchdog feeds one sample per tick and consumes
// the returned transitions; this module never emits events, notifications,
// or restarts itself (the deterministic watchdog is the only enforcement
// layer).
//
// Protection uses independently collected RSS and cgroup usage. The
// enforced series has a basis (ALPH-17): `worker` (the verified gateway
// worker's own RSS, what the heap + 192 MiB cap describes) or `group`
// (launcher + worker + every descendant, used only when the worker is not
// identified; the watchdog never restarts on a group-basis verdict). A basis
// change resets the series and re-warms: a mixed series reads the step
// between the two as growth. Container pressure counts toward a worker-basis
// verdict only while the worker dominates the group (≥ 50% of group RSS,
// from a complete census) and is itself growing (fitted slope ≥ 64 MB/h, so
// per-tick jitter on a flat worker does not count), so a tool child filling
// the container cannot make the gateway look like it is leaking.
//
// Critical (ALPH-22) needs all three gates on a worker-basis series, held
// for criticalConfirmEvals consecutive fresh evaluations:
//   slope  the fitted worker RSS slope over the window is positive;
//   floor  the worker's memory is at ≥ 90% of the cap (its private memory,
//          USS, when the PSS read is fresh, else its RSS), or the V8 heap is
//          at ≥ 70% of its limit;
//   heap   when heap telemetry is fresh: heap used ≥ 70% of the limit, or
//          post-GC heap floors are rising, or the worker itself has the
//          container near OOM. Stale or missing telemetry leaves this gate
//          open, so a missing writer can never hide a leak.
// A group-basis series (worker not verified) can latch a warning, labelled
// as the process group with its tool children, but never goes critical.
// Heap telemetry is gateway-reported (same UID): it can veto a critical the
// independent RSS measurements would reach and name the heap as the floor,
// but it never sets the memory cap, and every critical still needs the
// independently sampled worker slope.
//
//   State machine (per evaluate(); "eval" = one watchdog memory tick):
//
//     warming_up ──grace elapsed──▶ insufficient_samples ──coverage──▶ normal
//                                                                        │
//        bucket minima strictly rising + growth ≥ max(48MB, 5% cap)      ▼
//     normal ◀──minima flat (disarm)────────────────────────────────── watch
//                                                                        │
//        watch held 2 evals AND (projection ≤ 12h OR rss ≥ 75% cap;      ▼
//        capless: slope ≥ 64MB/h) ──────────────────────────▶ leak_suspected
//                                                                        │
//        critical gates hold for 3 consecutive evals ─────────────▶ critical
//        FAST PATH: critical gates hold AND rss rising, 3 consecutive
//        evals post-grace ────────────────────────────────────────▶ critical
//
//     de-latch (leak_suspected/critical → normal): slope ≤ 0 for 3 evals
//     OR rss ≤ 90% of episode peak → "cleared" transition + frozen summary.
//     pid change: full reset EXCEPT lastEpisodeSummary (frozen, reason
//     "process_exited") — a post-crash incident must see the leak that
//     killed the predecessor, not the replacement's warm-up.
//
// The memory budget is re-read every evaluation (ALPH-22):
//   operator budget (watchdog.memory.budgetMb), when set; else
//   min(container memory limit, host MemTotal) × memoryShareFraction (0.75):
//   the share of the memory it can see that the gateway worker may use,
//   leaving the rest for its tool children, AlphaClaw and the kernel.
// The heap signal has its own cap, the actual V8 heap limit from telemetry.
// Configured heap + 192 MiB is only the worker's expected size, an
// informational "above expected size" line; it decides nothing. The operator
// budget (issue #56) exists for a DIAGNOSED fast leak and may sit below the
// derived share. Never clamped up: a cap at/below current memory IS maximal
// pressure (pressure = 1.0), not an excuse to invent headroom.
const kMb = 1024 * 1024;
const { projectMemoryEvidence } = require("./gateway-memory/evidence");
const { createContainerMemoryMonitor } = require("./gateway-memory/container-monitor");

// The episode-id shape this module mints (`${pid}-${latchAtMs}`). Consumers
// that validate ids (doctor cards, overseer trusted projection) import THIS
// pattern so a format change here cannot silently break their gates.
const kEpisodeIdPattern = /^\d+-\d+$/;

const kMemoryTrendStates = Object.freeze([
  "disabled",
  "no_gateway",
  "warming_up",
  "insufficient_samples",
  "normal",
  "watch",
  "leak_suspected",
  "critical",
]);

// Defaults are module constants (not operator knobs in v1); every one is
// overridable through createGatewayMemoryMonitor({config}) as the test seam.
const kDefaultMonitorConfig = Object.freeze({
  windowMs: 60 * 60 * 1000,
  bucketCount: 6,
  minSamples: 24,
  minCoverageFraction: 0.8,
  minGrowthMb: 48,
  minGrowthCapFraction: 0.05,
  projectionHorizonMs: 12 * 60 * 60 * 1000,
  pressureFraction: 0.75,
  criticalFraction: 0.9,
  confirmEvals: 2,
  clearEvals: 3,
  peakDropFraction: 0.1,
  startupGraceMs: 10 * 60 * 1000,
  maxSamples: 120,
  maxConsecutiveMisses: 5,
  caplessSlopeMbPerHour: 64,
  gatewayNativeOverheadMb: 192,
  fastPathConfirmEvals: 3,
  criticalConfirmEvals: 3,
  heapNearFraction: 0.7,
  heapRestartFraction: 0.85,
  maxSampleAgeMs: 90_000,
  workerDominanceFraction: 0.5,
  containerWorkerSlopeMbPerHour: 64,
  memoryShareFraction: 0.75,
});

const round1 = (value) =>
  Number.isFinite(value) ? Math.round(value * 10) / 10 : null;

const toMb = (bytes) =>
  Number.isFinite(bytes) ? Math.round(bytes / kMb) : null;

// Least-squares slope over {atMs, rssBytes} samples, in bytes/ms. Null when
// the window has no time span (a zero denominator is not a trend).
const fitSlope = (samples) => {
  const n = samples.length;
  if (n < 2) return null;
  let sumX = 0;
  let sumY = 0;
  for (const s of samples) {
    sumX += s.atMs;
    sumY += s.rssBytes;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;
  let num = 0;
  let den = 0;
  for (const s of samples) {
    const dx = s.atMs - meanX;
    num += dx * (s.rssBytes - meanY);
    den += dx * dx;
  }
  if (den <= 0) return null;
  return num / den;
};

// Per-bucket minima across the trailing window. Returns null when any bucket
// is empty — the rising-minima test needs a floor in every bucket.
const bucketMinima = (samples, windowStartMs, windowMs, bucketCount) => {
  const minima = new Array(bucketCount).fill(null);
  const bucketSpan = windowMs / bucketCount;
  for (const s of samples) {
    let idx = Math.floor((s.atMs - windowStartMs) / bucketSpan);
    if (idx < 0) continue;
    if (idx >= bucketCount) idx = bucketCount - 1;
    if (minima[idx] === null || s.rssBytes < minima[idx]) {
      minima[idx] = s.rssBytes;
    }
  }
  return minima.every((m) => m !== null) ? minima : null;
};

const minimaStrictlyRising = (minima) => {
  for (let i = 1; i < minima.length; i += 1) {
    if (minima[i] <= minima[i - 1]) return false;
  }
  return true;
};

// The memory budget: the operator's, else a share of what the gateway can
// actually use, min(container limit, host MemTotal) × shareFraction.
const positive = (value) => Number.isFinite(value) && value > 0 ? value : null;
const computeEffectiveCap = ({
  budgetBytes = null,
  containerLimitBytes = null,
  hostTotalBytes = null,
  shareFraction = kDefaultMonitorConfig.memoryShareFraction,
} = {}) => {
  if (positive(budgetBytes) !== null) {
    return { capBytes: budgetBytes, capSource: "budget", capPhysicalBytes: null };
  }
  const container = positive(containerLimitBytes);
  const host = positive(hostTotalBytes);
  if (container === null && host === null) return { capBytes: null, capSource: "none", capPhysicalBytes: null };
  const fromContainer = container !== null && (host === null || container <= host);
  const physical = fromContainer ? container : host;
  return { capBytes: Math.floor(physical * shareFraction),
    capSource: fromContainer ? "container_share" : "host_share", capPhysicalBytes: physical };
};

// Configured heap + native overhead: the size the worker is expected to
// stay under. Informational only.
const expectedSizeBytes = (activeHeapMb, overheadMb) =>
  Number.isFinite(activeHeapMb) && activeHeapMb > 0 ? (activeHeapMb + overheadMb) * kMb : null;

// Heap telemetry as the verdict reads it: fresh only when the reader said so
// and the numbers are coherent. floorsRising is the attribution's confirmed
// post-GC floor growth (possible_heap_retention).
const normalizeHeap = (heap) => {
  if (!heap || typeof heap !== "object") return null;
  const usedBytes = Number.isFinite(heap.usedBytes) && heap.usedBytes >= 0 ? heap.usedBytes : null;
  const limitBytes = Number.isFinite(heap.limitBytes) && heap.limitBytes > 0 ? heap.limitBytes : null;
  return {
    status: heap.status === "fresh" && usedBytes !== null && limitBytes !== null ? "fresh"
      : typeof heap.status === "string" ? heap.status : "unavailable",
    atMs: Number.isFinite(heap.atMs) ? heap.atMs : null,
    usedBytes,
    limitBytes,
    floorsRising: heap.floorsRising === true,
  };
};

const projectExhaustion = ({ rssBytes, capBytes, slopeBytesPerMs, nowMs }) => {
  if (
    !Number.isFinite(capBytes) ||
    !Number.isFinite(slopeBytesPerMs) ||
    slopeBytesPerMs <= 0
  ) {
    return null;
  }
  const remaining = capBytes - rssBytes;
  if (remaining <= 0) return nowMs;
  return nowMs + remaining / slopeBytesPerMs;
};

// Idle snapshots for the two states only the watchdog can know (settings off,
// no gateway pid) — kept here so the enum has one owner.
const buildIdleMemoryTrendSnapshot = (state) => ({
  state: state === "disabled" ? "disabled" : "no_gateway",
  rssMb: null,
  slopeMbPerHour: null,
  effectiveCapMb: null,
  capSource: "none",
  pressureFraction: null,
  groupPressureFraction: null,
  containerPressureFraction: null,
  pressureSource: "none",
  projectedBudgetCrossingAt: null,
  projectedExhaustionAt: null,
  sampledAt: null,
  sampleStatus: "unavailable",
  evidence: null,
  episodeId: null,
  episodeStartedAt: null,
  peakRssMb: null,
  criticalEvalStreak: 0,
  sampleCount: 0,
  requiredSamples: kDefaultMonitorConfig.minSamples,
  evaluatedAt: null,
  lastEpisodeSummary: null,
});

const createGatewayMemoryMonitor = ({ config = {} } = {}) => {
  const cfg = { ...kDefaultMonitorConfig, ...config };
  let samples = []; // {atMs, rssBytes}
  let currentPid = null;
  let currentIdentityToken = null;
  let currentBasis = null;
  let sampleStatus = "unavailable";
  let lastCgroupAtMs = null;
  let firstSampleAtMs = null;
  let consecutiveMisses = 0;
  let watchStreak = 0;
  let fastPathStreak = 0;
  let nonPositiveSlopeStreak = 0;
  let criticalEvalStreak = 0;
  let episode = null; // {episodeId, pid, startedAtMs, peakRssBytes, peakSlope, mitigationCount, critical}
  let lastEpisodeSummary = null;
  let lastSample = null; // last accepted sample incl. cap inputs
  // The cap inputs of the newest accepted sample, the ones evaluate() uses,
  // kept across a process reset until the next sample: previewCap answers
  // "what cap would the next evaluation use".
  let lastCapInputs = { containerLimitBytes: null, hostTotalBytes: null };
  let previousEvalRssBytes = null;
  let lastSnapshot = null;
  // No fresh evidence, no state change: an evaluate() without a new real
  // sample since the previous one must never advance arming/clearing streaks
  // off stale data (a read-miss tick would otherwise confirm itself).
  let freshSampleSinceEval = false;

  const freezeEpisode = (reason, endedAtMs) => {
    if (!episode) return;
    lastEpisodeSummary = {
      episodeId: episode.episodeId,
      pid: episode.pid,
      peakRssMb: toMb(episode.peakRssBytes),
      rssBasis: episode.rssBasis ?? null,
      slopeMbPerHour: round1(episode.lastSlopeMbPerHour),
      endedAt: new Date(endedAtMs).toISOString(),
      reason,
      mitigationCount: episode.mitigationCount,
      effectiveCapMb: episode.effectiveCapMb,
      capSource: episode.capSource,
      capPhysicalMb: episode.capPhysicalMb ?? null,
      pressureSource: episode.pressureSource,
      trigger: episode.trigger,
      groupPressureFraction: episode.groupPressureFraction,
      containerPressureFraction: episode.containerPressureFraction,
      projectedBudgetCrossingAt: episode.projectedBudgetCrossingAt,
      evidence: projectMemoryEvidence(episode.evidence),
    };
    episode = null;
  };

  const resetForNewProcess = (pid, atMs, identityToken, reason = "process_exited") => {
    if (episode) freezeEpisode(reason, atMs);
    samples = [];
    currentPid = pid;
    currentIdentityToken = identityToken;
    currentBasis = null;
    lastCgroupAtMs = null;
    lastSample = null;
    lastSnapshot = null;
    freshSampleSinceEval = false;
    firstSampleAtMs = null;
    consecutiveMisses = 0;
    watchStreak = 0;
    fastPathStreak = 0;
    nonPositiveSlopeStreak = 0;
    criticalEvalStreak = 0;
    previousEvalRssBytes = null;
  };

  // One sample per watchdog tick. A null rssBytes is a MISS (proc died or
  // read failed): never arms anything, and enough consecutive misses clear
  // the pending watch arm so a flapping reader can't confirm itself.
  const addSample = ({
    atMs,
    pid = null,
    rssBytes = null,
    cgroupUsedBytes = null,
    containerLimitBytes = null,
    activeHeapMb = null,
    budgetBytes = null,
    hostTotalBytes = null,
    identityToken = null,
    evidence = null,
    sampleStatus: inputStatus = "fresh",
    cgroupAtMs = atMs,
    rssBasis = "group",
    groupRssBytes = null,
    workerPrivateBytes = null,
    heap = null,
  } = {}) => {
    const usable = inputStatus === "fresh" && Number.isFinite(rssBytes) && rssBytes > 0;
    const basisChanged = usable && currentBasis !== null && rssBasis !== currentBasis;
    if (pid !== null && (pid !== currentPid || basisChanged ||
      (identityToken !== null && currentIdentityToken !== null && identityToken !== currentIdentityToken))) {
      resetForNewProcess(pid, atMs, identityToken,
        pid === currentPid && basisChanged ? "basis_changed" : "process_exited");
    }
    if (identityToken !== null) currentIdentityToken = identityToken;
    if (usable) currentBasis = rssBasis;
    if (inputStatus !== "fresh" || !Number.isFinite(atMs) ||
      !Number.isFinite(rssBytes) || rssBytes <= 0 ||
      (lastSample && atMs <= lastSample.atMs)) {
      sampleStatus = inputStatus === "partial" ? "partial" :
        lastSample && atMs <= lastSample.atMs ? "stale" : "unavailable";
      consecutiveMisses += 1;
      if (consecutiveMisses >= cfg.maxConsecutiveMisses) {
        watchStreak = 0;
        fastPathStreak = 0;
        // The critical confirmation is a CONSECUTIVE-evidence gate: two
        // critical evals separated by a long read-miss gap are not
        // consecutive confirmation, and must not satisfy the restart gate
        // the moment reads recover.
        criticalEvalStreak = 0;
      }
      return;
    }
    consecutiveMisses = 0;
    sampleStatus = "fresh";
    const freshCgroup = Number.isFinite(cgroupAtMs) &&
      Number.isFinite(cgroupUsedBytes) && cgroupUsedBytes >= 0 &&
      Number.isFinite(containerLimitBytes) && containerLimitBytes > 0 &&
      (lastCgroupAtMs === null || cgroupAtMs > lastCgroupAtMs);
    if (freshCgroup) lastCgroupAtMs = cgroupAtMs;
    if (firstSampleAtMs === null) firstSampleAtMs = atMs;
    samples.push({ atMs, rssBytes });
    if (samples.length > cfg.maxSamples) {
      samples = samples.slice(samples.length - cfg.maxSamples);
    }
    lastSample = {
      atMs,
      rssBytes,
      rssBasis,
      groupRssBytes: Number.isFinite(groupRssBytes) && groupRssBytes > 0 ? groupRssBytes : null,
      workerPrivateBytes: rssBasis === "worker" && Number.isFinite(workerPrivateBytes) && workerPrivateBytes > 0
        ? workerPrivateBytes : null,
      heap: normalizeHeap(heap),
      cgroupUsedBytes,
      containerLimitBytes,
      activeHeapMb,
      budgetBytes,
      hostTotalBytes,
      cgroupAtMs,
      freshCgroup,
      evidence: projectMemoryEvidence(evidence),
    };
    lastCapInputs = { containerLimitBytes: positive(containerLimitBytes), hostTotalBytes: positive(hostTotalBytes) };
    freshSampleSinceEval = true;
  };

  // The cap the next evaluation would use for this budget, from the newest
  // physical limits seen. Never clamped: an operator budget above the derived
  // share is the cap.
  const previewCap = (budgetBytes = null) => {
    const { capBytes, capSource, capPhysicalBytes } = computeEffectiveCap({
      budgetBytes, ...lastCapInputs, shareFraction: cfg.memoryShareFraction,
    });
    return {
      effectiveCapMb: toMb(capBytes),
      capSource,
      capPhysicalMb: toMb(capPhysicalBytes),
      capFraction: capPhysicalBytes === null ? null : cfg.memoryShareFraction,
    };
  };

  const buildSnapshot = ({
    state,
    nowMs,
    rssBytes = null,
    slopeMbPerHour = null,
    capBytes = null,
    capSource = "none",
    capPhysicalBytes = null,
    expectedBytes = null,
    pressure = null,
    containerPressure = null,
    pressureSource = "none",
    projectedAtMs = null,
    heapProjectedAtMs = null,
    windowSampleCount = 0,
    memoryBytes = null,
    memoryMeasure = null,
    heapFraction = null,
    criticalGates = null,
    restartAuthority = null,
  }) => ({
    state,
    rssMb: toMb(rssBytes),
    rssBasis: lastSample?.rssBasis ?? null,
    groupRssMb: toMb(lastSample?.groupRssBytes),
    memoryMb: toMb(memoryBytes),
    memoryMeasure,
    heap: lastSample?.heap ? {
      status: lastSample.heap.status,
      usedMb: toMb(lastSample.heap.usedBytes),
      limitMb: toMb(lastSample.heap.limitBytes),
      fraction: heapFraction === null ? null : Math.round(heapFraction * 1000) / 1000,
      floorsRising: lastSample.heap.floorsRising,
    } : null,
    heapLimitCrossingAt: heapProjectedAtMs ? new Date(heapProjectedAtMs).toISOString() : null,
    criticalGates: criticalGates ? { ...criticalGates } : null,
    restartAuthority,
    slopeMbPerHour: round1(slopeMbPerHour),
    effectiveCapMb: toMb(capBytes),
    capSource,
    capPhysicalMb: toMb(capPhysicalBytes),
    capFraction: capPhysicalBytes === null ? null : cfg.memoryShareFraction,
    expectedSizeMb: toMb(expectedBytes),
    aboveExpectedSize: expectedBytes !== null && memoryBytes !== null && memoryBytes > expectedBytes,
    pressureSource,
    groupPressureFraction: pressure === null ? null : Math.round(pressure * 1000) / 1000,
    containerPressureFraction: containerPressure === null ? null : Math.round(containerPressure * 1000) / 1000,
    pressureFraction:
      pressure === null ? null : Math.round(pressure * 1000) / 1000,
    projectedExhaustionAt: projectedAtMs
      ? new Date(projectedAtMs).toISOString()
      : null,
    projectedBudgetCrossingAt: projectedAtMs ? new Date(projectedAtMs).toISOString() : null,
    sampledAt: lastSample ? new Date(lastSample.atMs).toISOString() : null,
    sampleStatus,
    evidence: projectMemoryEvidence(lastSample?.evidence),
    episodeId: episode ? episode.episodeId : null,
    episodeStartedAt: episode
      ? new Date(episode.startedAtMs).toISOString()
      : null,
    peakRssMb: episode ? toMb(episode.peakRssBytes) : null,
    criticalEvalStreak,
    sampleCount: windowSampleCount,
    requiredSamples: cfg.minSamples,
    evaluatedAt: new Date(nowMs).toISOString(),
    lastEpisodeSummary: lastEpisodeSummary ? structuredClone(lastEpisodeSummary) : null,
  });

  // Pure evaluation: returns {snapshot, transitions[]} and caches the
  // snapshot for getTrend(). Transitions: {type: "latched" | "escalated_critical"
  // | "cleared", episodeId, ...payload} — the watchdog owns what happens next.
  const evaluate = (nowMs) => {
    const transitions = [];
    const finish = (snapshot) => {
      lastSnapshot = snapshot;
      return {
        snapshot: structuredClone(snapshot),
        transitions: transitions.map((transition) => ({
          ...transition,
          rssBasis: snapshot.rssBasis,
          groupRssMb: snapshot.groupRssMb,
          memoryMb: snapshot.memoryMb,
          memoryMeasure: snapshot.memoryMeasure,
          restartAuthority: snapshot.restartAuthority,
          capPhysicalMb: snapshot.capPhysicalMb,
          capFraction: snapshot.capFraction,
          expectedSizeMb: snapshot.expectedSizeMb,
          aboveExpectedSize: snapshot.aboveExpectedSize,
          heap: snapshot.heap,
          criticalGates: snapshot.criticalGates,
          pressureSource: snapshot.pressureSource,
          groupPressureFraction: snapshot.groupPressureFraction,
          containerPressureFraction: snapshot.containerPressureFraction,
          projectedBudgetCrossingAt: transition.projectedExhaustionAt ?? null,
          evidence: projectMemoryEvidence(transition.type === "cleared"
            ? lastEpisodeSummary?.evidence : episode?.evidence ?? snapshot.evidence),
        })),
      };
    };

    if (!lastSample || samples.length === 0) {
      return finish(
        buildSnapshot({ state: currentPid === null ? "no_gateway" : "insufficient_samples", nowMs, windowSampleCount: 0 }),
      );
    }

    // Stale tick (read miss or no sampler run since the last evaluation):
    // hold the previous verdict, advance nothing.
    if (nowMs < lastSample.atMs || nowMs - lastSample.atMs > cfg.maxSampleAgeMs) {
      sampleStatus = "stale";
      freshSampleSinceEval = false;
    }
    if (!freshSampleSinceEval && lastSnapshot) {
      lastSnapshot = { ...lastSnapshot, sampleStatus };
      return { snapshot: structuredClone(lastSnapshot), transitions };
    }
    if (!freshSampleSinceEval) {
      return finish(buildSnapshot({ state: "insufficient_samples", nowMs }));
    }
    freshSampleSinceEval = false;

    const rssBytes = samples[samples.length - 1].rssBytes;
    // The floor reads the worker's own private memory (USS) when the PSS
    // read is fresh; the slope stays on the per-minute RSS series, where
    // shared pages are a near-constant offset.
    const memoryMeasure = lastSample.rssBasis !== "worker" ? "group_rss"
      : lastSample.workerPrivateBytes !== null ? "private" : "rss";
    const memoryBytes = lastSample.workerPrivateBytes ?? rssBytes;
    const { capBytes, capSource, capPhysicalBytes } = computeEffectiveCap({
      containerLimitBytes: lastSample.containerLimitBytes,
      hostTotalBytes: lastSample.hostTotalBytes,
      budgetBytes: lastSample.budgetBytes,
      shareFraction: cfg.memoryShareFraction,
    });
    const expectedBytes = lastSample.rssBasis === "worker"
      ? expectedSizeBytes(lastSample.activeHeapMb, cfg.gatewayNativeOverheadMb) : null;
    // Cap at/below current RSS is maximal pressure, never clamped headroom.
    const pressure =
      capBytes === null ? null : capBytes <= memoryBytes ? 1 : memoryBytes / capBytes;
    const containerPressure =
      lastSample.freshCgroup && Number.isFinite(lastSample.cgroupUsedBytes) && lastSample.cgroupUsedBytes >= 0 &&
      Number.isFinite(lastSample.containerLimitBytes) && lastSample.containerLimitBytes > 0 &&
      Number.isFinite(lastSample.cgroupAtMs) && lastSample.cgroupAtMs <= nowMs &&
      nowMs - lastSample.cgroupAtMs <= cfg.maxSampleAgeMs
        ? Math.min(1, lastSample.cgroupUsedBytes / lastSample.containerLimitBytes)
        : null;
    const windowStartMs = nowMs - cfg.windowMs;
    const windowSamples = samples.filter((s) => s.atMs >= windowStartMs && s.atMs <= nowMs);
    const slopeBytesPerMs = fitSlope(windowSamples);
    // Group RSS and the children never count toward the container side: only
    // a dominant, growing worker can be the reason the container is full.
    const containerCounts = lastSample.rssBasis === "worker" &&
      lastSample.groupRssBytes !== null && rssBytes >= lastSample.groupRssBytes * cfg.workerDominanceFraction &&
      slopeBytesPerMs !== null && slopeBytesPerMs * 3_600_000 / kMb >= cfg.containerWorkerSlopeMbPerHour;
    const enforcedContainerPressure = containerCounts ? containerPressure : null;
    const criticalPressure = pressure === null ? enforcedContainerPressure :
      enforcedContainerPressure === null ? pressure : Math.max(pressure, enforcedContainerPressure);
    const pressureSource = enforcedContainerPressure !== null && (pressure === null || enforcedContainerPressure > pressure)
      ? "container" : capSource;
    const slopeMbPerHour =
      slopeBytesPerMs === null
        ? null
        : (slopeBytesPerMs * 3_600_000) / kMb;
    const projectedAtMs = projectExhaustion({
      rssBytes: memoryBytes,
      capBytes,
      slopeBytesPerMs,
      nowMs,
    });
    const heap = lastSample.heap;
    const heapFresh = heap?.status === "fresh" && Number.isFinite(heap.atMs) &&
      heap.atMs <= nowMs && nowMs - heap.atMs <= cfg.maxSampleAgeMs;
    const heapFraction = heapFresh ? heap.usedBytes / heap.limitBytes : null;
    const heapNear = heapFraction !== null && heapFraction >= cfg.heapNearFraction;
    // Heap growth shows up in worker RSS about one for one, so the worker
    // slope projects the heap toward its limit.
    const heapProjectedAtMs = heapFresh && lastSample.rssBasis === "worker"
      ? projectExhaustion({ rssBytes: heap.usedBytes, capBytes: heap.limitBytes, slopeBytesPerMs, nowMs })
      : null;
    const workerNearOom = enforcedContainerPressure !== null && enforcedContainerPressure >= cfg.criticalFraction;
    const criticalGates = {
      slope: slopeBytesPerMs !== null && slopeBytesPerMs > 0,
      floor: (pressure !== null && pressure >= cfg.criticalFraction) || workerNearOom || heapNear,
      heap: !heapFresh || heapNear || heap.floorsRising || workerNearOom,
    };
    const criticalNow = lastSample.rssBasis === "worker" &&
      criticalGates.slope && criticalGates.floor && criticalGates.heap;
    // What would make a restart worth its cost (ALPH-22): the heap is close
    // enough to its limit that V8 would abort anyway, the worker itself is
    // filling the container, or the operator chose this budget. Critical on
    // its own is not enough.
    const restartAuthority = !criticalNow ? null
      : heapFraction !== null && heapFraction >= cfg.heapRestartFraction ? "heap_near_limit"
        : workerNearOom ? "worker_container_oom"
          : capSource === "budget" && pressure !== null && pressure >= cfg.criticalFraction ? "operator_budget"
            : null;

    const rssRising =
      previousEvalRssBytes !== null && rssBytes > previousEvalRssBytes;
    previousEvalRssBytes = rssBytes;

    const inGrace =
      firstSampleAtMs !== null && nowMs - firstSampleAtMs < cfg.startupGraceMs;

    const snapshotFields = {
      nowMs,
      rssBytes,
      slopeMbPerHour,
      capBytes,
      capSource,
      capPhysicalBytes,
      expectedBytes,
      pressure,
      containerPressure,
      pressureSource,
      projectedAtMs,
      heapProjectedAtMs,
      windowSampleCount: windowSamples.length,
      memoryBytes,
      memoryMeasure,
      heapFraction,
      criticalGates,
      restartAuthority,
    };

    // ---- Episode maintenance (latched states) --------------------------
    if (episode) {
      // Preserve the last useful explanation through diagnostic outages.
      // None of these gateway-reported fields participate in the verdict.
      const nextAttribution = lastSample.evidence?.attribution?.state;
      const preserveSupportedCause = episode.evidence?.attribution?.state === "attributed" && nextAttribution !== "attributed";
      if (lastSample.evidence && !preserveSupportedCause &&
        (nextAttribution !== "unknown" || !episode.evidence)) {
        episode.evidence = projectMemoryEvidence(lastSample.evidence);
      }
      episode.effectiveCapMb = toMb(capBytes);
      episode.capSource = capSource;
      episode.capPhysicalMb = toMb(capPhysicalBytes);
      episode.pressureSource = pressureSource;
      episode.groupPressureFraction = pressure;
      episode.containerPressureFraction = containerPressure;
      episode.projectedBudgetCrossingAt = projectedAtMs ? new Date(projectedAtMs).toISOString() : null;
      if (rssBytes > episode.peakRssBytes) episode.peakRssBytes = rssBytes;
      if (slopeMbPerHour !== null) episode.lastSlopeMbPerHour = slopeMbPerHour;
      if (slopeBytesPerMs !== null && slopeBytesPerMs <= 0) {
        nonPositiveSlopeStreak += 1;
      } else if (slopeBytesPerMs !== null) {
        nonPositiveSlopeStreak = 0;
      }
      const droppedFromPeak =
        rssBytes <= episode.peakRssBytes * (1 - cfg.peakDropFraction);
      if (nonPositiveSlopeStreak >= cfg.clearEvals || droppedFromPeak) {
        const summaryPayload = {
          episodeId: episode.episodeId,
          durationMs: nowMs - episode.startedAtMs,
          peakRssMb: toMb(episode.peakRssBytes),
          mitigationCount: episode.mitigationCount,
        };
        freezeEpisode("recovered", nowMs);
        criticalEvalStreak = 0;
        watchStreak = 0;
        fastPathStreak = 0;
        transitions.push({ type: "cleared", ...summaryPayload });
        return finish(buildSnapshot({ state: "normal", ...snapshotFields }));
      }
      // Escalation: every critical gate held for criticalConfirmEvals
      // consecutive fresh evaluations.
      if (criticalNow) {
        criticalEvalStreak += 1;
        if (!episode.critical && criticalEvalStreak >= cfg.criticalConfirmEvals) {
          episode.critical = true;
          // Emit-once per episode: a workload hovering at the threshold
          // flips critical on/off each eval — the flag stays honest for
          // status/mitigation, but the event feed gets ONE escalation per
          // episode, not one per oscillation.
          if (!episode.escalationEmitted) {
            episode.escalationEmitted = true;
            transitions.push({
              type: "escalated_critical",
              episodeId: episode.episodeId,
              rssMb: toMb(rssBytes),
              effectiveCapMb: toMb(capBytes),
              capSource,
              projectedExhaustionAt: projectedAtMs
                ? new Date(projectedAtMs).toISOString()
                : null,
            });
          }
        }
      } else {
        criticalEvalStreak = 0;
        episode.critical = false;
      }
      return finish(
        buildSnapshot({
          state: episode.critical ? "critical" : "leak_suspected",
          ...snapshotFields,
        }),
      );
    }

    // ---- Un-latched path ------------------------------------------------
    if (inGrace) {
      return finish(buildSnapshot({ state: "warming_up", ...snapshotFields }));
    }

    // Fast high-pressure path (post-grace): every critical gate holds AND
    // rss rises per tick, for fastPathConfirmEvals consecutive evaluations.
    // A stable gateway parked at 92% with per-tick jitter must never latch
    // here: lucky rising ticks are noise, a positive fitted slope over the
    // window is growth.
    if (criticalNow && rssRising) {
      fastPathStreak += 1;
    } else {
      fastPathStreak = 0;
    }
    if (fastPathStreak >= cfg.fastPathConfirmEvals) {
      const pid = currentPid ?? 0;
      episode = {
        episodeId: `${pid}-${nowMs}`,
        pid,
        startedAtMs: nowMs,
        peakRssBytes: rssBytes,
        lastSlopeMbPerHour: slopeMbPerHour,
        mitigationCount: 0,
        rssBasis: lastSample.rssBasis,
        critical: true,
        escalationEmitted: true,
        effectiveCapMb: toMb(capBytes),
        capSource,
        pressureSource,
        trigger: "fast_pressure",
        groupPressureFraction: pressure,
        containerPressureFraction: containerPressure,
        projectedBudgetCrossingAt: projectedAtMs ? new Date(projectedAtMs).toISOString() : null,
        evidence: projectMemoryEvidence(lastSample.evidence),
      };
      criticalEvalStreak = 1;
      nonPositiveSlopeStreak = 0;
      transitions.push({
        type: "latched",
        episodeId: episode.episodeId,
        via: "fast_pressure",
        rssMb: toMb(rssBytes),
        slopeMbPerHour: round1(slopeMbPerHour),
        effectiveCapMb: toMb(capBytes),
        capSource,
        projectedExhaustionAt: projectedAtMs
          ? new Date(projectedAtMs).toISOString()
          : null,
      });
      transitions.push({
        type: "escalated_critical",
        episodeId: episode.episodeId,
        rssMb: toMb(rssBytes),
        effectiveCapMb: toMb(capBytes),
        capSource,
        projectedExhaustionAt: projectedAtMs
          ? new Date(projectedAtMs).toISOString()
          : null,
      });
      return finish(buildSnapshot({ state: "critical", ...snapshotFields }));
    }

    // Coverage gate for the trend path.
    const spanMs =
      windowSamples.length >= 2
        ? windowSamples[windowSamples.length - 1].atMs - windowSamples[0].atMs
        : 0;
    if (
      windowSamples.length < cfg.minSamples ||
      spanMs < cfg.windowMs * cfg.minCoverageFraction
    ) {
      return finish(
        buildSnapshot({ state: "insufficient_samples", ...snapshotFields }),
      );
    }

    // Rising-bucket-minima watch condition.
    const minima = bucketMinima(
      windowSamples,
      windowStartMs,
      cfg.windowMs,
      cfg.bucketCount,
    );
    const growthBytes = minima
      ? minima[minima.length - 1] - minima[0]
      : 0;
    const growthThresholdBytes = Math.max(
      cfg.minGrowthMb * kMb,
      capBytes !== null ? capBytes * cfg.minGrowthCapFraction : 0,
    );
    const watchNow =
      !!minima &&
      minimaStrictlyRising(minima) &&
      growthBytes >= growthThresholdBytes;

    if (!watchNow) {
      watchStreak = 0;
      return finish(buildSnapshot({ state: "normal", ...snapshotFields }));
    }
    watchStreak += 1;

    // Latch condition on a confirmed watch.
    const projectionSoon = [projectedAtMs, heapProjectedAtMs]
      .some((atMs) => atMs !== null && atMs - nowMs <= cfg.projectionHorizonMs);
    const highPressure =
      criticalPressure !== null && criticalPressure >= cfg.pressureFraction;
    const caplessLeak =
      capBytes === null &&
      slopeMbPerHour !== null &&
      slopeMbPerHour >= cfg.caplessSlopeMbPerHour;
    const shouldLatch =
      watchStreak >= cfg.confirmEvals &&
      (highPressure || (capBytes === null ? caplessLeak : projectionSoon));

    if (!shouldLatch) {
      return finish(buildSnapshot({ state: "watch", ...snapshotFields }));
    }

    const pid = currentPid ?? 0;
    episode = {
      episodeId: `${pid}-${nowMs}`,
      pid,
      startedAtMs: nowMs,
      peakRssBytes: rssBytes,
      lastSlopeMbPerHour: slopeMbPerHour,
      mitigationCount: 0,
      rssBasis: lastSample.rssBasis,
      critical: false,
      effectiveCapMb: toMb(capBytes),
      capSource,
      pressureSource,
      trigger: "trend",
      groupPressureFraction: pressure,
      containerPressureFraction: containerPressure,
      projectedBudgetCrossingAt: projectedAtMs ? new Date(projectedAtMs).toISOString() : null,
      evidence: projectMemoryEvidence(lastSample.evidence),
    };
    nonPositiveSlopeStreak = 0;
    criticalEvalStreak = 0;
    transitions.push({
      type: "latched",
      episodeId: episode.episodeId,
      via: "trend",
      rssMb: toMb(rssBytes),
      slopeMbPerHour: round1(slopeMbPerHour),
      effectiveCapMb: toMb(capBytes),
      capSource,
      projectedExhaustionAt: projectedAtMs
        ? new Date(projectedAtMs).toISOString()
        : null,
    });
    return finish(
      buildSnapshot({ state: "leak_suspected", ...snapshotFields }),
    );
  };

  // The watchdog records a mitigation restart against the live episode so
  // the leak_cleared summary carries how many restarts the episode consumed.
  const noteMitigation = () => {
    if (episode) episode.mitigationCount += 1;
  };

  // Called by the watchdog when the gateway process EXITS: freeze a live
  // episode immediately instead of waiting for the replacement pid's first
  // sample (up to one tick later) — an incident that closes in that window
  // must still see the episode that killed the predecessor. The refreshed
  // snapshot keeps getTrend() consumers (incident close sample) current.
  // A pid, when provided, must match the tracked process — an unrelated
  // child's exit (duplicate launch, step-aside) never freezes the episode
  // of the still-running gateway.
  // Freeze any live episode under `reason`, clear ALL evaluation state
  // (buffers included — the OS can hand a replacement the same numeric pid,
  // and addSample's pid-change reset would then never fire: old samples
  // would blend into the new process's trend with no startup grace), and
  // rewrite the cached snapshot to `idleState`. lastEpisodeSummary survives.
  const freezeAndClear = (reason, atMs, idleState) => {
    if (episode) {
      freezeEpisode(
        reason,
        Number.isFinite(atMs) ? atMs : lastSample?.atMs ?? 0,
      );
    }
    samples = [];
    currentPid = null;
    currentIdentityToken = null;
    lastCgroupAtMs = null;
    sampleStatus = "unavailable";
    firstSampleAtMs = null;
    lastSample = null;
    consecutiveMisses = 0;
    previousEvalRssBytes = null;
    freshSampleSinceEval = false;
    criticalEvalStreak = 0;
    watchStreak = 0;
    fastPathStreak = 0;
    nonPositiveSlopeStreak = 0;
    if (lastSnapshot) {
      lastSnapshot = {
        ...lastSnapshot,
        state: idleState,
        episodeId: null,
        episodeStartedAt: null,
        peakRssMb: null,
        projectedExhaustionAt: null,
        projectedBudgetCrossingAt: null,
        pressureFraction: null,
        groupPressureFraction: null,
        containerPressureFraction: null,
        pressureSource: "none",
        sampleStatus: "unavailable",
        criticalEvalStreak: 0,
        lastEpisodeSummary: lastEpisodeSummary
          ? structuredClone(lastEpisodeSummary)
          : null,
      };
    }
  };

  const noteProcessExited = (atMs = null, pid = null) => {
    if (pid != null && currentPid != null && pid !== currentPid) return;
    freezeAndClear(
      "process_exited",
      atMs,
      lastSnapshot?.state === "disabled" ? "disabled" : "no_gateway",
    );
  };

  // Operator turned detection OFF: freeze honestly (the process is still
  // running — "process_exited" would lie to the doctor's recent-episode
  // card) and drop every buffer/streak, so re-enabling starts detection
  // from scratch instead of advancing a stale critical episode straight
  // into the mitigation gate with one fresh sample.
  const noteDetectionDisabled = (atMs = null) => {
    freezeAndClear("detection_disabled", atMs, "disabled");
  };

  // Cached last evaluation — every read path (resources payload, doctor
  // getter, status derivation) consumes this; nothing recomputes on read.
  const getTrend = () =>
    lastSnapshot ? structuredClone(lastSnapshot) : {
      ...buildIdleMemoryTrendSnapshot("no_gateway"),
      lastEpisodeSummary: lastEpisodeSummary ? structuredClone(lastEpisodeSummary) : null,
    };

  const reset = () => {
    samples = [];
    currentPid = null;
    currentIdentityToken = null;
    lastCgroupAtMs = null;
    sampleStatus = "unavailable";
    firstSampleAtMs = null;
    consecutiveMisses = 0;
    watchStreak = 0;
    fastPathStreak = 0;
    nonPositiveSlopeStreak = 0;
    criticalEvalStreak = 0;
    episode = null;
    lastEpisodeSummary = null;
    lastSample = null;
    previousEvalRssBytes = null;
    lastSnapshot = null;
    freshSampleSinceEval = false;
  };

  return {
    addSample,
    evaluate,
    getTrend,
    previewCap,
    noteMitigation,
    noteProcessExited,
    noteDetectionDisabled,
    reset,
  };
};

module.exports = {
  createContainerMemoryMonitor,
  createGatewayMemoryMonitor,
  buildIdleMemoryTrendSnapshot,
  kMemoryTrendStates,
  kEpisodeIdPattern,
  kDefaultMonitorConfig,
  // Pure helpers exported for direct unit tests.
  fitSlope,
  bucketMinima,
  computeEffectiveCap,
  projectExhaustion,
};

// Gateway memory-leak trend detector (pure — no timers, no fs, no imports
// from the watchdog). The watchdog feeds one sample per tick and consumes
// the returned transitions; this module never emits events, notifications,
// or restarts itself (the deterministic watchdog is the only enforcement
// layer).
//
// Detection is RSS-based: RSS is the only memory signal observable from
// outside the child process (no V8 heap stats without --inspect, which is a
// security/perf liability on a production gateway). Rising RSS floors can
// also be allocator fragmentation — copy everywhere says "suspected", and
// the discriminating signal is recurrence after a restart.
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
//        rss ≥ 90% cap AND slope > 0 ──────────────────────────────▶ critical
//        FAST PATH: rss ≥ 90% cap AND rss rising, 2 consecutive evals
//        post-grace ─────────────────────────────────────────────▶ critical
//
//     de-latch (leak_suspected/critical → normal): slope ≤ 0 for 3 evals
//     OR rss ≤ 90% of episode peak → "cleared" transition + frozen summary.
//     pid change: full reset EXCEPT lastEpisodeSummary (frozen, reason
//     "process_exited") — a post-crash incident must see the leak that
//     killed the predecessor, not the replacement's warm-up.
//
// Effective cap is co-residency-aware and re-read every evaluation:
//   min((activeHeapMb + 192) MB, containerLimit − (containerUsed − gatewayRss))
// Never clamped up: a computed cap at/below current RSS IS maximal pressure
// (pressure = 1.0), not an excuse to invent headroom.
const kMb = 1024 * 1024;

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
  fastPathConfirmEvals: 2,
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

// Co-residency-aware cap. Never clamps up: cap ≤ rss reads as pressure 1.0.
const computeEffectiveCap = ({
  rssBytes,
  cgroupUsedBytes,
  containerLimitBytes,
  activeHeapMb,
  overheadMb,
}) => {
  const heapCapBytes =
    Number.isFinite(activeHeapMb) && activeHeapMb > 0
      ? (activeHeapMb + overheadMb) * kMb
      : null;
  let containerCapBytes = null;
  if (Number.isFinite(containerLimitBytes) && containerLimitBytes > 0) {
    const nonGatewayUsed =
      Number.isFinite(cgroupUsedBytes) && Number.isFinite(rssBytes)
        ? Math.max(0, cgroupUsedBytes - rssBytes)
        : 0;
    containerCapBytes = containerLimitBytes - nonGatewayUsed;
  }
  if (heapCapBytes === null && containerCapBytes === null) {
    return { capBytes: null, capSource: "none" };
  }
  if (heapCapBytes === null) {
    return { capBytes: containerCapBytes, capSource: "container" };
  }
  if (containerCapBytes === null) {
    return { capBytes: heapCapBytes, capSource: "heap" };
  }
  return heapCapBytes <= containerCapBytes
    ? { capBytes: heapCapBytes, capSource: "heap" }
    : { capBytes: containerCapBytes, capSource: "container" };
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
  projectedExhaustionAt: null,
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
  let firstSampleAtMs = null;
  let consecutiveMisses = 0;
  let watchStreak = 0;
  let fastPathStreak = 0;
  let nonPositiveSlopeStreak = 0;
  let criticalEvalStreak = 0;
  let episode = null; // {episodeId, pid, startedAtMs, peakRssBytes, peakSlope, mitigationCount, critical}
  let lastEpisodeSummary = null;
  let lastSample = null; // last accepted sample incl. cap inputs
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
      slopeMbPerHour: round1(episode.lastSlopeMbPerHour),
      endedAt: new Date(endedAtMs).toISOString(),
      reason,
      mitigationCount: episode.mitigationCount,
    };
    episode = null;
  };

  const resetForNewProcess = (pid, atMs) => {
    if (episode) freezeEpisode("process_exited", atMs);
    samples = [];
    currentPid = pid;
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
  } = {}) => {
    if (pid !== null && pid !== currentPid) resetForNewProcess(pid, atMs);
    if (!Number.isFinite(rssBytes) || rssBytes <= 0) {
      consecutiveMisses += 1;
      if (consecutiveMisses >= cfg.maxConsecutiveMisses) {
        watchStreak = 0;
        fastPathStreak = 0;
      }
      return;
    }
    consecutiveMisses = 0;
    if (firstSampleAtMs === null) firstSampleAtMs = atMs;
    samples.push({ atMs, rssBytes });
    if (samples.length > cfg.maxSamples) {
      samples = samples.slice(samples.length - cfg.maxSamples);
    }
    lastSample = { atMs, rssBytes, cgroupUsedBytes, containerLimitBytes, activeHeapMb };
    freshSampleSinceEval = true;
  };

  const buildSnapshot = ({
    state,
    nowMs,
    rssBytes = null,
    slopeMbPerHour = null,
    capBytes = null,
    capSource = "none",
    pressure = null,
    projectedAtMs = null,
    windowSampleCount = 0,
  }) => ({
    state,
    rssMb: toMb(rssBytes),
    slopeMbPerHour: round1(slopeMbPerHour),
    effectiveCapMb: toMb(capBytes),
    capSource,
    pressureFraction:
      pressure === null ? null : Math.round(pressure * 1000) / 1000,
    projectedExhaustionAt: projectedAtMs
      ? new Date(projectedAtMs).toISOString()
      : null,
    episodeId: episode ? episode.episodeId : null,
    episodeStartedAt: episode
      ? new Date(episode.startedAtMs).toISOString()
      : null,
    peakRssMb: episode ? toMb(episode.peakRssBytes) : null,
    criticalEvalStreak,
    sampleCount: windowSampleCount,
    requiredSamples: cfg.minSamples,
    evaluatedAt: new Date(nowMs).toISOString(),
    lastEpisodeSummary: lastEpisodeSummary ? { ...lastEpisodeSummary } : null,
  });

  // Pure evaluation: returns {snapshot, transitions[]} and caches the
  // snapshot for getTrend(). Transitions: {type: "latched" | "escalated_critical"
  // | "cleared", episodeId, ...payload} — the watchdog owns what happens next.
  const evaluate = (nowMs) => {
    const transitions = [];
    const finish = (snapshot) => {
      lastSnapshot = snapshot;
      return { snapshot, transitions };
    };

    if (!lastSample || samples.length === 0) {
      return finish(
        buildSnapshot({ state: "no_gateway", nowMs, windowSampleCount: 0 }),
      );
    }

    // Stale tick (read miss or no sampler run since the last evaluation):
    // hold the previous verdict, advance nothing.
    if (!freshSampleSinceEval && lastSnapshot) {
      return { snapshot: { ...lastSnapshot }, transitions };
    }
    freshSampleSinceEval = false;

    const rssBytes = samples[samples.length - 1].rssBytes;
    const { capBytes, capSource } = computeEffectiveCap({
      rssBytes,
      cgroupUsedBytes: lastSample.cgroupUsedBytes,
      containerLimitBytes: lastSample.containerLimitBytes,
      activeHeapMb: lastSample.activeHeapMb,
      overheadMb: cfg.gatewayNativeOverheadMb,
    });
    // Cap at/below current RSS is maximal pressure, never clamped headroom.
    const pressure =
      capBytes === null ? null : capBytes <= rssBytes ? 1 : rssBytes / capBytes;

    const windowStartMs = nowMs - cfg.windowMs;
    const windowSamples = samples.filter((s) => s.atMs >= windowStartMs);
    const slopeBytesPerMs = fitSlope(windowSamples);
    const slopeMbPerHour =
      slopeBytesPerMs === null
        ? null
        : (slopeBytesPerMs * 3_600_000) / kMb;
    const projectedAtMs = projectExhaustion({
      rssBytes,
      capBytes,
      slopeBytesPerMs,
      nowMs,
    });

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
      pressure,
      projectedAtMs,
      windowSampleCount: windowSamples.length,
    };

    // ---- Episode maintenance (latched states) --------------------------
    if (episode) {
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
      // Escalation: pressure ≥ critical fraction AND slope still positive.
      const criticalNow =
        pressure !== null &&
        pressure >= cfg.criticalFraction &&
        slopeBytesPerMs !== null &&
        slopeBytesPerMs > 0;
      if (criticalNow) {
        criticalEvalStreak += 1;
        if (!episode.critical) {
          episode.critical = true;
          transitions.push({
            type: "escalated_critical",
            episodeId: episode.episodeId,
            rssMb: toMb(rssBytes),
            effectiveCapMb: toMb(capBytes),
            projectedExhaustionAt: projectedAtMs
              ? new Date(projectedAtMs).toISOString()
              : null,
          });
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

    // Fast high-pressure path (post-grace, slope-gated): rss ≥ critical
    // fraction of a KNOWN cap AND rss rising across the confirm window.
    if (pressure !== null && pressure >= cfg.criticalFraction && rssRising) {
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
        critical: true,
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
    const projectionSoon =
      projectedAtMs !== null && projectedAtMs - nowMs <= cfg.projectionHorizonMs;
    const highPressure =
      pressure !== null && pressure >= cfg.pressureFraction;
    const caplessLeak =
      capBytes === null &&
      slopeMbPerHour !== null &&
      slopeMbPerHour >= cfg.caplessSlopeMbPerHour;
    const shouldLatch =
      watchStreak >= cfg.confirmEvals &&
      (capBytes === null ? caplessLeak : projectionSoon || highPressure);

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
      critical: false,
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

  // Cached last evaluation — every read path (resources payload, doctor
  // getter, status derivation) consumes this; nothing recomputes on read.
  const getTrend = () =>
    lastSnapshot ? { ...lastSnapshot } : buildIdleMemoryTrendSnapshot("no_gateway");

  const reset = () => {
    samples = [];
    currentPid = null;
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
  };

  return { addSample, evaluate, getTrend, noteMitigation, reset };
};

module.exports = {
  createGatewayMemoryMonitor,
  buildIdleMemoryTrendSnapshot,
  kMemoryTrendStates,
  kDefaultMonitorConfig,
  // Pure helpers exported for direct unit tests.
  fitSlope,
  bucketMinima,
  computeEffectiveCap,
  projectExhaustion,
};

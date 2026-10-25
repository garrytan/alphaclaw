// Pure disk-space episode detector, one state machine per volume:
//
//   ok ──(free below a threshold, or a sustained growth trend)──▶ low | critical
//   low ──(critical condition)──▶ critical       (episodes never de-escalate)
//   low | critical ──(clear held for clearSamples samples)──▶ ok  ("cleared")
//
// Thresholds (bytes free to a non-root writer):
//   low       free < min(10% of size, 20 GB)
//   critical  free < min(5% of size, 5 GB)
// The percentage rules small volumes; the absolute cap keeps a multi-TB disk
// from alerting with hundreds of GB still free.
//
// Growth trigger: also low when the projected time to full is under 6 h and
// critical under 1 h. On a large disk the level thresholds alone fire too
// late (filling at 40 GB/h, a 20 GB threshold leaves 30 minutes); the
// projection fires hours earlier. It needs a sustained trend: samples
// spanning at least 30 min of the 60 min window and at least 1 GB consumed
// across it, so a brief download does not page. The rate is the
// least-squares slope of used bytes over the window.
//
// Clear: free above 1.25x the low threshold AND no growth trigger, held for
// 2 consecutive samples. The gap between the threshold and 1.25x is the
// hysteresis that keeps a volume hovering at the line from re-alerting.
// An unreadable sample ("unknown") never opens, escalates or clears an episode.
const kGiB = 1024 ** 3;
const kMinuteMs = 60_000;
const kHourMs = 60 * kMinuteMs;

const kDiskSpaceDefaults = Object.freeze({
  lowFraction: 0.1,
  lowCapBytes: 20 * kGiB,
  criticalFraction: 0.05,
  criticalCapBytes: 5 * kGiB,
  etaLowMs: 6 * kHourMs,
  etaCriticalMs: kHourMs,
  trendWindowMs: 60 * kMinuteMs,
  trendMinSpanMs: 30 * kMinuteMs,
  trendMinConsumedBytes: kGiB,
  clearFactor: 1.25,
  clearSamples: 2,
  maxSamples: 128,
});

const kTierRank = Object.freeze({ ok: 0, low: 1, critical: 2 });
const maxTier = (a, b) => (kTierRank[a] >= kTierRank[b] ? a : b);

const computeThresholds = (sizeBytes, config = kDiskSpaceDefaults) => ({
  lowBytes: Math.min(sizeBytes * config.lowFraction, config.lowCapBytes),
  criticalBytes: Math.min(sizeBytes * config.criticalFraction, config.criticalCapBytes),
});

const levelTierFor = (freeBytes, thresholds) => {
  if (freeBytes < thresholds.criticalBytes) return "critical";
  if (freeBytes < thresholds.lowBytes) return "low";
  return "ok";
};

// Least-squares slope (bytes per ms) of used bytes over the window. Times are
// taken relative to the first sample so the sums stay well inside double
// precision.
const computeTrend = (samples, freeBytes, config = kDiskSpaceDefaults) => {
  if (samples.length < 2) return { growthBytesPerHour: null, etaMs: null, spanMs: 0, consumedBytes: 0, sustained: false, tier: "ok" };
  const first = samples[0];
  const last = samples[samples.length - 1];
  const spanMs = last.atMs - first.atMs;
  const consumedBytes = last.usedBytes - first.usedBytes;
  let sumT = 0; let sumU = 0;
  for (const sample of samples) { sumT += sample.atMs - first.atMs; sumU += sample.usedBytes; }
  const meanT = sumT / samples.length;
  const meanU = sumU / samples.length;
  let num = 0; let den = 0;
  for (const sample of samples) {
    const dt = sample.atMs - first.atMs - meanT;
    num += dt * (sample.usedBytes - meanU);
    den += dt * dt;
  }
  const slope = den > 0 ? num / den : 0;
  const sustained = spanMs >= config.trendMinSpanMs && consumedBytes >= config.trendMinConsumedBytes && slope > 0;
  const etaMs = sustained ? Math.round(freeBytes / slope) : null;
  const tier = etaMs === null ? "ok" : etaMs < config.etaCriticalMs ? "critical" : etaMs < config.etaLowMs ? "low" : "ok";
  return {
    growthBytesPerHour: spanMs > 0 ? Math.round(slope * kHourMs) : null,
    etaMs,
    spanMs,
    consumedBytes,
    sustained,
    tier,
  };
};

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

const createDiskSpaceMonitor = ({ config = kDiskSpaceDefaults } = {}) => {
  const volumes = new Map();

  const describe = (volume) => ({
    id: volume.id,
    path: volume.path,
    mountPath: volume.mountPath,
    dev: volume.dev,
    sampleStatus: volume.sampleStatus,
    unknownReason: volume.sampleStatus === "unknown" ? volume.unknownReason : null,
    sampledAt: iso(volume.sampledAtMs),
    freeBytes: volume.freeBytes,
    sizeBytes: volume.sizeBytes,
    freePercent: volume.sizeBytes > 0 ? Math.round((volume.freeBytes / volume.sizeBytes) * 1000) / 10 : null,
    lowThresholdBytes: volume.thresholds?.lowBytes ?? null,
    criticalThresholdBytes: volume.thresholds?.criticalBytes ?? null,
    growthBytesPerHour: volume.trend?.growthBytesPerHour ?? null,
    trendWindowMs: volume.trend?.spanMs ?? 0,
    trendSustained: volume.trend?.sustained ?? false,
    etaMs: volume.trend?.etaMs ?? null,
    currentTier: volume.currentTier,
    state: volume.state,
    episodeId: volume.episodeId,
    episodeOpenedAt: iso(volume.episodeOpenedAtMs),
    trigger: volume.trigger,
    growers: volume.growers,
  });

  const getVolume = (reading) => {
    let volume = volumes.get(reading.id);
    if (!volume) {
      volume = {
        id: reading.id, path: reading.path, mountPath: null, dev: null,
        sampleStatus: "unknown", unknownReason: null, sampledAtMs: null, freeBytes: null, sizeBytes: null,
        samples: [], thresholds: null, trend: null, currentTier: "ok",
        state: "ok", episodeId: null, episodeOpenedAtMs: null, trigger: null, growers: null, clearStreak: 0,
      };
      volumes.set(reading.id, volume);
    }
    return volume;
  };

  const observe = (readings, atMs) => {
    const transitions = [];
    for (const reading of Array.isArray(readings) ? readings : []) {
      if (!reading || typeof reading.id !== "string") continue;
      const volume = getVolume(reading);
      volume.path = reading.path ?? volume.path;
      const valid = reading.status === "fresh" && Number.isFinite(reading.freeBytes) &&
        Number.isFinite(reading.sizeBytes) && reading.sizeBytes > 0 && reading.freeBytes >= 0;
      if (!valid) {
        volume.sampleStatus = "unknown";
        volume.unknownReason = reading.reason ?? "unreadable";
        volume.clearStreak = 0;
        continue;
      }
      if (volume.sizeBytes !== null && volume.sizeBytes !== reading.sizeBytes) volume.samples = [];
      volume.sampleStatus = "fresh";
      volume.unknownReason = null;
      volume.mountPath = reading.mountPath ?? volume.mountPath;
      volume.dev = reading.dev ?? volume.dev;
      volume.sampledAtMs = atMs;
      volume.freeBytes = reading.freeBytes;
      volume.sizeBytes = reading.sizeBytes;
      volume.samples.push({ atMs, usedBytes: reading.sizeBytes - reading.freeBytes });
      while (volume.samples.length > config.maxSamples ||
        (volume.samples.length && volume.samples[0].atMs < atMs - config.trendWindowMs)) volume.samples.shift();
      volume.thresholds = computeThresholds(reading.sizeBytes, config);
      volume.trend = computeTrend(volume.samples, reading.freeBytes, config);
      const levelTier = levelTierFor(reading.freeBytes, volume.thresholds);
      const tier = maxTier(levelTier, volume.trend.tier);
      const trigger = kTierRank[levelTier] >= kTierRank[tier] ? "level" : "eta";
      volume.currentTier = tier;

      if (volume.state === "ok") {
        if (tier === "ok") continue;
        volume.state = tier;
        volume.episodeId = `disk-${volume.id}-${atMs}`;
        volume.episodeOpenedAtMs = atMs;
        volume.trigger = trigger;
        volume.growers = null;
        volume.clearStreak = 0;
        transitions.push({ kind: "opened", tier, trigger, volumeId: volume.id, episodeId: volume.episodeId, volume: describe(volume) });
        continue;
      }
      if (volume.state === "low" && tier === "critical") {
        volume.state = "critical";
        volume.trigger = trigger;
        volume.clearStreak = 0;
        transitions.push({ kind: "escalated", tier, trigger, volumeId: volume.id, episodeId: volume.episodeId, volume: describe(volume) });
        continue;
      }
      const clearing = reading.freeBytes > config.clearFactor * volume.thresholds.lowBytes && volume.trend.tier === "ok";
      volume.clearStreak = clearing ? volume.clearStreak + 1 : 0;
      if (volume.clearStreak < config.clearSamples) continue;
      const closed = describe(volume);
      transitions.push({
        kind: "cleared", tier: volume.state, volumeId: volume.id, episodeId: volume.episodeId,
        durationMs: atMs - volume.episodeOpenedAtMs, volume: closed,
      });
      volume.state = "ok";
      volume.episodeId = null;
      volume.episodeOpenedAtMs = null;
      volume.trigger = null;
      volume.growers = null;
      volume.clearStreak = 0;
    }
    return transitions;
  };

  const setGrowers = (volumeId, episodeId, report) => {
    const volume = volumes.get(volumeId);
    if (volume && volume.episodeId === episodeId) volume.growers = report;
  };

  const getSnapshot = () => ({ volumes: [...volumes.values()].map(describe) });

  return { observe, setGrowers, getSnapshot };
};

module.exports = { createDiskSpaceMonitor, computeThresholds, computeTrend, kDiskSpaceDefaults };

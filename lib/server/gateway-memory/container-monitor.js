// Direct cgroup pressure, independent of whether a gateway is serving.
// This module has no restart policy; a flat/absent gateway can still share
// a critically full container without becoming a restart candidate.
const createContainerMemoryMonitor = ({ config = {} } = {}) => {
  const cfg = { criticalFraction: 0.9, confirmEvals: 2, clearEvals: 3, maxSampleAgeMs: 90_000, ...config };
  let sample = null;
  let pending = false;
  let highStreak = 0;
  let lowStreak = 0;
  let snapshot = {
    state: "unknown", since: null, usedBytes: null, limitBytes: null,
    pressureFraction: null, sampledAt: null, sampleStatus: "unavailable",
    episodeId: null, lastEpisodeSummary: null,
  };
  const changeState = (state, nowMs) => {
    if (state !== snapshot.state || snapshot.since === null) {
      snapshot.state = state;
      snapshot.since = new Date(nowMs).toISOString();
    }
  };
  const finishEpisode = (reason, nowMs) => {
    if (!snapshot.episodeId) return;
    snapshot.lastEpisodeSummary = {
      episodeId: snapshot.episodeId,
      endedAt: new Date(nowMs).toISOString(),
      reason,
    };
    snapshot.episodeId = null;
  };
  const addSample = ({ atMs, usedBytes, limitBytes } = {}) => {
    if (!Number.isFinite(atMs) || !Number.isFinite(usedBytes) || usedBytes < 0 ||
      !Number.isFinite(limitBytes) || limitBytes <= 0 || (sample && atMs <= sample.atMs)) {
      pending = false;
      highStreak = 0;
      lowStreak = 0;
      snapshot.sampleStatus = sample && atMs <= sample.atMs ? "stale" : "unavailable";
      return;
    }
    if (sample && atMs - sample.atMs > cfg.maxSampleAgeMs) {
      highStreak = 0;
      lowStreak = 0;
    }
    sample = { atMs, usedBytes, limitBytes };
    pending = true;
  };
  const getSnapshot = () => structuredClone(snapshot);
  const evaluate = (nowMs) => {
    if (sample && (sample.atMs > nowMs || nowMs - sample.atMs > cfg.maxSampleAgeMs)) {
      pending = false;
      highStreak = 0;
      lowStreak = 0;
      snapshot.sampleStatus = "stale";
    }
    if (!pending || !sample) return getSnapshot();
    pending = false;
    snapshot.usedBytes = sample.usedBytes;
    snapshot.limitBytes = sample.limitBytes;
    snapshot.pressureFraction = sample.usedBytes / sample.limitBytes;
    snapshot.sampledAt = new Date(sample.atMs).toISOString();
    snapshot.sampleStatus = "fresh";
    if (snapshot.pressureFraction >= cfg.criticalFraction) {
      highStreak += 1;
      lowStreak = 0;
      if (highStreak >= cfg.confirmEvals) {
        if (!snapshot.episodeId) snapshot.episodeId = `container-${sample.atMs}`;
        changeState("critical", nowMs);
      } else if (snapshot.state === "disabled") {
        changeState("unknown", nowMs);
      }
    } else {
      lowStreak += 1;
      highStreak = 0;
      if (snapshot.state !== "critical" || lowStreak >= cfg.clearEvals) {
        finishEpisode("recovered", nowMs);
        changeState("normal", nowMs);
      }
    }
    return getSnapshot();
  };
  const disable = (nowMs) => {
    finishEpisode("detection_disabled", nowMs);
    changeState("disabled", nowMs);
    sample = null;
    pending = false;
    highStreak = 0;
    lowStreak = 0;
    snapshot.sampleStatus = "unavailable";
    snapshot.usedBytes = null;
    snapshot.limitBytes = null;
    snapshot.pressureFraction = null;
    snapshot.sampledAt = null;
    return getSnapshot();
  };
  return { addSample, evaluate, disable, getSnapshot };
};

module.exports = { createContainerMemoryMonitor };

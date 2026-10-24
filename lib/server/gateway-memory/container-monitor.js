const kContainerCriticalFraction = 0.9;
// PSI `some avg60` at or above this share of the last minute (percent) is
// reclaim pressure: some task stalled on memory for 3 s of every 60.
const kContainerPsiSomeAvg60Threshold = 5;
const kReclaimCounters = ["high", "max"];

// A full container is critical only when the kernel is working to make room
// (ALPH-25): PSI some avg60 at the threshold, or memory.events high/max (v1:
// memory.failcnt) rising since the previous sample. A box whose usage is high
// but whose kernel is idle is not. When neither PSI nor a counter delta can
// be read (cgroup v1 without failcnt, a hidden file, the first sample), the
// fraction alone decides, as before, and the evidence says so.
const assessReclaimPressure = (pressure, previousEvents) => {
  const psiSomeAvg60 = Number.isFinite(pressure?.psi?.some?.avg60) ? pressure.psi.some.avg60 : null;
  const psiFullAvg60 = Number.isFinite(pressure?.psi?.full?.avg60) ? pressure.psi.full.avg60 : null;
  const events = pressure?.events ?? null;
  const counters = [];
  let countersCompared = false;
  if (events && previousEvents && events.source === previousEvents.source) {
    for (const counter of kReclaimCounters) {
      if (!Number.isSafeInteger(events[counter]) || !Number.isSafeInteger(previousEvents[counter])) continue;
      countersCompared = true;
      if (events[counter] > previousEvents[counter]) {
        counters.push({ source: events.source, counter, delta: events[counter] - previousEvents[counter] });
      }
    }
  }
  const psiFired = psiSomeAvg60 !== null && psiSomeAvg60 >= kContainerPsiSomeAvg60Threshold;
  const status = psiSomeAvg60 === null && !countersCompared ? "unavailable"
    : psiFired || counters.length ? "confirmed" : "absent";
  return { status, psiSomeAvg60, psiFullAvg60, psiFired, counters };
};

// Direct cgroup pressure, independent of whether a gateway is serving.
// This module has no restart policy; a flat/absent gateway can still share
// a critically full container without becoming a restart candidate.
const createContainerMemoryMonitor = ({ config = {} } = {}) => {
  const cfg = { criticalFraction: kContainerCriticalFraction, confirmEvals: 2, clearEvals: 3, maxSampleAgeMs: 90_000, ...config };
  let sample = null;
  let previousEvents = null;
  let pending = false;
  let highStreak = 0;
  let lowStreak = 0;
  let snapshot = {
    state: "unknown", since: null, usedBytes: null, limitBytes: null,
    pressureFraction: null, sampledAt: null, sampleStatus: "unavailable",
    pressureEvidence: null, episodeId: null, lastEpisodeSummary: null,
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
  const addSample = ({ atMs, usedBytes, limitBytes, pressure = null } = {}) => {
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
    const evidence = assessReclaimPressure(pressure, previousEvents);
    if (pressure?.events) previousEvents = pressure.events;
    sample = { atMs, usedBytes, limitBytes, evidence };
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
    snapshot.pressureEvidence = sample.evidence;
    const full = snapshot.pressureFraction >= cfg.criticalFraction;
    if (full && sample.evidence.status !== "absent") {
      highStreak += 1;
      lowStreak = 0;
      if (highStreak >= cfg.confirmEvals) {
        if (!snapshot.episodeId) snapshot.episodeId = `container-${sample.atMs}`;
        changeState("critical", nowMs);
      } else if (snapshot.state === "disabled") {
        changeState("unknown", nowMs);
      }
    } else if (full && snapshot.state === "critical") {
      // Still full with the kernel momentarily idle: hold, neither confirm
      // nor count toward recovery.
      highStreak = 0;
      lowStreak = 0;
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
    snapshot.pressureEvidence = null;
    previousEvents = null;
    return getSnapshot();
  };
  return { addSample, evaluate, disable, getSnapshot };
};

module.exports = { createContainerMemoryMonitor, assessReclaimPressure,
  kContainerCriticalFraction, kContainerPsiSomeAvg60Threshold };

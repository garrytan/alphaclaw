// The process's boot timeline (one per real-server process, created at
// listen). Singleton like boot-phase.js: a second begin() in the same process
// returns the timeline that already exists, so there is exactly one writer
// per bootId.
const { createBootTimeline } = require("./timeline");
const { appendBootHistory, readBootHistory, estimateBootDuration } = require("./history");

const kObserveIntervalMs = 1000;

let current = null;
let observeTimer = null;

const stopObserving = () => {
  if (observeTimer) clearInterval(observeTimer);
  observeTimer = null;
};

// managedDir: where boot-history.json lives. readSources() → { bootPhase,
// watchdog, activeOperation } sampled every second until the timeline ends.
const beginBootTimeline = ({
  bootId,
  startedAtMs,
  kind,
  managedDir,
  readVersions,
  readSources = () => ({}),
  readyBudgetMs,
  onboarded = true,
  fsModule,
  now = Date.now,
  logger = console,
  intervalMs = kObserveIntervalMs,
} = {}) => {
  if (current) return current;
  current = createBootTimeline({
    bootId,
    startedAtMs,
    kind,
    readVersions,
    readyBudgetMs,
    now,
    logger,
    estimateFor: ({ kind: estimateKind, openclawVersion }) =>
      estimateBootDuration({
        entries: readBootHistory({ managedDir, ...(fsModule ? { fsModule } : {}) }).entries,
        kind: estimateKind,
        openclawVersion,
      }),
    recordHistory: (entry) => appendBootHistory({ managedDir, entry, logger, ...(fsModule ? { fsModule } : {}) }),
  });
  if (!onboarded) {
    current.markNotOnboarded();
    return current;
  }
  current.onTerminal(stopObserving);
  observeTimer = setInterval(() => {
    try {
      current?.observe(readSources() || {});
    } catch (error) {
      logger.warn?.(`[alphaclaw] boot timeline observe failed: ${error?.message || error}`);
    }
  }, intervalMs);
  observeTimer.unref?.();
  return current;
};

const getBootTimeline = () => current;
const getBootSnapshot = () => current?.snapshot() || null;

const resetBootTimelineForTests = () => {
  stopObserving();
  current = null;
};

module.exports = {
  beginBootTimeline,
  getBootTimeline,
  getBootSnapshot,
  resetBootTimelineForTests,
};

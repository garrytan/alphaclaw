const fs = require("fs");
const os = require("os");
const path = require("path");
const sampler = require("./sampler");
const growers = require("./growers");
const notice = require("./notice");
const { createDiskSpaceMonitor } = require("./monitor");

// Disk-space early warning for the watchdog. Every sampleIntervalMs: statfs
// the watched volumes (sampler.js) and feed the pure episode detector
// (monitor.js). Every censusIntervalMs, in the background, a bounded size
// census of AlphaClaw's directories (growers.js) lands in a ring covering
// censusRingMs. When an episode opens or escalates, a fresh census is ranked
// against the oldest one in the ring, and the owner gets one notice per tier
// per episode, plus one cleared follow-up when the episode notified. Nothing
// here deletes anything, and nothing throws into the watchdog.
const kDiskSampleIntervalMs = 60_000;
const kDiskCensusIntervalMs = 15 * 60_000;
const kDiskCensusRingMs = 2 * 60 * 60_000;
const kDiskCensusRingMax = 12;

const kEventKinds = Object.freeze({ low: "disk_low", critical: "disk_critical" });

const createDiskSpaceTracker = ({
  stateDir,
  censusRoots = [os.tmpdir()],
  env = process.env,
  readVolumes = sampler.readDiskVolumes,
  runCensus = growers.runCensus,
  nowFn = Date.now,
  sampleIntervalMs = kDiskSampleIntervalMs,
  censusIntervalMs = kDiskCensusIntervalMs,
  censusRingMs = kDiskCensusRingMs,
  monitorConfig = undefined,
  logEvent = () => {},
  notify = async () => ({ ok: false, reason: "notifier_unavailable" }),
  withViewLogsSuffix = (line) => line,
  createCorrelationId = () => "",
} = {}) => {
  const monitor = createDiskSpaceMonitor(monitorConfig ? { config: monitorConfig } : {});
  const notifiedKeys = new Set();
  let censusRing = [];
  let censusInFlight = null;
  let lastCensusRequestAtMs = -Infinity;
  let tickInFlight = null;
  let timer = null;
  let stopped = false;

  // Roots are resolved to their real paths because the census never follows
  // a symlink. The state dir is its own root when it lives outside the others
  // (a state dir symlinked onto a bigger volume).
  const realpath = (target) => {
    try { return fs.realpathSync(target); } catch { return path.resolve(target); }
  };
  const isWithin = (child, parent) => child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  const roots = () => {
    const base = [...censusRoots, ...sampler.parseDiagnosticDirs(env?.NODE_OPTIONS).map((entry) => entry.path)]
      .filter(Boolean).map(realpath);
    const state = stateDir ? realpath(stateDir) : null;
    return [...new Set(state && !base.some((root) => isWithin(state, root)) ? [...base, state] : base)];
  };

  // Never more than one census in flight: a caller arriving while one runs
  // shares its result.
  const takeCensus = () => {
    if (censusInFlight) return censusInFlight;
    lastCensusRequestAtMs = nowFn();
    const run = (async () => {
      try {
        const census = await runCensus({ roots: roots() });
        if (!census || !Number.isFinite(census.atMs)) return null;
        censusRing = [...censusRing, census]
          .filter((entry) => entry.atMs >= census.atMs - censusRingMs)
          .slice(-kDiskCensusRingMax);
        return census;
      } catch {
        return null;
      }
    })();
    censusInFlight = run;
    run.then(() => { if (censusInFlight === run) censusInFlight = null; });
    return run;
  };

  const notifyOnce = async (episodeId, tier, lines, correlationId) => {
    const key = `${episodeId}:${tier}`;
    if (notifiedKeys.has(key) || stopped) return;
    let result = null;
    try { result = await notify(lines.join("\n"), correlationId); } catch {}
    if (result?.ok || result?.skipped) notifiedKeys.add(key);
  };

  const eventDetails = (transition, volume) => ({
    volume: volume.id,
    path: volume.path,
    mountPath: volume.mountPath,
    episodeId: transition.episodeId,
    freeBytes: volume.freeBytes,
    sizeBytes: volume.sizeBytes,
    lowThresholdBytes: volume.lowThresholdBytes,
    criticalThresholdBytes: volume.criticalThresholdBytes,
    growthBytesPerHour: volume.growthBytesPerHour,
    etaMs: volume.etaMs,
  });

  const handleEpisode = async (transition) => {
    const correlationId = createCorrelationId();
    const { volume, tier, trigger, episodeId } = transition;
    try {
      logEvent("disk", "disk-monitor", "warning", {
        kind: kEventKinds[tier], tier, trigger, opened: transition.kind === "opened", ...eventDetails(transition, volume),
      }, correlationId);
    } catch {}
    const census = await takeCensus();
    const baseline = census ? censusRing.find((entry) => entry.atMs < census.atMs) ?? null : null;
    const report = census ? growers.rankGrowers({ latest: census, baseline, dev: volume.dev ?? null }) : null;
    monitor.setGrowers(transition.volumeId, episodeId, report);
    await notifyOnce(episodeId, tier, [
      "🐺 *AlphaClaw Watchdog*",
      withViewLogsSuffix(notice.describeHeadline(volume, tier, trigger)),
      ...notice.describeEpisodeNotice({ volume, tier, trigger, growers: report }),
    ], correlationId);
  };

  const handleCleared = async (transition) => {
    const correlationId = createCorrelationId();
    const { volume, episodeId } = transition;
    try {
      logEvent("disk", "disk-monitor", "info", {
        kind: "disk_recovered", tier: transition.tier, durationMs: transition.durationMs, ...eventDetails(transition, volume),
      }, correlationId);
    } catch {}
    const notified = notifiedKeys.has(`${episodeId}:low`) || notifiedKeys.has(`${episodeId}:critical`);
    notifiedKeys.delete(`${episodeId}:low`);
    notifiedKeys.delete(`${episodeId}:critical`);
    if (!notified || stopped) return;
    try {
      await notify([
        "🐺 *AlphaClaw Watchdog*",
        withViewLogsSuffix(`✅ Disk space back to normal on ${notice.volumeName(volume)}`),
        ...notice.describeClearedNotice(transition),
      ].join("\n"), correlationId);
    } catch {}
  };

  const runTick = async () => {
    const atMs = nowFn();
    let readings = [];
    try { readings = readVolumes({ stateDir, env }) || []; } catch {}
    const transitions = monitor.observe(readings, atMs);
    for (const transition of transitions) {
      try {
        if (transition.kind === "cleared") await handleCleared(transition);
        else await handleEpisode(transition);
      } catch {}
    }
    if (!stopped && !censusInFlight && atMs - lastCensusRequestAtMs >= censusIntervalMs) void takeCensus();
  };

  const tick = () => {
    if (tickInFlight) return tickInFlight;
    tickInFlight = runTick().catch(() => {}).finally(() => { tickInFlight = null; });
    return tickInFlight;
  };

  // The first sample is immediate (statfs is cheap); the first background
  // census waits one sample interval so it never competes with boot.
  const start = () => {
    if (timer) return;
    stopped = false;
    lastCensusRequestAtMs = nowFn() - censusIntervalMs + sampleIntervalMs;
    timer = setInterval(() => { void tick(); }, sampleIntervalMs);
    timer.unref?.();
    void tick();
  };

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  const getSnapshot = () => {
    const newest = censusRing[censusRing.length - 1] ?? null;
    return {
      ...monitor.getSnapshot(),
      census: {
        lastAt: newest ? new Date(newest.atMs).toISOString() : null,
        truncated: newest ? newest.truncated : null,
        inFlight: censusInFlight !== null,
        ringSize: censusRing.length,
      },
    };
  };

  return { start, stop, tick, getSnapshot };
};

module.exports = {
  createDiskSpaceTracker,
  kDiskSampleIntervalMs,
  kDiskCensusIntervalMs,
  kDiskCensusRingMs,
};

const { createContainerMemoryMonitor, kContainerCriticalFraction } = require("./container-monitor");
const { projectMemoryEvidence, describeMemorySplit } = require("./evidence");
const processCommand = require("./process-command");
const containerCensus = require("./container-census");
const { resolveContainerLimitBehavior } = require("./container-limit");
const notice = require("./container-notice");

// Two samples further apart than this are not a rate.
const kTrendMaxGapMs = 3 * 60_000;
// The gateway's own census explains the pressure while its group holds at
// least this share of the container's usage.
const kGatewayExplainsShare = 0.5;
// An outside process is the subject of the alert only while it holds at
// least this share; a smaller one is named beside the generic alert.
const kOutsideCulpritShare = 0.25;

// Tool children (an exec'd package install, a build) can fill the container
// while the gateway worker stays flat. The alert then says so and names the
// largest child; it never restarts the gateway, which would not free that
// memory (ALPH-17). Child-driven: the attribution saw child RSS grow, or the
// worker is not the dominant contributor of the process group.
const kChildCauses = new Set(["child_growth", "child_accumulation"]);
const describeChildPressure = (evidence) => {
  const projected = projectMemoryEvidence(evidence);
  const process = projected?.process;
  if (!process || process.workerRssBytes === null) return { childDriven: false, largestChild: null, split: "" };
  const largest = process.contributors.find((entry) => entry.role === "gateway_child" && entry.rssBytes !== null) ?? null;
  const childDriven = !!largest && (projected.attribution.causes.some((cause) => kChildCauses.has(cause)) ||
    (process.groupRssBytes !== null && process.workerRssBytes < process.groupRssBytes * 0.5));
  return { childDriven, largestChild: largest ? { pid: largest.pid, rssBytes: largest.rssBytes } : null,
    workerRssBytes: process.workerRssBytes, split: describeMemorySplit(projected) };
};

// Where the container census's largest process sits (ALPH-25):
//   outside   a complete gateway census does not hold it, and the gateway's
//             own group does not explain the pressure
//   unknown   no complete gateway census (no gateway, a partial or capped
//             census), so it cannot be called outside the gateway
//   null      it is in the gateway's tree, or the gateway explains the pressure
// The projected contributors are the group's largest, so the container's
// largest process, if it is in the group, is among them.
const kContributorCap = 128;
const classifyLargestProcess = (largest, evidence, usedBytes) => {
  if (!largest) return null;
  const process = projectMemoryEvidence(evidence)?.process;
  if (process?.status !== "fresh" || !(process.processCount <= kContributorCap)) return "unknown";
  const treePids = new Set([process.root?.pid, process.worker?.pid, ...process.contributors.map((entry) => entry.pid)]);
  if (treePids.has(largest.pid)) return null;
  const group = process.groupRssBytes;
  if (Number.isFinite(group) && Number.isFinite(usedBytes) && group >= usedBytes * kGatewayExplainsShare) return null;
  return "outside";
};

// Independent lifecycle: a gateway exit does not end container pressure.
// Delivery is a side effect of the latched state, never an enforcement input.
// The record (container-restart-record.js) keeps the last full sample on
// disk so the next boot can say the container restarted at its limit.
const createContainerPressureTracker = ({ logEvent, notifyOnce, forgetEpisode, createCorrelationId, withViewLogsSuffix,
  record = null, env = process.env }) => {
  const monitor = createContainerMemoryMonitor();
  let notificationInFlight = false;
  let previousUsage = null;
  let previousLargest = null;
  let lastLargest = null;

  // Bounded census of the whole container, only while it is full, with the
  // largest process's growth when the previous full sample saw it too.
  const scanContainer = (atMs) => {
    let census = null;
    try { census = containerCensus.readLargestContainerProcess(); } catch {}
    const largest = census?.largest ?? null;
    const comparable = largest && previousLargest && previousLargest.pid === largest.pid &&
      previousLargest.startTicks === largest.startTicks && atMs > previousLargest.atMs &&
      atMs - previousLargest.atMs <= kTrendMaxGapMs;
    const growthBytesPerMin = comparable
      ? ((largest.rssBytes - previousLargest.rssBytes) / (atMs - previousLargest.atMs)) * 60_000 : null;
    previousLargest = largest ? { ...largest, atMs } : null;
    return largest ? { pid: largest.pid, rssBytes: largest.rssBytes, growthBytesPerMin } : null;
  };

  const sample = (input, nowMs, evidence = null) => {
    const atMs = input.cgroupAtMs ?? nowMs;
    const usedBytes = input.cgroupUsedBytes ?? null;
    const limitBytes = input.containerLimitBytes ?? null;
    const before = monitor.getSnapshot();
    monitor.addSample({ atMs, usedBytes, limitBytes, pressure: input.cgroupPressure ?? null });
    monitor.evaluate(nowMs);
    const current = monitor.getSnapshot();
    const measured = Number.isFinite(usedBytes) && Number.isFinite(limitBytes) && limitBytes > 0;
    let etaMs = null;
    if (measured && previousUsage && atMs > previousUsage.atMs && atMs - previousUsage.atMs <= kTrendMaxGapMs) {
      const slope = (usedBytes - previousUsage.usedBytes) / (atMs - previousUsage.atMs);
      if (slope > 0 && usedBytes < limitBytes) etaMs = Math.round((limitBytes - usedBytes) / slope);
    }
    if (measured) previousUsage = { atMs, usedBytes };
    if (measured && usedBytes / limitBytes >= kContainerCriticalFraction) {
      lastLargest = scanContainer(atMs);
      const evidence = current.sampleStatus === "fresh" ? current.pressureEvidence : null;
      const limitHit = Boolean(evidence?.counters?.some((entry) => entry.counter === "max"));
      try {
        record?.recordFull({ atMs, usedBytes, limitBytes, limitHit, largest: lastLargest
          ? { command: processCommand.readProcessCommand(lastLargest.pid), rssBytes: lastLargest.rssBytes } : null });
      } catch {}
    } else if (measured) {
      previousLargest = null;
      lastLargest = null;
      try { record?.recordClear(atMs); } catch {}
    }
    const critical = current.state === "critical";
    const entering = critical && before.state !== "critical";
    const children = entering ? describeChildPressure(evidence) : null;
    const behavior = critical ? resolveContainerLimitBehavior({ events: input.cgroupPressure?.events ?? null, env }) : null;
    const placement = critical ? classifyLargestProcess(lastLargest, evidence, usedBytes) : null;
    const outside = placement === "outside" ? lastLargest : null;
    try {
      if (current.state !== before.state && (critical || before.state === "critical")) {
        const pressureEvidence = current.pressureEvidence;
        logEvent("memory", "memory-monitor", critical ? "warning" : "info", {
          kind: critical ? "container_critical" : "container_recovered", scope: "container",
          episodeId: current.episodeId ?? before.episodeId,
          usedBytes: current.usedBytes, limitBytes: current.limitBytes,
          ...(children ? { childDriven: children.childDriven, largestChild: children.largestChild } : {}),
          ...(critical ? {
            usageBasis: input.cgroupUsageBasis ?? null,
            pressureBasis: pressureEvidence?.status === "unavailable" ? "fraction_only" : "reclaim_evidence",
            pressureEvidence,
            limitBehavior: { kind: behavior.kind, platform: behavior.platform, limitHits: behavior.limitHits, oomKills: behavior.oomKills },
            largestProcess: lastLargest ? { ...lastLargest, placement: placement ?? "gateway_or_explained" } : null,
            etaToLimitMs: etaMs,
          } : {}),
        }, createCorrelationId());
        if (!critical && before.episodeId) forgetEpisode(before.episodeId);
      }
    } catch {}
    if (critical && !notificationInFlight) {
      notificationInFlight = true;
      const detail = children ?? describeChildPressure(evidence);
      const usage = notice.describeContainerUsage({ usedBytes: current.usedBytes, limitBytes: current.limitBytes,
        basis: input.cgroupUsageBasis ?? null, workerRssBytes: detail.childDriven ? detail.workerRssBytes : null,
        evidence: current.pressureEvidence, etaMs });
      const lines = detail.childDriven ? [
        "🐺 *AlphaClaw Watchdog*", withViewLogsSuffix("🔴 Container memory critical: a tool process, not the gateway"),
        ...notice.describeChildAlert({ command: processCommand.readProcessCommand(detail.largestChild.pid),
          rssBytes: detail.largestChild.rssBytes, usage, behavior }),
      ] : outside && outside.rssBytes >= current.usedBytes * kOutsideCulpritShare ? [
        "🐺 *AlphaClaw Watchdog*", withViewLogsSuffix("🔴 Container memory critical: a process outside the gateway"),
        ...notice.describeOutsideAlert({ command: processCommand.readProcessCommand(outside.pid), rssBytes: outside.rssBytes,
          growthBytesPerMin: outside.growthBytesPerMin, usage, behavior }),
      ] : [
        "🐺 *AlphaClaw Watchdog*", withViewLogsSuffix("🔴 Container memory critical"),
        ...notice.describeGenericAlert({ usage, split: detail.split, behavior, largest: placement
          ? { command: processCommand.readProcessCommand(lastLargest.pid), rssBytes: lastLargest.rssBytes,
            growthBytesPerMin: lastLargest.growthBytesPerMin, outside: !!outside } : null }),
      ];
      // Delivery can wait on a remote service indefinitely. Do not await it
      // in the RSS enforcement tick, and never fan out a second pending send.
      void Promise.resolve().then(() => notifyOnce(current.episodeId, "container_critical",
        lines.join("\n"), createCorrelationId()))
        .catch(() => {})
        .finally(() => { notificationInFlight = false; });
    }
    return current;
  };
  return { sample, getSnapshot: monitor.getSnapshot, disable: monitor.disable };
};
module.exports = { createContainerPressureTracker };

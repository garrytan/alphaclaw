const { createContainerMemoryMonitor } = require("./container-monitor");
const { projectMemoryEvidence, describeMemorySplit } = require("./evidence");

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
    split: describeMemorySplit(projected) };
};

// Independent lifecycle: a gateway exit does not end container pressure.
// Delivery is a side effect of the latched state, never an enforcement input.
const createContainerPressureTracker = ({ logEvent, notifyOnce, forgetEpisode, createCorrelationId, withViewLogsSuffix }) => {
  const monitor = createContainerMemoryMonitor();
  let notificationInFlight = false;
  const sample = (input, nowMs, evidence = null) => {
    const before = monitor.getSnapshot();
    monitor.addSample({ atMs: input.cgroupAtMs ?? nowMs,
      usedBytes: input.cgroupUsedBytes ?? null, limitBytes: input.containerLimitBytes ?? null });
    monitor.evaluate(nowMs);
    const current = monitor.getSnapshot();
    const entering = current.state === "critical" && before.state !== "critical";
    const children = entering ? describeChildPressure(evidence) : null;
    try {
      if (current.state !== before.state && (current.state === "critical" || before.state === "critical")) {
        const critical = current.state === "critical";
        logEvent("memory", "memory-monitor", critical ? "warning" : "info", {
          kind: critical ? "container_critical" : "container_recovered", scope: "container",
          episodeId: current.episodeId ?? before.episodeId,
          usedBytes: current.usedBytes, limitBytes: current.limitBytes,
          ...(children ? { childDriven: children.childDriven, largestChild: children.largestChild } : {}),
        }, createCorrelationId());
        if (!critical && before.episodeId) forgetEpisode(before.episodeId);
      }
    } catch {}
    if (current.state === "critical" && !notificationInFlight) {
      notificationInFlight = true;
      const detail = children ?? describeChildPressure(evidence);
      const lines = detail.childDriven ? [
        "🐺 *AlphaClaw Watchdog*", withViewLogsSuffix("🔴 Container memory critical: tool processes, not the gateway"),
        "The container working set (usage minus inactive page cache) is at or above 90% of its limit, and the growth is in processes the gateway started.",
        detail.split,
        "A gateway restart would not free this memory, so the watchdog will not restart the gateway for it. Check the named process.",
      ] : [
        "🐺 *AlphaClaw Watchdog*", withViewLogsSuffix("🔴 Container memory critical"),
        "The container working set (usage minus inactive page cache) is at or above 90% of its limit. Inspect gateway and co-resident load.",
        ...(detail.split ? [detail.split] : []),
        "Container pressure alone does not authorize a gateway restart.",
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

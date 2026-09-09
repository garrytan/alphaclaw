const { createContainerMemoryMonitor } = require("./container-monitor");

// Independent lifecycle: a gateway exit does not end container pressure.
// Delivery is a side effect of the latched state, never an enforcement input.
const createContainerPressureTracker = ({ logEvent, notifyOnce, forgetEpisode, createCorrelationId, withViewLogsSuffix }) => {
  const monitor = createContainerMemoryMonitor();
  let notificationInFlight = false;
  const sample = (input, nowMs) => {
    const before = monitor.getSnapshot();
    monitor.addSample({ atMs: input.cgroupAtMs ?? nowMs,
      usedBytes: input.cgroupUsedBytes ?? null, limitBytes: input.containerLimitBytes ?? null });
    monitor.evaluate(nowMs);
    const current = monitor.getSnapshot();
    try {
      if (current.state !== before.state && (current.state === "critical" || before.state === "critical")) {
        const critical = current.state === "critical";
        logEvent("memory", "memory-monitor", critical ? "warning" : "info", {
          kind: critical ? "container_critical" : "container_recovered", scope: "container",
          episodeId: current.episodeId ?? before.episodeId,
          usedBytes: current.usedBytes, limitBytes: current.limitBytes,
        }, createCorrelationId());
        if (!critical && before.episodeId) forgetEpisode(before.episodeId);
      }
    } catch {}
    if (current.state === "critical" && !notificationInFlight) {
      notificationInFlight = true;
      // Delivery can wait on a remote service indefinitely. Do not await it
      // in the RSS enforcement tick, and never fan out a second pending send.
      void Promise.resolve().then(() => notifyOnce(current.episodeId, "container_critical", [
          "🐺 *AlphaClaw Watchdog*", withViewLogsSuffix("🔴 Container memory critical"),
          "Measured container usage is at or above 90% of its limit. Inspect gateway and co-resident load.",
          "Container pressure alone does not authorize a gateway restart.",
        ].join("\n"), createCorrelationId()))
        .catch(() => {})
        .finally(() => { notificationInFlight = false; });
    }
    return current;
  };
  return { sample, getSnapshot: monitor.getSnapshot, disable: monitor.disable };
};
module.exports = { createContainerPressureTracker };

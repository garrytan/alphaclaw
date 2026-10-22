const { createContainerMemoryMonitor } = require("./container-monitor");
const { projectMemoryEvidence, describeMemorySplit } = require("./evidence");
const processCommand = require("./process-command");

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

// The owner's message names the child's command and its RSS against the
// limit, never its pid, and says what happens if it keeps growing. Neither a
// kill nor a restart: the kernel picks the child anyway (OpenClaw sets its
// tool children's oom_score_adj to 1000), and a restart would end it too.
const kMbBytes = 1024 * 1024;
const mb = (bytes) => Math.round(bytes / kMbBytes);
const describeChildAlert = ({ largestChild, workerRssBytes }, { usedBytes, limitBytes }) => {
  const command = processCommand.readProcessCommand(largestChild.pid);
  const subject = command ? `\`${command}\`, a process the gateway started,`
    : "A process the gateway started (its name could not be read)";
  const container = Number.isFinite(usedBytes) && Number.isFinite(limitBytes) && limitBytes > 0
    ? ` The container working set is ${mb(usedBytes)} MB of its ${mb(limitBytes)} MB limit (${Math.round((usedBytes / limitBytes) * 100)}%)` +
      (workerRssBytes !== null ? `, and the gateway worker is ${mb(workerRssBytes)} MB.` : ".")
    : "";
  return [
    `${subject} is using ${mb(largestChild.rssBytes)} MB.${container}`,
    "If it keeps growing, the kernel will kill it when the container runs out of memory. OpenClaw marks the processes it starts as the kernel's first choice, so the gateway keeps running.",
    "The watchdog will not restart the gateway or stop the process, because a restart would end the process too. To let it finish, stop other work in the container or give the container more memory.",
  ];
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
        "🐺 *AlphaClaw Watchdog*", withViewLogsSuffix("🔴 Container memory critical: a tool process, not the gateway"),
        ...describeChildAlert(detail, current),
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

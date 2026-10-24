// The owner's container-memory notices (ALPH-17, ALPH-25). Commands are the
// plain-token basenames process-command.js returns; no argv, path or pid ever
// reaches a sentence. Sizes under 10 GB read in MB, larger ones in GB.
const kMiB = 1024 * 1024;
const kGiB = 1024 * kMiB;
const size = (bytes) => bytes >= 10 * kGiB ? `${(bytes / kGiB).toFixed(1)} GB` : `${Math.round(bytes / kMiB)} MB`;
const rate = (bytesPerMin) => bytesPerMin >= 0.1 * kGiB
  ? `${(bytesPerMin / kGiB).toFixed(1)} GB/min` : `${Math.round(bytesPerMin / kMiB)} MB/min`;
const duration = (ms) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return minutes < 120 ? `about ${minutes} minute${minutes === 1 ? "" : "s"}` : `about ${Math.round(minutes / 60)} hours`;
};
const plural = (count, noun) => `${count} ${noun}${count === 1 ? "" : "s"}`;

const kBasisPhrases = {
  non_reclaimable: "not counting reclaimable page cache",
  working_set: "not counting inactive page cache",
  raw: "page cache included",
};
const kCounterNames = { "memory.events": (counter) => `memory.events ${counter}`, "memory.failcnt": () => "memory.failcnt" };

// Usage against the limit, then the reclaim evidence that latched it: PSI
// avg60 and any limit counter that rose since the previous sample.
const describeContainerUsage = ({ usedBytes, limitBytes, basis = null, workerRssBytes = null, evidence = null, etaMs = null }) => {
  if (!Number.isFinite(usedBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) return "";
  const qualifier = kBasisPhrases[basis] ? `, ${kBasisPhrases[basis]}` : "";
  const parts = [`The container is using ${size(usedBytes)} of its ${size(limitBytes)} limit (${Math.round((usedBytes / limitBytes) * 100)}%${qualifier})` +
    (Number.isFinite(workerRssBytes) ? `, and the gateway worker is ${size(workerRssBytes)}.` : ".")];
  if (evidence?.status === "unavailable") {
    parts.push("Memory pressure (PSI) and the cgroup's limit counters cannot be read here, so this alert rests on usage alone.");
  } else if (evidence) {
    if (evidence.psiSomeAvg60 !== null) {
      parts.push(`Memory pressure over the last minute (PSI avg60): some ${evidence.psiSomeAvg60.toFixed(1)}%` +
        (evidence.psiFullAvg60 !== null ? `, full ${evidence.psiFullAvg60.toFixed(1)}%.` : "."));
    }
    for (const fired of evidence.counters || []) {
      parts.push(`${(kCounterNames[fired.source] ?? kCounterNames["memory.events"])(fired.counter)} rose by ${fired.delta} since the previous sample.`);
    }
  }
  if (Number.isFinite(etaMs) && etaMs > 0) parts.push(`At the current rate the container reaches its limit in ${duration(etaMs)}.`);
  return parts.join(" ");
};

// What happens at the limit, from container-limit.js's evidence.
const describeLimitOutcome = (behavior, { subject }) => {
  if (behavior?.kind === "kernel_kills") {
    if (subject === "child") {
      return "If it keeps growing, the kernel will kill it when the container runs out of memory. OpenClaw marks the processes it starts as the kernel's first choice, so the gateway keeps running.";
    }
    return `If usage keeps growing, the kernel will kill a process when the container runs out of memory, as it already has ${plural(behavior.oomKills, "time")} in this container. ` +
      "It takes the tool processes OpenClaw marks as its first choice, then usually the largest process, which can be the gateway.";
  }
  const lead = subject === "child" ? "If it keeps growing" : "If usage keeps growing";
  const outcome = behavior?.kind === "instance_restart"
    ? behavior.restartsAtLimit
      ? `${lead}, ${behavior.platformLabel} will restart the whole container when it reaches its limit, and the gateway goes down with it.`
      : `${lead}, ${behavior.platformLabel} is likely to restart the whole container when it reaches its limit, and the gateway would go down with it.`
    : `${lead}, the whole container, gateway included, is likely to restart when it reaches its limit.`;
  if (behavior?.oomKills !== 0) return outcome;
  return `${outcome} The kernel has not killed any process in this container` +
    (behavior.limitHits > 0 ? `, though usage has reached the limit ${plural(behavior.limitHits, "time")}.` : ".");
};

const describeChildAlert = ({ command, rssBytes, usage, behavior }) => [
  `${command ? `\`${command}\`, a process the gateway started,` : "A process the gateway started (its name could not be read)"} is using ${size(rssBytes)}.${usage ? ` ${usage}` : ""}`,
  describeLimitOutcome(behavior, { subject: "child" }),
  "The watchdog will not restart the gateway or stop the process, because a restart would end the process too. To let it finish, stop other work in the container or give the container more memory.",
];

const describeOutsideAlert = ({ command, rssBytes, growthBytesPerMin, usage, behavior }) => [
  `${command ? `\`${command}\`, a process outside the gateway,` : "A process outside the gateway (its name could not be read)"} is using ${size(rssBytes)}` +
    (growthBytesPerMin > 0 ? ` and growing at ${rate(growthBytesPerMin)}.` : ".") + (usage ? ` ${usage}` : ""),
  describeLimitOutcome(behavior, { subject: "process" }),
  "The watchdog will not stop the process or restart the gateway, which would not free this memory. To keep the gateway up, stop that process or give the container more memory.",
];

const describeGenericAlert = ({ usage, split, behavior, largest = null }) => [
  `${usage ? `${usage} ` : ""}Inspect gateway and co-resident load.`,
  ...(largest ? [`The largest process ${largest.outside ? "outside the gateway" : "in the container"} is ${largest.command ? `\`${largest.command}\`` : "one whose name could not be read"}, at ${size(largest.rssBytes)}` +
    (largest.growthBytesPerMin > 0 ? ` and growing at ${rate(largest.growthBytesPerMin)}.` : ".")] : []),
  ...(split ? [split] : []),
  describeLimitOutcome(behavior, { subject: "container" }),
  "Container pressure alone does not authorize a gateway restart.",
];

const describeRestartAtLimit = ({ atMs, usedBytes, limitBytes, largest }) => {
  const at = new Date(atMs).toISOString().slice(11, 16);
  return [
    `AlphaClaw restarted after the container hit its memory limit${largest
      ? `; the largest process was ${largest.command ? `\`${largest.command}\`` : "a process whose name could not be read"} at ${size(largest.rssBytes)}` : ""}.`,
    `The previous AlphaClaw process ended without shutting down while the container was at ${size(usedBytes)} of its ${size(limitBytes)} limit (${Math.round((usedBytes / limitBytes) * 100)}%, last sampled at ${at} UTC). The watchdog did not restart it.`,
    "To stop this from repeating, find what fills the container or give it more memory.",
  ];
};

module.exports = { describeContainerUsage, describeLimitOutcome, describeChildAlert, describeOutsideAlert,
  describeGenericAlert, describeRestartAtLimit, formatSize: size };

// The owner's disk-space notices and the shared size wording. Sizes of a GB
// or more read in GB, smaller ones in MB. Paths are the operator's own
// directories; backticks and newlines are flattened so a path cannot break
// the chat formatting.
const kMiB = 1024 * 1024;
const kGiB = 1024 * kMiB;

const formatBytes = (bytes) => {
  if (!Number.isFinite(bytes)) return "an unknown amount";
  const abs = Math.abs(bytes);
  if (abs >= 100 * kGiB) return `${Math.round(bytes / kGiB)} GB`;
  if (abs >= kGiB) return `${(bytes / kGiB).toFixed(1)} GB`;
  return `${Math.max(0, Math.round(bytes / kMiB))} MB`;
};

const formatDuration = (ms) => {
  const minutes = Math.max(1, Math.round((ms ?? 0) / 60_000));
  if (minutes < 120) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} hours` : `${Math.round(hours / 24)} days`;
};

const flattenPath = (value) => String(value ?? "").replace(/[`\r\n\u2028\u2029]+/g, "'");

const kVolumeLabels = Object.freeze({
  state: "OpenClaw's state",
  diagnostic: "Node's diagnostic reports and heap snapshots",
  report: "Node's diagnostic reports",
});

const volumeName = (volume) => flattenPath(volume.mountPath || volume.path || "the volume");

const describeUsage = (volume) => {
  const percent = Number.isFinite(volume.freePercent) ? ` (${volume.freePercent}% free)` : "";
  return `${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.sizeBytes)}${percent} on the volume that holds ${kVolumeLabels[volume.id] ?? "AlphaClaw's data"} (\`${flattenPath(volume.path)}\`).`;
};

const describeTrend = (volume) => {
  if (!volume.trendSustained || !Number.isFinite(volume.growthBytesPerHour) || volume.growthBytesPerHour <= 0) {
    return "No sustained growth has been measured yet.";
  }
  const eta = Number.isFinite(volume.etaMs) ? ` At this rate it is full in about ${formatDuration(volume.etaMs)}.` : "";
  return `Used space grew at ${formatBytes(volume.growthBytesPerHour)}/hour over the last ${formatDuration(volume.trendWindowMs)}.${eta}`;
};

const describeGrowers = (report) => {
  if (!report) return ["The size census of AlphaClaw's directories did not run, so the growers are unknown."];
  const estimate = report.truncated ? " These sizes are estimates: the census stopped at its time or file budget." : "";
  if (!report.entries?.length) {
    return [report.basis === "growth"
      ? `No watched directory grew in the last ${formatDuration(report.windowMs)}; the growth is outside AlphaClaw's directories.${estimate}`
      : `The size census found no readable directories on this volume.${estimate}`];
  }
  const header = report.basis === "growth"
    ? `Fastest-growing directories over the last ${formatDuration(report.windowMs)}:`
    : "There is no earlier size census to compare with yet, so these are the largest directories:";
  return [
    header,
    ...report.entries.map((entry) => report.basis === "growth"
      ? `• \`${flattenPath(entry.path)}\` +${formatBytes(entry.growthBytes)} (now ${formatBytes(entry.bytes)})`
      : `• \`${flattenPath(entry.path)}\` ${formatBytes(entry.bytes)}`),
    ...(estimate ? [estimate.trim()] : []),
  ];
};

const kAdvice = "The watchdog deletes nothing. Find what is growing and free space there; heap snapshots (*.heapsnapshot) and OpenClaw's cache directory are the usual suspects. Never delete OpenClaw's state databases.";

const describeHeadline = (volume, tier, trigger) => {
  const name = volumeName(volume);
  if (trigger === "eta" && Number.isFinite(volume.etaMs)) {
    return `${tier === "critical" ? "🔴" : "🟡"} Disk filling fast on ${name}: full in about ${formatDuration(volume.etaMs)}`;
  }
  return tier === "critical" ? `🔴 Disk almost full on ${name}` : `🟡 Disk space low on ${name}`;
};

const describeEpisodeNotice = ({ volume, tier, trigger, growers }) => [
  describeUsage(volume),
  describeTrend(volume),
  ...describeGrowers(growers),
  tier === "critical"
    ? "When the volume is full, OpenClaw can no longer write its state and the gateway stops working. " + kAdvice
    : kAdvice,
  "Run Doctor for a guided diagnosis.",
];

const describeClearedNotice = ({ volume, durationMs, tier }) => [
  describeUsage(volume),
  `The episode lasted ${formatDuration(durationMs)}${tier === "critical" ? " and reached critical" : ""}.`,
];

module.exports = {
  formatBytes,
  formatDuration,
  flattenPath,
  volumeName,
  kVolumeLabels,
  describeUsage,
  describeTrend,
  describeGrowers,
  describeHeadline,
  describeEpisodeNotice,
  describeClearedNotice,
};

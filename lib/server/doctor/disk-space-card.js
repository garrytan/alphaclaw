const { formatBytes, formatDuration, kVolumeLabels } = require("../disk-space/notice");

const kEpisodeIdPattern = /^disk-(state|diagnostic|report)-\d{1,16}$/;
const kMaxEvidenceGrowers = 5;

// One card per volume with an open disk-space episode (watchdog
// getDiskSpace()). Episode-scoped sourceKeys: dismissing one episode never
// hides the next, and the severity suffix keeps "dismissing low never hides
// critical". Critical REPLACES the low card. No card once the episode clears.
const buildDiskSpaceCards = (diskSpace, { sanitize = (text) => String(text ?? "") } = {}) => {
  const cards = [];
  for (const volume of Array.isArray(diskSpace?.volumes) ? diskSpace.volumes : []) {
    if (volume?.state !== "low" && volume?.state !== "critical") continue;
    if (typeof volume.episodeId !== "string" || !kEpisodeIdPattern.test(volume.episodeId)) continue;
    if (!Number.isFinite(volume.freeBytes) || !Number.isFinite(volume.sizeBytes) || volume.sizeBytes <= 0) continue;
    const critical = volume.state === "critical";
    const where = sanitize(volume.mountPath || volume.path || "");
    const label = kVolumeLabels[volume.id] ?? "AlphaClaw's data";
    const percent = Math.round((volume.freeBytes / volume.sizeBytes) * 1000) / 10;
    const stats = `${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.sizeBytes)} (${percent}%)`;
    const eta = Number.isFinite(volume.etaMs) && Number.isFinite(volume.growthBytesPerHour)
      ? ` Used space is growing at ${formatBytes(volume.growthBytesPerHour)}/hour; at this rate the volume is full in about ${formatDuration(volume.etaMs)}.`
      : "";
    const growers = volume.growers && Array.isArray(volume.growers.entries) ? volume.growers : null;
    const growerLines = growers ? growers.entries.slice(0, kMaxEvidenceGrowers)
      .filter((entry) => typeof entry?.path === "string" && Number.isFinite(entry.bytes))
      .map((entry) => ({
        type: "text",
        text: sanitize(growers.basis === "growth" && Number.isFinite(entry.growthBytes)
          ? `${entry.path}: +${formatBytes(entry.growthBytes)} in ${formatDuration(growers.windowMs)} (now ${formatBytes(entry.bytes)})`
          : `${entry.path}: ${formatBytes(entry.bytes)}`),
      })) : [];
    const growerHeader = !growers
      ? "The size census has not run for this episode, so the growing directories are unknown."
      : growers.basis === "growth"
        ? `Fastest-growing directories over ${formatDuration(growers.windowMs)}${growers.truncated ? " (estimates; the census stopped at its budget)" : ""}:`
        : `No earlier size census to compare with; largest directories${growers.truncated ? " (estimates; the census stopped at its budget)" : ""}:`;
    cards.push({
      sourceKey: `det:disk-space-${critical ? "critical" : "low"}:${volume.episodeId}`,
      priority: critical ? "P0" : "P1",
      category: "workspace state",
      title: critical ? "The disk is almost full" : "Disk space is running low",
      summary: `The volume at ${where} that holds ${label} has ${stats}.${eta}` +
        (critical ? " When it fills, OpenClaw can no longer write its state and the gateway stops working." : ""),
      recommendation: "Find what is growing and free space there. Heap snapshots (*.heapsnapshot) and OpenClaw's cache directory " +
        "are the usual suspects; never delete OpenClaw's state databases.",
      evidence: [
        { type: "text", text: sanitize(`${where}: ${stats}${eta} (episode ${volume.episodeId})`) },
        { type: "text", text: growerHeader },
        ...growerLines,
      ],
      targetPaths: [],
      fixPrompt: "Read `alphaclaw admin GET /api/watchdog/resources` and inspect `resources.diskSpace`: each volume's free space, " +
        "growth rate, projected time to full and the fastest-growing directories. Diagnose what is writing before deleting anything: " +
        "measure the listed directories with `du -sh` (stay on one filesystem with `-x`) and identify the process writing there. " +
        "The usual suspects are heap snapshots (`*.heapsnapshot`, written by Node's --heapsnapshot-near-heap-limit into the diagnostic " +
        "directory or the working directory) and OpenClaw's cache directory. Never delete or truncate OpenClaw's state databases " +
        "(`*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`) or anything under the state directory you cannot identify. Propose the " +
        "cleanup and the change that stops the growth, and confirm with the owner before removing files.",
    });
  }
  return cards;
};

module.exports = { buildDiskSpaceCards };

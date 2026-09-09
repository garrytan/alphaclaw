const { kDefaultMonitorConfig } = require("../gateway-memory-monitor");

const formatMb = (value) => Number.isFinite(value) && value >= 0
  ? `${Math.round(value / (1024 * 1024))} MiB` : "unknown";
const validIso = (value) => {
  if (typeof value !== "string") return null;
  const atMs = Date.parse(value);
  return Number.isFinite(atMs) && new Date(atMs).toISOString() === value ? atMs : null;
};

// Container episodes survive a gateway exit and missing samples. The card is
// independently scoped so dismissing a gateway finding never hides this one.
const buildContainerMemoryCard = (container, { nowMs = Date.now() } = {}) => {
  if (container?.state !== "critical" || typeof container.episodeId !== "string" ||
    !/^container-\d{1,16}$/.test(container.episodeId)) return null;
  const sampledMs = validIso(container.sampledAt);
  const fresh = container.sampleStatus === "fresh" && sampledMs !== null &&
    sampledMs <= nowMs && nowMs - sampledMs <= kDefaultMonitorConfig.maxSampleAgeMs;
  const stats = `${fresh ? "Latest measured" : "Last known"} container usage: ` +
    `${formatMb(container.usedBytes)} / ${formatMb(container.limitBytes)} limit.`;
  const availability = fresh
    ? ` Sampled at ${container.sampledAt}.`
    : ` Fresh evidence unavailable; ${sampledMs === null ? "sample time unknown" : `last sample at ${container.sampledAt}`}.`;
  return {
    sourceKey: `det:container-memory-critical:${container.episodeId}`,
    priority: "P0",
    category: "workspace state",
    title: "Container memory pressure requires attention",
    summary: `The container pressure episode remains unresolved. ${stats}${availability}`,
    recommendation: "Inspect measured container usage and gateway/co-resident load. " +
      "Container pressure alone does not authorize a gateway restart; confirm fresh measurements before acting.",
    evidence: [{ type: "text", text: `${stats}${availability} (episode ${container.episodeId})` }],
    targetPaths: [],
    fixPrompt: "Read `alphaclaw admin GET /api/watchdog/resources` and inspect the independent " +
      "container pressure state, sample freshness, usage and limit. Compare gateway group RSS and " +
      "co-resident load without subtracting summed RSS from container usage. Missing readings " +
      "do not clear the episode. Diagnose the contributing workload before proposing a change; " +
      "container pressure alone does not authorize a gateway restart or a heap increase.",
  };
};

module.exports = { buildContainerMemoryCard };

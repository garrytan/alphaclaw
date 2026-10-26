import { useState } from "preact/hooks";
import { usePolling } from "../../../hooks/usePolling.js";
import { fetchBoxView } from "../../../lib/api/box.js";

// The Box card's reads (ALPH-40). Every view is cached server-side, so the
// cadences only decide how fresh the card looks: one minute for the cheap
// views, five for the disk census (the server keeps it five minutes anyway).
// Nothing polls while the card is collapsed except the summary views.
const kSummaryIntervalMs = 60_000;
const kDiskIntervalMs = 5 * 60_000;

export const useWatchdogBox = () => {
  const [expanded, setExpanded] = useState(false);
  const processes = usePolling(() => fetchBoxView("processes", { limit: "8" }), kSummaryIntervalMs, { cacheKey: "/api/box/processes?limit=8" });
  const restart = usePolling(() => fetchBoxView("restart"), kSummaryIntervalMs, { cacheKey: "/api/box/restart" });
  const mcp = usePolling(() => fetchBoxView("mcp"), kSummaryIntervalMs, { cacheKey: "/api/box/mcp" });
  const schedules = usePolling(() => fetchBoxView("schedules"), kSummaryIntervalMs, { cacheKey: "/api/box/schedules", enabled: expanded });
  const disk = usePolling(() => fetchBoxView("disk"), kDiskIntervalMs, { cacheKey: "/api/box/disk", enabled: expanded });
  const reads = { processes, restart, mcp, schedules, disk };
  return {
    box: Object.fromEntries(Object.entries(reads).map(([view, read]) => [view, read.data || null])),
    boxErrors: Object.fromEntries(Object.entries(reads).map(([view, read]) => [view, read.error || null])),
    boxExpanded: expanded,
    setBoxExpanded: setExpanded,
    refreshBox: () => Object.values(reads).forEach((read) => read.refresh()),
  };
};

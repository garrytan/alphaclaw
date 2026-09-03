import { useState } from "preact/hooks";
import { usePolling } from "../../../hooks/usePolling.js";
import { fetchWatchdogResources } from "../../../lib/api.js";

export const useWatchdogResources = () => {
  const resourcesPoll = usePolling(() => fetchWatchdogResources(), 5000, {
    cacheKey: "/api/watchdog/resources",
    dedupeInFlight: true,
  });
  const [memoryExpanded, setMemoryExpanded] = useState(false);
  return {
    resources: resourcesPoll.data?.resources || null,
    // Boot-computed machine capacity profile (absent on older servers). The
    // Resources card renders it as the capacity header and the Autotune card
    // watches its detectedAt to catch live container resizes.
    resourcesProfile: resourcesPoll.data?.profile || null,
    // Exposed so the card can keep its frame on a failed poll: inline error
    // while loading failed, stale note when old values are still shown.
    resourcesError: resourcesPoll.error,
    refreshResources: resourcesPoll.refresh,
    memoryExpanded,
    setMemoryExpanded,
  };
};

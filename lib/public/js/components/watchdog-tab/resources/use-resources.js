import { useState } from "preact/hooks";
import { usePolling } from "../../../hooks/usePolling.js";
import { fetchWatchdogResources } from "../../../lib/api.js";

export const useWatchdogResources = () => {
  const resourcesPoll = usePolling(() => fetchWatchdogResources(), 5000);
  const [memoryExpanded, setMemoryExpanded] = useState(false);
  return {
    resources: resourcesPoll.data?.resources || null,
    // Exposed so the card can keep its frame on a failed poll: inline error
    // while loading failed, stale note when old values are still shown.
    resourcesError: resourcesPoll.error,
    refreshResources: resourcesPoll.refresh,
    memoryExpanded,
    setMemoryExpanded,
  };
};

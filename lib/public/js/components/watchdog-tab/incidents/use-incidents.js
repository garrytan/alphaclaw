import { useEffect } from "preact/hooks";
import { usePolling } from "../../../hooks/usePolling.js";
import { fetchWatchdogEvents } from "../../../lib/api.js";

export const useWatchdogIncidents = ({
  restartSignal = 0,
  onRefreshStatuses = () => {},
} = {}) => {
  const eventsPoll = usePolling(() => fetchWatchdogEvents(20), 15000, {
    cacheKey: "/api/watchdog/events?limit=20",
    dedupeInFlight: true,
  });

  useEffect(() => {
    if (!restartSignal) return;
    onRefreshStatuses();
    eventsPoll.refresh();
    const t1 = setTimeout(() => {
      onRefreshStatuses();
      eventsPoll.refresh();
    }, 1200);
    const t2 = setTimeout(() => {
      onRefreshStatuses();
      eventsPoll.refresh();
    }, 3500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [restartSignal, onRefreshStatuses, eventsPoll.refresh]);

  return {
    events: eventsPoll.data?.events || [],
    // Loaded/error travel separately so a failed fetch never renders as a
    // confident "No incidents recorded." — the card distinguishes loading,
    // error (+Retry), stale-with-error, and genuinely empty.
    eventsLoaded: !!eventsPoll.data,
    eventsError: eventsPoll.error,
    refreshingEvents: eventsPoll.isPolling,
    refreshEvents: eventsPoll.refresh,
  };
};

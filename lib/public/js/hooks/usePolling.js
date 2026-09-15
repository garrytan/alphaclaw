import { useState, useEffect, useCallback } from "preact/hooks";
import { useCachedFetch } from "./use-cached-fetch.js";

export const usePolling = (
  fetcher,
  interval,
  {
    enabled = true,
    pauseWhenHidden = true,
    cacheKey = "",
    // Kept for call-site compatibility: all periodic reads now deduplicate.
    dedupeInFlight: _dedupeInFlight = true,
    timeoutMs,
    acceptsSignal = false,
  } = {},
) => {
  const read = useCachedFetch(cacheKey, fetcher, {
    initialFetch: false,
    subscribeEnabled: enabled,
    maxAgeMs: 0,
    staleWhileRevalidate: false,
    timeoutMs,
    acceptsSignal,
  });
  const [isDocumentVisible, setIsDocumentVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );

  useEffect(() => {
    if (!enabled || (pauseWhenHidden && !isDocumentVisible)) return;
    // Failure lives in the shared snapshot. A denied key parks here until a
    // human force-refreshes it; a slow request is joined instead of replaced.
    const poll = () => read.refresh().catch(() => null);
    poll();
    const intervalId = setInterval(poll, interval);
    return () => clearInterval(intervalId);
  }, [enabled, interval, pauseWhenHidden, isDocumentVisible, read.refresh]);

  useEffect(() => {
    if (!pauseWhenHidden || typeof document === "undefined") return;
    const handleVisibilityChange = () => setIsDocumentVisible(!document.hidden);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [pauseWhenHidden]);

  // Preserve usePolling's null-on-failure imperative refresh contract.
  const refresh = useCallback((options) => read.refresh(options).catch(() => null), [read.refresh]);
  return { data: read.data, error: read.error, refresh, isPolling: read.isFetching, stale: read.stale };
};

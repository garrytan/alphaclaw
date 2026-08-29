import { useState, useEffect, useCallback, useRef } from "preact/hooks";
import { getCached, setCached } from "../lib/api-cache.js";

export const usePolling = (
  fetcher,
  interval,
  {
    enabled = true,
    pauseWhenHidden = true,
    cacheKey = "",
    dedupeInFlight = false,
  } = {},
) => {
  const normalizedCacheKey = String(cacheKey || "");
  const [data, setData] = useState(() =>
    normalizedCacheKey ? getCached(normalizedCacheKey) : null,
  );
  const [error, setError] = useState(null);
  const [isPolling, setIsPolling] = useState(false);
  // Visibility is reactive state (not a render-time read of document.hidden)
  // so mounting while hidden still starts the recurring interval once the
  // tab becomes visible — the interval effect re-runs on this dependency.
  const [isDocumentVisible, setIsDocumentVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );
  const fetcherRef = useRef(fetcher);
  const inFlightRefreshRef = useRef(null);
  const activeRefreshCountRef = useRef(0);
  const nextRefreshIdRef = useRef(0);
  const latestRefreshIdRef = useRef(0);
  fetcherRef.current = fetcher;

  const refresh = useCallback(async ({ force = false } = {}) => {
    if (dedupeInFlight && inFlightRefreshRef.current && !force) {
      return inFlightRefreshRef.current;
    }
    const refreshId = nextRefreshIdRef.current + 1;
    nextRefreshIdRef.current = refreshId;
    latestRefreshIdRef.current = refreshId;
    activeRefreshCountRef.current += 1;
    setIsPolling(true);
    const refreshPromise = Promise.resolve().then(async () => {
      try {
        const result = await fetcherRef.current();
        if (latestRefreshIdRef.current === refreshId) {
          if (normalizedCacheKey) {
            setCached(normalizedCacheKey, result);
          }
          setData(result);
          setError(null);
        }
        return result;
      } catch (err) {
        if (latestRefreshIdRef.current === refreshId) {
          setError(err);
        }
        return null;
      } finally {
        activeRefreshCountRef.current = Math.max(
          0,
          activeRefreshCountRef.current - 1,
        );
        setIsPolling(activeRefreshCountRef.current > 0);
        if (inFlightRefreshRef.current === refreshPromise) {
          inFlightRefreshRef.current = null;
        }
      }
    });
    if (dedupeInFlight) {
      inFlightRefreshRef.current = refreshPromise;
    }
    return refreshPromise;
  }, [dedupeInFlight, normalizedCacheKey]);

  useEffect(() => {
    if (!normalizedCacheKey) return;
    const cached = getCached(normalizedCacheKey);
    if (cached !== null) {
      setData(cached);
    }
  }, [normalizedCacheKey]);

  useEffect(() => {
    if (!enabled) return;
    if (pauseWhenHidden && !isDocumentVisible) {
      return undefined;
    }
    refresh();
    const intervalId = setInterval(refresh, interval);
    return () => clearInterval(intervalId);
  }, [enabled, interval, pauseWhenHidden, isDocumentVisible, refresh]);

  // Tracked regardless of `enabled` so the visibility state can never go
  // stale while a poll is disabled (becoming visible during a poll re-run
  // handles the refresh via the interval effect above).
  useEffect(() => {
    if (!pauseWhenHidden || typeof document === "undefined") return;
    const handleVisibilityChange = () => {
      setIsDocumentVisible(!document.hidden);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [pauseWhenHidden]);

  return { data, error, refresh, isPolling };
};

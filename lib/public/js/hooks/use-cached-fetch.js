import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { cachedFetch, getCached } from "../lib/api-cache.js";

export const useCachedFetch = (
  key,
  fetcher,
  {
    enabled = true,
    maxAgeMs = 15000,
    staleWhileRevalidate = true,
  } = {},
) => {
  const normalizedKey = useMemo(() => String(key || ""), [key]);
  const initialCachedData = useMemo(() => getCached(normalizedKey), [normalizedKey]);
  const [data, setData] = useState(initialCachedData);
  const [loading, setLoading] = useState(initialCachedData === null);
  const [error, setError] = useState(null);
  // fetcher lives in a ref (usePolling pattern): an inline-lambda fetcher must
  // not re-trigger the mount effect every render — that was a measured
  // refetch-loop source (webhook detail, agent pairing, models tab).
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  // Latest-request-wins for the hook's LOCAL state: cache generations protect
  // the shared cache, but without this an older refresh() resolving late
  // could overwrite newer data/error/loading.
  const latestRefreshIdRef = useRef(0);

  useEffect(() => {
    // Full reset on key change: without clearing error/loading, a per-entity
    // consumer switching keys shows the PREVIOUS entity's error attributed to
    // the new one, plus a confident-empty frame (data=null, loading=false)
    // while the new key's fetch is still in flight.
    const cached = getCached(normalizedKey);
    setData(cached);
    setError(null);
    setLoading(cached === null);
  }, [normalizedKey]);

  const refresh = useCallback(
    async ({ force = false } = {}) => {
      if (!enabled) return getCached(normalizedKey);
      const refreshId = ++latestRefreshIdRef.current;
      if (getCached(normalizedKey) === null) {
        setLoading(true);
      }
      try {
        const next = await cachedFetch(normalizedKey, () => fetcherRef.current(), {
          maxAgeMs,
          force,
          staleWhileRevalidate,
          onRevalidate: (revalidatedData) => {
            if (latestRefreshIdRef.current === refreshId) {
              setData(revalidatedData);
              setError(null);
            }
          },
        });
        if (latestRefreshIdRef.current === refreshId) {
          setData(next);
          setError(null);
        }
        return next;
      } catch (err) {
        if (latestRefreshIdRef.current === refreshId) {
          setError(err);
        }
        throw err;
      } finally {
        if (latestRefreshIdRef.current === refreshId) {
          setLoading(false);
        }
      }
    },
    [enabled, maxAgeMs, normalizedKey, staleWhileRevalidate],
  );

  useEffect(() => {
    if (!enabled) return;
    refresh().catch(() => {});
  }, [enabled, refresh]);

  return {
    data,
    error,
    loading,
    refresh,
  };
};

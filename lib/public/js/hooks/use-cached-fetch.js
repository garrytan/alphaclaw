import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { cachedFetch, getCached, getCacheSnapshot, invalidateCache, subscribeCache } from "../lib/api-cache.js";

let nextPrivateKey = 0;

export const useCachedFetch = (
  key,
  fetcher,
  {
    enabled = true,
    maxAgeMs = 15000,
    staleWhileRevalidate = true,
    initialFetch = true,
    timeoutMs,
    // Explicit adapters only: legacy fetchers may have positional arguments.
    acceptsSignal = false,
  } = {},
) => {
  const privateKeyRef = useRef(null);
  if (!privateKeyRef.current) privateKeyRef.current = `private-read:${++nextPrivateKey}`;
  const normalizedKey = String(key || privateKeyRef.current);
  const [state, setState] = useState(() => ({ key: normalizedKey, snapshot: getCacheSnapshot(normalizedKey) }));
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  // Only committed entries supply rendered data. A superseded promise never
  // paints locally, and unsubscribe prevents writes into an unmounted hook.
  useEffect(() => {
    const unsubscribe = subscribeCache(normalizedKey, (snapshot) => {
      setState({ key: normalizedKey, snapshot });
    });
    return () => {
      unsubscribe();
      if (normalizedKey === privateKeyRef.current) invalidateCache(normalizedKey);
    };
  }, [normalizedKey]);

  const refresh = useCallback(
    async ({ force = false } = {}) => {
      if (!enabled) return getCached(normalizedKey);
      // Bind the current fetcher at dispatch. A render switching entity keys
      // before the work microtask runs must not fetch B into A's cache key.
      const requestFetcher = fetcherRef.current;
      return cachedFetch(normalizedKey,
        acceptsSignal
          ? ({ signal }) => requestFetcher({ signal })
          : () => requestFetcher(),
        { maxAgeMs, force, staleWhileRevalidate, timeoutMs, acceptsSignal },
      );
    },
    [enabled, maxAgeMs, normalizedKey, staleWhileRevalidate, timeoutMs, acceptsSignal],
  );

  useEffect(() => {
    if (enabled && initialFetch) refresh().catch(() => {});
  }, [enabled, initialFetch, refresh]);

  const snapshot = state.key === normalizedKey ? state.snapshot : getCacheSnapshot(normalizedKey);
  return {
    data: snapshot.data,
    error: snapshot.error,
    loading: !snapshot.loaded && !snapshot.error,
    isFetching: snapshot.fetching,
    stale: snapshot.stale,
    refresh,
  };
};

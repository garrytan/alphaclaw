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
    subscribeEnabled = enabled,
  } = {},
) => {
  const privateKeyRef = useRef(null);
  if (!privateKeyRef.current) privateKeyRef.current = `private-read:${++nextPrivateKey}`;
  const normalizedKey = String(key || privateKeyRef.current);
  const [state, setState] = useState(() => ({ key: normalizedKey, snapshot: getCacheSnapshot(normalizedKey) }));
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const observerRef = useRef(null);
  if (observerRef.current?.key !== normalizedKey || observerRef.current?.enabled !== subscribeEnabled) {
    // Each key/enable transition is a new observer lifetime, including
    // A -> B -> A. Ordinary rerenders must retain the same lifetime.
    observerRef.current = { key: normalizedKey, enabled: subscribeEnabled, active: true };
  }
  const observer = observerRef.current;

  // Only committed entries supply rendered data. A superseded promise never
  // paints locally, and unsubscribe prevents writes into an unmounted hook.
  useEffect(() => {
    observer.active = true;
    const unsubscribe = subscribeCache(normalizedKey, (snapshot) => {
      if (!observer.active || observerRef.current !== observer) return;
      // Disable fences this consumer, not a shared request another consumer
      // still owns. Access revocation must clear even a disabled pane.
      if (!observer.enabled && ![401, 403].includes(snapshot.error?.status)) return;
      setState({ key: normalizedKey, snapshot });
    });
    return () => {
      observer.active = false;
      unsubscribe();
      if (normalizedKey === privateKeyRef.current) invalidateCache(normalizedKey);
    };
  }, [normalizedKey, observer]);

  const refresh = useCallback(
    async ({ force = false, publishWhenDisabled = false } = {}) => {
      if (!enabled) return getCached(normalizedKey);
      const requestObserver = observerRef.current;
      if (!requestObserver.active || requestObserver.key !== normalizedKey) return getCached(normalizedKey);
      const publishDisabled = publishWhenDisabled && !requestObserver.enabled;
      // Bind the current fetcher at dispatch. A render switching entity keys
      // before the work microtask runs must not fetch B into A's cache key.
      const requestFetcher = fetcherRef.current;
      try {
        return await cachedFetch(normalizedKey,
          acceptsSignal
            ? ({ signal }) => requestFetcher({ signal })
            : () => requestFetcher(),
          { maxAgeMs, force, staleWhileRevalidate: publishDisabled ? false : staleWhileRevalidate, timeoutMs, acceptsSignal },
        );
      } finally {
        // A deliberate refresh of an already-disabled poll is new intent.
        // Its payload may have been superseded; publish only the committed
        // snapshot, and only into the observer that requested this refresh.
        if (publishDisabled && requestObserver.active && observerRef.current === requestObserver) {
          setState({ key: normalizedKey, snapshot: getCacheSnapshot(normalizedKey) });
        }
      }
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
    loading: subscribeEnabled && !snapshot.loaded && !snapshot.error,
    isFetching: subscribeEnabled && snapshot.fetching,
    stale: snapshot.stale,
    refresh,
  };
};

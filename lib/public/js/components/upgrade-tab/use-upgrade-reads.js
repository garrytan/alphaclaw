import { useCallback, useEffect, useRef } from "preact/hooks";
import { fetchOpenclawCatalog, fetchOpenclawChannel, fetchOpenclawRuns } from "../../lib/api.js";
import { cachedFetch, getCached, setCached } from "../../lib/api-cache.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { useVisibleInterval } from "../../hooks/use-visible-interval.js";
import { buildErrorEnvelopeModel } from "./helpers.js";

export const kChannelCacheKey = "/api/openclaw/channel";
const kCatalogCacheKey = "/api/openclaw/catalog";
const kReadOptions = { maxAgeMs: 60_000, acceptsSignal: true, initialFetch: false };
const kEmptyRuns = [];

export const useUpgradeReads = ({ catalogStaleFollowUpMs = 5000 } = {}) => {
  const channelRead = useCachedFetch(kChannelCacheKey, fetchOpenclawChannel, kReadOptions);
  const catalogRead = useCachedFetch(kCatalogCacheKey, fetchOpenclawCatalog, kReadOptions);
  const runsRead = useCachedFetch("/api/openclaw/runs", fetchOpenclawRuns, { initialFetch: false });
  const followedStale = useRef(false);
  const loadChannel = useCallback(async ({ fromCache = false } = {}) => {
    try { return await channelRead.refresh({ force: !fromCache }); } catch { return null; }
  }, [channelRead.refresh]);
  const loadCatalog = useCallback(async ({ refresh = false, fromCache = false } = {}) => {
    if (refresh) followedStale.current = false;
    try {
      const data = await cachedFetch(kCatalogCacheKey,
        ({ signal }) => fetchOpenclawCatalog({ refresh, signal }),
        { maxAgeMs: 60_000, force: !fromCache, acceptsSignal: true });
      return data?.catalog || null;
    } catch { return null; }
  }, []);

  useVisibleInterval(() => loadCatalog({ fromCache: true }), 10 * 60_000, {
    enabled: Boolean(catalogRead.data), immediate: false,
  });
  useEffect(() => {
    if (!catalogRead.data?.catalog?.stale || followedStale.current) return;
    const timer = setTimeout(() => {
      followedStale.current = true;
      loadCatalog();
    }, Math.max(0, catalogStaleFollowUpMs));
    return () => clearTimeout(timer);
  }, [catalogRead.data, loadCatalog, catalogStaleFollowUpMs]);

  const updateChannel = useCallback((mutate) => {
    const data = getCached(kChannelCacheKey);
    if (data) setCached(kChannelCacheKey, mutate(data));
  }, []);
  const loadRuns = useCallback(async () => {
    try { return (await runsRead.refresh({ force: true }))?.runs || kEmptyRuns; } catch { return null; }
  }, [runsRead.refresh]);
  return {
    channelInfo: channelRead.data,
    channelError: channelRead.error ? buildErrorEnvelopeModel(channelRead.error) : null,
    loadingChannel: channelRead.loading,
    catalog: catalogRead.data?.catalog || null,
    whatsNew: catalogRead.data?.whatsNew || null,
    catalogError: catalogRead.error ? buildErrorEnvelopeModel(catalogRead.error) : null,
    loadingCatalog: catalogRead.loading,
    refreshingCatalog: catalogRead.isFetching && Boolean(catalogRead.data),
    runs: runsRead.data?.runs || kEmptyRuns,
    runsError: runsRead.error,
    loadChannel, loadCatalog, loadRuns, updateChannel,
  };
};

const kApiCache = new Map();
// key -> { promise, generation } — in-flight bookkeeping is generation-aware:
// every write path (setCached, invalidateCache, force) bumps the key's
// generation, and a request may only (a) be deduped onto and (b) write the
// cache while its dispatch generation is still current. This kills the
// post-mutation stale-refresh class: a refresh after a PUT can never be
// satisfied by — or overwritten by — a request dispatched before the write.
const kInFlightByKey = new Map();
const kGenerationByKey = new Map();

// Only slow-moving, non-sensitive data survives a reload via sessionStorage:
// the release catalog takes seconds to rebuild upstream, while live status and
// incident data must never paint stale from a previous session.
const kSessionCacheKeyPrefixes = ["/api/openclaw/catalog"];
const kSessionStoragePrefix = "acApiCache:";

const isSessionPersistedKey = (key) =>
  kSessionCacheKeyPrefixes.some((prefix) => key.startsWith(prefix));

const getSessionStorage = () => {
  try {
    return globalThis.sessionStorage || null;
  } catch {
    return null;
  }
};

const persistEntry = (key, entry) => {
  if (!isSessionPersistedKey(key)) return;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.setItem(kSessionStoragePrefix + key, JSON.stringify(entry));
  } catch {
    // Quota/privacy-mode failures degrade to in-memory caching.
  }
};

const removePersistedEntry = (key) => {
  if (!isSessionPersistedKey(key)) return;
  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(kSessionStoragePrefix + key);
  } catch {}
};

const hydrateFromSessionStorage = () => {
  const storage = getSessionStorage();
  if (!storage) return;
  const keys = [];
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const storageKey = storage.key(i);
      if (storageKey && storageKey.startsWith(kSessionStoragePrefix)) {
        keys.push(storageKey);
      }
    }
  } catch {
    return;
  }
  for (const storageKey of keys) {
    // Per-entry: one corrupt persisted value must not abort hydration of the
    // remaining keys, and it gets removed so it can't break every future load.
    try {
      const key = storageKey.slice(kSessionStoragePrefix.length);
      if (!isSessionPersistedKey(key)) continue;
      const entry = JSON.parse(storage.getItem(storageKey));
      if (!entry || typeof entry.fetchedAt !== "number") continue;
      kApiCache.set(key, entry);
    } catch {
      try {
        storage.removeItem(storageKey);
      } catch {}
    }
  }
};

hydrateFromSessionStorage();

const nowMs = () => Date.now();

const currentGeneration = (key) => kGenerationByKey.get(key) || 0;

const bumpGeneration = (key) => {
  const next = currentGeneration(key) + 1;
  kGenerationByKey.set(key, next);
  return next;
};

const isFresh = (entry, maxAgeMs) => {
  if (!entry) return false;
  return nowMs() - Number(entry.fetchedAt || 0) < Number(maxAgeMs || 0);
};

export const getCached = (key = "") => {
  const normalizedKey = String(key || "");
  if (!normalizedKey) return null;
  return kApiCache.get(normalizedKey)?.data ?? null;
};

export const setCached = (key = "", data = null) => {
  const normalizedKey = String(key || "");
  if (!normalizedKey) return data;
  bumpGeneration(normalizedKey);
  const entry = {
    data,
    fetchedAt: nowMs(),
  };
  kApiCache.set(normalizedKey, entry);
  persistEntry(normalizedKey, entry);
  return data;
};

// "As of" stamp for cached data — epoch ms of the last successful fetch, or
// null when nothing is cached.
export const getCachedAt = (key = "") => {
  const normalizedKey = String(key || "");
  if (!normalizedKey) return null;
  const fetchedAt = kApiCache.get(normalizedKey)?.fetchedAt;
  return typeof fetchedAt === "number" ? fetchedAt : null;
};

export const invalidateCache = (key = "") => {
  const normalizedKey = String(key || "");
  if (!normalizedKey) return;
  // Bump so an in-flight request dispatched pre-invalidation can neither be
  // deduped onto by later reads nor write its (now obsolete) result.
  bumpGeneration(normalizedKey);
  kApiCache.delete(normalizedKey);
  kInFlightByKey.delete(normalizedKey);
  removePersistedEntry(normalizedKey);
};

// Invalidate every key sharing a prefix — for endpoints with query-scoped
// variants (e.g. "/api/models/config?agentId=...") whose responses embed
// global state a mutation just changed. An empty prefix is a no-op: it would
// otherwise nuke the whole cache by accident.
export const invalidateCachePrefix = (prefix = "") => {
  const normalizedPrefix = String(prefix || "");
  if (!normalizedPrefix) return;
  for (const key of [...kApiCache.keys()]) {
    if (key.startsWith(normalizedPrefix)) invalidateCache(key);
  }
  for (const key of [...kInFlightByKey.keys()]) {
    if (key.startsWith(normalizedPrefix)) invalidateCache(key);
  }
};

export const cachedFetch = async (
  key,
  fetcher,
  {
    maxAgeMs = 15000,
    force = false,
    staleWhileRevalidate = true,
    onRevalidate = null,
  } = {},
) => {
  const normalizedKey = String(key || "");
  if (!normalizedKey || typeof fetcher !== "function") {
    return fetcher();
  }

  const dispatch = () => {
    // force must NOT reuse an in-flight promise (it may predate the mutation
    // this refresh is meant to observe) — bump the generation and go fresh.
    const generation = force
      ? bumpGeneration(normalizedKey)
      : currentGeneration(normalizedKey);
    const requestPromise = Promise.resolve()
      .then(() => fetcher())
      .then((result) => {
        // A superseded request's result must never overwrite newer cache
        // state (its generation went stale via setCached/invalidate/force).
        if (currentGeneration(normalizedKey) === generation) {
          const freshEntry = { data: result, fetchedAt: nowMs() };
          kApiCache.set(normalizedKey, freshEntry);
          bumpGeneration(normalizedKey);
          persistEntry(normalizedKey, freshEntry);
        }
        return result;
      })
      .finally(() => {
        // Delete ONLY if the map still holds THIS promise — a superseded
        // request's cleanup must not evict its replacement (that would
        // re-open the stale-dedupe window this module exists to close).
        if (kInFlightByKey.get(normalizedKey)?.promise === requestPromise) {
          kInFlightByKey.delete(normalizedKey);
        }
      });
    kInFlightByKey.set(normalizedKey, { promise: requestPromise, generation });
    return requestPromise;
  };

  const entry = kApiCache.get(normalizedKey);
  if (!force && isFresh(entry, maxAgeMs)) {
    return entry.data;
  }

  if (!force && staleWhileRevalidate && entry) {
    const inFlight = kInFlightByKey.get(normalizedKey);
    const reusable =
      inFlight && inFlight.generation === currentGeneration(normalizedKey);
    if (!reusable) {
      const backgroundPromise = dispatch().then((result) => {
        if (typeof onRevalidate === "function") {
          onRevalidate(result);
        }
        return result;
      });
      // Nobody awaits a background revalidation — a failure must not become
      // an unhandled rejection (the stale entry stays; a later call retries).
      // Only this derived chain is marked handled: dedupe consumers awaiting
      // the stored in-flight promise still receive the rejection.
      backgroundPromise.catch(() => {});
    }
    return entry.data;
  }

  const inFlight = kInFlightByKey.get(normalizedKey);
  if (
    !force &&
    inFlight &&
    inFlight.generation === currentGeneration(normalizedKey)
  ) {
    return inFlight.promise;
  }

  return dispatch();
};

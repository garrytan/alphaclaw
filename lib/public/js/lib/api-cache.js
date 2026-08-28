const kApiCache = new Map();
const kInFlightByKey = new Map();

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
  try {
    for (let i = 0; i < storage.length; i += 1) {
      const storageKey = storage.key(i);
      if (!storageKey || !storageKey.startsWith(kSessionStoragePrefix)) continue;
      const key = storageKey.slice(kSessionStoragePrefix.length);
      if (!isSessionPersistedKey(key)) continue;
      const entry = JSON.parse(storage.getItem(storageKey));
      if (!entry || typeof entry.fetchedAt !== "number") continue;
      kApiCache.set(key, entry);
    }
  } catch {}
};

hydrateFromSessionStorage();

const nowMs = () => Date.now();

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
  kApiCache.delete(normalizedKey);
  kInFlightByKey.delete(normalizedKey);
  removePersistedEntry(normalizedKey);
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

  const entry = kApiCache.get(normalizedKey);
  if (!force && isFresh(entry, maxAgeMs)) {
    return entry.data;
  }

  if (!force && staleWhileRevalidate && entry) {
    if (!kInFlightByKey.has(normalizedKey)) {
      const backgroundPromise = Promise.resolve()
        .then(() => fetcher())
        .then((result) => {
          setCached(normalizedKey, result);
          if (typeof onRevalidate === "function") {
            onRevalidate(result);
          }
          return result;
        })
        // Nobody awaits a background revalidation — a failure must not become
        // an unhandled rejection. The stale entry stays; a later call retries.
        .catch(() => null)
        .finally(() => {
          kInFlightByKey.delete(normalizedKey);
        });
      kInFlightByKey.set(normalizedKey, backgroundPromise);
    }
    return entry.data;
  }

  if (kInFlightByKey.has(normalizedKey)) {
    return kInFlightByKey.get(normalizedKey);
  }

  const requestPromise = Promise.resolve()
    .then(() => fetcher())
    .then((result) => {
      setCached(normalizedKey, result);
      return result;
    })
    .finally(() => {
      kInFlightByKey.delete(normalizedKey);
    });
  kInFlightByKey.set(normalizedKey, requestPromise);
  return requestPromise;
};

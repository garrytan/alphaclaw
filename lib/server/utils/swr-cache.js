// Stale-while-revalidate cache for small-but-synchronous status readers
// (config/credential file reads). Seeds synchronously on first use, then
// serves the cached value and refreshes off the request tick, so the 2s SSE
// loop never runs sync FS work inline. (Upstream v0.9.36 design.)
//
// Lives in utils (not routes/system.js) because the openclaw-channel routes
// share it: a route module requiring another route module for one helper
// dragged the gateway spine into the channel routes' load graph.
//
// `shouldRefresh` (optional) is consulted before every background refresh:
// when it returns false the stale value keeps being served and no compute
// runs — the seam the state-DB quiet period uses to keep status readers off
// the db while a backup snapshots it. The first read still seeds.
const createSwrCache = (compute, ttlMs, { shouldRefresh = null } = {}) => {
  const cache = { value: undefined, fetchedAt: 0, seeded: false, refreshing: false };
  const refreshAllowed = () => typeof shouldRefresh !== "function" || shouldRefresh() !== false;
  const read = () => {
    const now = Date.now();
    if (!cache.seeded) {
      cache.value = compute();
      cache.fetchedAt = now;
      cache.seeded = true;
      return cache.value;
    }
    if (now - cache.fetchedAt >= ttlMs && !cache.refreshing && refreshAllowed()) {
      cache.refreshing = true;
      setImmediate(() => {
        try {
          cache.value = compute();
          cache.fetchedAt = Date.now();
        } catch {
          // keep stale value
        } finally {
          cache.refreshing = false;
        }
      });
    }
    return cache.value;
  };
  // Mutations that change what the cache reflects (env save, gateway
  // restart) invalidate so the next status read recomputes immediately.
  read.invalidate = () => {
    cache.seeded = false;
    cache.fetchedAt = 0;
  };
  return read;
};

module.exports = { createSwrCache };

// Shared api-cache keys whose exact string equality is load-bearing: the
// fetch side (useCachedFetch/cachedFetch) and the invalidation side
// (invalidateCache after mutations) live in different feature files, and a
// drifted literal silently breaks post-save freshness. Declare once here.
// (Model-catalog's key already lives in lib/model-catalog.js.)
export const kEnvCacheKey = "/api/env";
export const kModelsConfigCacheKey = "/api/models/config";
export const kCodexStatusCacheKey = "/api/codex/status";
export const kClaudeCodeStatusCacheKey = "/api/claude-code/status";

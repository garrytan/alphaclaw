import { fetchModels } from "./api.js";
import { cachedFetch } from "./api-cache.js";
import { getFeaturedModels } from "./model-config.js";

export const kModelCatalogCacheKey = "/api/models";
export const kModelCatalogPollIntervalMs = 3000;
export const kDefaultOnboardingModelKey = "anthropic/claude-opus-4-8";

export const getModelCatalogModels = (payload) =>
  Array.isArray(payload?.models) ? payload.models : [];

export const isModelCatalogRefreshing = (payload) =>
  Boolean(payload?.refreshing);

export const preloadModelCatalog = ({
  force = true,
  maxAgeMs = 30000,
} = {}) =>
  cachedFetch(kModelCatalogCacheKey, fetchModels, {
    force,
    maxAgeMs,
  });

export const getInitialOnboardingModelKey = ({
  catalog = [],
  currentModelKey = "",
} = {}) => {
  const normalizedCurrent = String(currentModelKey || "").trim();
  if (normalizedCurrent) return normalizedCurrent;
  const catalogHasKey = (key) =>
    catalog.some((model) => String(model?.key || "") === key);
  if (catalogHasKey(kDefaultOnboardingModelKey)) {
    return kDefaultOnboardingModelKey;
  }
  const featuredModels = getFeaturedModels(catalog);
  return String(featuredModels[0]?.key || catalog[0]?.key || "");
};

// OpenClaw 2026.8 defaults fresh OpenAI setups to GPT-5.6: an API-key setup to
// openai/gpt-5.6 (the Sol alias) and a Codex OAuth setup to the exact openai/gpt-5.6-sol.
// Apply that ONLY when the live catalog actually lists the model — a fresh install runs
// the stable pin, and preselecting a model the gateway cannot route is a broken first
// run (C8). `openai/gpt-5.6` and `openai/gpt-5.6-sol` are the same model (alias), so
// either satisfies the API-key case.
export const resolveOnboardingModelDefault = ({
  catalog = [],
  authProvider = "",
  currentModelKey = "",
} = {}) => {
  const normalizedCurrent = String(currentModelKey || "").trim();
  if (normalizedCurrent) return normalizedCurrent;
  const has = (key) => catalog.some((model) => String(model?.key || "") === key);
  const provider = String(authProvider || "").trim();
  if (provider === "openai-codex" && has("openai/gpt-5.6-sol")) {
    return "openai/gpt-5.6-sol";
  }
  if (provider === "openai") {
    if (has("openai/gpt-5.6")) return "openai/gpt-5.6";
    // The alias resolves to Sol; if the catalog only lists the exact id, use it.
    if (has("openai/gpt-5.6-sol")) return "openai/gpt-5.6-sol";
  }
  return getInitialOnboardingModelKey({ catalog, currentModelKey });
};

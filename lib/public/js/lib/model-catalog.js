import { fetchModels } from "./api.js";
import { cachedFetch } from "./api-cache.js";
import { getFeaturedModels } from "./model-config.js";

export const kModelCatalogCacheKey = "/api/models";
export const kModelCatalogPollIntervalMs = 3000;
export const kDefaultOnboardingModelKey = "anthropic/claude-opus-5-5";

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

// Fresh OpenAI setups follow the pinned OpenClaw's defaults: 2026.10 picks
// openai/gpt-6-astra for both API-key and Codex OAuth setups
// (OPENAI_DEFAULT_MODEL / OPENAI_CODEX_DEFAULT_MODEL). Older catalogs fall back
// to the 2026.8 GPT-5.6 defaults (the openai/gpt-5.6 alias for API keys, the
// exact openai/gpt-5.6-sol for Codex). Each default applies ONLY when the live
// catalog lists the model: preselecting a model the gateway cannot route is a
// broken first run (C8).
export const resolveOnboardingModelDefault = ({
  catalog = [],
  authProvider = "",
  currentModelKey = "",
} = {}) => {
  const normalizedCurrent = String(currentModelKey || "").trim();
  if (normalizedCurrent) return normalizedCurrent;
  const has = (key) => catalog.some((model) => String(model?.key || "") === key);
  const provider = String(authProvider || "").trim();
  if (provider === "openai-codex" || provider === "openai") {
    if (has("openai/gpt-6-astra")) return "openai/gpt-6-astra";
  }
  if (provider === "openai-codex" && has("openai/gpt-5.6-sol")) {
    return "openai/gpt-5.6-sol";
  }
  if (provider === "openai") {
    if (has("openai/gpt-5.6")) return "openai/gpt-5.6";
    if (has("openai/gpt-5.6-sol")) return "openai/gpt-5.6-sol";
  }
  return getInitialOnboardingModelKey({ catalog, currentModelKey });
};

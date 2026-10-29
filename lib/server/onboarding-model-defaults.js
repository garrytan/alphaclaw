// Env-independent onboarding model defaults: the provider set, the minimal
// fallback list, and the bootstrap catalog merged with the curated rows.
// Re-exported from constants.js.
const kBootstrapModelCatalog = require("./model-catalog-bootstrap.json");
const kCuratedModelCatalog = require("./model-catalog-curated.json");

const kOnboardingModelProviders = new Set([
  "anthropic",
  "openai",
  "openai-codex",
  "google",
  "opencode",
  "openrouter",
  "zai",
  "vercel-ai-gateway",
  "kilocode",
  "xai",
  "mistral",
  "cerebras",
  "moonshot",
  "kimi-coding",
  "volcengine",
  "volcengine-plan",
  "byteplus",
  "byteplus-plan",
  "synthetic",
  "minimax",
  // Same credential as minimax (the auth mapping lives in the UI's
  // getAuthProviderFromModelProvider); without this entry every minimax-cn/*
  // row is silently dropped from live/cached catalogs while the raw bootstrap
  // fallback still shows them — models appear on cold start, then vanish.
  "minimax-cn",
  "voyage",
  "groq",
  "vllm",
  "particle",
]);
const kMinimalFallbackOnboardingModels = [
  {
    key: "anthropic/claude-opus-5-5",
    provider: "anthropic",
    label: "Claude Opus 5.5",
  },
  {
    key: "anthropic/claude-sonnet-5-5",
    provider: "anthropic",
    label: "Claude Sonnet 5.5",
  },
  {
    key: "anthropic/claude-haiku-5-5",
    provider: "anthropic",
    label: "Claude Haiku 5.5",
  },
  {
    key: "openai/gpt-6.1-sol",
    provider: "openai",
    label: "GPT-6.1 Sol",
    agentRuntime: { id: "codex" },
  },
  {
    key: "openai/gpt-6-astra",
    provider: "openai",
    label: "GPT-6 Astra",
    agentRuntime: { id: "codex" },
  },
  {
    key: "openai/gpt-6-sol",
    provider: "openai",
    label: "GPT-6 Sol",
    agentRuntime: { id: "codex" },
  },
  {
    key: "openai/gpt-6-luna",
    provider: "openai",
    label: "GPT-6 Luna",
    agentRuntime: { id: "codex" },
  },
  {
    key: "anthropic/claude-opus-4-8",
    provider: "anthropic",
    label: "Claude Opus 4.8",
  },
  {
    key: "anthropic/claude-opus-4-7",
    provider: "anthropic",
    label: "Claude Opus 4.7",
  },
  {
    key: "anthropic/claude-opus-4-6",
    provider: "anthropic",
    label: "Claude Opus 4.6",
  },
  {
    key: "anthropic/claude-sonnet-4-6",
    provider: "anthropic",
    label: "Claude Sonnet 4.6",
  },
  {
    key: "anthropic/claude-haiku-4-6",
    provider: "anthropic",
    label: "Claude Haiku 4.6",
  },
  {
    key: "openai/gpt-5.6-sol",
    provider: "openai",
    label: "GPT-5.6 Sol",
    agentRuntime: { id: "codex" },
  },
  {
    key: "openai/gpt-5.6-terra",
    provider: "openai",
    label: "GPT-5.6 Terra",
    agentRuntime: { id: "codex" },
  },
  {
    key: "openai/gpt-5.6-luna",
    provider: "openai",
    label: "GPT-5.6 Luna",
    agentRuntime: { id: "codex" },
  },
  {
    key: "openai/gpt-5.5",
    provider: "openai",
    label: "GPT-5.5",
  },
  {
    key: "openai/gpt-5.3-codex",
    provider: "openai",
    label: "Codex GPT-5.3",
  },
  {
    key: "openai/gpt-5.1-codex",
    provider: "openai",
    label: "OpenAI GPT-5.1 Codex",
  },
  {
    key: "google/gemini-3.1-pro-preview",
    provider: "google",
    label: "Gemini 3.1 Pro",
  },
  {
    key: "google/gemini-3-flash-preview",
    provider: "google",
    label: "Gemini 3 Flash Preview",
  },
];
// Curated rows (model-catalog-curated.json) fill gaps the pinned CLI does not
// emit; on a `key` collision the GENERATED row wins — freshest-from-CLI beats
// hand-curated. Output keeps the refresh script's localeCompare-by-key order.
const mergeCatalogModels = (generatedModels, curatedModels) => {
  const mergedByKey = new Map();
  for (const row of Array.isArray(curatedModels) ? curatedModels : []) {
    if (row && typeof row.key === "string" && row.key) {
      mergedByKey.set(row.key, row);
    }
  }
  for (const row of Array.isArray(generatedModels) ? generatedModels : []) {
    if (row && typeof row.key === "string" && row.key) {
      mergedByKey.set(row.key, row);
    }
  }
  return Array.from(mergedByKey.values()).sort((a, b) =>
    a.key.localeCompare(b.key),
  );
};
const kFallbackOnboardingModels =
  Array.isArray(kBootstrapModelCatalog.models) &&
  kBootstrapModelCatalog.models.length > 0
    ? mergeCatalogModels(
        kBootstrapModelCatalog.models,
        kCuratedModelCatalog.models,
      )
    : kMinimalFallbackOnboardingModels;


module.exports = {
  kOnboardingModelProviders,
  mergeCatalogModels,
  kFallbackOnboardingModels,
};

// Providers AlphaClaw configures in OpenClaw itself, because the pinned
// OpenClaw ships no plugin for them. Each row is the canonical
// models.providers.<id> block AlphaClaw writes while the row's env var is
// set (lib/server/providers/ensure.js), plus what the Setup UI and the model
// check need to know about the provider. A row's `previousOwned` lists the
// owned subsets earlier AlphaClaw releases wrote, so a block one of them
// wrote is upgraded rather than treated as an operator edit.
const kOwnedProviderPresets = [
  {
    id: "particle",
    envVar: "PARTICLE_API_KEY",
    label: "Particle",
    keyUrl: "https://platform.particle.ai",
    baseUrl: "https://api.particle.ai/v1",
    api: "openai-completions",
    // Particle lists and answers with the namespaced id; requests use the
    // short alias, which Particle documents as stable.
    listedAliases: { "particle-1": "particle-ai/particle-1" },
    // Particle queues requests for up to ~30 s before answering.
    probeTimeoutMs: 45_000,
    models: [
      {
        id: "particle-1",
        name: "Particle-1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1048576,
        maxTokens: 131072,
        cost: { input: 0.25, output: 1, cacheRead: 0.03, cacheWrite: 0 },
        compat: {
          supportsTools: true,
          supportsUsageInStreaming: true,
          supportsPromptCacheKey: true,
          supportedReasoningEfforts: ["none", "low", "high", "max"],
          reasoningEffortMap: { off: "none" },
        },
      },
    ],
    previousOwned: [],
  },
];

const findOwnedProviderPreset = (providerId) =>
  kOwnedProviderPresets.find((preset) => preset.id === String(providerId || "").trim()) || null;

module.exports = { kOwnedProviderPresets, findOwnedProviderPreset };

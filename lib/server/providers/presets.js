// Providers AlphaClaw configures in OpenClaw itself. Each row is the
// canonical models.providers.<id> block AlphaClaw writes while the row's env
// var is set (lib/server/providers/ensure.js), plus what the Setup UI and the
// model check need to know about the provider. The pinned OpenClaw bundles
// no plugin for them, but one can be installed (OpenClaw publishes
// @openclaw/particle-provider since 2026.11.2); its model id policy then
// applies to this block's rows, so each row id here is the id that policy
// keeps. A row's `previousOwned`
// lists the owned subsets earlier AlphaClaw releases wrote, so a block one of
// them wrote is upgraded rather than treated as an operator edit, and
// `renamedModelIds` maps an earlier row id to its current one
// (renamed-models.js moves the row and the refs to it at boot).
const kOwnedProviderPresets = [
  {
    id: "particle",
    envVar: "PARTICLE_API_KEY",
    label: "Particle",
    keyUrl: "https://platform.particle.ai",
    baseUrl: "https://api.particle.ai/v1",
    api: "openai-completions",
    // OpenClaw's Particle plugin rewrites a particle-1 row to this id on any
    // config write, and Particle lists and answers with it.
    renamedModelIds: { "particle-1": "particle-ai/particle-1" },
    // Particle queues requests for up to ~30 s before answering.
    probeTimeoutMs: 45_000,
    models: [
      {
        id: "particle-ai/particle-1",
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
    // Written into agents.defaults.models["particle/particle-ai/particle-1"]
    // .params at a gateway launch (model-defaults.js): OpenClaw's default
    // sends "low".
    thinkingDefaults: { "particle-ai/particle-1": "high" },
    previousOwned: [],
  },
];

const findOwnedProviderPreset = (providerId) =>
  kOwnedProviderPresets.find((preset) => preset.id === String(providerId || "").trim()) || null;

module.exports = { kOwnedProviderPresets, findOwnedProviderPreset };

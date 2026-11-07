// Where OpenClaw sends a built-in provider's requests when its
// models.providers entry has no baseUrl. OpenClaw's config validation accepts
// an entry without a baseUrl only for its built-in provider ids ("custom model
// providers must declare baseUrl; provider overlays without baseUrl are only
// supported for bundled providers"), then lays the entry over the provider
// plugin's own catalog entry (mergeProviders in models-config.merge), so the
// base URL and API come from the plugin.
//
// The id list mirrors OpenClaw's src/config/model-provider-overlay-ids.ts,
// which the package does not export; tests/live/model-check-provider-defaults
// holds it equal to the pinned dist. The base URLs and APIs are read from the
// bundled plugins' manifests (dist/extensions/<plugin>/openclaw.plugin.json,
// modelCatalog.providers.<id>), the catalog the plugins' provider discovery
// builds that entry from.
const fs = require("fs");
const path = require("path");
const { isNonArrayObject } = require("../utils/object");

const kOpenclawBuiltInProviderIds = new Set([
  "amazon-bedrock",
  "amazon-bedrock-mantle",
  "anthropic",
  "anthropic-vertex",
  "arcee",
  "azure-openai-responses",
  "byteplus",
  "byteplus-plan",
  "cerebras",
  "chutes",
  "claude-cli",
  "clawrouter",
  "cloudflare-ai-gateway",
  "codex",
  "comfy",
  "copilot-proxy",
  "dashscope",
  "deepinfra",
  "deepseek",
  "fal",
  "fireworks",
  "github-copilot",
  "gmi",
  "gmi-cloud",
  "gmicloud",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kie",
  "kilocode",
  "kimi",
  "kimi-coding",
  "litellm",
  "lmstudio",
  "meta",
  "microsoft-foundry",
  "minimax",
  "minimax-portal",
  "mistral",
  "modelstudio",
  "moonshot",
  "moonshot-ai",
  "moonshotai",
  "nvidia",
  "novita",
  "novita-ai",
  "novitaai",
  "ollama",
  "ollama-cloud",
  "openai",
  "opencode",
  "opencode-go",
  "openrouter",
  "qianfan",
  "qwen",
  "qwen-token-plan",
  "qwencloud",
  "runway",
  "sglang",
  "stepfun",
  "stepfun-plan",
  "synthetic",
  "tencent-tokenhub",
  "tencent-tokenplan",
  "together",
  "venice",
  "vercel-ai-gateway",
  "vllm",
  "volcengine",
  "volcengine-plan",
  "vydra",
  "x-ai",
  "xai",
  "xiaomi",
  "xiaomi-token-plan",
  "z.ai",
  "z-ai",
  "zai",
]);

const normalizeProviderId = (provider) => String(provider || "").trim().toLowerCase();

const isOpenclawBuiltInProvider = (provider) => kOpenclawBuiltInProviderIds.has(normalizeProviderId(provider));

const resolveOpenclawDistDir = () => {
  try {
    return path.dirname(require.resolve("openclaw"));
  } catch {
    return "";
  }
};

// Map of normalized provider id -> { baseUrl, api } for every bundled plugin
// manifest that declares an http(s) base URL. Unreadable manifests are skipped.
const readOpenclawProviderDefaults = (distDir = resolveOpenclawDistDir()) => {
  const defaults = new Map();
  if (!distDir) return defaults;
  const extensionsDir = path.join(distDir, "extensions");
  let pluginDirs = [];
  try {
    pluginDirs = fs
      .readdirSync(extensionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return defaults;
  }
  for (const pluginDir of pluginDirs) {
    let providers = null;
    try {
      providers = JSON.parse(fs.readFileSync(path.join(extensionsDir, pluginDir, "openclaw.plugin.json"), "utf8"))?.modelCatalog?.providers;
    } catch {
      continue;
    }
    if (!isNonArrayObject(providers)) continue;
    for (const [providerId, catalog] of Object.entries(providers)) {
      const baseUrl = typeof catalog?.baseUrl === "string" ? catalog.baseUrl.trim() : "";
      if (!/^https?:\/\//i.test(baseUrl)) continue;
      const api = typeof catalog.api === "string" && catalog.api.trim() ? catalog.api.trim() : null;
      defaults.set(normalizeProviderId(providerId), { baseUrl, api });
    }
  }
  return defaults;
};

module.exports = {
  isOpenclawBuiltInProvider,
  kOpenclawBuiltInProviderIds,
  normalizeProviderId,
  readOpenclawProviderDefaults,
};

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

// Built-in providers whose manifest base URL is not where OpenClaw sends
// requests: GitHub Copilot's host comes from the signed-in GitHub account
// (params.githubDomain or COPILOT_GITHUB_DOMAIN, then the Copilot user
// endpoint), resolved at run time by the plugin.
const kOpenclawRuntimeHostProviderIds = new Set(["github-copilot"]);

const normalizeProviderId = (provider) => String(provider || "").trim().toLowerCase();

const isOpenclawBuiltInProvider = (provider) => kOpenclawBuiltInProviderIds.has(normalizeProviderId(provider));

const resolveOpenclawDistDir = () => {
  try {
    return path.dirname(require.resolve("openclaw"));
  } catch {
    return "";
  }
};

const readHttpUrl = (value) => {
  const url = typeof value === "string" ? value.trim() : "";
  return /^https?:\/\//i.test(url) ? url : "";
};
const readApi = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

// Map of normalized provider id -> { baseUrl, api, models } for every bundled
// plugin manifest that declares an http(s) base URL; models maps a catalog
// model id to the api and baseUrl that model sets for itself, when it sets
// either. Unreadable manifests are skipped.
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
      const baseUrl = readHttpUrl(catalog?.baseUrl);
      if (!baseUrl) continue;
      const models = new Map();
      for (const model of Array.isArray(catalog.models) ? catalog.models : []) {
        const id = typeof model?.id === "string" ? model.id.trim() : "";
        const route = { api: readApi(model?.api), baseUrl: readHttpUrl(model?.baseUrl) || null };
        if (id && (route.api || route.baseUrl)) models.set(id, route);
      }
      defaults.set(normalizeProviderId(providerId), { baseUrl, api: readApi(catalog.api), models });
    }
  }
  return defaults;
};

module.exports = {
  isOpenclawBuiltInProvider,
  kOpenclawBuiltInProviderIds,
  kOpenclawRuntimeHostProviderIds,
  normalizeProviderId,
  readOpenclawProviderDefaults,
};

// LIVE TIER — what the model check assumes about OpenClaw's built-in
// providers, held against the REAL pinned OpenClaw (ALPH-69). A
// models.providers entry with no baseUrl is fine for a built-in provider:
// OpenClaw lays it over the provider plugin's catalog entry and sends requests
// to that entry's base URL. The model check called the box's Google block
// misconfigured for lacking a baseUrl while a real turn through it replied.
//
// lib/server/model-check/openclaw-provider-defaults.js keeps OpenClaw's list
// of built-in provider ids (src/config/model-provider-overlay-ids.ts, not
// exported by the package) and reads the base URLs from the bundled plugin
// manifests. A pin bump that changes either fails here.
const fs = require("fs");
const path = require("path");

const { kLiveEnabled, mkTemp, runCliJson, repoOpenclawBin, scrubTestRunnerEnv } = require("./live-helpers");
const {
  kOpenclawBuiltInProviderIds,
  readOpenclawProviderDefaults,
} = require("../../lib/server/model-check/openclaw-provider-defaults");

const describeLive = kLiveEnabled ? describe : describe.skip;
const kDistDir = path.dirname(require.resolve("openclaw"));
const kOverlayRegion = "//#region src/config/model-provider-overlay-ids.ts";

// The box's block (OpenClaw 2026.10.9), key order as stored: no baseUrl key.
const kBoxGoogleBlock = {
  apiKey: "live-provider-defaults-key-0000",
  api: "google-generative-ai",
  models: [
    {
      id: "gemini-3.1-pro-preview",
      name: "Gemini 3.1 Pro",
      reasoning: true,
      contextWindow: 1048576,
      contextTokens: 1048576,
      maxTokens: 65536,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
};

const validate = (providers) => {
  const dir = mkTemp("alphaclaw-live-provider-defaults-");
  const configPath = path.join(dir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ models: { providers } }));
  return runCliJson(repoOpenclawBin(), ["config", "validate", "--json"], {
    env: { ...scrubTestRunnerEnv(), HOME: dir, OPENCLAW_STATE_DIR: path.join(dir, "state"), OPENCLAW_CONFIG_PATH: configPath },
    exits: [0, 1],
  });
};

describeLive("model check vs OpenClaw's built-in providers (live, pinned dist)", () => {
  it("keeps the same built-in provider ids as OpenClaw's config validation", () => {
    const copies = fs
      .readdirSync(kDistDir)
      .filter((name) => name.endsWith(".mjs"))
      .flatMap((name) => {
        const text = fs.readFileSync(path.join(kDistDir, name), "utf8");
        const start = text.indexOf(kOverlayRegion);
        if (start < 0) return [];
        const body = text.slice(start, text.indexOf("]);", start));
        return [{ name, ids: [...body.matchAll(/"([^"]+)"/g)].map((match) => match[1]).sort() }];
      });
    expect(copies.length).toBeGreaterThan(0);
    for (const copy of copies) expect({ name: copy.name, ids: copy.ids }).toEqual({ name: copy.name, ids: [...kOpenclawBuiltInProviderIds].sort() });
  });

  it("accepts every one of those ids, and the box's Google block, without a baseUrl, and refuses any other id", () => {
    const builtIns = Object.fromEntries([...kOpenclawBuiltInProviderIds].map((id) => [id, {}]));
    expect(validate({ ...builtIns, google: kBoxGoogleBlock })).toMatchObject({ valid: true });
    const custom = validate({ "my-gemini": kBoxGoogleBlock });
    expect(custom.valid).toBe(false);
    expect(custom.issues).toEqual([expect.objectContaining({ path: "models.providers.my-gemini.baseUrl" })]);
  });

  it("reads the base URL and API OpenClaw's own provider discovery fills in", async () => {
    const defaults = readOpenclawProviderDefaults();
    expect(defaults.get("google")).toMatchObject({ baseUrl: "https://generativelanguage.googleapis.com/v1beta", api: "google-generative-ai" });
    expect(defaults.get("opencode-go").models.get("qwen3.8-max")).toEqual({ api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go" });
    for (const id of defaults.keys()) expect(kOpenclawBuiltInProviderIds.has(id)).toBe(true);
    const compared = [];
    for (const pluginDir of fs.readdirSync(path.join(kDistDir, "extensions"))) {
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(path.join(kDistDir, "extensions", pluginDir, "openclaw.plugin.json"), "utf8"));
      } catch {
        continue;
      }
      if (!manifest.providerCatalogEntry) continue;
      const discovery = (await import(path.join(kDistDir, "extensions", pluginDir, manifest.providerCatalogEntry))).default;
      if (!discovery?.staticCatalog?.run) continue;
      const { providers = {} } = (await discovery.staticCatalog.run({ config: {}, env: {} })) || {};
      for (const [id, provider] of Object.entries(providers)) {
        if (!defaults.has(id)) continue;
        const { baseUrl, api, models } = defaults.get(id);
        expect({ id, baseUrl: provider.baseUrl, api: provider.api }).toEqual({ id, baseUrl, api });
        const routes = (provider.models || [])
          .filter((model) => model.api || model.baseUrl)
          .map((model) => [model.id, { api: model.api || null, baseUrl: model.baseUrl || null }]);
        expect({ id, routes: new Map(routes) }).toEqual({ id, routes: models });
        compared.push(id);
      }
    }
    expect(compared).toContain("google");
  });
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { kOwnedProviderPresets, findOwnedProviderPreset } = require("../../lib/server/providers/presets");
const {
  applyOwnedProviders,
  classifyOwnedProvider,
  ensureOwnedProviders,
  isEnvValueSet,
} = require("../../lib/server/providers/ensure");
const { normalizeBootConfig } = require("../../lib/server/boot-config-normalization");

const kKey = "pai-test-0000000000000000000000000000000000000";
const particle = findOwnedProviderPreset("particle");
const quietLogger = { log: () => {}, warn: () => {} };

describe("server/providers presets", () => {
  it("declares Particle's canonical block: Chat Completions, the env ref, and particle-1's real limits and request contract", () => {
    expect(particle).toMatchObject({ envVar: "PARTICLE_API_KEY", baseUrl: "https://api.particle.ai/v1", api: "openai-completions" });
    const [model] = particle.models;
    expect(model).toMatchObject({
      id: "particle-1",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 1048576,
      maxTokens: 131072,
      cost: { input: 0.25, output: 1, cacheRead: 0.03, cacheWrite: 0 },
    });
    // Particle reasons at high when reasoning_effort is omitted, so thinking
    // off must send "none".
    expect(model.compat.reasoningEffortMap.off).toBe("none");
    expect(model.compat).toMatchObject({ supportsTools: true, supportsUsageInStreaming: true, supportsPromptCacheKey: true });
    expect(particle.listedAliases["particle-1"]).toBe("particle-ai/particle-1");
  });
});

describe("server/providers applyOwnedProviders", () => {
  it("writes nothing while the env var is unset, blank or the onboarding placeholder", () => {
    for (const value of [undefined, "", "   ", "placeholder"]) {
      const config = {};
      expect(isEnvValueSet(value)).toBe(false);
      expect(applyOwnedProviders(config, { env: { PARTICLE_API_KEY: value } })).toEqual({ changed: false, results: [] });
      expect(config).toEqual({});
    }
  });

  it("writes the canonical block with an env reference, never the key, and leaves the model allowlists alone", () => {
    const agents = { defaults: { model: { primary: "anthropic/claude-opus-5-5" }, modelPolicy: { allow: ["anthropic/claude-opus-5-5"] }, models: { "anthropic/claude-opus-5-5": {} } } };
    const config = { agents: structuredClone(agents), models: { providers: { other: { baseUrl: "https://x.test/v1" } } } };
    expect(applyOwnedProviders(config, { env: { PARTICLE_API_KEY: kKey } })).toEqual({ changed: true, results: [{ id: "particle", action: "written" }] });
    expect(config.models.providers.particle).toEqual({ baseUrl: particle.baseUrl, api: particle.api, apiKey: "${PARTICLE_API_KEY}", models: particle.models });
    expect(config.models.providers.other).toEqual({ baseUrl: "https://x.test/v1" });
    expect(config.agents).toEqual(agents);
    expect(JSON.stringify(config)).not.toContain(kKey);
  });

  it("treats an exact canonical block as AlphaClaw's (adoption) and changes nothing", () => {
    const config = {};
    applyOwnedProviders(config, { env: { PARTICLE_API_KEY: kKey } });
    const before = structuredClone(config);
    expect(applyOwnedProviders(config, { env: { PARTICLE_API_KEY: kKey } })).toEqual({ changed: false, results: [{ id: "particle", action: "unchanged" }] });
    expect(config).toEqual(before);
  });

  it("keeps keys it does not own: an operator's timeoutSeconds and extra model rows stay", () => {
    const config = {};
    applyOwnedProviders(config, { env: { PARTICLE_API_KEY: kKey } });
    config.models.providers.particle.timeoutSeconds = 600;
    config.models.providers.particle.models.push({ id: "glm-5.3-flash", name: "GLM" });
    expect(classifyOwnedProvider(config, particle).state).toBe("current");
    expect(applyOwnedProviders(config, { env: { PARTICLE_API_KEY: kKey } }).changed).toBe(false);
    expect(config.models.providers.particle.timeoutSeconds).toBe(600);
  });

  it("upgrades a block an earlier preset wrote, keeping unowned keys", () => {
    const previous = { baseUrl: particle.baseUrl, api: particle.api, apiKey: "${PARTICLE_API_KEY}", models: [{ ...particle.models[0], maxTokens: 32000 }] };
    const preset = { ...particle, previousOwned: [previous] };
    const config = { models: { providers: { particle: { ...structuredClone(previous), timeoutSeconds: 300 } } } };
    expect(classifyOwnedProvider(config, preset)).toEqual({ state: "previous", differs: ["models[particle-1]"] });
    expect(applyOwnedProviders(config, { env: { PARTICLE_API_KEY: kKey }, presets: [preset] }).results).toEqual([{ id: "particle", action: "upgraded" }]);
    expect(config.models.providers.particle.models[0].maxTokens).toBe(131072);
    expect(config.models.providers.particle.timeoutSeconds).toBe(300);
  });

  it("leaves an operator-edited block untouched and names the owned keys that differ", () => {
    const edited = { baseUrl: "https://proxy.example.test/v1", api: "openai-completions", apiKey: "${PARTICLE_API_KEY}", models: [{ id: "particle-1", name: "P1", contextWindow: 200000 }] };
    const config = { models: { providers: { particle: structuredClone(edited) } } };
    expect(applyOwnedProviders(config, { env: { PARTICLE_API_KEY: kKey } }).results).toEqual([
      { id: "particle", action: "left_customized", differs: ["baseUrl", "models[particle-1]"] },
    ]);
    expect(config.models.providers.particle).toEqual(edited);
  });
});

describe("server/providers ensureOwnedProviders", () => {
  let root;
  let configPath;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-owned-providers-"));
    configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: { model: { primary: "particle/particle-1" } } } }, null, 2));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes once, then skips the write entirely (same bytes, same mtime)", () => {
    expect(ensureOwnedProviders({ openclawDir: root, env: { PARTICLE_API_KEY: kKey }, logger: quietLogger })).toMatchObject({ ok: true, changed: true });
    const bytes = fs.readFileSync(configPath, "utf8");
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(configPath, past, past);
    const mtime = fs.statSync(configPath).mtimeMs;
    expect(ensureOwnedProviders({ openclawDir: root, env: { PARTICLE_API_KEY: kKey }, logger: quietLogger })).toMatchObject({ ok: true, changed: false });
    expect(fs.readFileSync(configPath, "utf8")).toBe(bytes);
    expect(fs.statSync(configPath).mtimeMs).toBe(mtime);
    expect(bytes).not.toContain(kKey);
    expect(JSON.parse(bytes).models.providers.particle.apiKey).toBe("${PARTICLE_API_KEY}");
  });

  it("does not open the config at all while no preset key is set", () => {
    fs.writeFileSync(configPath, "{ not json");
    expect(ensureOwnedProviders({ openclawDir: root, env: {}, logger: quietLogger })).toEqual({ ok: true, changed: false, results: [] });
  });

  it("never throws: an unreadable config comes back as a warning", () => {
    fs.writeFileSync(configPath, "{ not json");
    const warn = vi.fn();
    const result = ensureOwnedProviders({ openclawDir: root, env: { PARTICLE_API_KEY: kKey }, logger: { log: () => {}, warn } });
    expect(result.ok).toBe(false);
    expect(result.warning).toMatch(/writing the provider config failed/);
    expect(result.warning).not.toContain(kKey);
    expect(warn).toHaveBeenCalled();
  });
});

describe("server/providers thinking defaults (GST-121)", () => {
  const { applyOwnedProviderThinkingDefaults, applyOwnedProviderThinkingDefaultsBeforeLaunch } = require("../../lib/server/providers/model-defaults");
  const env = { PARTICLE_API_KEY: kKey };
  const ref = "particle/particle-1";
  const withRow = (row, defaults = {}) => ({ agents: { defaults: { model: { primary: ref }, ...defaults, models: { [ref]: row } } } });

  it("declares high for particle-1 only", () => {
    expect(particle.thinkingDefaults).toEqual({ "particle-1": "high" });
    expect(particle.models[0]).not.toHaveProperty("thinking");
    expect(particle.models[0]).not.toHaveProperty("params");
  });

  it("fresh setup: fills high into the row `openclaw models set` creates, and nothing else", () => {
    const config = { meta: { migrations: { modelPolicyAllowlist: true } }, ...withRow({}) };
    config.agents.defaults.models["anthropic/claude-opus-5-5"] = {};
    expect(applyOwnedProviderThinkingDefaults(config, { env })).toEqual([{ ref, thinking: "high" }]);
    expect(config.agents.defaults.models).toEqual({ [ref]: { params: { thinking: "high" } }, "anthropic/claude-opus-5-5": {} });
    expect(applyOwnedProviderThinkingDefaults(config, { env })).toEqual([]);
  });

  it.each([["low"], ["medium"], ["off"], [false], [null]])("keeps an operator's explicit thinking %j", (thinking) => {
    const config = withRow({ params: { thinking } });
    const before = structuredClone(config);
    expect(applyOwnedProviderThinkingDefaults(config, { env })).toEqual([]);
    expect(config).toEqual(before);
  });

  it("upgrade: a row from an earlier release keeps its alias and other params and gains thinking", () => {
    const config = withRow({ alias: "particle", params: { temperature: 0.2 } });
    expect(applyOwnedProviderThinkingDefaults(config, { env })).toEqual([{ ref, thinking: "high" }]);
    expect(config.agents.defaults.models[ref]).toEqual({ alias: "particle", params: { temperature: 0.2, thinking: "high" } });
  });

  it("never creates the row: agents.defaults.models keys are an allowlist, and every row is a modelPolicy gap", () => {
    for (const config of [
      { agents: { defaults: { model: { primary: ref } } } },
      { agents: { defaults: { model: { primary: ref }, models: { "anthropic/claude-opus-5-5": {} } } } },
      { agents: { defaults: { model: { primary: ref }, models: {}, modelPolicy: { allow: ["anthropic/claude-opus-5-5"] } } } },
    ]) {
      const before = structuredClone(config);
      expect(applyOwnedProviderThinkingDefaults(config, { env })).toEqual([]);
      expect(config).toEqual(before);
    }
  });

  it("leaves it to an operator's agents.defaults.thinkingDefault, which a per-model param would override", () => {
    const config = withRow({}, { thinkingDefault: "medium" });
    expect(applyOwnedProviderThinkingDefaults(config, { env })).toEqual([]);
    expect(config.agents.defaults.models[ref]).toEqual({});
  });

  it("writes nothing while the key is unset or the placeholder, or when the row's params is not an object", () => {
    for (const value of [undefined, "", "placeholder"]) {
      const config = withRow({});
      expect(applyOwnedProviderThinkingDefaults(config, { env: { PARTICLE_API_KEY: value } })).toEqual([]);
      expect(config.agents.defaults.models[ref]).toEqual({});
    }
    const odd = withRow({ params: "high" });
    expect(applyOwnedProviderThinkingDefaults(odd, { env })).toEqual([]);
    expect(odd.agents.defaults.models[ref]).toEqual({ params: "high" });
  });

  describe("before launch", () => {
    let root;
    let configPath;
    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-thinking-defaults-"));
      configPath = path.join(root, "openclaw.json");
    });
    afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

    it("writes once with a log line, then skips the write entirely (same bytes, same mtime)", () => {
      fs.writeFileSync(configPath, JSON.stringify(withRow({}), null, 2));
      const log = vi.fn();
      expect(applyOwnedProviderThinkingDefaultsBeforeLaunch({ openclawDir: root, env, logger: { log, warn: () => {} } })).toEqual({ ok: true, applied: [{ ref, thinking: "high" }] });
      expect(log).toHaveBeenCalledWith('[alphaclaw] provider defaults: agents.defaults.models["particle/particle-1"].params.thinking=high before launch');
      const bytes = fs.readFileSync(configPath, "utf8");
      expect(JSON.parse(bytes).agents.defaults.models[ref]).toEqual({ params: { thinking: "high" } });
      const past = new Date(Date.now() - 60_000);
      fs.utimesSync(configPath, past, past);
      const mtime = fs.statSync(configPath).mtimeMs;
      expect(applyOwnedProviderThinkingDefaultsBeforeLaunch({ openclawDir: root, env, logger: quietLogger })).toEqual({ ok: true, applied: [] });
      expect(fs.readFileSync(configPath, "utf8")).toBe(bytes);
      expect(fs.statSync(configPath).mtimeMs).toBe(mtime);
    });

    it("never throws: an unreadable config is a warning and the next launch retries", () => {
      fs.writeFileSync(configPath, "{ not json");
      const warn = vi.fn();
      expect(applyOwnedProviderThinkingDefaultsBeforeLaunch({ openclawDir: root, env, logger: { log: () => {}, warn } })).toEqual({ ok: false, applied: [] });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/retried on the next launch/));
    });
  });
});

describe("server/providers at boot", () => {
  let root;
  let configPath;
  const deps = () => ({
    hold: { isValid: () => true },
    env: { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: root, PARTICLE_API_KEY: kKey },
    logger: { log: () => {} },
    logFile: path.join(root, "logs", "openclaw.log"),
  });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-owned-providers-boot-"));
    configPath = path.join(root, "openclaw.json");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("writes the block for an env-only deployment inside the boot normalization's own write, with no secret in the file", () => {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults: {} } }));
    expect(normalizeBootConfig(deps())).toEqual({ changed: true });
    const text = fs.readFileSync(configPath, "utf8");
    expect(JSON.parse(text).models.providers.particle.apiKey).toBe("${PARTICLE_API_KEY}");
    expect(text).not.toContain(kKey);
    expect(normalizeBootConfig(deps())).toEqual({ changed: false });
  });
});

describe("server/providers registries", () => {
  const { getEnvVarForApiKeyProvider, listApiKeyProviders } = require("../../lib/server/auth-profiles");
  const { kKnownVars } = require("../../lib/server/known-env-vars");
  const { kOnboardingModelProviders } = require("../../lib/server/onboarding-model-defaults");
  const { filterGatewayChildEnv } = require("../../lib/server/gateway-env-policy");
  const curated = require("../../lib/server/model-catalog-curated.json");
  const detectorSource = fs.readFileSync(path.join(__dirname, "../../lib/server/onboarding/import/secret-detector.js"), "utf8");

  it.each(kOwnedProviderPresets.map((preset) => [preset.id, preset]))("%s is wired through every list that must stay in sync", async (id, preset) => {
    expect(listApiKeyProviders()).toContain(id);
    expect(getEnvVarForApiKeyProvider(id)).toBe(preset.envVar);
    expect(kKnownVars.find((entry) => entry.key === preset.envVar)).toMatchObject({ group: "ai", features: ["Models"] });
    expect(kOnboardingModelProviders.has(id)).toBe(true);
    expect(detectorSource).toContain(`"models.providers.${id}.apiKey": "${preset.envVar}"`);
    for (const model of preset.models) expect(curated.models).toContainEqual(expect.objectContaining({ key: `${id}/${model.id}`, provider: id }));
    const ui = await import("../../lib/public/js/lib/model-config.js");
    expect(ui.kProviderAuthFields[id].map((field) => field.key)).toEqual([preset.envVar]);
    expect(ui.kProviderOrder).toContain(id);
    expect(ui.kProviderLabels[id]).toBe(preset.label);
    expect(filterGatewayChildEnv({ [preset.envVar]: kKey }, { logger: quietLogger })[preset.envVar]).toBe(kKey);
  });

  // Tripwire: when the pinned OpenClaw starts shipping its own plugin for a
  // preset's provider, the built-in wins (ALPH-47): stop writing the block,
  // keep the key, and remove a block only while it still matches the preset.
  // Shipping means bundled in dist/extensions or installed with the pin. A
  // listing in the official external plugin catalog (2026.10.10 lists
  // @openclaw/particle-provider) is only installable on request, and AlphaClaw
  // installs no catalog plugin, so it does not trip this.
  it.each(kOwnedProviderPresets.map((preset) => [preset.id]))("the pinned OpenClaw still ships no %s plugin", (id) => {
    const dist = path.join(__dirname, "../../node_modules/openclaw/dist");
    if (!fs.existsSync(dist)) return;
    expect(fs.existsSync(path.join(dist, "extensions", id))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, "../../node_modules/@openclaw", `${id}-provider`))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, "../../node_modules/openclaw/node_modules/@openclaw", `${id}-provider`))).toBe(false);
  });
});

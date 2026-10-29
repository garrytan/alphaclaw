const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const kRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-model-policy-"));
process.env.ALPHACLAW_ROOT_DIR = kRoot;

const { OPENCLAW_DIR } = require("../../lib/server/constants");
const {
  allowPrimaryModel,
  applyModelPolicyBeforeLaunch,
  findModelPolicyGaps,
  noteModelPolicyGaps,
} = require("../../lib/server/model-policy");
const { createAuthProfiles } = require("../../lib/server/auth-profiles");
const { createAgentsService } = require("../../lib/server/agents/service");
const { registerModelRoutes } = require("../../lib/server/routes/models");
const { registerAgentRoutes } = require("../../lib/server/routes/agents");

const kConfigPath = path.join(OPENCLAW_DIR, "openclaw.json");
const readConfig = () => JSON.parse(fs.readFileSync(kConfigPath, "utf8"));
const writeConfig = (config) => fs.writeFileSync(kConfigPath, JSON.stringify(config, null, 2));
const quietLogger = () => ({ log: vi.fn(), warn: vi.fn() });

const governedConfig = () => ({
  meta: { migrations: { modelPolicyAllowlist: true } },
  agents: {
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6" },
      models: { "anthropic/claude-opus-4-6": {} },
      modelPolicy: { allow: ["anthropic/claude-opus-4-6"] },
    },
    list: [
      { id: "main", default: true },
      { id: "lab", modelPolicy: { allow: ["google/*"] } },
    ],
  },
  gateway: { port: 18789 },
});

afterAll(() => {
  fs.rmSync(kRoot, { recursive: true, force: true });
});

describe("server/model-policy gaps", () => {
  it("lists the defaults primary, every models row and an inheriting agent's primary under the defaults list", () => {
    const config = governedConfig();
    config.agents.defaults.model.primary = "particle/particle-1";
    config.agents.defaults.models["openai/gpt-6-astra"] = {};
    config.agents.list.push({ id: "ops", model: { primary: "openai/gpt-6-luna", fallbacks: ["x/y"] } });
    config.agents.list.push({ id: "lab2", model: "google/gemini-3.1-pro", modelPolicy: { allow: ["google/*"] } });
    config.agents.list[1].model = "openai/gpt-6.1-sol";
    expect(findModelPolicyGaps(config)).toEqual([
      { agentId: null, ref: "particle/particle-1" },
      { agentId: null, ref: "openai/gpt-6-astra" },
      { agentId: null, ref: "openai/gpt-6-luna" },
      { agentId: "lab", ref: "openai/gpt-6.1-sol" },
    ]);
  });

  it("finds nothing under an empty list, a provider wildcard, no policy, or a pre-migration models map", () => {
    const empty = governedConfig();
    empty.agents.defaults.modelPolicy.allow = [];
    empty.agents.defaults.model.primary = "openai/gpt-6-astra";
    expect(findModelPolicyGaps(empty)).toEqual([]);

    const wildcard = governedConfig();
    wildcard.agents.defaults.modelPolicy.allow = ["openai/*", "anthropic/claude-opus-4-6"];
    wildcard.agents.defaults.models["openai/gpt-6-astra"] = {};
    expect(findModelPolicyGaps(wildcard)).toEqual([]);

    expect(findModelPolicyGaps({ agents: { defaults: { model: { primary: "openai/gpt-6-astra" }, models: { "anthropic/claude-opus-4-6": {} } } } })).toEqual([]);
    expect(findModelPolicyGaps({})).toEqual([]);
  });

  it("allowPrimaryModel never touches a modelPolicy list and still extends a pre-migration models map", () => {
    const governed = governedConfig();
    allowPrimaryModel(governed, "particle/particle-1");
    allowPrimaryModel(governed, "openai/gpt-6.1-sol", governed.agents.list[1]);
    expect(governed).toEqual(governedConfig());

    const legacy = { agents: { defaults: { models: { "anthropic/claude-opus-4-6": {} } } } };
    allowPrimaryModel(legacy, "particle/particle-1");
    expect(legacy.agents.defaults.models).toEqual({ "anthropic/claude-opus-4-6": {}, "particle/particle-1": {} });
  });

  it("notes the pending refs and marks the restart reason once per save", () => {
    const restartRequiredState = { markRequired: vi.fn() };
    const config = governedConfig();
    config.agents.defaults.model.primary = "particle/particle-1";
    const noted = noteModelPolicyGaps({ readConfig: () => config, restartRequiredState });
    expect(noted.modelPolicyPending).toEqual(["particle/particle-1"]);
    expect(noted.modelPolicyWarning).toContain("particle/particle-1 is added to the model policy (modelPolicy.allow) when the gateway restarts");
    expect(restartRequiredState.markRequired).toHaveBeenCalledWith("model_policy_pending");

    restartRequiredState.markRequired.mockClear();
    expect(noteModelPolicyGaps({ readConfig: () => governedConfig(), restartRequiredState })).toEqual({});
    expect(noteModelPolicyGaps({ readConfig: () => { throw new Error("unreadable"); }, restartRequiredState })).toEqual({});
    expect(restartRequiredState.markRequired).not.toHaveBeenCalled();
  });
});

describe("server/model-policy on the hot path (real openclaw.json)", () => {
  const kParticleKey = "pai-hermetic-policy-test-0000000000000000";
  let savedParticleKey;

  beforeEach(() => {
    fs.mkdirSync(path.join(OPENCLAW_DIR, "agents", "main", "agent"), { recursive: true });
    writeConfig(governedConfig());
    savedParticleKey = process.env.PARTICLE_API_KEY;
    process.env.PARTICLE_API_KEY = kParticleKey;
  });

  afterEach(() => {
    if (savedParticleKey === undefined) delete process.env.PARTICLE_API_KEY;
    else process.env.PARTICLE_API_KEY = savedParticleKey;
  });

  const policies = (config) => ({
    defaults: config.agents.defaults.modelPolicy,
    lab: config.agents.list.find((agent) => agent.id === "lab").modelPolicy,
  });

  it("saves models, agents and the Particle block without writing a modelPolicy; the next launch adds them", async () => {
    const before = policies(readConfig());
    const restartRequiredState = { markRequired: vi.fn(), hasReason: vi.fn(() => false) };
    const app = express();
    app.use(express.json());
    registerModelRoutes({
      app,
      shellCmd: vi.fn(),
      execFileCmd: vi.fn(),
      gitSync: vi.fn(async () => null),
      gatewayEnv: vi.fn(() => ({})),
      parseJsonFromNoisyOutput: vi.fn(() => ({})),
      normalizeOnboardingModels: vi.fn(() => []),
      readOpenclawVersion: vi.fn(() => "2026.10.8"),
      isOnboarded: () => false,
      readEnvFile: vi.fn(() => [{ key: "PARTICLE_API_KEY", value: kParticleKey }]),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(() => true),
      authProfiles: createAuthProfiles({ prepareFreshStore: () => {}, refreshRuntime: async () => ({ refreshed: true }) }),
      restartRequiredState,
    });
    registerAgentRoutes({ app, agentsService: createAgentsService({ OPENCLAW_DIR }), restartRequiredState });

    const saved = await request(app).put("/api/models/config").send({
      primary: "particle/particle-1",
      configuredModels: { "anthropic/claude-opus-4-6": {}, "particle/particle-1": {} },
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ ok: true, modelPolicyPending: ["particle/particle-1"] });
    const created = await request(app).post("/api/agents").send({ id: "intake", model: { primary: "openai/gpt-6-luna" } });
    expect(created.status).toBe(201);
    expect(created.body.modelPolicyPending).toEqual(["particle/particle-1", "openai/gpt-6-luna"]);
    const updated = await request(app).put("/api/agents/lab").send({ model: { primary: "openai/gpt-6.1-sol" } });
    expect(updated.status).toBe(200);
    expect(updated.body.modelPolicyPending).toEqual(["particle/particle-1", "openai/gpt-6-luna", "openai/gpt-6.1-sol"]);
    expect(restartRequiredState.markRequired).toHaveBeenCalledWith("model_policy_pending");

    const afterSaves = readConfig();
    expect(afterSaves.agents.defaults.model.primary).toBe("particle/particle-1");
    expect(afterSaves.agents.defaults.models["particle/particle-1"]).toEqual({});
    expect(afterSaves.models.providers.particle.apiKey).toBe("${PARTICLE_API_KEY}");
    expect(JSON.stringify(afterSaves)).not.toContain(kParticleKey);
    expect(policies(afterSaves)).toEqual(before);

    const logger = quietLogger();
    expect(applyModelPolicyBeforeLaunch({ openclawDir: OPENCLAW_DIR, logger })).toEqual({
      ok: true,
      added: [
        { agentId: null, ref: "particle/particle-1" },
        { agentId: null, ref: "openai/gpt-6-luna" },
        { agentId: "lab", ref: "openai/gpt-6.1-sol" },
      ],
    });
    expect(policies(readConfig())).toEqual({
      defaults: { allow: ["anthropic/claude-opus-4-6", "particle/particle-1", "openai/gpt-6-luna"] },
      lab: { allow: ["google/*", "openai/gpt-6.1-sol"] },
    });
    expect(logger.log).toHaveBeenCalledWith("[alphaclaw] model policy: added particle/particle-1 to agents.defaults modelPolicy.allow before launch");
    expect(logger.log).toHaveBeenCalledWith("[alphaclaw] model policy: added openai/gpt-6.1-sol to agent lab modelPolicy.allow before launch");
  });

  it("leaves the file untouched when nothing is missing, and never throws on an unreadable config", () => {
    const bytes = fs.readFileSync(kConfigPath);
    const mtime = fs.statSync(kConfigPath).mtimeMs;
    expect(applyModelPolicyBeforeLaunch({ openclawDir: OPENCLAW_DIR, logger: quietLogger() })).toEqual({ ok: true, added: [] });
    expect(fs.readFileSync(kConfigPath).equals(bytes)).toBe(true);
    expect(fs.statSync(kConfigPath).mtimeMs).toBe(mtime);

    fs.writeFileSync(kConfigPath, "{ not json");
    const logger = quietLogger();
    expect(applyModelPolicyBeforeLaunch({ openclawDir: OPENCLAW_DIR, logger })).toEqual({ ok: false, added: [] });
    expect(fs.readFileSync(kConfigPath, "utf8")).toBe("{ not json");
    expect(logger.warn.mock.calls[0][0]).toMatch(/^\[alphaclaw\] model policy: update before launch failed \(.+\); retried on the next launch$/);
  });
});

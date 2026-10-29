const { createModelCheck } = require("../../lib/server/model-check");
const { applyOwnedProviders } = require("../../lib/server/providers/ensure");

const kKey = "pai-test-model-check-000000000000000000000000";

// A config with AlphaClaw's Particle block, as the ensure writes it.
const particleConfig = (mutate = () => {}) => {
  const config = { agents: { defaults: { model: { primary: "particle/particle-1" } } } };
  applyOwnedProviders(config, { env: { PARTICLE_API_KEY: kKey } });
  mutate(config);
  return config;
};

const response = (status, payload) => ({ status, text: async () => JSON.stringify(payload) });

// fetch stand-in: answer(url, body) decides the reply; every call is recorded.
const fakeFetch = (answer) => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, method: options.method, body, auth: options.headers?.Authorization || null });
    return answer(url, body);
  };
  return { fetchImpl, calls };
};

const run = async ({ config, answer, env = { PARTICLE_API_KEY: kKey }, isEnvRestartPending }) => {
  const fake = fakeFetch(answer);
  const check = createModelCheck({ readConfig: () => config, getEnv: () => env, fetchImpl: fake.fetchImpl, isEnvRestartPending, logger: { warn: () => {} } });
  const result = (await check.run()).results.find((row) => row.ref === "particle/particle-1");
  return { result, calls: fake.calls };
};

describe("server/model-check with an AlphaClaw-owned provider", () => {
  it("probes Particle with thinking off, the env key, and passes", async () => {
    const { result, calls } = await run({ config: particleConfig(), answer: () => response(200, { choices: [] }) });
    expect(result).toMatchObject({ status: "ok", severity: "ok", credentialSource: "env PARTICLE_API_KEY" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.particle.ai/v1/chat/completions");
    expect(calls[0].auth).toBe(`Bearer ${kKey}`);
    expect(calls[0].body).toMatchObject({ model: "particle-1", max_tokens: 16, reasoning_effort: "none" });
    expect(result.notes).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(kKey);
  });

  it("counts Particle's namespaced listing as the configured id, so a rejection is not blamed on a missing entitlement", async () => {
    const { result } = await run({
      config: particleConfig(),
      answer: (url) => (url.endsWith("/models")
        ? response(200, { object: "list", data: [{ id: "particle-ai/particle-1" }] })
        : response(404, { error: { message: "The requested model was not found." } })),
    });
    expect(result).toMatchObject({ status: "model_rejected", listed: true, listedCount: 1 });
  });

  it("keeps exact matching for every other provider", async () => {
    const config = {
      agents: { defaults: { model: { primary: "acme/foo" } } },
      models: { providers: { acme: { baseUrl: "https://acme.example.test/v1", api: "openai-completions", apiKey: "k", models: [{ id: "foo" }] } } },
    };
    const fake = fakeFetch((url) => (url.endsWith("/models")
      ? response(200, { data: [{ id: "org/foo" }] })
      : response(404, { error: { message: "The requested model was not found." } })));
    const check = createModelCheck({ readConfig: () => config, getEnv: () => ({}), fetchImpl: fake.fetchImpl, logger: { warn: () => {} } });
    const [result] = (await check.run()).results;
    expect(result).toMatchObject({ ref: "acme/foo", status: "model_rejected", listed: false, suggestions: ["org/foo"] });
    expect(fake.calls.find((call) => call.method === "POST").body.reasoning_effort).toBeUndefined();
  });

  it("names an empty balance (402 insufficient_credits) as a billing problem with no config change", async () => {
    const { result } = await run({
      config: particleConfig(),
      answer: () => response(402, { error: { message: "Your credit balance is empty. Add credits to continue.", type: "insufficient_credits_error", code: "insufficient_credits" } }),
    });
    expect(result).toMatchObject({ status: "billing", severity: "error", providerStatus: 402 });
    expect(result.fix).toContain("Add credits on particle's billing page");
    expect(result.fix).toContain("No AlphaClaw or OpenClaw config change is needed");
  });

  it("reads 503 model_unavailable as a provider outage, not a rejected id", async () => {
    const { result } = await run({ config: particleConfig(), answer: () => response(503, { error: { message: "The model is not available right now", code: "model_unavailable" } }) });
    expect(result).toMatchObject({ status: "provider_unavailable", severity: "warn" });
  });

  it("reads a probe timeout as a busy queue when the model list still answers", async () => {
    const { result, calls } = await run({
      config: particleConfig(),
      answer: (url) => {
        if (url.endsWith("/models")) return response(200, { data: [{ id: "particle-ai/particle-1" }] });
        throw Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
      },
    });
    expect(result).toMatchObject({ status: "busy", severity: "warn" });
    expect(calls.map((call) => call.method)).toEqual(["POST", "GET"]);
  });

  it("still reports an unreachable provider when neither request answers", async () => {
    const { result } = await run({
      config: particleConfig(),
      answer: () => {
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      },
    });
    expect(result).toMatchObject({ status: "unreachable", severity: "error" });
  });

  it("notes an edited block, a baseUrl that sends the key elsewhere, and a pending restart", async () => {
    const config = particleConfig((cfg) => {
      cfg.models.providers.particle.baseUrl = "https://proxy.example.test/v1";
    });
    const { result } = await run({ config, answer: () => response(200, {}), isEnvRestartPending: () => true });
    expect(result.notes).toEqual([
      expect.stringContaining("models.providers.particle was edited (baseUrl), so AlphaClaw no longer updates it"),
      expect.stringContaining("points at https://proxy.example.test, not https://api.particle.ai; that host receives the Particle key"),
      expect.stringContaining("If you set or replaced PARTICLE_API_KEY, restart the gateway"),
    ]);
  });

  it("reports the unset key with the variable to set", async () => {
    const { result, calls } = await run({ config: particleConfig(), env: {}, answer: () => response(200, {}) });
    expect(result).toMatchObject({ status: "no_credential", envVar: "PARTICLE_API_KEY" });
    expect(calls).toHaveLength(0);
  });
});

const http = require("http");
const { createModelCheck } = require("../../lib/server/model-check");
const { collectModelTargets, resolveProviderConnection, resolveSecretValue } = require("../../lib/server/model-check/targets");
const { classifyAnswer } = require("../../lib/server/model-check/probe");

const kKey = "sk-test-model-check-0000000000000000";

// A provider that serves "good" on both OpenAI APIs, "wonder-1" only on the
// Responses API (the shape of a model configured with the wrong api), and
// nothing else; its /models lists good, wonder-1 and gone-2.
const startProvider = () =>
  new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        const parsed = body ? JSON.parse(body) : {};
        requests.push({ method: req.method, url: req.url, model: parsed.model, auth: req.headers.authorization || req.headers["x-api-key"] || null, body: parsed });
        const send = (status, payload) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(payload));
        };
        if (req.headers.authorization !== `Bearer ${kKey}` && req.headers["x-api-key"] !== kKey) {
          return send(401, { error: { message: "Invalid API key provided: " + String(req.headers.authorization || "") } });
        }
        if (req.url.startsWith("/empty/")) {
          if (req.method === "GET" && req.url.endsWith("/models")) return send(200, { object: "list", data: [] });
          return send(404, { error: { message: "The requested model was not found." } });
        }
        if (req.method === "GET" && req.url.endsWith("/models")) return send(200, { object: "list", data: [{ id: "good" }, { id: "wonder-1" }, { id: "gone-2" }] });
        const onResponses = req.url.endsWith("/responses");
        if (parsed.model === "good" || (onResponses && parsed.model === "wonder-1")) return send(200, { id: "x", output: [] });
        return send(404, { error: { message: "The requested model was not found.", type: "invalid_request_error" } });
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }));
  });

describe("server/model-check targets", () => {
  it("collects every primary, fallback, allowlist and alias ref once, per scope, and skips wildcards", () => {
    const targets = collectModelTargets({
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-5-5", fallbacks: ["openai/gpt-6-sol"] },
          models: { "meta/muse-wonder-1.0": { alias: "wonder" }, "anthropic/claude-opus-5-5": {} },
          modelPolicy: { allow: ["together/*", "meta/muse-spark-1.3"] },
        },
        list: [{ id: "ops", model: "openai/gpt-6-sol" }, { id: "bad id!", model: { primary: "x/y" } }],
      },
    });
    expect(targets.map((target) => [target.ref, target.roles, target.aliases])).toEqual([
      ["anthropic/claude-opus-5-5", ["primary", "allowed"], []],
      ["openai/gpt-6-sol", ["fallback", "primary (agent ops)"], []],
      ["meta/muse-wonder-1.0", ["allowed"], ["wonder"]],
      ["meta/muse-spark-1.3", ["allowed"], []],
      ["x/y", ["primary (agent #1)"], []],
    ]);
  });

  it("resolves ${VAR}, bare env names and env SecretRefs, and names the missing variable", () => {
    const env = { META_KEY: "k1", OTHER: "" };
    expect(resolveSecretValue("${META_KEY}", env)).toEqual({ present: true, value: "k1", envVar: "META_KEY" });
    expect(resolveSecretValue("META_KEY", env)).toEqual({ present: true, value: "k1", envVar: "META_KEY" });
    expect(resolveSecretValue({ source: "env", id: "META_KEY" }, env)).toEqual({ present: true, value: "k1", envVar: "META_KEY" });
    expect(resolveSecretValue("${MISSING}", env)).toEqual({ present: false, envVar: "MISSING" });
    expect(resolveSecretValue("OTHER", env)).toEqual({ present: false, envVar: "OTHER" });
    expect(resolveSecretValue({ source: "file", id: "x" }, env)).toEqual({ present: true, unreadable: true });
    expect(resolveSecretValue("literal-key", env)).toEqual({ present: true, value: "literal-key" });
  });

  it("builds the connection from apiKey, an auth profile, request.auth, or names why it cannot probe", () => {
    const config = {
      models: {
        providers: {
          meta: { baseUrl: "https://api.example.test/v1", api: "openai-completions", apiKey: "${META_KEY}", models: [{ id: "muse-wonder-1.0" }] },
          prof: { baseUrl: "https://prof.example.test/v1" },
          ant: { baseUrl: "https://ant.example.test", api: "anthropic-messages", apiKey: "a-key" },
          hdr: { baseUrl: "https://hdr.example.test/v1", request: { auth: { mode: "header", headerName: "api-key", value: "h-key" } } },
          gem: { baseUrl: "https://gem.example.test", api: "google-generative-ai", apiKey: "g" },
          nourl: { api: "openai-completions", apiKey: "k" },
        },
      },
    };
    const connect = (provider, env = {}) =>
      resolveProviderConnection({ config, provider, env, profiles: [{ id: "prof:default", provider: "prof", type: "api_key", key: "p-key" }] });
    expect(connect("meta")).toMatchObject({ custom: true, probe: false, skip: "no_credential", envVar: "META_KEY" });
    expect(connect("meta", { META_KEY: "k1" })).toMatchObject({ probe: true, headers: { Authorization: "Bearer k1" }, credentialSource: "env META_KEY", declaredModels: ["muse-wonder-1.0"] });
    expect(connect("prof")).toMatchObject({ probe: true, api: "openai-completions", headers: { Authorization: "Bearer p-key" }, credentialSource: "auth profile prof:default" });
    expect(connect("ant")).toMatchObject({ probe: true, headers: { "x-api-key": "a-key" } });
    expect(connect("hdr")).toMatchObject({ probe: true, headers: { "api-key": "h-key" }, credentialSource: "request.auth" });
    expect(connect("gem")).toMatchObject({ probe: false, skip: "unsupported_api" });
    expect(connect("nourl")).toMatchObject({ probe: false, skip: "no_base_url" });
    expect(connect("anthropic")).toEqual({ custom: false });
  });

  it("classifies provider answers by status and the provider's own words", () => {
    expect(classifyAnswer({ status: 200, text: "{}" }).outcome).toBe("ok");
    expect(classifyAnswer({ status: 404, text: '{"error":{"message":"The requested model was not found."}}' })).toEqual({ outcome: "model_rejected", message: "The requested model was not found." });
    expect(classifyAnswer({ status: 400, text: '{"error":{"message":"The model \'x\' does not exist"}}' }).outcome).toBe("model_rejected");
    expect(classifyAnswer({ status: 404, text: "<html>Not Found</html>" }).outcome).toBe("endpoint_not_found");
    expect(classifyAnswer({ status: 401, text: '{"error":"bad key"}' }).outcome).toBe("auth_rejected");
    expect(classifyAnswer({ status: 429, text: "" }).outcome).toBe("rate_limited");
    expect(classifyAnswer({ status: 500, text: "boom" }).outcome).toBe("inconclusive");
    expect(classifyAnswer({ status: 0, error: "ECONNREFUSED" }).outcome).toBe("unreachable");
  });
});

describe("server/model-check run", () => {
  let provider;
  beforeAll(async () => {
    provider = await startProvider();
  });
  afterAll(() => provider.server.close());
  beforeEach(() => {
    provider.requests.length = 0;
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  const makeConfig = () => ({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-5-5", fallbacks: ["fx/good"] },
        models: { "fx/wonder-1": { alias: "wonder" }, "fx/gone-1": {}, "keyless/m": {}, "badkey/good": {}, "meta/muse-wonder-1.0": {}, "nokey/m": {}, "ent/muse-1": {} },
      },
    },
    models: {
      providers: {
        fx: { baseUrl: provider.baseUrl, api: "openai-completions", apiKey: "${FX_KEY}", models: [{ id: "good" }, { id: "wonder-1" }, { id: "gone-1" }] },
        keyless: { baseUrl: "https://keyless.example.test/v1", apiKey: "${KEYLESS_KEY}", models: [{ id: "m" }] },
        ent: { baseUrl: provider.baseUrl.replace(/\/v1$/, "/empty/v1"), apiKey: "${FX_KEY}", models: [{ id: "muse-1" }] },
        badkey: { baseUrl: provider.baseUrl, apiKey: "wrong-key-value-123456", models: [{ id: "good" }] },
      },
    },
  });
  const openclawRows = [
    { key: "anthropic/claude-opus-5-5", input: "text+image", contextWindow: 1000000, available: true },
    { key: "meta/muse-wonder-1.0", input: "-", contextWindow: null, available: null },
    { key: "nokey/m", input: "text", contextWindow: 1000, available: false },
  ];
  const makeCheck = (overrides = {}) =>
    createModelCheck({
      readConfig: makeConfig,
      getEnv: () => ({ FX_KEY: kKey }),
      listOpenclawModels: async () => openclawRows,
      redact: (text) => String(text).split(kKey).join("***").split("wrong-key-value-123456").join("***"),
      ...overrides,
    });
  const byRef = (run) => Object.fromEntries(run.results.map((result) => [result.ref, result]));

  it("names what each provider answered and the one fix", async () => {
    const run = await makeCheck().run();
    const results = byRef(run);
    expect(results["fx/good"]).toMatchObject({ status: "ok", severity: "ok", providerStatus: 200, api: "openai-completions" });
    expect(results["fx/wonder-1"]).toMatchObject({
      status: "wrong_api",
      severity: "error",
      alternateApi: "openai-responses",
      providerStatus: 404,
      providerAnswer: "The requested model was not found.",
      aliases: ["wonder"],
    });
    expect(results["fx/wonder-1"].reason).toContain("fx answered 404 \"The requested model was not found.\" for wonder-1 on openai-completions");
    expect(results["fx/wonder-1"].fix).toContain('Set models.providers.fx.api to "openai-responses"');
    expect(results["fx/gone-1"]).toMatchObject({ status: "model_rejected", listed: false });
    expect(results["fx/gone-1"].suggestions[0]).toBe("gone-2");
    expect(results["fx/gone-1"].reason).toContain("The key works, but gone-1 is not among the 3 models the provider lists for it.");
    expect(results["fx/gone-1"].fix).toBe("Your fx key does not have access to gone-1. Enable it for this key in fx's dashboard, or, if the id is a typo, use one it lists (gone-2, wonder-1, good).");
    // The shape of a key with no model entitlements: 200 with an empty list,
    // 404 for every id on both APIs. The fix is at the provider, not config.
    expect(results["ent/muse-1"]).toMatchObject({ status: "model_rejected", listed: false, listedCount: 0 });
    expect(results["ent/muse-1"].reason).toContain("The key works, but the provider's model list for it is empty.");
    expect(results["ent/muse-1"].fix).toBe("Your ent key has access to no models. Enable model access for this key in ent's dashboard, then run the check again. No AlphaClaw or OpenClaw config change is needed.");
    expect(results["keyless/m"]).toMatchObject({ status: "no_credential", envVar: "KEYLESS_KEY" });
    expect(results["keyless/m"].fix).toBe("Set KEYLESS_KEY in Envars, then restart the gateway.");
    expect(results["badkey/good"]).toMatchObject({ status: "auth_rejected", providerStatus: 401 });
    expect(results["meta/muse-wonder-1.0"]).toMatchObject({ status: "unresolved", custom: false });
    expect(results["meta/muse-wonder-1.0"].reason).toContain('no installed plugin provides "meta"');
    expect(results["nokey/m"]).toMatchObject({ status: "no_credential", custom: false });
    expect(results["anthropic/claude-opus-5-5"]).toMatchObject({ status: "available", severity: "ok" });
    expect(run.problems).toBe(7);
    expect(makeCheck().getLastRun()).toBe(null);
  });

  it("never returns or logs a credential, even when the provider echoes it", async () => {
    const check = makeCheck();
    const run = await check.run();
    expect(JSON.stringify(run)).not.toContain(kKey);
    expect(JSON.stringify(run)).not.toContain("wrong-key-value-123456");
    expect(byRef(run)["badkey/good"].providerAnswer).toBe("Invalid API key provided: Bearer ***");
    expect(check.getLastRun()).toBe(run);
  });

  it("sends at most 16 output tokens per probe and nothing when probe is false", async () => {
    await makeCheck().run({ refs: ["fx/wonder-1"] });
    expect(provider.requests.map((request) => [request.url, request.model])).toEqual([
      ["/v1/chat/completions", "wonder-1"],
      ["/v1/responses", "wonder-1"],
    ]);
    expect(provider.requests[0].body.max_tokens).toBe(16);
    expect(provider.requests[1].body.max_output_tokens).toBe(16);
    provider.requests.length = 0;
    const run = await makeCheck().run({ probe: false });
    expect(provider.requests).toEqual([]);
    expect(byRef(run)["fx/good"].status).toBe("not_probed");
  });

  it("checks a ref outside the config when asked, and coalesces concurrent full checks", async () => {
    const check = makeCheck();
    expect(await check.checkRef("badkey/other")).toMatchObject({ status: "auth_rejected", roles: [], declared: false });
    expect(await check.checkRef("fx/good")).toMatchObject({ status: "ok", roles: ["fallback"] });
    const [first, second] = await Promise.all([check.run(), check.run()]);
    expect(first).toBe(second);
  });

  it("still reports custom providers when OpenClaw's listing fails", async () => {
    const run = await makeCheck({ listOpenclawModels: async () => { throw new Error("cli down"); } }).run({ refs: ["fx/good", "meta/muse-wonder-1.0"] });
    expect(run.openclawListing).toBe(false);
    expect(byRef(run)["fx/good"].status).toBe("ok");
    expect(byRef(run)["meta/muse-wonder-1.0"]).toMatchObject({ status: "not_checked", severity: "info" });
  });
});

// The box's models.providers.google block (OpenClaw 2026.10.9), key order as
// stored, key redacted: no baseUrl key at all. OpenClaw accepts it because
// google is one of its built-in providers and fills in the Google plugin's
// base URL; a real turn through it replies.
const boxGoogleBlock = () =>
  JSON.parse(
    '{"apiKey":"${GEMINI_API_KEY}","api":"google-generative-ai","models":[{"id":"gemini-3.1-pro-preview","name":"Gemini 3.1 Pro","reasoning":true,"contextWindow":1048576,"contextTokens":1048576,"maxTokens":65536,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}',
  );

describe("server/model-check built-in providers without a baseUrl", () => {
  const kGoogleKey = "test-gemini-key-000000000000";
  const kOpenaiKey = "test-openai-key-000000000000";
  const makeFetch = () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization || null, body: init.body ? JSON.parse(init.body) : null });
      return { status: 200, text: async () => "{}" };
    };
    return { calls, fetchImpl };
  };

  it("does not call the box's Google block misconfigured, and resolves Google's built-in base URL from the pinned OpenClaw", async () => {
    const config = {
      models: { providers: { google: boxGoogleBlock() } },
      agents: {
        defaults: {
          models: { "google/gemini-3.1-pro-preview": { alias: "gemini" } },
          modelPolicy: { allow: ["google/gemini-3.1-pro-preview"] },
        },
      },
    };
    const before = JSON.stringify(config);
    const { calls, fetchImpl } = makeFetch();
    const check = createModelCheck({
      readConfig: () => config,
      getEnv: () => ({ GEMINI_API_KEY: kGoogleKey }),
      listProfiles: () => [
        { id: "google:default", provider: "google", type: "api_key", key: kGoogleKey },
        { id: "google-vertex:default", provider: "google-vertex", type: "api_key", key: "test-vertex-key-0000" },
      ],
      listOpenclawModels: async () => [{ key: "google/gemini-3.1-pro-preview", input: "text+image", contextWindow: 1048576, available: true }],
      fetchImpl,
    });
    const result = await check.checkRef("google/gemini-3.1-pro-preview");
    expect(result).toMatchObject({
      custom: true,
      api: "google-generative-ai",
      openclaw: "available",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      aliases: ["gemini"],
      severity: "info",
    });
    expect(result.status).not.toBe("misconfigured");
    expect(result.reason).toBe("AlphaClaw does not test the google-generative-ai API.");
    expect(calls).toEqual([]);
    expect(JSON.stringify(config)).toBe(before);
    expect(JSON.stringify(result)).not.toContain(kGoogleKey);
  });

  it("probes a built-in provider whose entry has no baseUrl on the base URL and API OpenClaw fills in", async () => {
    const providerDefaults = new Map([["openai", { baseUrl: "https://api.openai.com/v1", api: "openai-responses" }]]);
    const config = { models: { providers: { OpenAI: { apiKey: "${OPENAI_KEY}", models: [{ id: "gpt-6-sol" }] } } } };
    expect(resolveProviderConnection({ config, provider: "OpenAI", env: { OPENAI_KEY: kOpenaiKey }, providerDefaults })).toMatchObject({
      probe: true,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    const { calls, fetchImpl } = makeFetch();
    const result = await createModelCheck({
      readConfig: () => config,
      getEnv: () => ({ OPENAI_KEY: kOpenaiKey }),
      readProviderDefaults: () => providerDefaults,
      fetchImpl,
    }).checkRef("OpenAI/gpt-6-sol");
    expect(result).toMatchObject({ status: "ok", severity: "ok", api: "openai-responses", baseUrl: "https://api.openai.com/v1", endpoint: "https://api.openai.com/v1/responses" });
    expect(calls).toEqual([{ url: "https://api.openai.com/v1/responses", auth: `Bearer ${kOpenaiKey}`, body: expect.objectContaining({ model: "gpt-6-sol", max_output_tokens: 16 }) }]);
  });

  it("leaves a built-in provider whose base URL AlphaClaw cannot see unchecked, not misconfigured", async () => {
    const config = { models: { providers: { deepseek: { api: "openai-completions", apiKey: "k", models: [{ id: "deepseek-v4-pro" }] } } } };
    const { calls, fetchImpl } = makeFetch();
    const result = await createModelCheck({ readConfig: () => config, readProviderDefaults: () => new Map(), fetchImpl }).checkRef("deepseek/deepseek-v4-pro");
    expect(result).toMatchObject({ status: "not_checked", severity: "info" });
    expect(result.reason).toBe("OpenClaw supplies the base URL for its built-in deepseek provider, and AlphaClaw does not know it, so no test request was sent.");
    expect(calls).toEqual([]);
  });

  it("keeps a provider OpenClaw has no built-in base URL for misconfigured, even on the Google API", async () => {
    const config = { models: { providers: { "my-gemini": boxGoogleBlock() } } };
    const result = await createModelCheck({ readConfig: () => config, getEnv: () => ({ GEMINI_API_KEY: kGoogleKey }) }).checkRef("my-gemini/gemini-3.1-pro-preview");
    expect(result).toMatchObject({ status: "misconfigured", severity: "error" });
    expect(result.reason).toBe("models.providers.my-gemini has no baseUrl, and OpenClaw fills one in only for its built-in providers.");
    expect(result.fix).toBe("Set models.providers.my-gemini.baseUrl to the provider's API root.");
  });
});


// What the pinned OpenClaw would do with these overlays, read from its
// bundled plugin manifests (no readProviderDefaults override): the manifest
// fallback must never send a credential to a host, or in a form, OpenClaw
// itself would not use.
describe("server/model-check manifest fallback limits", () => {
  const recordFetch = () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      calls.push({ url, authorization: init.headers.Authorization || null, apiKey: init.headers["x-api-key"] || null });
      return { status: 200, text: async () => "{}" };
    };
    return { calls, fetchImpl };
  };
  const checkOne = async ({ config, ref, profiles = [], env = {} }) => {
    const { calls, fetchImpl } = recordFetch();
    const result = await createModelCheck({ readConfig: () => config, getEnv: () => env, listProfiles: () => profiles, fetchImpl }).checkRef(ref);
    return { result, calls };
  };

  it("never probes GitHub Copilot on the manifest's host, whose real host depends on the GitHub account", async () => {
    const kCopilotKey = "test-copilot-key-0000000000";
    const profiles = [{ id: "github-copilot:default", provider: "github-copilot", type: "api_key", key: kCopilotKey }];
    for (const entry of [{ params: { githubDomain: "acme.ghe.com" } }, { api: "openai-responses" }]) {
      const config = { models: { providers: { "github-copilot": { ...entry, models: [{ id: "gpt-6-sol" }] } } } };
      const { result, calls } = await checkOne({ config, ref: "github-copilot/gpt-6-sol", profiles });
      expect(result).toMatchObject({ status: "not_checked", severity: "info" });
      expect(result.baseUrl).toBeUndefined();
      expect(result.reason).toBe("The GitHub Copilot host depends on the GitHub account, and only OpenClaw looks it up, so no test request was sent.");
      expect(calls).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(kCopilotKey);
    }
  });

  it("uses the API and base URL the manifest gives one model, and the provider-wide ones for the rest", async () => {
    const kOpencodeKey = "test-opencode-key-0000000000";
    const config = { models: { providers: { "opencode-go": { apiKey: kOpencodeKey } } } };
    const qwen = await checkOne({ config, ref: "opencode-go/qwen3.8-max" });
    expect(qwen.result).toMatchObject({ status: "ok", api: "anthropic-messages", baseUrl: "https://opencode.ai/zen/go" });
    expect(qwen.calls).toEqual([{ url: "https://opencode.ai/zen/go/v1/messages", authorization: null, apiKey: kOpencodeKey }]);
    const luna = await checkOne({ config, ref: "opencode-go/gpt-5.6-luna" });
    expect(luna.result).toMatchObject({ status: "ok", api: "openai-responses", baseUrl: "https://opencode.ai/zen/go/v1" });
    expect(luna.calls).toEqual([{ url: "https://opencode.ai/zen/go/v1/responses", authorization: `Bearer ${kOpencodeKey}`, apiKey: null }]);
    const other = await checkOne({ config, ref: "opencode-go/some-other-model" });
    expect(other.result).toMatchObject({ api: "openai-completions", baseUrl: "https://opencode.ai/zen/go/v1" });
    expect(other.calls.map((call) => call.url)).toEqual(["https://opencode.ai/zen/go/v1/chat/completions"]);
  });

  it("leaves a model unchecked when the entry lists it and the manifest gives it a route of its own", async () => {
    const config = { models: { providers: { "opencode-go": { apiKey: "test-opencode-key", models: [{ id: "qwen3.8-max" }] } } } };
    const { result, calls } = await checkOne({ config, ref: "opencode-go/qwen3.8-max" });
    expect(result).toMatchObject({ status: "not_checked", severity: "info" });
    expect(result.reason).toBe("OpenClaw's catalog gives qwen3.8-max its own API or base URL, and this entry also lists it, so AlphaClaw cannot tell which one OpenClaw uses and sent no test request.");
    expect(calls).toEqual([]);
  });

  it("does not send a sign-in or subscription token as an API key on the manifest's base URL", async () => {
    const kSetupToken = "sk-ant-oat01-test-000000000000";
    const cases = [
      { entry: { apiKey: kSetupToken }, profiles: [] },
      { entry: {}, profiles: [{ id: "anthropic:manual", provider: "anthropic", type: "token", token: "test-anthropic-token-0000" }] },
      { entry: {}, profiles: [{ id: "anthropic:default", provider: "anthropic", type: "oauth", access: "test-anthropic-access-0000" }] },
      { entry: { apiKey: "test-anthropic-api-key-0000" }, profiles: [{ id: "anthropic:manual", provider: "anthropic", type: "token", token: "test-anthropic-token-0000" }] },
    ];
    for (const { entry, profiles } of cases) {
      const config = { models: { providers: { anthropic: { ...entry, models: [{ id: "claude-opus-5-5" }] } } } };
      const { result, calls } = await checkOne({ config, ref: "anthropic/claude-opus-5-5", profiles });
      expect(result).toMatchObject({ status: "not_checked", severity: "info" });
      expect(result.reason).toBe("The credential for anthropic is a sign-in or subscription token, which OpenClaw sends its own way, so no test request was sent.");
      expect(calls).toEqual([]);
    }
    const plain = await checkOne({ config: { models: { providers: { anthropic: { apiKey: "test-anthropic-api-key-0000" } } } }, ref: "anthropic/claude-opus-5-5" });
    expect(plain.calls).toEqual([{ url: "https://api.anthropic.com/v1/messages", authorization: null, apiKey: "test-anthropic-api-key-0000" }]);
  });

  it("keeps probing an entry that sets its own baseUrl, on that URL and with the token as configured", async () => {
    const kSetupToken = "sk-ant-oat01-test-000000000000";
    const config = {
      models: {
        providers: {
          anthropic: { baseUrl: "https://proxy.example.test", api: "anthropic-messages", apiKey: kSetupToken },
          openai: { baseUrl: "https://gateway.example.test/v1", api: "openai-completions", apiKey: "test-openai-key-0000" },
        },
      },
    };
    const ant = await checkOne({ config, ref: "anthropic/claude-opus-5-5" });
    expect(ant.result).toMatchObject({ status: "ok", api: "anthropic-messages", baseUrl: "https://proxy.example.test" });
    expect(ant.calls).toEqual([{ url: "https://proxy.example.test/v1/messages", authorization: null, apiKey: kSetupToken }]);
    const oai = await checkOne({ config, ref: "openai/gpt-6-sol" });
    expect(oai.result).toMatchObject({ status: "ok", api: "openai-completions", baseUrl: "https://gateway.example.test/v1" });
    expect(oai.calls).toEqual([{ url: "https://gateway.example.test/v1/chat/completions", authorization: "Bearer test-openai-key-0000", apiKey: null }]);
  });
});


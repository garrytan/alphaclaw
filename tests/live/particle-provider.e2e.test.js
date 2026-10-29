// LIVE TIER: AlphaClaw's Particle provider block (ALPH-53) against the REAL
// pinned OpenClaw and a local stub of Particle's Chat Completions API.
//
// The block is the one ensureOwnedProviders writes (lib/server/providers),
// with only baseUrl pointed at the stub, and openclaw.json carries an
// agents.defaults.modelPolicy.allow list that does not name Particle, the
// shape of a migrated box. It proves:
//   1. the launch adds particle/particle-1 to modelPolicy.allow while no
//      gateway serves (model-policy.js), so the first turn is not refused;
//   2. the request OpenClaw sends: model id, the env key as a bearer token,
//      streamed usage, prompt_cache_key, max_completion_tokens, tools, and
//      reasoning_effort (low by default, none after /think off);
//   3. a streamed tool call runs the tool loop to a final answer;
//   4. streamed usage lands in the transcript, priced from the block;
//   5. OpenClaw lists the model only once the policy names it.
// What only the real API can show (cache hits, real reasoning tokens, the
// served model name) is outside this test.
const fs = require("fs");
const http = require("http");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-particle-root-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
process.env.PATH = [liveHelpers.repoBinDir(), process.env.PATH].join(path.delimiter);

const { kLiveEnabled, waitFor, readDeclaredPin, runCliJson, repoOpenclawBin } = liveHelpers;
const describeLive = kLiveEnabled ? describe : describe.skip;
const kTestTimeoutMs = 10 * 60 * 1000;
const kKey = "pai-live-fixture-key-000000000000000000000000";
const kStubModel = "particle-ai/particle-1";

// Particle's wire shape as documented (docs.particle.ai): SSE chunks with
// reasoning_content, then a usage chunk with no choices, then [DONE].
const startStub = () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {}
      requests.push({ url: req.url, method: req.method, auth: req.headers.authorization || null, body: parsed });
      if (req.headers.authorization !== `Bearer ${kKey}`) {
        res.writeHead(401, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "Invalid API key", code: "invalid_api_key" } }));
      }
      if (req.method === "GET" && req.url.endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ object: "list", data: [{ id: kStubModel }] }));
      }
      if (!req.url.endsWith("/chat/completions")) {
        res.writeHead(404);
        return res.end("{}");
      }
      const messages = parsed.messages || [];
      const last = messages[messages.length - 1] || {};
      const lastUser = JSON.stringify([...messages].reverse().find((m) => m.role === "user")?.content || "");
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "chatcmpl-live", object: "chat.completion.chunk", created: 1, model: kStubModel, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const usage = `data: ${JSON.stringify({ id: "chatcmpl-live", object: "chat.completion.chunk", created: 1, model: kStubModel, choices: [], usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 3 } } })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant" }));
      res.write(chunk({ reasoning_content: "thinking it over" }));
      if (lastUser.includes("TOOLCALL") && last.role !== "tool") {
        const tool = (parsed.tools || []).map((entry) => entry.function?.name).find(Boolean);
        res.write(chunk({ tool_calls: [{ index: 0, id: "call_live_1", type: "function", function: { name: tool, arguments: "{}" } }] }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ content: last.role === "tool" ? "tool loop done" : "pong particle" }));
        res.write(chunk({}, "stop"));
      }
      res.write(usage);
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests })));
};

describeLive(`LIVE Particle provider against the ${readDeclaredPin()} pin`, () => {
  let gateway;
  let stub;
  let port;
  let configPath;
  let savedKey;

  beforeAll(async () => {
    stub = await startStub();
    savedKey = process.env.PARTICLE_API_KEY;
    process.env.PARTICLE_API_KEY = kKey;
    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    const { ensureOwnedProviders } = require("../../lib/server/providers/ensure");
    const { kOwnedProviderPresets } = require("../../lib/server/providers/presets");
    port = 19400 + Math.floor(Math.random() * 300);
    const token = "live-particle-token-000000000000000000";
    fs.mkdirSync(path.join(OPENCLAW_DIR, "workspace"), { recursive: true });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    configPath = path.join(OPENCLAW_DIR, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({
      meta: { migrations: { modelPolicyAllowlist: true } },
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: {
        defaults: {
          workspace: path.join(OPENCLAW_DIR, "workspace"),
          model: { primary: "particle/particle-1" },
          models: { "particle/particle-1": {} },
          modelPolicy: { allow: ["openai/gpt-6-luna"] },
        },
      },
      channels: {},
    }, null, 2));
    const presets = kOwnedProviderPresets.map((preset) => ({ ...preset, baseUrl: `http://127.0.0.1:${stub.server.address().port}/v1` }));
    expect(ensureOwnedProviders({ openclawDir: OPENCLAW_DIR, env: { PARTICLE_API_KEY: kKey }, presets })).toMatchObject({ ok: true, changed: true });
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");
  });

  afterAll(async () => {
    try {
      await gateway?.stopGatewayForShutdown?.({ budgetMs: 8000 });
    } catch {}
    for (const pid of require("../../lib/server/gateway-identity").findPortListenerPids?.(port) || []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    stub?.server.close();
    if (savedKey === undefined) delete process.env.PARTICLE_API_KEY;
    else process.env.PARTICLE_API_KEY = savedKey;
  });

  const readyzOk = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
    } catch {
      return false;
    }
  };
  const call = (method, params) =>
    runCliJson(repoOpenclawBin(), ["gateway", "call", method, "--params", JSON.stringify(params), "--json"], { env: gateway.gatewayEnv(), label: method });
  const sessionKey = "agent:main:explicit:particle-live";
  let sent = 0;
  const send = (message) => call("chat.send", { sessionKey, message, idempotencyKey: `particle-live-${(sent += 1)}` });
  const history = () => call("chat.history", { sessionKey, limit: 50 }).messages || [];
  const countIn = (needle) => (JSON.stringify(history()).split(needle).length - 1);
  const waitForCount = (needle, count, label) => waitFor(async () => countIn(needle) >= count, 120_000, label);
  const chatRequests = () => stub.requests.filter((request) => request.method === "POST" && request.url.endsWith("/chat/completions"));

  it(
    "runs Particle turns through the AlphaClaw block: policy added at launch, request shape, thinking off, tool loop, usage",
    async () => {
      const block = JSON.parse(fs.readFileSync(configPath, "utf8")).models.providers.particle;
      console.log(`[live] particle block:\n${JSON.stringify(block, null, 2)}`);
      expect(block.apiKey).toBe("${PARTICLE_API_KEY}");
      expect(fs.readFileSync(configPath, "utf8")).not.toContain(kKey);

      const listParticle = (env) => runCliJson(repoOpenclawBin(), ["models", "list", "--json"], { env }).models.find((model) => model.key === "particle/particle-1");
      // The modelPolicy list governs: before the launch adds Particle to it,
      // OpenClaw does not offer the model at all.
      expect(listParticle(gateway.gatewayEnv())).toBeUndefined();

      await gateway.startGateway();
      await waitFor(readyzOk, 180_000, "gateway /readyz 200");
      expect(JSON.parse(fs.readFileSync(configPath, "utf8")).agents.defaults.modelPolicy.allow).toEqual(["openai/gpt-6-luna", "particle/particle-1"]);
      expect(listParticle(gateway.gatewayEnv())).toMatchObject({ available: true, contextWindow: 1048576, input: "text+image" });

      send("Hi");
      await waitForCount("pong particle", 1, "first Particle reply");
      const first = chatRequests()[0];
      expect(first.auth).toBe(`Bearer ${kKey}`);
      expect(first.body).toMatchObject({
        model: "particle-1",
        stream: true,
        stream_options: { include_usage: true },
        max_completion_tokens: 131072,
        reasoning_effort: "low",
      });
      expect(typeof first.body.prompt_cache_key).toBe("string");
      expect(first.body.prompt_cache_key.length).toBeGreaterThan(0);
      expect(first.body.tools.length).toBeGreaterThan(0);
      expect(first.body.max_tokens).toBeUndefined();

      send("/think off");
      await waitForCount("Thinking disabled", 1, "/think off acknowledged");
      send("Hi off");
      await waitForCount("pong particle", 2, "reply with thinking off");
      expect(chatRequests().at(-1).body.reasoning_effort).toBe("none");

      send("TOOLCALL please");
      await waitForCount("tool loop done", 1, "tool loop final answer");
      const toolTurn = chatRequests().slice(-2);
      expect(toolTurn[0].body.messages.at(-1).role).toBe("user");
      const followUp = toolTurn[1].body.messages;
      const toolResult = followUp.at(-1);
      const callingTurn = followUp.at(-2);
      console.log(`[live] tool round trip: ${JSON.stringify({ calls: callingTurn.tool_calls, result: { role: toolResult.role, tool_call_id: toolResult.tool_call_id } })}`);
      expect(toolResult.role).toBe("tool");
      expect(callingTurn.role).toBe("assistant");
      expect(callingTurn.tool_calls.map((entry) => entry.id)).toContain(toolResult.tool_call_id);

      const replies = history().filter((message) => message.role === "assistant" && message.provider === "particle");
      expect(replies.length).toBeGreaterThanOrEqual(3);
      expect(replies[0]).toMatchObject({ model: "particle-1", usage: { input: 12, output: 9, totalTokens: 21 } });
      expect(replies[0].usage.cost.input).toBeCloseTo(12 * 0.25 / 1e6, 12);
      expect(replies[0].usage.cost.output).toBeCloseTo(9 * 1 / 1e6, 12);
    },
    kTestTimeoutMs,
  );
});

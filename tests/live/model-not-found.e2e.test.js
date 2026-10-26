// LIVE TIER — a model /model accepts but the provider will not serve
// (ALPH-47), against the REAL pinned OpenClaw. A local provider serves
// "wonder-1" on the Responses API only, while openclaw.json configures the
// provider with api openai-completions and allowlists the model with an
// alias: the shape of a hand-configured provider whose API is wrong.
//
// It reproduces the failure (`/model wonder` is accepted, the next message
// answers "This model was not found", fallbacks off for the override), then
// shows AlphaClaw's side: the model_not_found watch tells the owner which
// model failed, what the provider answered and the fix; the model check says
// the same; applying the fix makes the next reply and the check succeed.
const fs = require("fs");
const http = require("http");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-model-root-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
const kCandidateBinDir = process.env.OPENCLAW_CONTRACT_INSTALL_DIR
  ? path.resolve(process.env.OPENCLAW_CONTRACT_INSTALL_DIR, "node_modules", ".bin")
  : null;
process.env.PATH = [kCandidateBinDir, liveHelpers.repoBinDir(), process.env.PATH].filter(Boolean).join(path.delimiter);

const { kLiveEnabled, waitFor, readDeclaredPin, runCliJson, repoOpenclawBin } = liveHelpers;
const describeLive = kLiveEnabled ? describe : describe.skip;
const kTestTimeoutMs = 10 * 60 * 1000;
const kApiKey = "live-model-fixture-key-0000000000";
const kNotFound = "The requested model was not found.";

// Minimal OpenAI-compatible provider: Chat Completions serves only "fixture";
// the Responses API serves "fixture" and "wonder-1"; /models lists both.
const startProvider = () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed = {};
      try {
        parsed = JSON.parse(body || "{}");
      } catch {}
      const api = req.url.includes("/responses") ? "responses" : req.url.includes("/chat/completions") ? "chat" : "other";
      requests.push({ api, method: req.method, model: parsed.model || null, stream: !!parsed.stream });
      const json = (status, payload) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.headers.authorization !== `Bearer ${kApiKey}`) return json(401, { error: { message: "bad key" } });
      // An account whose key works but has no model entitlements: an empty
      // model list and 404 for every id on every API.
      if (req.url.startsWith("/no-access/")) {
        if (req.method === "GET" && req.url.endsWith("/models")) return json(200, { object: "list", data: [] });
        return json(404, { error: { message: kNotFound } });
      }
      if (req.method === "GET" && req.url.endsWith("/models")) return json(200, { object: "list", data: [{ id: "fixture" }, { id: "wonder-1" }] });
      const model = parsed.model;
      if (api === "chat") {
        if (model !== "fixture") return json(404, { error: { message: kNotFound, type: "invalid_request_error", code: "model_not_found" } });
        if (!parsed.stream) return json(200, { id: "c", object: "chat.completion", model, choices: [{ index: 0, message: { role: "assistant", content: "pong chat" }, finish_reason: "stop" }] });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: "assistant", content: "pong chat" }));
        res.write(chunk({}, "stop"));
        return res.end("data: [DONE]\n\n");
      }
      if (api === "responses") {
        if (model !== "fixture" && model !== "wonder-1") return json(404, { error: { message: kNotFound } });
        const text = `pong responses ${model}`;
        const rid = `resp_${Date.now()}`;
        const usage = { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3 };
        const base = (status, output) => ({ id: rid, object: "response", created_at: 1, status, model, output, usage: status === "completed" ? usage : null, error: null, incomplete_details: null });
        const item = (status, content) => ({ id: `msg_${rid}`, type: "message", status, role: "assistant", content: status === "completed" ? [{ type: "output_text", text: content, annotations: [] }] : [] });
        if (!parsed.stream) return json(200, base("completed", [item("completed", text)]));
        res.writeHead(200, { "content-type": "text/event-stream" });
        let seq = 0;
        const ev = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...payload })}\n\n`);
        const iid = `msg_${rid}`;
        ev("response.created", { response: base("in_progress", []) });
        ev("response.in_progress", { response: base("in_progress", []) });
        ev("response.output_item.added", { output_index: 0, item: item("in_progress") });
        ev("response.content_part.added", { item_id: iid, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
        ev("response.output_text.delta", { item_id: iid, output_index: 0, content_index: 0, delta: text, logprobs: [] });
        ev("response.output_text.done", { item_id: iid, output_index: 0, content_index: 0, text, logprobs: [] });
        ev("response.content_part.done", { item_id: iid, output_index: 0, content_index: 0, part: { type: "output_text", text, annotations: [] } });
        ev("response.output_item.done", { output_index: 0, item: item("completed", text) });
        ev("response.completed", { response: base("completed", [item("completed", text)]) });
        return res.end();
      }
      return json(404, { error: { message: "no such route" } });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, requests })));
};

describeLive(`LIVE model not found against the ${kCandidateBinDir ? "candidate" : readDeclaredPin()} pin`, () => {
  let gateway;
  let provider;
  let port;
  let configPath;

  beforeAll(async () => {
    provider = await startProvider();
    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    port = 19100 + Math.floor(Math.random() * 300);
    const token = "live-model-token-000000000000000000000";
    fs.mkdirSync(path.join(OPENCLAW_DIR, "workspace"), { recursive: true });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    configPath = path.join(OPENCLAW_DIR, "openclaw.json");
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: {
        defaults: {
          workspace: path.join(OPENCLAW_DIR, "workspace"),
          model: { primary: "fixture/fixture" },
          models: { "fixture/fixture": {}, "fixture/wonder-1": { alias: "wonder" }, "acct/muse-1": { alias: "muse" } },
          modelPolicy: { allow: ["fixture/fixture", "fixture/wonder-1", "acct/muse-1"] },
        },
      },
      models: { providers: { fixture: {
        baseUrl: `http://127.0.0.1:${provider.server.address().port}/v1`,
        api: "openai-completions",
        apiKey: kApiKey,
        models: [
          { id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 },
          { id: "wonder-1", name: "wonder", contextWindow: 128000, maxTokens: 1024 },
        ],
      },
      acct: {
        baseUrl: `http://127.0.0.1:${provider.server.address().port}/no-access/v1`,
        api: "openai-completions",
        apiKey: kApiKey,
        models: [{ id: "muse-1", name: "muse", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      channels: {},
    }, null, 2));
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");
  });

  afterAll(async () => {
    gateway?.setGatewayOutputObserver?.(null);
    try {
      await gateway?.stopGatewayForShutdown?.({ budgetMs: 8000 });
    } catch {}
    for (const pid of require("../../lib/server/gateway-identity").findPortListenerPids?.(port) || []) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    provider?.server.close();
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
  const sessionKey = "agent:main:explicit:model-live";
  let sent = 0;
  const send = (message) => call("chat.send", { sessionKey, message, idempotencyKey: `model-live-${(sent += 1)}` });
  const transcript = () => JSON.stringify(call("chat.history", { sessionKey, limit: 20 }).messages || []);
  const waitForTranscript = (needle, label) =>
    waitFor(async () => transcript().includes(needle), 120_000, label);

  it(
    "/model accepts a model the provider rejects; the watch and the check name the model, the provider's answer and the fix; the fix makes it run",
    async () => {
      const { createModelCheck } = require("../../lib/server/model-check");
      const { createModelFailureWatch } = require("../../lib/server/model-failure-watch");
      const { readOpenclawConfig, updateOpenclawConfig } = require("../../lib/server/openclaw-config");
      const { OPENCLAW_DIR } = require("../../lib/server/constants");
      const readConfig = () => readOpenclawConfig({ openclawDir: OPENCLAW_DIR, fallback: {} });
      const modelCheck = createModelCheck({
        readConfig,
        getEnv: () => gateway.gatewayEnv(),
        listOpenclawModels: async () => runCliJson(repoOpenclawBin(), ["models", "list", "--json"], { env: gateway.gatewayEnv() }).models,
      });
      const notify = vi.fn(async () => ({ ok: true }));
      const insertEvent = vi.fn();
      const watch = createModelFailureWatch({
        notify,
        insertEvent,
        checkRef: (ref) => modelCheck.checkRef(ref),
        readDefaultModel: () => readConfig().agents.defaults.model.primary,
      });
      gateway.setGatewayOutputObserver((text) => watch.observeGatewayOutput(text));
      await gateway.startGateway();
      await waitFor(readyzOk, 180_000, "gateway /readyz 200");

      // 1. The failure: /model by alias is accepted, the next message fails.
      send("/model wonder");
      await waitForTranscript("Model set to wonder (fixture/wonder-1)", "/model accepted the alias");
      send("Hi");
      await waitForTranscript("This model was not found", "the run failed with model_not_found");
      expect(provider.requests.some((r) => r.api === "chat" && r.model === "wonder-1")).toBe(true);

      // 2. The owner hears which model, what the provider said, and the fix.
      await waitFor(async () => notify.mock.calls.length > 0, 120_000, "model_not_found notice");
      await watch.settled();
      const [message] = notify.mock.calls[0];
      console.log(`[live] owner notice:\n${message}`);
      expect(message).toContain("A reply failed: model fixture/wonder-1 was not found");
      expect(message).toContain(kNotFound);
      expect(message).toContain("a /model choice turns off the configured fallbacks");
      expect(message).toContain("Send /model default in that chat to go back to fixture/fixture.");
      expect(message).toContain('Fix: Set models.providers.fixture.api to "openai-responses".');
      expect(message).not.toContain(kApiKey);
      expect(insertEvent).toHaveBeenCalledWith(expect.objectContaining({ eventType: "model_not_found", status: "failed" }));

      // 3. The check says the same for every configured model.
      const before = await modelCheck.run();
      const byRef = (run) => Object.fromEntries(run.results.map((r) => [r.ref, r]));
      expect(byRef(before)["fixture/fixture"]).toMatchObject({ status: "ok", openclaw: "available" });
      expect(byRef(before)["fixture/wonder-1"]).toMatchObject({ status: "wrong_api", alternateApi: "openai-responses", providerStatus: 404, providerAnswer: kNotFound, aliases: ["wonder"] });
      expect(byRef(before)["acct/muse-1"]).toMatchObject({ status: "model_rejected", listed: false, listedCount: 0 });
      expect(byRef(before)["acct/muse-1"].fix).toContain("Your acct key has access to no models. Enable model access for this key in acct's dashboard");
      expect(JSON.stringify(before)).not.toContain(kApiKey);

      // 4. Apply the fix the notice named; the next reply and the check pass.
      updateOpenclawConfig({ openclawDir: OPENCLAW_DIR, mutate: (cfg) => { cfg.models.providers.fixture.api = "openai-responses"; } });
      await waitFor(async () => {
        if (!(await readyzOk())) return false;
        try {
          send("Hi again");
        } catch {
          return false;
        }
        return true;
      }, 180_000, "chat.send after the fix");
      await waitForTranscript("pong responses wonder-1", "the fixed model replied");
      const after = await modelCheck.run();
      expect(byRef(after)["fixture/wonder-1"]).toMatchObject({ status: "ok", api: "openai-responses" });
      expect(byRef(after)["fixture/fixture"]).toMatchObject({ status: "ok" });
    },
    kTestTimeoutMs,
  );
});

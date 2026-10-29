// LIVE TIER, PAID and opt-in: Particle's real API through AlphaClaw's block
// (ALPH-53). Runs only with PARTICLE_LIVE_E2E=1 and PARTICLE_API_KEY set,
// under OPENCLAW_LIVE_E2E=1 like the rest of the live tier. It is never part
// of CI.
//
// Every model request goes through a test-owned counting proxy that rewrites
// max_completion_tokens / max_tokens to 4096, refuses a fifth model request
// and refuses a request past the aggregate input budget, so the spend is
// bounded before anything is sent; the bound is printed first. No retries.
//
// Asserts on one two-turn conversation (thinking off, then low): the tool
// call continues to a final answer, every completed response carries usage
// (zero cached tokens is a valid answer, a missing usage block is not), and
// the response model id is Particle's.
const fs = require("fs");
const http = require("http");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRealEnabled = liveHelpers.kLiveEnabled && process.env.PARTICLE_LIVE_E2E === "1" && !!String(process.env.PARTICLE_API_KEY || "").trim();
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-particle-real-");
process.env.ALPHACLAW_ROOT_DIR = kRootDir;
delete process.env.OPENCLAW_GIT_DIR;
delete process.env.OPENCLAW_NO_RESPAWN;
for (const key of ["VITEST", "VITEST_MODE", "VITEST_POOL_ID", "VITEST_WORKER_ID", "NODE_ENV", "TEST"]) {
  delete process.env[key];
}
process.env.NODE_COMPILE_CACHE = path.join(kRootDir, "cache", "openclaw-compile-cache");
process.env.PATH = [liveHelpers.repoBinDir(), process.env.PATH].join(path.delimiter);

const { waitFor, readDeclaredPin, runCliJson, repoOpenclawBin } = liveHelpers;
const describeReal = kRealEnabled ? describe : describe.skip;
const kUpstream = "https://api.particle.ai/v1";
const kMaxModelRequests = 4;
const kMaxOutputTokens = 4096;
const kInputBudgetBytes = 600_000;
const kPeakPrice = { inputPerMillion: 0.25, outputPerMillion: 1 };
const kPaidWindowMs = 120_000;

// Upper bound in USD: every allowed request at the output cap, the whole input
// budget at the input price (a token is at least one byte of request JSON).
const costBoundUsd = () =>
  (kMaxModelRequests * kMaxOutputTokens * kPeakPrice.outputPerMillion + kInputBudgetBytes * kPeakPrice.inputPerMillion) / 1e6;

const parseSse = (text) => {
  const usage = [];
  const models = new Set();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (event.model) models.add(event.model);
      if (event.usage) usage.push(event.usage);
    } catch {}
  }
  return { usage: usage.at(-1) || null, models: [...models] };
};

const startProxy = () => {
  const log = { modelRequests: 0, inputBytes: 0, refused: [], requests: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", async () => {
      const refuse = (reason) => {
        log.refused.push(reason);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `counting proxy refused: ${reason}`, code: "proxy_budget" } }));
      };
      const isModelRequest = req.method === "POST" && req.url.endsWith("/chat/completions");
      let forwardBody = body;
      if (isModelRequest) {
        if (log.modelRequests >= kMaxModelRequests) return refuse(`more than ${kMaxModelRequests} model requests`);
        const parsed = JSON.parse(body || "{}");
        for (const key of ["max_completion_tokens", "max_tokens"]) if (key in parsed) parsed[key] = kMaxOutputTokens;
        forwardBody = JSON.stringify(parsed);
        const bytes = Buffer.byteLength(forwardBody);
        if (log.inputBytes + bytes > kInputBudgetBytes) return refuse(`input budget of ${kInputBudgetBytes} bytes`);
        log.modelRequests += 1;
        log.inputBytes += bytes;
        console.log(`[live-real] model request ${log.modelRequests}/${kMaxModelRequests}: ${bytes} bytes, reasoning_effort=${parsed.reasoning_effort}, bound ${((bytes * kPeakPrice.inputPerMillion + kMaxOutputTokens * kPeakPrice.outputPerMillion) / 1e6).toFixed(5)} USD`);
        log.requests.push({ body: parsed, response: null });
      }
      const upstream = await fetch(`${kUpstream}${req.url.replace(/^\/v1/, "")}`, {
        method: req.method,
        headers: { authorization: req.headers.authorization || "", "content-type": "application/json" },
        body: req.method === "GET" ? undefined : forwardBody,
      }).catch((error) => ({ error }));
      if (upstream.error) {
        res.writeHead(502);
        return res.end(String(upstream.error.message));
      }
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") || "application/json" });
      let text = "";
      const decoder = new TextDecoder();
      for await (const chunk of upstream.body) {
        text += decoder.decode(chunk, { stream: true });
        res.write(chunk);
      }
      res.end();
      if (isModelRequest) {
        const entry = log.requests.at(-1);
        entry.response = { status: upstream.status, ...(String(upstream.headers.get("content-type")).includes("event-stream") ? parseSse(text) : { usage: null, models: [], text: text.slice(0, 300) }) };
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, log })));
};

describeReal(`LIVE (paid) Particle real API against the ${readDeclaredPin()} pin`, () => {
  let gateway;
  let proxy;
  let port;

  beforeAll(async () => {
    console.log(`[live-real] spend bound: at most ${kMaxModelRequests} model requests, ${kMaxOutputTokens} output tokens each, ${kInputBudgetBytes} input bytes in total: <= ${costBoundUsd().toFixed(4)} USD at ${kPeakPrice.inputPerMillion}/${kPeakPrice.outputPerMillion} USD per million tokens`);
    proxy = await startProxy();
    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    const { ensureOwnedProviders } = require("../../lib/server/providers/ensure");
    const { kOwnedProviderPresets } = require("../../lib/server/providers/presets");
    port = 19700 + Math.floor(Math.random() * 200);
    const token = "live-particle-real-token-0000000000000";
    fs.mkdirSync(path.join(OPENCLAW_DIR, "workspace"), { recursive: true });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: { defaults: { workspace: path.join(OPENCLAW_DIR, "workspace"), model: { primary: "particle/particle-1" }, models: { "particle/particle-1": {} } } },
      channels: {},
    }, null, 2));
    const presets = kOwnedProviderPresets.map((preset) => ({ ...preset, baseUrl: `http://127.0.0.1:${proxy.server.address().port}/v1` }));
    expect(ensureOwnedProviders({ openclawDir: OPENCLAW_DIR, env: { PARTICLE_API_KEY: process.env.PARTICLE_API_KEY }, presets })).toMatchObject({ ok: true, changed: true });
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
    proxy?.server.close();
  });

  it(
    "runs a two-turn tool loop on the real API within the spend bound",
    { retry: 0, timeout: 300_000 },
    async () => {
      const call = (method, params) =>
        runCliJson(repoOpenclawBin(), ["gateway", "call", method, "--params", JSON.stringify(params), "--json"], { env: gateway.gatewayEnv(), label: method });
      const sessionKey = "agent:main:explicit:particle-real";
      let sent = 0;
      const send = (message) => call("chat.send", { sessionKey, message, idempotencyKey: `particle-real-${(sent += 1)}` });
      const replies = () => (call("chat.history", { sessionKey, limit: 50 }).messages || []).filter((message) => message.role === "assistant" && message.provider === "particle");
      await gateway.startGateway();
      await waitFor(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
        } catch {
          return false;
        }
      }, 180_000, "gateway /readyz 200");

      const paidStart = Date.now();
      send("/think off");
      send("Call the session_status tool exactly once. After it returns, reply with the single word: done");
      await waitFor(async () => replies().some((message) => message.stopReason === "stop"), kPaidWindowMs, "turn 1 final answer");
      send("/think low");
      const before = replies().length;
      send("Reply with the single word: ok");
      await waitFor(async () => replies().length > before && replies().at(-1).stopReason === "stop", Math.max(1000, kPaidWindowMs - (Date.now() - paidStart)), "turn 2 final answer");

      const { log } = proxy;
      for (const entry of log.requests) {
        console.log(`[live-real] effort=${entry.body.reasoning_effort} status=${entry.response?.status} models=${JSON.stringify(entry.response?.models)} usage=${JSON.stringify(entry.response?.usage)}`);
      }
      expect(log.refused).toEqual([]);
      expect(log.requests.length).toBeGreaterThanOrEqual(3);
      expect(log.requests[0].body.reasoning_effort).toBe("none");
      expect(log.requests.at(-1).body.reasoning_effort).toBe("low");
      expect(log.requests.some((entry) => entry.body.messages.some((message) => message.role === "tool"))).toBe(true);
      for (const entry of log.requests) {
        expect(entry.response?.status).toBe(200);
        expect(entry.response.usage, "every completed response carries usage").toMatchObject({ prompt_tokens: expect.any(Number), completion_tokens: expect.any(Number) });
        expect(entry.response.models.every((model) => /(^|\/)particle-1$/.test(model))).toBe(true);
      }
      const spent = log.requests.reduce((sum, entry) => sum + (entry.response.usage.prompt_tokens * kPeakPrice.inputPerMillion + entry.response.usage.completion_tokens * kPeakPrice.outputPerMillion) / 1e6, 0);
      console.log(`[live-real] spent at most ${spent.toFixed(5)} USD (peak prices, cache discounts ignored)`);
    },
  );
});

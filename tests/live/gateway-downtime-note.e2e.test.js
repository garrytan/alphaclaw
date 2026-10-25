// LIVE TIER — the gateway downtime note (ALPH-39) against the REAL pinned
// OpenClaw: `openclaw system event --mode next-heartbeat` (the gateway's
// `wake` RPC) enqueues the note on the default agent's main session, and the
// next turn there carries it once in its prompt as a `System:` line. The turn
// here is a heartbeat (the reply path inbound channel messages share; the
// `agent` RPC behind `openclaw agent` does not drain system events). A local
// OpenAI-compatible model fixture records every request body.
const fs = require("fs");
const http = require("http");
const path = require("path");
const { shellEscapeArg } = require("../../lib/server/agents/shared");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-downtime-root-");
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

const { kLiveEnabled, waitFor, readDeclaredPin } = liveHelpers;
const describeLive = kLiveEnabled ? describe : describe.skip;
const kTestTimeoutMs = 8 * 60 * 1000;

const lastUserText = (body) => {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const user = [...messages].reverse().find((message) => message?.role === "user");
  if (!user) return "";
  return typeof user.content === "string"
    ? user.content
    : (Array.isArray(user.content) ? user.content : []).map((part) => part?.text || "").join("\n");
};

describeLive(`LIVE downtime note against the ${kCandidateBinDir ? "candidate" : readDeclaredPin()} pin`, () => {
  let gateway;
  let model;
  const requests = [];
  let port;

  beforeAll(async () => {
    model = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        try {
          requests.push(JSON.parse(raw));
        } catch {
          requests.push(null);
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish = null) =>
          `data: ${JSON.stringify({ id: "downtime-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: "assistant", content: "noted" }));
        res.write(chunk({}, "stop"));
        res.end("data: [DONE]\n\n");
      });
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    port = 19500 + Math.floor(Math.random() * 400);
    const token = "live-downtime-token-000000000000000000";
    fs.mkdirSync(path.join(OPENCLAW_DIR, "workspace"), { recursive: true });
    fs.mkdirSync(process.env.NODE_COMPILE_CACHE, { recursive: true });
    fs.writeFileSync(path.join(OPENCLAW_DIR, "openclaw.json"), JSON.stringify({
      gateway: { mode: "local", bind: "loopback", port, auth: { mode: "token", token } },
      agents: { defaults: { workspace: path.join(OPENCLAW_DIR, "workspace"), model: { primary: "fixture/fixture" } } },
      models: { providers: { fixture: {
        baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
        api: "openai-completions",
        apiKey: "local-model-fixture",
        models: [{ id: "fixture", name: "fixture", contextWindow: 128000, maxTokens: 1024 }],
      } } },
      channels: {},
    }));
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
    model?.close();
  });

  let clawCmd;
  // A heartbeat turn on the main session: OpenClaw's own `--mode now` wake
  // with a probe event of the test's own. It drains every queued system event
  // of that session into the prompt, the downtime note included.
  const heartbeatNow = async (probe) => {
    const result = await clawCmd(`system event --text ${shellEscapeArg(probe)} --mode now --json`, { quiet: true, timeoutMs: 60_000 });
    expect(result.ok, result.stderr).toBe(true);
    await waitFor(async () => requests.some((body) => JSON.stringify(body).includes(probe)), 180_000, `turn with "${probe}" reached the model`);
    return requests.find((body) => JSON.stringify(body).includes(probe));
  };

  it(
    "the note reaches the next main-session turn once, as a System line, after a relaunch past the threshold",
    async () => {
      const constants = require("../../lib/server/constants");
      const stampPath = path.join(constants.kOpenclawManagedDir, "gateway-last-serving.json");
      const downAt = Date.now() - 11 * 60_000;
      fs.mkdirSync(path.dirname(stampPath), { recursive: true });
      fs.writeFileSync(stampPath, JSON.stringify({ lastServingAt: downAt, cause: "crash", restarts: [], launches: 1 }));

      ({ clawCmd } = require("../../lib/server/commands").createCommands({ gatewayEnv: gateway.gatewayEnv }));
      const { createGatewayDowntimeNote } = require("../../lib/server/gateway-downtime-note");
      const note = createGatewayDowntimeNote({
        clawCmd,
        stampPath,
        resolveReadyzUrl: () => `http://127.0.0.1:${port}/readyz`,
      });

      await gateway.startGateway();
      const result = await note.onGatewayLaunch({ generation: 1 });
      expect(result).toEqual(expect.objectContaining({ sent: true, cause: "crash" }));
      expect(JSON.parse(fs.readFileSync(stampPath, "utf8")).cause).toBeNull();

      const first = lastUserText(await heartbeatNow("downtime-live-probe-1"));
      console.log(`[live] first turn user message: ${JSON.stringify(first.slice(0, 800))}`);
      expect(first).toMatch(/System: \[[^\]]+\] The gateway was down for 1[12] min \(\d\d:\d\d–\d\d:\d\d UTC\) after a crash; messages queued during that time may be stale/);

      const second = lastUserText(await heartbeatNow("downtime-live-probe-2"));
      expect(second).toContain("downtime-live-probe-2");
      expect(second).not.toContain("The gateway was down");
    },
    kTestTimeoutMs,
  );
});

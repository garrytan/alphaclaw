// LIVE TIER — the Agent Relay bridge against the REAL pinned OpenClaw gateway
// and the REAL sha256-pinned Relaycast engine (downloaded and verified like a
// box does it). A local model fixture answers the agent turns. Pins what the
// hermetic bridge tests only fake: chat.send's run id, the agent lifecycle
// end event, chat.history's content shape, sessions.list's hasActiveRun, and
// that a gateway SIGKILL mid-run still ends in exactly one relay reply.
const fs = require("fs");
const http = require("http");
const path = require("path");

const liveHelpers = require("./live-helpers");
const kRootDir = liveHelpers.mkTemp("alphaclaw-live-relay-root-");
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
const describeLive = kLiveEnabled && process.platform === "linux" ? describe : describe.skip;
const kTestTimeoutMs = 10 * 60 * 1000;
const kSlowTurnSeconds = 40;

describeLive(`LIVE Agent Relay bridge against the ${kCandidateBinDir ? "candidate" : readDeclaredPin()} pin`, () => {
  let gateway;
  let model;
  let sidecars;
  let relay;
  let port;
  let relayPort;
  let slowNext = false;
  let modelRequests = 0;
  let gatewaySends = 0;
  let secrets;

  const relayUrl = (p) => `http://127.0.0.1:${relayPort}${p}`;
  const relayCall = async (method, p, token, body) => {
    const res = await fetch(relayUrl(p), {
      method,
      headers: { "content-type": "application/json", authorization: "Bearer " + token },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (!res.ok) throw new Error(method + " " + p + " " + res.status + " " + JSON.stringify(json));
    return json.data;
  };
  const repliesOf = async (token, messageId) =>
    (await relayCall("GET", "/v1/messages/" + messageId + "/replies", token)).replies.filter((reply) => reply.agent_name === relay.getStatus().agentName);
  const readyzOk = async () => {
    try {
      return (await fetch(`http://127.0.0.1:${port}/readyz`)).status === 200;
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    model = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        modelRequests += 1;
        const slow = slowNext;
        res.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finish = null) =>
          `data: ${JSON.stringify({ id: "relay-live", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        if (!slow) {
          const asked = [...body.matchAll(/ping-(\d+)/g)].pop();
          res.write(chunk({ role: "assistant", content: "pong-" + (asked ? asked[1] : "none") + " from the box" }));
          res.write(chunk({}, "stop"));
          res.end("data: [DONE]\n\n");
          return;
        }
        let n = 0;
        const timer = setInterval(() => {
          n += 1;
          if (res.destroyed) return clearInterval(timer);
          res.write(chunk(n === 1 ? { role: "assistant", content: "slow " } : { content: "slow " }));
          if (n >= kSlowTurnSeconds) {
            clearInterval(timer);
            res.write(chunk({}, "stop"));
            res.end("data: [DONE]\n\n");
          }
        }, 1000);
      });
    });
    await new Promise((resolve) => model.listen(0, "127.0.0.1", resolve));
    const { OPENCLAW_DIR, kOnboardingMarkerPath } = require("../../lib/server/constants");
    port = 19500 + Math.floor(Math.random() * 400);
    relayPort = 18800 + Math.floor(Math.random() * 400);
    const token = "live-relay-token-000000000000000000000";
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

    const { createRelayService, buildRelayEngineSidecarEntry } = require("../../lib/server/relay");
    const { createSidecarService } = require("../../lib/server/sidecars");
    const { normalizeBuiltinSidecarEntry } = require("../../lib/server/sidecars/registry");
    relay = createRelayService({
      env: { ALPHACLAW_RELAY_PORT: String(relayPort), ALPHACLAW_RELAY_AGENT_NAME: "wintermute" },
      rootDir: kRootDir,
      getSupervisor: () => sidecars.find("relay-engine"),
      resolveAgentId: () => "main",
      createGatewayClient: ({ onEvent, onDisconnect }) => {
        const client = require("../../lib/server/chat/gateway-client").createGatewayClient({
          fs,
          openclawDir: OPENCLAW_DIR,
          getGatewayPort: () => port,
          WebSocketImpl: require("ws").WebSocket,
          onEvent,
          onDisconnect,
        });
        return {
          ...client,
          requestGateway: (method, ...rest) => {
            if (method === "chat.send") gatewaySends += 1;
            return client.requestGateway(method, ...rest);
          },
        };
      },
    });
    sidecars = createSidecarService({
      env: {},
      rootDir: kRootDir,
      builtinEntries: [normalizeBuiltinSidecarEntry(buildRelayEngineSidecarEntry({ config: relay.config, paths: relay.paths }))],
    });
  }, 120_000);

  afterAll(async () => {
    try {
      relay?.stop();
    } catch {}
    try {
      await sidecars?.stopAll();
    } catch {}
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

  it(
    "a relay DM becomes a run in the sender's own session and its answer comes back as one reply; a gateway SIGKILL mid-run still settles with exactly one reply and no second send",
    async () => {
      await gateway.startGateway();
      await waitFor(readyzOk, 180_000, "gateway /readyz 200");
      await sidecars.start();
      relay.start();
      await waitFor(async () => relay.isReady(), 180_000, "relay ready (binary verified, engine up, provisioned)");
      const status = relay.getStatus();
      expect(status).toMatchObject({ phase: "ready", agentName: "wintermute" });
      expect(fs.statSync(relay.paths.dir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(relay.paths.secretsFile).mode & 0o777).toBe(0o600);
      secrets = JSON.parse(fs.readFileSync(relay.paths.secretsFile, "utf8"));
      const capy = await relayCall("POST", "/v1/agents", secrets.workspaceKey, { name: "capy-live", type: "agent" });

      // 1. Round trip through the real gateway.
      const dm = await relayCall("POST", "/v1/dm", capy.token, { to: "wintermute", text: "ping-41" });
      const firstId = dm.id || dm.message?.id;
      await waitFor(async () => (await repliesOf(capy.token, firstId)).length > 0, 180_000, "first relay reply");
      const [first] = await repliesOf(capy.token, firstId);
      expect(first.text).toContain("pong-41 from the box");
      expect(relay.getStatus().bridge.counts.answered).toBe(1);
      const sessions = await new Promise((resolve, reject) => {
        const { clawCmd } = require("../../lib/server/commands").createCommands({ gatewayEnv: gateway.gatewayEnv });
        clawCmd("gateway call 'sessions.list' --params '{\"limit\":50}' --json", { quiet: true }).then(resolve, reject);
      });
      const keys = JSON.parse(sessions.stdout).sessions.map((s) => s.key);
      expect(keys).toContain("agent:main:relay-capy-live");
      expect(keys).not.toContain("agent:main:main");

      // 2. SIGKILL the gateway while the relay run is in flight.
      slowNext = true;
      const before = modelRequests;
      const slow = await relayCall("POST", "/v1/dm", capy.token, { to: "wintermute", text: "ping-42 take your time" });
      const slowId = slow.id || slow.message?.id;
      await waitFor(async () => modelRequests > before, 120_000, "slow relay run reached the model");
      slowNext = false;
      gateway.killManagedGatewayChildNow();
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await gateway.startGateway();
      await waitFor(readyzOk, 180_000, "relaunched gateway /readyz 200");
      await waitFor(async () => (await repliesOf(capy.token, slowId)).length > 0, 300_000, "relay reply after the SIGKILL");
      await new Promise((resolve) => setTimeout(resolve, 5000));
      const replies = await repliesOf(capy.token, slowId);
      expect(replies).toHaveLength(1);
      expect(gatewaySends).toBe(2);
      const counts = relay.getStatus().bridge.counts;
      console.log("[live] relay after SIGKILL: " + JSON.stringify({ text: replies[0].text.slice(0, 200), metadata: replies[0].metadata, counts }));
      // The pinned OpenClaw resumes the killed turn itself (main-session restart
      // recovery); the bridge must wait for it and post the resumed answer.
      expect(replies[0].text).toContain("pong-42 from the box");
      expect(replies[0].metadata).toMatchObject({ relay_status: "answered" });
      expect(counts.answered).toBe(2);
      expect(counts.dispatched || 0).toBe(0);
      expect(counts.reconciling || 0).toBe(0);
    },
    kTestTimeoutMs,
  );
});

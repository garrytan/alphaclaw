// LIVE TIER — the Agent Relay bridge against the REAL pinned OpenClaw gateway
// and the REAL sha256-pinned Relaycast engine (downloaded and verified like a
// box does it). A local model fixture answers the agent turns. Pins what the
// hermetic bridge tests only fake: chat.send's run id, the agent lifecycle
// end event, chat.history's content shape, sessions.list's hasActiveRun, and
// that a gateway SIGKILL mid-run still ends in exactly one relay reply.
// GST-2090: and that a peer's turn reaches OpenClaw over the bridge's peer
// socket (no operator.admin), so OpenClaw records it as not the owner's,
// while a delegate's turn rides the admin socket and is the owner's.
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

const { kLiveEnabled, waitFor, readDeclaredPin, runCliJson, repoOpenclawBin } = liveHelpers;
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
  // Each turn the bridge sent, by socket: { admin: [runId], peer: [runId] }.
  const sendsBySocket = { admin: [], peer: [] };
  let secrets;
  let remote;
  // The bound remote caller of the OAuth MCP case, reused by the grant case.
  let remoteApp;
  let remoteTool;
  let remoteBound;
  const ownerNotices = [];
  const wakePosts = [];
  // The brain archive writes through a gbrain wrapper: the real gbrain when
  // OPENCLAW_LIVE_GBRAIN_BIN names one (a scratch brain with a "relay"
  // source, never a real one), else the recording fake. Its clock runs
  // ahead on demand so the test need not sit out the 2-minute debounce.
  const kRealGbrain = process.env.OPENCLAW_LIVE_GBRAIN_BIN || "";
  const fakeGbrainDir = liveHelpers.mkTemp("alphaclaw-live-relay-gbrain-");
  const scratchBrain = kRealGbrain ? require("./gbrain-scratch").createScratchBrain(kRealGbrain) : null;
  let archiveClockOffsetMs = 0;
  // Narration (GST-2304) runs on a clock the test moves ahead, so the case
  // need not sit out the 30-second and 60-second windows.
  let narrationClockOffsetMs = 0;
  const fakeGbrainCalls = () =>
    fs.existsSync(path.join(fakeGbrainDir, "calls.jsonl"))
      ? fs.readFileSync(path.join(fakeGbrainDir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
      : [];

  const probePath = () => path.join(require("../../lib/server/constants").OPENCLAW_DIR, "workspace", ".env.relay-probe");
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
  // OpenClaw's own record of a relay turn: the user row chat.history returns
  // for it, whose __openclaw.senderIsOwner OpenClaw stamps only when the
  // sending client held operator.admin.
  const userRowOf = (sessionKey, messageId) => {
    const history = runCliJson(repoOpenclawBin(), ["gateway", "call", "chat.history", "--params", JSON.stringify({ sessionKey, limit: 200 }), "--json"], { env: gateway.gatewayEnv(), label: "chat.history" });
    return (history.messages || []).find((row) => row.role === "user" && JSON.stringify(row.content).includes("relay:" + messageId)) || null;
  };
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
        // The grant case: "confirm-probe-N" asks for one write to a
        // protected file in the workspace, then answers with the guard's
        // confirmation ref when the write was held.
        const probe = slow ? null : [...body.matchAll(/confirm-probe-(\d+)/g)].pop();
        if (probe) {
          const messages = JSON.parse(body).messages || [];
          const last = messages[messages.length - 1] || {};
          if (last.role !== "tool") {
            res.write(chunk({ role: "assistant", content: null, tool_calls: [{ index: 0, id: "call_probe_" + probe[1], type: "function", function: { name: "write", arguments: JSON.stringify({ path: probePath(), content: "probe " + probe[1] + "\n" }) } }] }));
            res.write(chunk({}, "tool_calls"));
            res.end("data: [DONE]\n\n");
            return;
          }
          const ref = JSON.stringify(last.content).match(/rc_[a-f0-9]{16}/);
          res.write(chunk({ role: "assistant", content: ref ? "held " + ref[0] : "wrote probe " + probe[1] }));
          res.write(chunk({}, "stop"));
          res.end("data: [DONE]\n\n");
          return;
        }
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
      // The relay guard plugin, as ensureGatewayProxyConfig writes it: the
      // bridge dispatches only once plugins.list reports it active.
      plugins: (() => {
        const cfg = {};
        require("../../lib/server/relay/guard-entry").applyRelayGuardEntry(cfg, require("../../lib/server/relay/guard-entry").buildRelayGuardEntry({ rootDir: kRootDir }), { log: () => {} });
        return cfg.plugins;
      })(),
    }));
    fs.writeFileSync(kOnboardingMarkerPath, JSON.stringify({ live: true }));
    process.env.OPENCLAW_GATEWAY_TOKEN = token;
    gateway = require("../../lib/server/gateway");

    const { createRelayService, buildRelayEngineSidecarEntry } = require("../../lib/server/relay");
    const { createSidecarService } = require("../../lib/server/sidecars");
    const { normalizeBuiltinSidecarEntry } = require("../../lib/server/sidecars/registry");
    relay = createRelayService({
      env: {
        ALPHACLAW_RELAY_PORT: String(relayPort),
        ALPHACLAW_RELAY_AGENT_NAME: "wintermute",
        ALPHACLAW_RELAY_BRAIN_BIN: kRealGbrain || path.join(__dirname, "..", "fixtures", "fake-gbrain.js"),
      },
      brainArchiveOptions: {
        env: scratchBrain ? scratchBrain.env : { ...liveHelpers.scrubTestRunnerEnv(), GBRAIN_FAKE_DIR: fakeGbrainDir, GBRAIN_FAKE_CHECKOUT: path.join(fakeGbrainDir, "relay-src") },
        now: () => Date.now() + archiveClockOffsetMs,
        sleep: async () => {},
      },
      narrationOptions: { now: () => Date.now() + narrationClockOffsetMs },
      rootDir: kRootDir,
      getSupervisor: () => sidecars.find("relay-engine"),
      resolveAgentId: () => "main",
      onRelayMessage: (routed) => remote?.onRelayMessage(routed),
      notifyOwner: (text, opts) => ownerNotices.push({ text, opts }),
      // As lib/server.js wires it: the remote side's grants decide the tier.
      resolveSenderTrust: (sender) => (remote ? remote.resolveDelegate(sender) : { trust: "peer", reason: "not_bound" }),
      createGatewayClient: ({ onEvent, onDisconnect, scopes }) => {
        const client = require("../../lib/server/chat/gateway-client").createGatewayClient({
          fs,
          openclawDir: OPENCLAW_DIR,
          getGatewayPort: () => port,
          WebSocketImpl: require("ws").WebSocket,
          onEvent,
          onDisconnect,
          scopes,
        });
        const socket = client.scopes.includes("operator.admin") ? "admin" : "peer";
        return {
          ...client,
          requestGateway: (method, params, ...rest) => {
            if (method === "chat.send") {
              gatewaySends += 1;
              sendsBySocket[socket].push(params.idempotencyKey);
            }
            return client.requestGateway(method, params, ...rest);
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
      remote?.stop();
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
      expect(relay.getStatus().bridge.guard.state).toBe("active");
      const sessions = await new Promise((resolve, reject) => {
        const { clawCmd } = require("../../lib/server/commands").createCommands({ gatewayEnv: gateway.gatewayEnv });
        clawCmd("gateway call 'sessions.list' --params '{\"limit\":50}' --json", { quiet: true }).then(resolve, reject);
      });
      const keys = JSON.parse(sessions.stdout).sessions.map((s) => s.key);
      expect(keys).toContain("agent:main:relay-capy-live");
      expect(keys).not.toContain("agent:main:main");
      // GST-2090: an unbound sender is a peer. The bridge stamped the turn
      // peer and sent it on the peer socket, and OpenClaw did not run it as
      // the owner.
      const peerRow = userRowOf("agent:main:relay-capy-live", firstId);
      console.log("[live] peer turn: " + JSON.stringify({ trust: relay.getStore().get(firstId).trust, senderIsOwner: peerRow?.__openclaw?.senderIsOwner ?? null, sockets: sendsBySocket }));
      expect(relay.getStore().get(firstId).trust).toBe("peer");
      expect(peerRow).toBeTruthy();
      expect(peerRow.__openclaw?.senderIsOwner === true).toBe(false);
      expect(sendsBySocket).toEqual({ admin: [], peer: ["relay-" + firstId] });

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
  it(
    "a remote caller over the OAuth MCP endpoint binds a thread, DMs the box agent, and is woken with the real answer",
    async () => {
      expect(relay.isReady()).toBe(true);
      const crypto = require("crypto");
      const express = require("express");
      const request = require("supertest");
      const { EventEmitter } = require("events");
      const { createRelayRemote } = require("../../lib/server/relay/remote");
      const { registerRelayRemoteRoutes } = require("../../lib/server/routes/relay-remote");
      const kPublic = "https://box.relay-live.test";
      const kRedirect = "https://capy.ai/web/callbacks/mcp";
      remote = createRelayRemote({
        relayService: relay,
        getPublicUrl: () => kPublic,
        wakeOptions: {
          lookup: async () => [{ address: "34.120.1.1", family: 4 }],
          requestImpl: (options, onResponse) => {
            const req = new EventEmitter();
            req.destroy = () => {};
            req.end = (body) => {
              wakePosts.push({ options, body: JSON.parse(body) });
              const res = new EventEmitter();
              res.statusCode = 202;
              res.resume = () => {};
              setImmediate(() => {
                onResponse(res);
                res.emit("end");
              });
            };
            return req;
          },
        },
      });
      const app = express();
      app.use(express.json());
      registerRelayRemoteRoutes({
        app,
        requireAuth: (req, res, next) => next(),
        requireAdmin: (req, res, next) => next(),
        resolveRequestIdentity: () => ({ kind: "legacy", role: "admin" }),
        relayRemote: remote,
      });

      const allowed = (await request(app).post("/api/relay/remote/consent-window")).body;
      expect(allowed.ok).toBe(true);
      const client = (await request(app).post("/relay/oauth/register").send({ client_name: "Capy", redirect_uris: [kRedirect], token_endpoint_auth_method: "none" })).body;
      const verifier = crypto.randomBytes(32).toString("base64url");
      const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
      const authorize = await request(app)
        .get("/relay/oauth/authorize")
        .query({ client_id: client.client_id, redirect_uri: kRedirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: kPublic + "/relay/mcp" });
      const consentUrl = new URL(authorize.headers.location, kPublic);
      const page = await request(app).get(consentUrl.pathname + consentUrl.search);
      const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)[1];
      const approved = await request(app).post("/relay/oauth/consent").set("Origin", kPublic).type("form").send({ request: consentUrl.searchParams.get("request"), csrf, decision: "approve", consent_code: allowed.code });
      const code = new URL(approved.headers.location).searchParams.get("code");
      const token = (await request(app).post("/relay/oauth/token").type("form").send({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: kRedirect })).body;
      expect(token.access_token).toBeTruthy();

      let rpc = 1;
      const tool = async (name, args) => {
        const res = await request(app)
          .post("/relay/mcp")
          .set("Authorization", "Bearer " + token.access_token)
          .set("Accept", "application/json, text/event-stream")
          .send({ jsonrpc: "2.0", id: rpc++, method: "tools/call", params: { name, arguments: args } });
        expect(res.status).toBe(200);
        return { isError: res.body.result.isError === true, data: JSON.parse(res.body.result.content[0].text) };
      };
      const bound = await tool("relay_bind", { thread_id: "jam_live_relay", webhook_url: "https://api.capy.ai/webhooks/automations/live-test-token" });
      expect(bound.isError).toBe(false);
      remoteApp = app;
      remoteTool = tool;
      remoteBound = bound.data;
      const roster = await tool("relay_agents", {});
      expect(roster.data.agents.map((agent) => agent.name)).toEqual(expect.arrayContaining(["wintermute", bound.data.agent]));
      const sent = await tool("relay_send", { as: bound.data.agent, capability: bound.data.capability, to: "wintermute", text: "ping-77 from a remote thread" });
      expect(sent.isError).toBe(false);

      await waitFor(async () => wakePosts.some((post) => post.body.status === "answered"), 180_000, "wake for the box agent's answer");
      const wake = wakePosts.find((post) => post.body.status === "answered");
      expect(wake.options).toMatchObject({ hostname: "api.capy.ai", port: 443, path: "/webhooks/automations/live-test-token" });
      expect(wake.body).toMatchObject({ from: "wintermute", to: bound.data.agent, untrusted: true });
      expect(wake.body.text).toContain("pong-77 from the box");
      const history = await tool("relay_history", { as: bound.data.agent, capability: bound.data.capability, with: "wintermute" });
      expect(history.data.messages.map((message) => message.text).join("\n")).toContain("pong-77 from the box");
      const status = remote.getStatus();
      expect(status.bindings[0]).toMatchObject({ agent: bound.data.agent, lastWakeStatus: "delivered" });
      expect(JSON.stringify(status)).not.toContain(bound.data.capability);
    },
    kTestTimeoutMs,
  );

  it(
    "the owner gets one narration notice for an ask with a summary, naming the sender, and none for an acknowledgment (GST-2304)",
    async () => {
      expect(remoteTool).toBeTruthy();
      const narration = relay._internal.state.narration;
      const narrationNotices = () => ownerNotices.filter((notice) => notice.opts?.eventType === "relay_narration");
      // Everything sent before this case is narrated first, so the next
      // notice holds only this case's asks.
      narrationClockOffsetMs += 2 * 60 * 1000;
      narration.tick();
      const before = narrationNotices().length;
      const as = { as: remoteBound.agent, capability: remoteBound.capability };
      const asked = await remoteTool("relay_send", { ...as, to: "wintermute", text: "ping-88 please look at the box", summary: "look at the box for ping-88" });
      expect(asked.isError).toBe(false);
      expect(asked.data.summary).toBe("look at the box for ping-88");
      const ack = await remoteTool("relay_send", { ...as, to: "wintermute", text: "thanks", summary: "ack only" });
      expect(ack.isError).toBe(false);
      await waitFor(async () => Boolean(relay.getStore().get(asked.data.message_id) && relay.getStore().get(ack.data.message_id)), 60_000, "both messages taken in by the bridge");
      expect(relay.getStore().get(asked.data.message_id)).toMatchObject({ summary: "look at the box for ping-88", isAck: false, bodyChars: 30, route: "public" });
      expect(relay.getStore().get(ack.data.message_id).isAck).toBe(true);
      narrationClockOffsetMs += 2 * 60 * 1000;
      narration.tick();
      narrationClockOffsetMs += 2 * 60 * 1000;
      narration.tick();
      const fresh = narrationNotices().slice(before);
      console.log("[live] narration: " + JSON.stringify(fresh.map((notice) => ({ id: notice.opts.id, text: notice.text }))));
      expect(fresh).toHaveLength(1);
      const lines = fresh[0].text.split("\n").filter((line) => line.startsWith("🛰"));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("@" + remoteBound.agent + " (peer, public URL, 30 characters) asks: \"`look at the box for ping-88`\"");
      expect(fresh[0].text).not.toContain("ack only");
      expect(fresh[0].text).not.toContain("ping-88 please");
      expect(fresh[0].text).toContain("only 🔐 links approve relay actions.");
      expect(fresh[0].opts).toEqual({ eventType: "relay_narration", id: "relay-narration-" + asked.data.message_id, verbose: true });
      expect(relay.getStore().get(ack.data.message_id).narration).toBe("ack");
      // Both runs settle before the next case.
      await waitFor(
        async () => [asked, ack].every(({ data }) => !["queued", "dispatched", "completing", "reconciling", "replying"].includes(relay.getStore().get(data.message_id)?.state)),
        180_000,
        "both relay runs settled",
      );
    },
    kTestTimeoutMs,
  );

  it(
    "the relay conversation is saved to the brain through the gbrain wrapper: both sides, the box agent's session, no tool output, then one commit-push",
    async () => {
      expect(relay.isReady()).toBe(true);
      const archive = relay._internal.state.archive;
      // The archive's own timer may be mid-tick (one tick at a time), so tick
      // until the pages are saved and committed, moving its clock 3 minutes
      // per try.
      await waitFor(
        async () => {
          archiveClockOffsetMs += 3 * 60 * 1000;
          await archive._internal.tick();
          const counts = relay.getStatus().archive.counts || {};
          return counts.pages >= 1 && counts.due === 0 && counts.commitsQueued === 0;
        },
        180_000,
        "relay conversations saved to the brain and committed",
      );
      const status = relay.getStatus().archive;
      console.log("[live] brain archive: " + JSON.stringify({ phase: status.phase, code: status.code, counts: status.counts, parked: status.parked, real: Boolean(kRealGbrain) }));
      expect(status).toMatchObject({ enabled: true, phase: "ready", code: null, parked: [] });
      expect(status.counts.pages).toBeGreaterThanOrEqual(1);
      expect(status.counts.commitsQueued).toBe(0);
      const slug = "relay/wintermute/capy-live/";
      let page;
      if (scratchBrain) {
        const files = scratchBrain.trackedFiles("relay/wintermute/capy-live");
        expect(files.filter((name) => /-part-\d+\.md$/.test(name))).toEqual([]);
        const file = files[0];
        expect(file).toMatch(/^relay\/wintermute\/capy-live\/.+\.md$/);
        expect(scratchBrain.json(["get", "--source", "relay", "--json", "--", file.replace(/\.md$/, "")])).toMatchObject({ type: "relay-conversation", source_id: "relay" });
        expect(scratchBrain.run(["get", "--json", "--", file.replace(/\.md$/, "")]).status).not.toBe(0);
        page = fs.readFileSync(path.join(scratchBrain.checkout, file), "utf8");
      } else {
        const puts = fakeGbrainCalls().filter((call) => call.argv[0] === "put" && call.argv[1].startsWith(slug));
        expect(puts.length).toBeGreaterThanOrEqual(1);
        expect(puts[0].argv.slice(2, 4)).toEqual(["--source", "relay"]);
        expect(puts.filter((call) => /-part-\d+$/.test(call.argv[1]))).toEqual([]);
        page = puts[puts.length - 1].stdin;
        const commits = fakeGbrainCalls().filter((call) => call.argv[0] === "git");
        expect(commits.length).toBeGreaterThanOrEqual(1);
        expect(commits[0].argv.slice(0, 3)).toEqual(["git", "commit-push", "--path"]);
      }
      expect(page).toContain("type: relay-conversation");
      expect(page).toContain("trust: external");
      expect(page).toContain("facts_backstop: false");
      expect(page).toContain("ping-41");
      expect(page).toContain("pong-41 from the box");
      expect(page).toContain("@capy-live (peer)");
      expect(page).not.toContain("Handle it as read-only diagnostics");
      expect(page).not.toContain(secrets.workspaceKey);
    },
    kTestTimeoutMs,
  );

  it(
    "a granted delegate works on its own lane, a high-risk write waits for the owner's one tap and runs once, and a revoke aborts a running turn",
    async () => {
      expect(remoteTool).toBeTruthy();
      const request = require("supertest");
      const as = { as: remoteBound.agent, capability: remoteBound.capability };
      const granted = await request(remoteApp).post("/api/relay/remote/grants").send({ agent: remoteBound.agent });
      expect(granted.status).toBe(200);
      // The lane's conversation as the thread reads it (wakes are held to
      // one a minute, so they are not counted here).
      const laneText = async () =>
        (await remoteTool("relay_history", { ...as, with: "wintermute", lane: "gbrain" })).data.messages.map((message) => message.text).join("\n");
      const occurrences = async (needle) => (await laneText()).split(needle).length - 1;

      const first = await remoteTool("relay_send", { ...as, to: "wintermute", text: "confirm-probe-1", lane: "gbrain" });
      expect(first.data).toMatchObject({ trust: "delegate", lane: "gbrain" });
      await waitFor(async () => (await occurrences("held rc_")) === 1, 180_000, "the held write's answer");
      const ref = (await laneText()).match(/held (rc_[a-f0-9]{16})/)[1];
      expect(fs.existsSync(probePath())).toBe(false);
      const row = relay.getStore().get(first.data.message_id);
      expect(row).toMatchObject({ trust: "delegate", lane: "gbrain", grantId: granted.body.grant.id });
      expect(row.sessionKey).toMatch(/:lane-gbrain$/);
      // GST-2090: a delegate's turn rides the admin socket and OpenClaw runs
      // it as the owner.
      expect(sendsBySocket.admin).toContain("relay-" + first.data.message_id);
      expect(sendsBySocket.peer).not.toContain("relay-" + first.data.message_id);
      const delegateRow = userRowOf(row.sessionKey, first.data.message_id);
      console.log("[live] delegate turn: " + JSON.stringify({ trust: row.trust, senderIsOwner: delegateRow?.__openclaw?.senderIsOwner ?? null }));
      expect(delegateRow?.__openclaw?.senderIsOwner).toBe(true);
      // Every turn the bridge sent so far went over the socket its tier names.
      for (const runId of sendsBySocket.peer) expect(relay.getStore().get(runId.replace(/^relay-/, ""))?.trust).toBe("peer");

      await waitFor(async () => ownerNotices.some((notice) => notice.opts?.id === "relay-confirm-" + ref), 30_000, "the owner's confirmation link");
      const notice = ownerNotices.find((entry) => entry.opts?.id === "relay-confirm-" + ref);
      expect(notice.text).toContain("wants to `write .env.relay-probe`");
      expect(notice.text).not.toContain("confirm-probe-1");
      const token = notice.text.match(/\/relay\/confirm\/(rcl_[a-f0-9]{48})/)[1];
      expect(await relay.confirmations.decide({ token, approve: true, by: "owner" })).toMatchObject({ ok: true, state: "confirmed" });
      await waitFor(async () => (await occurrences("your owner approved")) === 1, 60_000, "the sender is told about the approval");

      const retry = await remoteTool("relay_send", { ...as, to: "wintermute", text: "confirm-probe-2", lane: "gbrain", confirmation_ref: ref });
      expect(retry.isError).toBe(false);
      await waitFor(async () => (await occurrences("wrote probe 2")) === 1, 180_000, "the confirmed write's answer");
      expect(fs.readFileSync(probePath(), "utf8")).toBe("probe 2\n");
      expect(relay.getStore().confirmations.get(ref)).toMatchObject({ state: "spent", spentMessageId: retry.data.message_id });

      const replay = await remoteTool("relay_send", { ...as, to: "wintermute", text: "confirm-probe-3", lane: "gbrain", confirmation_ref: ref });
      expect(replay.isError).toBe(false);
      await waitFor(async () => (await occurrences("held rc_")) === 2, 180_000, "the replayed write held again");
      expect(fs.readFileSync(probePath(), "utf8")).toBe("probe 2\n");

      // A revoke ends a running turn: the slow turn is aborted and settles.
      slowNext = true;
      const slow = await remoteTool("relay_send", { ...as, to: "wintermute", text: "a long job" });
      await waitFor(async () => relay.getStore().get(slow.data.message_id)?.state === "dispatched", 60_000, "the slow turn running");
      slowNext = false;
      const revoked = await request(remoteApp).post("/api/relay/remote/grants/" + granted.body.grant.id + "/revoke");
      expect(revoked.status).toBe(200);
      await waitFor(async () => relay.getStore().get(slow.data.message_id)?.trust === "peer", 30_000, "the running turn demoted");
      await waitFor(
        async () => !["queued", "dispatched", "completing", "reconciling"].includes(relay.getStore().get(slow.data.message_id)?.state),
        kSlowTurnSeconds * 1000 - 5_000,
        "the aborted turn settling before the slow model would have finished",
      );
    },
    kTestTimeoutMs,
  );
});

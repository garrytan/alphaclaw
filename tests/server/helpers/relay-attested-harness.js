// The relay attested-delegate test box (GST-2323), shared by
// relay-attested-delegate.test.js and relay-owner-threads.test.js: the real
// remote side, bridge, relay guard and confirmation notifier on a temp root.
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { registerRelayRemoteRoutes } = require("../../../lib/server/routes/relay-remote");
const { createRelayRemote } = require("../../../lib/server/relay/remote");
const { readRelayConfig } = require("../../../lib/server/relay/config");
const { relayPaths } = require("../../../lib/server/relay/constants");
const { kRelayGuardPluginId, kRelayGuardPluginPath } = require("../../../lib/server/relay/guard-entry");
const { createRelayBridge, relaySessionKey } = require("../../../lib/server/relay/bridge");
const { openBridgeStore } = require("../../../lib/server/relay/bridge-store");
const { sha256 } = require("../../../lib/server/relay/remote-store");
const { createRelayConfirmations } = require("../../../lib/server/relay/confirmations");
const { createRelayGuardPlugin } = require("../../../lib/plugin/relay-guard");
const { checkConfirmation, classifyAnchor } = require("../../../lib/plugin/relay-guard/confirm");
const { attestationVerdict } = require("../../../lib/plugin/relay-guard/grants");
const { resolveRelayTrust } = require("../../../lib/plugin/relay-guard/trust");
const { createCapyIssuer } = require("./capy-oidc-fixture");

const kPublic = "https://box.relay.test";
const kResource = kPublic + "/relay/mcp";
const kAudience = "https://box.relay.test/relay";
const kWebhook = "https://api.capy.ai/webhooks/automations/tok_abcdefghijklmnop";
const kJwtBearer = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const kOauthClient = "d1df4e9e-8f1b-4520-98f6-2db9ab5d035f";
const kOwner = "user_1";
const kOtherOwner = "user_2";
const kMinute = 60 * 1000;
const kHour = 60 * kMinute;
const quiet = { log: () => {}, warn: () => {}, info: () => {}, error: () => {} };

const flush = async (times = 20) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

// The engine the remote side registers bound agents on.
const createRemoteEngine = () => {
  const agents = new Map([["wintermute", "at_live_box"]]);
  const byToken = (token) => [...agents.entries()].find(([, value]) => value === token)?.[0];
  return {
    registerAgent: async (key, name) => {
      const token = "at_live_" + crypto.randomBytes(6).toString("hex");
      agents.set(name, token);
      return { name, token };
    },
    deleteAgent: async (key, name) => agents.delete(name),
    inbox: async (token) => {
      if (!byToken(token)) throw Object.assign(new Error("401"), { engineStatus: 401 });
      return { unread: [] };
    },
    sendDm: async () => ({ id: "1", conversation_id: "conv-1" }),
    dmConversations: async () => [],
    dmMessages: async () => [],
    listAgents: async () => [...agents.keys()].map((name) => ({ name, status: "active" })),
    getMessage: async (key, id) => ({ id, agent_name: "wintermute", text: "x" }),
  };
};

// The engine the bridge reads relay DMs to the box agent from.
const createBridgeEngine = () => {
  let seq = 0;
  let id = 500;
  const events = [];
  const messages = new Map();
  return {
    dm(from, text, metadata = {}) {
      const message = { id: String(++id), agent_name: from, text, metadata };
      messages.set(message.id, message);
      events.push({ seq: ++seq, type: "dm.received", payload: { conversation_id: "dm_" + from, message: { id: message.id, agent_name: from, text } } });
      return message.id;
    },
    events: async (key, since, limit) => {
      const page = events.filter((event) => event.seq > since).slice(0, limit);
      return { events: page, latest_seq: seq, next_since: page.length ? page[page.length - 1].seq : since };
    },
    conversations: async () => [...new Set(events.map((event) => event.payload.message.agent_name))].map((name) => ({ id: "dm_" + name, type: "1:1", participants: [name, "wintermute"] })),
    getMessage: async (token, messageId) => messages.get(String(messageId)),
    reply: async () => ({ id: String(++id) }),
    thread: async () => ({ replies: [] }),
  };
};

const createSocket = () => {
  const socket = {
    sends: [],
    requestGateway: async (method, params, timeoutMs, { onFrameWritten } = {}) => {
      if (method === "chat.send") {
        onFrameWritten?.();
        socket.sends.push(params);
        return { runId: params.idempotencyKey };
      }
      if (method === "chat.history") return { messages: [] };
      if (method === "sessions.list") return { sessions: [] };
      if (method === "chat.abort") return { ok: true };
      if (method === "plugins.list") return { plugins: [{ id: kRelayGuardPluginId, runtime: { state: "active" } }] };
      throw new Error("unexpected " + method);
    },
  };
  return socket;
};

const capyEnv = ({ org = "org_garry", audience = kAudience, owners = kOwner } = {}) => ({
  ...(org ? { ALPHACLAW_RELAY_CAPY_ORG: org } : {}),
  ...(audience ? { ALPHACLAW_RELAY_CAPY_AUDIENCE: audience } : {}),
  ...(owners ? { ALPHACLAW_RELAY_CAPY_OWNERS: owners } : {}),
});

// The box's openclaw.json as AlphaClaw writes it, with the relay guard.
const guardedConfig = (rootDir, extra = {}) => ({
  gateway: { bind: "loopback" },
  plugins: {
    allow: [kRelayGuardPluginId],
    load: { paths: [kRelayGuardPluginPath] },
    entries: { [kRelayGuardPluginId]: { enabled: true, config: { _alphaclawManaged: "relay", rootDir } } },
  },
  ...extra,
});

const setup = ({ env = capyEnv() } = {}) => {
  // The fake clock starts at the real time: the MCP SDK's bearer check
  // (requireBearerAuth) compares a token's expiry with the real clock, so a
  // fixed start date expires every access token an hour after that date.
  const clock = { now: Math.floor(Date.now() / 1000) * 1000 };
  const now = () => clock.now;
  const issuer = createCapyIssuer({ org: "org_garry", audience: kAudience, now });
  issuer.rotate("k1");
  const rootDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "relay-attested-")));
  const paths = relayPaths(rootDir);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const openclawJson = path.join(rootDir, ".openclaw", "openclaw.json");
  fs.mkdirSync(path.dirname(openclawJson), { recursive: true });
  fs.writeFileSync(openclawJson, JSON.stringify(guardedConfig(rootDir), null, 2));
  const dotEnv = path.join(rootDir, ".env");
  fs.writeFileSync(dotEnv, "A=1\n");
  const relayService = {
    config: readRelayConfig({ env }),
    paths,
    engine: createRemoteEngine(),
    isReady: () => true,
    getAuth: () => ({ workspaceKey: "rk_live_workspace", agentName: "wintermute", agentToken: "at_live_box" }),
    demoteSender: vi.fn(),
  };
  const relayRemote = createRelayRemote({
    relayService,
    getPublicUrl: () => kPublic,
    now,
    logger: quiet,
    fetchImpl: issuer.fetchImpl,
    wakeOptions: { lookup: async () => [{ address: "34.120.1.1", family: 4 }], requestImpl: () => ({ on() {}, end() {}, destroy() {} }) },
  });
  const app = express();
  app.use(express.json());
  registerRelayRemoteRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
    resolveRequestIdentity: () => ({ kind: "legacy", role: "admin" }),
    relayRemote,
    logger: quiet,
  });
  const access = async (claims) =>
    (await request(app).post("/relay/oauth/token").type("form").send({ grant_type: kJwtBearer, assertion: issuer.sign(claims), resource: kResource })).body.access_token;
  const tool = async (accessToken, name, args) => {
    const res = await request(app)
      .post("/relay/mcp")
      .set("Authorization", "Bearer " + accessToken)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    if (res.status !== 200) return { httpStatus: res.status };
    return JSON.parse(res.body.result.content[0].text);
  };
  const store = () => relayRemote.ensureOpen().store;

  const bridgeStore = openBridgeStore({ dbPath: paths.bridgeDb, now });
  const bridgeEngine = createBridgeEngine();
  const admin = createSocket();
  const peer = createSocket();
  const guardState = { active: true };
  const bridgeLogs = [];
  const bridge = createRelayBridge({
    engine: bridgeEngine,
    getAuth: () => ({ workspaceKey: "rk", agentToken: "at", agentName: "wintermute" }),
    store: bridgeStore,
    requestGateway: (...args) => admin.requestGateway(...args),
    requestPeerGateway: (...args) => peer.requestGateway(...args),
    checkGuard: async () => guardState.active,
    resolveAgentId: () => "main",
    config: { maxConcurrent: 6, hourlyCap: 100 },
    resolveSenderTrust: (sender) => relayRemote.resolveDelegate(sender),
    now,
    setTimer: () => null,
    clearTimer: () => {},
    logger: { log: (line) => bridgeLogs.push(line), warn: (line) => bridgeLogs.push(line) },
  });
  bridge.start();
  // The bridge's first poll only sets its cursor, as on a fresh box.
  let primed = false;
  const tick = async () => {
    if (!primed) {
      primed = true;
      await bridge._internal.pollOnce();
    }
    await bridge._internal.pollOnce();
    await bridge._internal.pump();
    await flush();
  };

  const handlers = {};
  const guardLogs = [];
  createRelayGuardPlugin().register({
    pluginConfig: { rootDir },
    logger: { info: (line) => guardLogs.push(line), warn: (line) => guardLogs.push(line), error: (line) => guardLogs.push(line) },
    on: (name, handler) => (handlers[name] = handler),
  });
  const notices = [];
  const confirmations = createRelayConfirmations({
    getStore: () => bridgeStore,
    // The daily digest is left out: the clock starts at the real time, so
    // after 15:00 UTC (kDigestHourUtc) the first tick would send it, and
    // these tests count confirmation notices only.
    notify: (text, opts) => {
      if (opts?.eventType !== "relay_digest") notices.push({ text, opts });
    },
    resolveSetupUrl: () => kPublic,
    sendToAgent: async () => {},
    readRevokes: () => 0,
    resolveGrantCreator: () => null,
    now,
    setTimer: () => null,
    clearTimer: () => {},
    logger: quiet,
  });

  // A Capy thread bound through a Capy grant for its project and owner, with
  // a verified token. The fixture's token names user_1 unless told otherwise.
  const attestedAgent = async (claims = {}) => {
    const user = claims.user || kOwner;
    if (!store().grants.liveCapy({ project: "proj_1", user }).length) {
      expect((await request(app).post("/api/relay/remote/grants").send({ kind: "capy", project: "proj_1", user })).status).toBe(200);
    }
    const token = await access(claims);
    const bound = await tool(token, "relay_bind", { webhook_url: kWebhook });
    expect(bound.agent).toMatch(/^capy-[a-f0-9]{12}$/);
    return { ...bound, token };
  };
  // A Capy thread bound through the plain OAuth connector, made a delegate
  // with Make delegate: no attestation.
  const oauthDelegate = (agent = "capy-25cf4e98b5b6", { grant = true, threadId = "jam_A" } = {}) => {
    const remote = store();
    if (!remote.clients.get(kOauthClient)) {
      remote.clients.insert({ client_id: kOauthClient, client_name: "Capy", redirect_uris: ["https://capy.ai/web/callbacks/mcp"] });
      remote.clients.markConsented(kOauthClient);
    }
    remote.bindings.upsert({ agent, threadId, clientId: kOauthClient, webhookUrl: kWebhook, until: clock.now + 24 * kHour, capabilityHash: sha256("arcap_" + agent), agentToken: "at_" + agent });
    if (grant) relayRemote.createGrant({ agent, actor: "legacy" });
    return { agent };
  };
  // A relay message from sender, dispatched by the bridge the way a real
  // remote relay_send arrives (relay_generation is what remote-tools writes).
  // Runs never end here, so each later message of a sender takes a lane of
  // its own and runs beside the earlier ones.
  const sent = new Map();
  const deliver = async (sender, metadata) => {
    await tick();
    const count = (sent.get(sender) || 0) + 1;
    sent.set(sender, count);
    const lane = count > 1 ? "l" + count : null;
    const generation = store().bindings.get(sender)?.generation ?? 1;
    const base = metadata === undefined ? { relay_generation: generation, relay_route: "public" } : metadata;
    const messageId = bridgeEngine.dm(sender, "please fix the box config", lane ? { ...base, relay_lane: lane } : base);
    await tick();
    return { messageId, ctx: { sessionKey: relaySessionKey("main", sender, lane), runId: "relay-" + messageId } };
  };
  const call = (run, toolName, params) => handlers.before_tool_call({ toolName, params }, run.ctx);
  const alphaclawJson = path.join(rootDir, "alphaclaw.json");
  const wmGuard = path.join(rootDir, ".openclaw", "extensions", "wm-guards", "index.js");
  const configWrite = JSON.stringify(guardedConfig(rootDir, { gateway: { bind: "lan" } }));
  // The four kinds of call in the owner's screenshot, plus a config command
  // and an automations write (PR4).
  const highRiskCalls = [
    ["write openclaw.json", "write", { path: openclawJson, content: configWrite }],
    ["edit openclaw.json", "edit", { path: openclawJson, old_string: '"bind": "loopback"', new_string: '"bind": "lan"' }],
    ["write alphaclaw.json", "write", { path: alphaclawJson, content: "{}" }],
    ["edit .env", "edit", { path: dotEnv, old_string: "A=1", new_string: "A=2" }],
    ["write wm-guards", "write", { path: wmGuard, content: "module.exports = {};" }],
    ["exec openclaw config set", "exec", { command: "openclaw config set gateway.bind lan" }],
    ["automations run", "automations", { action: "run", jobId: "job-1" }],
  ];
  const confirmationCount = () => Object.values(bridgeStore.confirmations.countsSince(0)).reduce((sum, n) => sum + n, 0);
  return {
    clock,
    rootDir,
    relayRemote,
    store,
    tool,
    access,
    bridgeStore,
    bridgeEngine,
    admin,
    guardState,
    tick,
    bridgeLogs,
    guardLogs,
    confirmations,
    notices,
    attestedAgent,
    oauthDelegate,
    deliver,
    call,
    highRiskCalls,
    openclawJson,
    dotEnv,
    confirmationCount,
    setConfig: (nextEnv) => {
      relayService.config = readRelayConfig({ env: nextEnv });
    },
    cleanup: () => {
      relayRemote.stop();
      bridgeStore.close();
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
};

const expectHeld = (result, label) => {
  expect(result.block, label).toBe(true);
  expect(result.blockReason, label).toMatch(/needs your owner's confirmation rc_[a-f0-9]{16}|is waiting for your owner's confirmation rc_[a-f0-9]{16}/);
};

// Held as today: a confirmation row, and one notice after the notifier ticks.
const expectHeldWithTap = (ctx, run, toolName, params) => {
  const before = ctx.confirmationCount();
  expectHeld(ctx.call(run, toolName, params), toolName);
  expect(ctx.confirmationCount()).toBe(before + 1);
  ctx.confirmations.tick();
  expect(ctx.notices.at(-1).text).toContain("Relay confirmation needed");
};

module.exports = {
  kPublic,
  kResource,
  kAudience,
  kWebhook,
  kJwtBearer,
  kOauthClient,
  kOwner,
  kOtherOwner,
  kMinute,
  kHour,
  quiet,
  flush,
  createRemoteEngine,
  createBridgeEngine,
  createSocket,
  capyEnv,
  guardedConfig,
  setup,
  expectHeld,
  expectHeldWithTap,
};

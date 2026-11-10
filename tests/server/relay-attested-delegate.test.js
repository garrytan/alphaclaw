const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { registerRelayRemoteRoutes } = require("../../lib/server/routes/relay-remote");
const { createRelayRemote } = require("../../lib/server/relay/remote");
const { readRelayConfig } = require("../../lib/server/relay/config");
const { relayPaths } = require("../../lib/server/relay/constants");
const { kRelayGuardPluginId, kRelayGuardPluginPath } = require("../../lib/server/relay/guard-entry");
const { createRelayBridge, relaySessionKey } = require("../../lib/server/relay/bridge");
const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
const { sha256 } = require("../../lib/server/relay/remote-store");
const { createRelayConfirmations } = require("../../lib/server/relay/confirmations");
const { createRelayGuardPlugin } = require("../../lib/plugin/relay-guard");
const { checkConfirmation, classifyAnchor } = require("../../lib/plugin/relay-guard/confirm");
const { attestationVerdict } = require("../../lib/plugin/relay-guard/grants");
const { resolveRelayTrust } = require("../../lib/plugin/relay-guard/trust");
const { createCapyIssuer } = require("./helpers/capy-oidc-fixture");

// GST-2323: a delegate whose binding was accepted through a verified Capy
// attestation of the box's configured org, for a thread whose owner (the
// token's user claim) is on ALPHACLAW_RELAY_CAPY_OWNERS, acts for the owner
// like the owner's own turn: its high-risk calls (config, env, guards,
// automations) run with no confirmation row and no link to the owner. Its
// changes to the relay's trust anchor are refused outright, also with no
// row and no notice. Every other sender is held exactly as before. These
// tests drive the real remote side (token exchange and relay_bind), the
// real bridge (which stamps the run), the real relay guard and the real
// confirmation notifier.
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
  const clock = { now: Date.parse("2026-11-10T10:00:00Z") };
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
    notify: (text, opts) => notices.push({ text, opts }),
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
  const oauthDelegate = (agent = "capy-25cf4e98b5b6", { grant = true } = {}) => {
    const remote = store();
    if (!remote.clients.get(kOauthClient)) {
      remote.clients.insert({ client_id: kOauthClient, client_name: "Capy", redirect_uris: ["https://capy.ai/web/callbacks/mcp"] });
      remote.clients.markConsented(kOauthClient);
    }
    remote.bindings.upsert({ agent, threadId: "jam_A", clientId: kOauthClient, webhookUrl: kWebhook, until: clock.now + 24 * kHour, capabilityHash: sha256("arcap_" + agent), agentToken: "at_" + agent });
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

describe("relay attested delegates (GST-2323): no owner taps for the owner's attested threads", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it("runs an attested owner's thread's protected-file, env, guard, config and automations changes with no confirmation row and no notice", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    expect(ctx.relayRemote.resolveDelegate(agent)).toMatchObject({ trust: "delegate", attested: true, attestedOrg: "org_garry", attestedOwner: kOwner });
    const run = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ state: "dispatched", trust: "delegate", attestedOrg: "org_garry", attestedOwner: kOwner });
    expect(ctx.bridgeLogs.some((line) => line.includes("message=" + run.messageId) && line.includes("attested=org_garry"))).toBe(true);
    const [sent] = ctx.admin.sends;
    expect(sent.message).toContain("This thread's Capy attestation was verified");
    expect(sent.message).not.toContain("needs your owner's one-tap confirmation");
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx })).toMatchObject({ tier: "delegate", attested: true, attestedOrg: "org_garry", owner: kOwner });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "delegate", owner: kOwner });
    for (const [label, toolName, params] of ctx.highRiskCalls) {
      expect(ctx.call(run, toolName, params), label).toEqual({});
    }
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
    expect(ctx.guardLogs.filter((line) => line.includes("attested delegate call admitted"))).toHaveLength(ctx.highRiskCalls.length);
    // The tools a delegate never gets stay withheld: attestation lifts the
    // taps, not the tool policy.
    expect(ctx.call(run, "gateway", { action: "restart" }).block).toBe(true);
  });

  it("holds an unattested delegate (plain OAuth connector) for each of the same calls and sends the owner a link", async () => {
    ctx = setup();
    const { agent } = ctx.oauthDelegate();
    expect(ctx.relayRemote.resolveDelegate(agent)).toMatchObject({ trust: "delegate", attested: false, attestedOrg: null, attestedOwner: null });
    const run = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", attestedOrg: null, attestedOwner: null });
    expect(ctx.admin.sends[0].message).toContain("needs your owner's one-tap confirmation");
    // A sender has at most 5 open requests, as today.
    const calls = ctx.highRiskCalls.slice(0, 5);
    for (const [label, toolName, params] of calls) expectHeld(ctx.call(run, toolName, params), label);
    expect(ctx.confirmationCount()).toBe(calls.length);
    ctx.confirmations.tick();
    expect(ctx.notices).toHaveLength(calls.length);
    expect(ctx.notices[0].text).toContain("Relay confirmation needed");
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx })).toMatchObject({ tier: "delegate", attested: false, attestationReason: "not_attested", owner: null });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "peer", reason: "owner_not_trusted" });
  });

  it("gives a peer nothing: its high-risk calls stay refused", async () => {
    ctx = setup();
    const { agent } = ctx.oauthDelegate("capy-00000000abcd", { grant: false });
    const run = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "peer", attestedOrg: null });
    for (const [label, toolName, params] of ctx.highRiskCalls) expect(ctx.call(run, toolName, params).block, label).toBe(true);
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx })).toMatchObject({ tier: "peer", attested: false });
  });

  it("holds an attested thread of another owner in the same org, with today's tap", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent({ user: kOtherOwner });
    expect(ctx.relayRemote.resolveDelegate(agent)).toMatchObject({ trust: "delegate", attested: false, attestedOwner: null });
    const run = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", attestedOrg: null, attestedOwner: null });
    expect(ctx.admin.sends[0].message).toContain("needs your owner's one-tap confirmation");
    expectHeldWithTap(ctx, run, "write", { path: ctx.openclawJson, content: "{}" });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx })).toMatchObject({ tier: "delegate", attested: false, attestationReason: "owner_not_trusted", owner: kOtherOwner });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "peer", reason: "owner_not_trusted", owner: kOtherOwner });
  });

  it.each([
    ["the owner allowlist is empty", capyEnv({ owners: "" })],
    ["the allowlist names someone else", capyEnv({ owners: "user_9" })],
    ["the allowlist entry is malformed", capyEnv({ owners: "user 1" })],
  ])("holds the owner's attested thread when %s", async (_name, env) => {
    ctx = setup({ env });
    const { agent } = await ctx.attestedAgent();
    const run = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", attestedOwner: null });
    expectHeldWithTap(ctx, run, "edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "A=2" });
  });

  it("holds a binding whose recorded claims carry no owner, or claims that cannot be read", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    const binding = ctx.store().bindings.get(agent);
    const { user, ...noOwner } = binding.attestedClaims;
    expect(user).toBe(kOwner);
    ctx.store().bindings.attest(agent, { claims: noOwner, expiresAt: binding.attestedUntil });
    expect(ctx.relayRemote.resolveDelegate(agent)).toMatchObject({ trust: "delegate", attested: false });
    const run = await ctx.deliver(agent);
    expectHeldWithTap(ctx, run, "write", { path: ctx.openclawJson, content: "{}" });
    // Unreadable claims under a run the bridge stamped: still not attested.
    ctx.store().bindings.attest(agent, { claims: binding.attestedClaims, expiresAt: binding.attestedUntil });
    const stamped = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(stamped.messageId).attestedOwner).toBe(kOwner);
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(path.join(ctx.rootDir, "relay", "remote.db"));
    raw.prepare("UPDATE relay_bindings SET attested_claims = ? WHERE agent = ?").run("{not json", agent);
    raw.close();
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...stamped.ctx })).toMatchObject({ tier: "delegate", attested: false, attestationReason: "not_attested", owner: null });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...stamped.ctx, requireTrustedOwner: true })).toMatchObject({ tier: "peer", reason: "owner_not_trusted" });
    expectHeld(ctx.call(stamped, "write", { path: ctx.openclawJson, content: "{}" }));
  });

  it("holds an attested binding once the box is configured for another Capy org", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    ctx.setConfig(capyEnv({ org: "org_other" }));
    expect(ctx.relayRemote.resolveDelegate(agent)).toMatchObject({ trust: "delegate", attested: false });
    const run = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(run.messageId).attestedOrg).toBeNull();
    expectHeldWithTap(ctx, run, "write", { path: ctx.openclawJson, content: "{}" });
  });

  it.each([
    ["the Capy org is unset", capyEnv({ org: "" })],
    ["the Capy audience is unset", capyEnv({ audience: "" })],
    ["no Capy key is set", {}],
  ])("holds an attested binding when %s", async (_name, env) => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    ctx.setConfig(env);
    const run = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", attestedOrg: null });
    expectHeldWithTap(ctx, run, "edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "A=2" });
  });

  it("holds a binding whose stored claims name another org than the box's", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    const binding = ctx.store().bindings.get(agent);
    ctx.store().bindings.attest(agent, { claims: { ...binding.attestedClaims, org: "org_evil", sub: "org/org_evil/project/proj_1/thread/ALPH-85" }, expiresAt: binding.attestedUntil });
    const run = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(run.messageId).attestedOrg).toBeNull();
    expectHeld(ctx.call(run, "write", { path: ctx.openclawJson, content: "{}" }));
  });

  it("holds a delegate whose attestation went stale while its message waited in the queue", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    // A Make delegate grant on the agent keeps it a delegate past the Capy
    // grant's queue rule, so only the attestation's freshness decides here.
    // It must be the newer grant: with the clock frozen both grants share a
    // createdAt and the resolver would pick between them by random id.
    ctx.clock.now += 1000;
    const legacy = ctx.relayRemote.createGrant({ agent, actor: "legacy" });
    expect(ctx.relayRemote.resolveDelegate(agent)).toMatchObject({ trust: "delegate", grantId: legacy.id, attestationRequired: false });
    // The binding itself outlives the wait; only the token is old.
    const { DatabaseSync } = require("node:sqlite");
    const raw = new DatabaseSync(path.join(ctx.rootDir, "relay", "remote.db"));
    raw.prepare("UPDATE relay_bindings SET until_at = ? WHERE agent = ?").run(ctx.clock.now + 24 * kHour, agent);
    raw.close();
    await ctx.tick();
    ctx.guardState.active = false;
    const generation = ctx.store().bindings.get(agent).generation;
    const messageId = ctx.bridgeEngine.dm(agent, "queued", { relay_generation: generation });
    await ctx.tick();
    expect(ctx.bridgeStore.get(messageId).state).toBe("queued");
    ctx.clock.now += 3 * kHour;
    ctx.guardState.active = true;
    await ctx.tick();
    expect(ctx.bridgeStore.get(messageId)).toMatchObject({ state: "dispatched", trust: "delegate", attestedOrg: null });
    expectHeld(ctx.call({ ctx: { sessionKey: "agent:main:relay-" + agent, runId: "relay-" + messageId } }, "write", { path: ctx.openclawJson, content: "{}" }));
  });

  it("holds the rest of a turn after a handoff moves the binding to a new generation", async () => {
    ctx = setup();
    const { agent, capability, token } = await ctx.attestedAgent();
    const run = await ctx.deliver(agent);
    expect(ctx.call(run, "edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "A=2" })).toEqual({});
    expect(await ctx.tool(token, "relay_handoff", { as: agent, capability, successor_thread: "ALPH-99" })).toMatchObject({ successor_thread: "ALPH-99" });
    const successor = await ctx.access({ thread: "ALPH-99", sub: "org/org_garry/project/proj_1/thread/ALPH-99" });
    expect(await ctx.tool(successor, "relay_claim", { as: agent, webhook_url: kWebhook })).toMatchObject({ generation: 2 });
    expectHeld(ctx.call(run, "edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "A=2" }));
    // A message sent under the old generation is a peer; one under the new
    // generation from the successor's attested binding runs untapped.
    const old = await ctx.deliver(agent, { relay_generation: 1 });
    expect(ctx.bridgeStore.get(old.messageId)).toMatchObject({ trust: "peer", attestedOrg: null });
    const fresh = await ctx.deliver(agent);
    expect(ctx.bridgeStore.get(fresh.messageId)).toMatchObject({ trust: "delegate", attestedOrg: "org_garry", attestedOwner: kOwner });
    expect(ctx.call(fresh, "edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "A=2" })).toEqual({});
  });

  it("holds a message with no binding generation, and ends the bypass when the Capy grant is revoked", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    const unfenced = await ctx.deliver(agent, { relay_route: "public" });
    expect(ctx.bridgeStore.get(unfenced.messageId)).toMatchObject({ trust: "delegate", attestedOrg: null });
    expectHeld(ctx.call(unfenced, "edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "A=2" }));
    const run = await ctx.deliver(agent);
    expect(ctx.call(run, "edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "A=2" })).toEqual({});
    const grant = ctx.store().grants.liveCapy({ project: "proj_1", user: kOwner })[0];
    ctx.relayRemote.revokeGrant({ id: grant.id, actor: "legacy" });
    expect(ctx.call(run, "edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "A=2" }).block).toBe(true);
  });

  it("holds attestation claims stored on a binding that is not on a Capy grant's connection", async () => {
    ctx = setup();
    const { agent } = ctx.oauthDelegate();
    ctx.store().bindings.attest(agent, {
      claims: { sub: "org/org_garry/project/proj_1/thread/ALPH-85", org: "org_garry", project: "proj_1", thread: "ALPH-85", user: kOwner, machine: null, exp: 0 },
      expiresAt: ctx.clock.now + kHour,
    });
    expect(ctx.relayRemote.resolveDelegate(agent)).toMatchObject({ trust: "delegate", attested: false });
    const run = await ctx.deliver(agent);
    expectHeld(ctx.call(run, "write", { path: ctx.openclawJson, content: "{}" }));
  });
});

describe("relay attested delegates (GST-2323): the trust anchor is refused outright", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  const anchorCalls = (box) => {
    const relay = path.join(box.rootDir, "relay");
    const repoRoot = path.resolve(__dirname, "..", "..");
    const noGuard = guardedConfig(box.rootDir);
    delete noGuard.plugins.entries[kRelayGuardPluginId];
    const disabled = guardedConfig(box.rootDir);
    disabled.plugins.entries[kRelayGuardPluginId].enabled = false;
    const reloaded = guardedConfig(box.rootDir);
    reloaded.plugins.entries[kRelayGuardPluginId].config.delegateAgents = ["capy-25cf4e98b5b6"];
    return [
      ["relay dir: remote.db", "write", { path: path.join(relay, "remote.db"), content: "x" }],
      ["relay dir: secrets.json", "edit", { path: path.join(relay, "secrets.json"), old_string: "a", new_string: "b" }],
      ["relay dir: any new file", "write", { path: path.join(relay, "notes.txt"), content: "x" }],
      ["relay dir: sqlite on the grants", "exec", { command: "sqlite3 " + path.join(relay, "remote.db") + " 'DELETE FROM relay_grants'" }],
      ["relay dir: rm by its home path", "exec", { command: "rm -rf ~/.alphaclaw/relay/bridge.db" }],
      ["relay dir: patch", "apply_patch", { input: "*** Begin Patch\n*** Add File: " + path.join(relay, "x.json") + "\n+{}\n*** End Patch" }],
      ["installed code: this package", "write", { path: path.join(repoRoot, "lib", "server", "relay", "bridge.js"), content: "x" }],
      ["installed code: /app/node_modules/alphaclaw", "edit", { path: "/app/node_modules/alphaclaw/lib/plugin/relay-guard/confirm.js", old_string: "a", new_string: "b" }],
      ["installed code: shell into node_modules/alphaclaw", "exec", { command: "sed -i s/a/b/ /app/node_modules/alphaclaw/lib/server.js" }],
      ["installed code: a relay-guard directory", "write", { path: path.join(box.rootDir, ".openclaw", "extensions", "relay-guard", "index.js"), content: "x" }],
      ["guard: openclaw.json without the guard entry", "write", { path: box.openclawJson, content: JSON.stringify(noGuard) }],
      ["guard: openclaw.json disabling the guard", "write", { path: box.openclawJson, content: JSON.stringify(disabled) }],
      ["guard: openclaw.json reloading the guard", "write", { path: box.openclawJson, content: JSON.stringify(reloaded) }],
      ["guard: edit disabling the guard", "edit", { path: box.openclawJson, old_string: '"enabled": true', new_string: '"enabled": false' }],
      ["guard: edit dropping allow", "edit", { path: box.openclawJson, old_string: '"allow": [\n      "relay-guard"\n    ],', new_string: "" }],
      ["guard: patch to openclaw.json", "apply_patch", { input: "*** Begin Patch\n*** Update File: " + box.openclawJson + "\n@@\n-x\n+y\n*** End Patch" }],
      ["guard: openclaw.json that does not parse", "write", { path: box.openclawJson, content: "{ plugins: " }],
      ["guard: openclaw plugins disable", "exec", { command: "openclaw plugins disable relay-guard" }],
      ["guard: openclaw config set on the entry", "exec", { command: "openclaw config set plugins.entries.relay-guard.enabled false" }],
      ["guard: openclaw config unset plugins", "exec", { command: "openclaw config unset plugins" }],
      ["guard: openclaw config apply", "exec", { command: "openclaw config apply /tmp/new.json" }],
      ["guard: shell edit of openclaw.json", "exec", { command: "jq '.plugins.entries = {}' " + box.openclawJson + " > /tmp/o && mv /tmp/o " + box.openclawJson }],
      ["env: ALPHACLAW_ROOT_DIR in .env", "edit", { path: box.dotEnv, old_string: "A=1", new_string: "A=1\nALPHACLAW_ROOT_DIR=/tmp/fake" }],
      ["env: WM_GUARDS_RELAY_TRUST_PATH in .env", "write", { path: box.dotEnv, content: "WM_GUARDS_RELAY_TRUST_PATH=/tmp/trust.js\n" }],
      ["env: ALPHACLAW_RELAY_DELEGATE_AGENTS for a command", "exec", { command: "node x.js", env: { ALPHACLAW_RELAY_DELEGATE_AGENTS: "capy-x" } }],
      ["env: the owner allowlist", "exec", { command: "echo ALPHACLAW_RELAY_CAPY_OWNERS=user_x >> " + box.dotEnv }],
      ["env: the owner allowlist in openclaw.json", "edit", { path: box.openclawJson, old_string: '"bind": "loopback"', new_string: '"bind": "loopback", "env": { "ALPHACLAW_RELAY_CAPY_OWNERS": "user_x" }' }],
      ["env: typed into a process", "process", { action: "write", sessionId: "s1", data: "export ALPHACLAW_ROOT_DIR=/tmp/x\n" }],
      ["automations: a job that edits the grants", "automations", { action: "add", job: { name: "j", prompt: "run sqlite3 ~/.alphaclaw/relay/remote.db" } }],
    ];
  };

  it("refuses each anchor class for the owner's attested thread with zero confirmation rows and zero notices", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    const run = await ctx.deliver(agent);
    for (const [label, toolName, params] of anchorCalls(ctx)) {
      const result = ctx.call(run, toolName, params);
      expect(result.block, label).toBe(true);
      expect(result.blockReason, label).toContain("would change what decides relay trust on this box");
      expect(result.blockReason, label).toContain("AlphaClaw repository and a deploy, or by the box's operator from outside this agent");
      expect(result.blockReason, label).not.toMatch(/rc_[a-f0-9]{16}/);
    }
    expect(ctx.confirmationCount()).toBe(0);
    ctx.confirmations.tick();
    expect(ctx.notices).toEqual([]);
    // Reads of the anchor are not changes.
    expect(ctx.call(run, "exec", { command: "cat " + path.join(ctx.rootDir, "relay", "secrets.json") })).toEqual({});
    expect(ctx.call(run, "read", { path: path.join(ctx.rootDir, "relay", "remote.db") })).toEqual({});
  });

  it("keeps today's holds, taps included, for the same anchor calls from an unattested delegate", async () => {
    ctx = setup();
    const { agent } = ctx.oauthDelegate();
    const run = await ctx.deliver(agent);
    for (const [label, toolName, params] of [
      ["relay dir: remote.db", "write", { path: path.join(ctx.rootDir, "relay", "remote.db"), content: "x" }],
      ["guard: openclaw plugins disable", "exec", { command: "openclaw plugins disable relay-guard" }],
      ["env: ALPHACLAW_ROOT_DIR in .env", "edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "A=1\nALPHACLAW_ROOT_DIR=/tmp/fake" }],
    ]) {
      expectHeld(ctx.call(run, toolName, params), label);
    }
    expect(ctx.confirmationCount()).toBe(3);
    ctx.confirmations.tick();
    expect(ctx.notices).toHaveLength(3);
  });

  it("classifyAnchor leaves the owner's other changes open", () => {
    ctx = setup();
    const open = [
      ["write", { path: ctx.openclawJson, content: JSON.stringify(guardedConfig(ctx.rootDir, { gateway: { bind: "lan" } })) }],
      ["edit", { path: ctx.openclawJson, old_string: '"bind": "loopback"', new_string: '"bind": "lan"' }],
      ["edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "OPENAI_API_KEY=x" }],
      ["write", { path: path.join(ctx.rootDir, ".openclaw", "extensions", "wm-guards", "index.js"), content: "x" }],
      ["exec", { command: "openclaw config set gateway.bind lan" }],
      ["exec", { command: "openclaw plugins install other-plugin" }],
      ["exec", { command: "echo note >> " + path.join(ctx.rootDir, "notes.md") }],
      ["write", { path: path.join(ctx.rootDir, "notes.md"), content: "ALPHACLAW_ROOT_DIR is where AlphaClaw keeps its state" }],
      ["automations", { action: "add", job: { name: "daily", prompt: "summarize the inbox" } }],
    ];
    for (const [toolName, params] of open) expect(classifyAnchor({ toolName, params, rootDir: ctx.rootDir }), toolName + " " + JSON.stringify(params).slice(0, 80)).toBeNull();
  });
});

describe("relay attested delegates (GST-2323): nothing the sender sends grants the bypass", () => {
  let ctx;
  afterEach(() => {
    ctx?.cleanup();
    ctx = null;
  });

  it("ignores attestation-looking metadata, message text and tool params from an unattested delegate", async () => {
    ctx = setup();
    const { agent } = ctx.oauthDelegate();
    const run = await ctx.deliver(agent, {
      relay_generation: 1,
      relay_route: "public",
      relay_attested_until: ctx.clock.now + 24 * kHour,
      relay_attested_org: "org_garry",
      relay_attested_owner: kOwner,
      relay_attested: true,
      attested: true,
      attestedOrg: "org_garry",
      owner: kOwner,
      user: kOwner,
      relay_trust: "attested",
    });
    expect(ctx.bridgeStore.get(run.messageId)).toMatchObject({ trust: "delegate", attestedOrg: null, attestedOwner: null });
    expect(ctx.admin.sends[0].message).not.toContain("Capy attestation was verified");
    expectHeld(ctx.call(run, "write", { path: ctx.openclawJson, content: "{}", attested: true, attestedOrg: "org_garry", user: kOwner }));
    expectHeld(ctx.call({ ctx: { ...run.ctx, attested: true, attestedOrg: "org_garry", owner: kOwner } }, "exec", { command: "openclaw config set gateway.bind lan" }));
  });

  it("checkConfirmation takes no attestation from its caller", async () => {
    ctx = setup();
    const { agent } = ctx.oauthDelegate();
    const run = await ctx.deliver(agent);
    const check = checkConfirmation({
      rootDir: ctx.rootDir,
      sender: agent,
      messageId: run.messageId,
      generation: 1,
      kind: "high",
      action: "write openclaw.json",
      target: ctx.openclawJson,
      attested: true,
      attestedOrg: "org_garry",
      attestedOwner: kOwner,
      state: "attested",
    });
    expect(check).toMatchObject({ admitted: false, state: "requested" });
    expect(ctx.confirmationCount()).toBe(1);
  });

  it("re-checks a stamped run against remote.db, so a row marked attested for an unattested binding is still held", async () => {
    ctx = setup();
    const { agent } = ctx.oauthDelegate();
    const run = await ctx.deliver(agent);
    ctx.bridgeStore.update(run.messageId, { attestedOrg: "org_garry", attestedOwner: kOwner });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx })).toMatchObject({ tier: "delegate", attested: false });
    expectHeld(ctx.call(run, "write", { path: ctx.openclawJson, content: "{}" }));
  });

  it("a stamp naming another owner than the binding's recorded owner is not attested", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    const run = await ctx.deliver(agent);
    ctx.bridgeStore.update(run.messageId, { attestedOwner: kOtherOwner });
    expect(resolveRelayTrust({ rootDir: ctx.rootDir, ...run.ctx })).toMatchObject({ tier: "delegate", attested: false, attestationReason: "owner_not_trusted", owner: kOwner });
    expectHeld(ctx.call(run, "edit", { path: ctx.dotEnv, old_string: "A=1", new_string: "A=2" }));
  });

  it("an attested delegate's own message ids only: another sender naming its message id is held", async () => {
    ctx = setup();
    const { agent } = await ctx.attestedAgent();
    const attested = await ctx.deliver(agent);
    const { agent: other } = ctx.oauthDelegate();
    await ctx.deliver(other);
    const check = checkConfirmation({ rootDir: ctx.rootDir, sender: other, messageId: attested.messageId, generation: 1, kind: "high", action: "write openclaw.json", target: ctx.openclawJson });
    expect(check).toMatchObject({ admitted: false, state: "requested" });
    expect(checkConfirmation({ rootDir: ctx.rootDir, sender: agent, messageId: attested.messageId, generation: 1, kind: "high", action: "write openclaw.json", target: ctx.openclawJson })).toEqual({
      admitted: true,
      state: "attested",
      ref: null,
    });
  });
});

describe("relay attested delegates (GST-2323): attestationVerdict and the owner allowlist", () => {
  const claims = { sub: "org/org_garry/project/proj_1/thread/ALPH-85", org: "org_garry", project: "proj_1", thread: "ALPH-85", user: kOwner };
  const binding = { clientId: "capy_1", threadCode: "ALPH-85", attestedClaims: claims };
  const capyGrant = { id: "rg_1", tier: "delegate", principalKind: "capy", principal: { project: "proj_1", user: kOwner, clientId: "capy_1" }, revokedAt: null };
  const owners = [kOwner];

  it("is attested only for the configured org, a matching Capy grant, consistent claims and an allowlisted owner", () => {
    expect(attestationVerdict({ binding, grants: [capyGrant], org: "org_garry", owners })).toMatchObject({ attested: true, capyGrantId: "rg_1", owner: kOwner });
    expect(attestationVerdict({ binding, grants: [capyGrant], org: "org_garry", owners: [] })).toMatchObject({ attested: false, reason: "owner_not_trusted", owner: kOwner });
    expect(attestationVerdict({ binding, grants: [capyGrant], org: "org_garry" }).reason).toBe("owner_not_trusted");
    expect(attestationVerdict({ binding, grants: [capyGrant], org: "org_garry", owners: [kOtherOwner] }).reason).toBe("owner_not_trusted");
    const { user, ...noUser } = claims;
    expect(attestationVerdict({ binding: { ...binding, attestedClaims: noUser }, grants: [{ ...capyGrant, principal: { ...capyGrant.principal, user: undefined } }], org: "org_garry", owners })).toMatchObject({ attested: false, owner: null });
    expect(attestationVerdict({ binding, grants: [capyGrant], org: "", owners }).reason).toBe("attestation_off");
    expect(attestationVerdict({ binding, grants: [capyGrant], org: "org_other", owners }).reason).toBe("attestation_org");
    expect(attestationVerdict({ binding: { ...binding, threadCode: null }, grants: [capyGrant], org: "org_garry", owners }).reason).toBe("not_attested");
    expect(attestationVerdict({ binding: { ...binding, threadCode: "ALPH-90" }, grants: [capyGrant], org: "org_garry", owners }).reason).toBe("attestation_mismatch");
    expect(attestationVerdict({ binding: { ...binding, attestedClaims: { ...claims, sub: "org/org_garry/project/proj_2/thread/ALPH-85" } }, grants: [capyGrant], org: "org_garry", owners }).reason).toBe("attestation_mismatch");
    for (const grant of [
      { ...capyGrant, revokedAt: 1 },
      { ...capyGrant, tier: "peer" },
      { ...capyGrant, principalKind: "agent" },
      { ...capyGrant, principal: { ...capyGrant.principal, clientId: "capy_2" } },
      { ...capyGrant, principal: { ...capyGrant.principal, user: kOtherOwner } },
      { ...capyGrant, principal: { ...capyGrant.principal, project: "proj_2" } },
    ]) {
      expect(attestationVerdict({ binding, grants: [grant], org: "org_garry", owners }).reason).toBe("not_capy_connection");
    }
    expect(attestationVerdict({ binding: null, grants: [capyGrant], org: "org_garry", owners }).reason).toBe("not_bound");
  });

  it("reads ALPHACLAW_RELAY_CAPY_OWNERS from the deployment env only, empty by default", () => {
    expect(readRelayConfig({ env: {} }).capyOwners).toEqual([]);
    expect(readRelayConfig({ env: { ALPHACLAW_RELAY_CAPY_OWNERS: " user_a, user_b ,bad id,user_a" } })).toMatchObject({ capyOwners: ["user_a", "user_b"], capyOwnersRejected: 1 });
    expect(require("../../lib/server/deployment-only-env").kDeploymentOnlyEnvKeys).toContain("ALPHACLAW_RELAY_CAPY_OWNERS");
  });

  it("the fixture's token user claim is the thread owner's Capy user id, as capy-oidc.js returns it", async () => {
    const { createCapyOidcVerifier } = require("../../lib/server/relay/capy-oidc");
    const issuer = createCapyIssuer({ org: "org_garry", audience: kAudience });
    issuer.rotate("k1");
    const verifier = createCapyOidcVerifier({ org: "org_garry", audience: kAudience, fetchImpl: issuer.fetchImpl, logger: quiet });
    const verified = await verifier.verify(issuer.sign({ user: "user_owner42" }));
    expect(verified.claims.user).toBe("user_owner42");
  });
});

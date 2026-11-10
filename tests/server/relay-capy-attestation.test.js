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
const { resolveRelayTrust } = require("../../lib/plugin/relay-guard/trust");
const { createCapyIssuer } = require("./helpers/capy-oidc-fixture");

// Relay trust v2 PR3 (GST-2090): a Capy machine proves which thread it is
// with its Capy OIDC token, exchanged for an access token (RFC 7523), and a
// Capy grant names the project and owner whose threads act for the owner.
const kPublic = "https://box.relay.test";
const kResource = kPublic + "/relay/mcp";
const kAudience = "https://box.relay.test/relay";
const kWebhook = "https://api.capy.ai/webhooks/automations/tok_abcdefghijklmnop";
const kJwtBearer = "urn:ietf:params:oauth:grant-type:jwt-bearer";
const kMinute = 60 * 1000;

const createFakeEngine = () => {
  const agents = new Map([["wintermute", "at_live_box"]]);
  const sent = [];
  let nextId = 1000;
  const byToken = (token) => [...agents.entries()].find(([, value]) => value === token)?.[0];
  const unauthorized = () => Object.assign(new Error("401"), { engineStatus: 401 });
  return {
    sent,
    registerAgent: async (key, name) => {
      const token = "at_live_" + crypto.randomBytes(6).toString("hex");
      agents.set(name, token);
      return { name, token };
    },
    deleteAgent: async (key, name) => agents.delete(name),
    inbox: async (token) => {
      if (!byToken(token)) throw unauthorized();
      return { unread: [] };
    },
    sendDm: async (token, to, text, metadata) => {
      const from = byToken(token);
      if (!from) throw unauthorized();
      const id = String(nextId++);
      sent.push({ id, from, to, text, metadata });
      return { id, conversation_id: "conv-1" };
    },
    dmConversations: async () => [],
    dmMessages: async () => [],
    listAgents: async () => [...agents.keys()].map((name) => ({ name, status: "active" })),
    getMessage: async (key, id) => ({ id, agent_name: "wintermute", text: "x" }),
  };
};

const setup = ({ org = "org_garry", audience = kAudience } = {}) => {
  const clock = { now: Date.now() };
  const now = () => clock.now;
  const issuer = createCapyIssuer({ org: "org_garry", audience: kAudience, now });
  issuer.rotate("k1");
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-attest-"));
  const paths = relayPaths(rootDir);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const engine = createFakeEngine();
  const relayService = {
    config: readRelayConfig({ env: { ALPHACLAW_RELAY_CAPY_ORG: org, ALPHACLAW_RELAY_CAPY_AUDIENCE: audience } }),
    paths,
    engine,
    isReady: () => true,
    getAuth: () => ({ workspaceKey: "rk_live_workspace", agentName: "wintermute", agentToken: "at_live_box" }),
    demoteSender: vi.fn(),
  };
  const logger = { log: () => {}, warn: () => {} };
  const relayRemote = createRelayRemote({ relayService, getPublicUrl: () => kPublic, now, logger, fetchImpl: issuer.fetchImpl, wakeOptions: { lookup: async () => [{ address: "34.120.1.1", family: 4 }], requestImpl: () => ({ on() {}, end() {}, destroy() {} }) } });
  const app = express();
  app.use(express.json());
  registerRelayRemoteRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => next(),
    resolveRequestIdentity: () => ({ kind: "legacy", role: "admin" }),
    relayRemote,
    logger,
  });
  const exchange = (assertion, resource = kResource) => request(app).post("/relay/oauth/token").type("form").send({ grant_type: kJwtBearer, assertion, resource });
  const tool = async (accessToken, name, args) => {
    const res = await request(app)
      .post("/relay/mcp")
      .set("Authorization", "Bearer " + accessToken)
      .set("Accept", "application/json, text/event-stream")
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    if (res.status !== 200) return { httpStatus: res.status };
    return JSON.parse(res.body.result.content[0].text);
  };
  const grant = (body = {}) => request(app).post("/api/relay/remote/grants").send({ kind: "capy", project: "proj_1", user: "user_1", ...body });
  const access = async (claims) => (await exchange(issuer.sign(claims))).body.access_token;
  return {
    app,
    clock,
    issuer,
    engine,
    relayRemote,
    relayService,
    rootDir,
    exchange,
    tool,
    grant,
    access,
    store: () => relayRemote.ensureOpen().store,
    cleanup: () => {
      relayRemote.stop();
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
};

describe("relay Capy attestation: the token exchange", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("is advertised, and needs a live Capy grant for the token's project and owner", async () => {
    ctx = setup();
    const meta = await request(ctx.app).get("/.well-known/oauth-authorization-server");
    expect(meta.body.grant_types_supported).toContain(kJwtBearer);
    const token = ctx.issuer.sign();
    const refused = await ctx.exchange(token);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: "invalid_grant" });
    expect(refused.body.error_description).toMatch(/^no_grant:/);
    expect((await ctx.grant()).body.grant).toMatchObject({ kind: "capy", project: "proj_1", tier: "delegate" });
    expect((await ctx.grant()).status).toBe(400);
    const ok = await ctx.exchange(token);
    expect(ok.status).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(ok.body).toMatchObject({ token_type: "bearer" });
    expect(ok.body.refresh_token).toBeUndefined();
    expect(ok.body.expires_in).toBeLessThanOrEqual(3600);
    expect((await ctx.exchange(ctx.issuer.sign({ user: "user_2" }))).body.error_description).toMatch(/^no_grant:/);
    expect((await ctx.exchange(ctx.issuer.sign({ project: "proj_2", sub: "org/org_garry/project/proj_2/thread/ALPH-85" }))).body.error_description).toMatch(/^no_grant:/);
    expect(JSON.stringify(ctx.store().recentAudit(20))).not.toContain(token.slice(-40));
  });

  it("caps the access token at the Capy token's exp, and refuses a token from the wrong issuer, audience or signer", async () => {
    ctx = setup();
    await ctx.grant();
    const exp = Math.floor(ctx.clock.now / 1000) + 5 * 60;
    expect((await ctx.exchange(ctx.issuer.sign({ exp }))).body.expires_in).toBeLessThanOrEqual(300);
    expect((await ctx.exchange(ctx.issuer.sign({ iss: "https://api.capy.ai/oidc/orgs/org_evil" }))).body.error_description).toMatch(/^attestation_invalid:/);
    expect((await ctx.exchange(ctx.issuer.sign({ aud: "https://other.example" }))).body.error_description).toMatch(/^attestation_invalid:/);
    expect((await ctx.exchange(ctx.issuer.sign({ exp: Math.floor(ctx.clock.now / 1000) - 300 }))).body.error_description).toMatch(/^attestation_stale:/);
    const forged = ctx.issuer.sign().split(".");
    forged[1] = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(forged[1], "base64url")), thread: "ALPH-1" })).toString("base64url");
    expect((await ctx.exchange(forged.join("."))).body.error_description).toMatch(/^attestation_invalid:/);
  });

  it("an unchanged token exchanges again, three times in a row and twice at once; a foreign resource is refused", async () => {
    ctx = setup();
    await ctx.grant();
    const token = ctx.issuer.sign();
    for (let n = 0; n < 3; n += 1) expect((await ctx.exchange(token)).status).toBe(200);
    const both = await Promise.all([ctx.exchange(token), ctx.exchange(token)]);
    expect(both.map((res) => res.status)).toEqual([200, 200]);
    expect(new Set(both.map((res) => res.body.access_token)).size).toBe(2);
    const foreign = await ctx.exchange(token, "https://box.tailnet.ts.net/relay/mcp");
    expect(foreign.status).toBe(400);
    expect(foreign.body.error).toBe("invalid_target");
  });

  it("refuses the same token id once another grant's client used it", async () => {
    ctx = setup();
    await ctx.grant();
    const token = ctx.issuer.sign({ jti: "jti-shared" });
    expect((await ctx.exchange(token)).status).toBe(200);
    const live = ctx.store().grants.liveCapy({ project: "proj_1", user: "user_1" })[0];
    ctx.relayRemote.revokeGrant({ id: live.id, actor: "legacy" });
    await ctx.grant();
    const again = await ctx.exchange(token);
    expect(again.status).toBe(400);
    expect(again.body.error_description).toMatch(/^attestation_reused:/);
  });
});

describe("relay Capy attestation: bound threads", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("binds as the token's thread, stamps the attestation and sends as the owner's delegate", async () => {
    ctx = setup();
    await ctx.grant();
    const token = await ctx.access({ thread: "ALPH-85", sub: "org/org_garry/project/proj_1/thread/ALPH-85", machine: "machine_a" });
    expect(await ctx.tool(token, "relay_bind", { thread_id: "ALPH-99", webhook_url: kWebhook })).toMatchObject({ error: "attestation_mismatch" });
    const bound = await ctx.tool(token, "relay_bind", { webhook_url: kWebhook });
    expect(bound).toMatchObject({ agent: expect.stringMatching(/^capy-[a-f0-9]{12}$/), thread_id: "ALPH-85" });
    const binding = ctx.store().bindings.get(bound.agent);
    expect(binding).toMatchObject({ threadId: "ALPH-85", threadCode: "ALPH-85", attestedClaims: expect.objectContaining({ machine: "machine_a", project: "proj_1" }) });
    expect(binding.attestedUntil).toBeGreaterThan(ctx.clock.now);
    const sent = await ctx.tool(token, "relay_send", { as: bound.agent, capability: bound.capability, to: "wintermute", text: "hi" });
    expect(sent).toMatchObject({ trust: "delegate", reason: "grant" });
    expect(ctx.engine.sent[0].metadata).toMatchObject({ relay_attested_until: binding.attestedUntil });
    expect(ctx.relayRemote.resolveDelegate(bound.agent)).toMatchObject({ trust: "delegate", attestationRequired: true });
  });

  it("one token id binds one binding; on that binding it is good five times over 40 minutes", async () => {
    ctx = setup();
    await ctx.grant();
    const token = await ctx.access({ exp: Math.floor(ctx.clock.now / 1000) + 3600 });
    const bound = await ctx.tool(token, "relay_bind", { webhook_url: kWebhook });
    for (let n = 0; n < 5; n += 1) {
      ctx.clock.now += 8 * kMinute;
      const call = n % 2 ? ["relay_inbox", { as: bound.agent, capability: bound.capability }] : ["relay_bind", { webhook_url: kWebhook, capability: bound.capability }];
      expect((await ctx.tool(token, ...call)).error).toBeUndefined();
    }
    expect(await ctx.tool(token, "relay_unbind", { as: bound.agent, capability: bound.capability })).toMatchObject({ unbound: true });
    expect(await ctx.tool(token, "relay_bind", { webhook_url: kWebhook })).toMatchObject({ error: "attestation_reused" });
    const next = await ctx.access();
    expect((await ctx.tool(next, "relay_bind", { webhook_url: kWebhook })).agent).toMatch(/^capy-/);
  });

  it("another thread's token cannot use the binding, while a replaced machine of the same thread can", async () => {
    ctx = setup();
    await ctx.grant();
    const bound = await ctx.tool(await ctx.access(), "relay_bind", { webhook_url: kWebhook });
    const other = await ctx.access({ thread: "ALPH-90", sub: "org/org_garry/project/proj_1/thread/ALPH-90" });
    expect(await ctx.tool(other, "relay_inbox", { as: bound.agent, capability: bound.capability })).toMatchObject({ error: "attestation_mismatch" });
    const replaced = await ctx.access({ machine: "machine_new" });
    expect(await ctx.tool(replaced, "relay_send", { as: bound.agent, capability: bound.capability, to: "wintermute", text: "after a machine swap" })).toMatchObject({ trust: "delegate" });
    expect(ctx.store().bindings.get(bound.agent).attestedClaims.machine).toBe("machine_new");
  });

  it("a run accepted with 5 minutes of token left stays the delegate after the token expires", async () => {
    ctx = setup();
    await ctx.grant();
    const token = await ctx.access({ exp: Math.floor(ctx.clock.now / 1000) + 5 * 60 });
    const bound = await ctx.tool(token, "relay_bind", { webhook_url: kWebhook });
    expect(await ctx.tool(token, "relay_send", { as: bound.agent, capability: bound.capability, to: "wintermute", text: "long job" })).toMatchObject({ trust: "delegate" });
    ctx.clock.now += 40 * kMinute;
    expect(ctx.relayRemote.resolveDelegate(bound.agent)).toMatchObject({ trust: "delegate", reason: "grant" });
    expect(ctx.relayService.demoteSender).not.toHaveBeenCalled();
    expect((await ctx.tool(token, "relay_inbox", { as: bound.agent, capability: bound.capability })).httpStatus).toBe(401);
  });

  it("the guard sees a Capy grant's binding as the delegate, and revoking the grant ends it", async () => {
    ctx = setup();
    await ctx.grant();
    const bound = await ctx.tool(await ctx.access(), "relay_bind", { webhook_url: kWebhook });
    const grant = ctx.store().grants.liveCapy({ project: "proj_1", user: "user_1" })[0];
    const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
    const bridge = openBridgeStore({ dbPath: path.join(ctx.rootDir, "relay", "bridge.db") });
    bridge.insert({ messageId: "m1", sender: bound.agent, conversationId: "c", threadRoot: "m1", sessionKey: "agent:main:relay-" + bound.agent, state: "queued" });
    bridge.update("m1", { state: "dispatched", runId: "relay-m1", trust: "delegate", grantId: grant.id });
    const check = () => resolveRelayTrust({ rootDir: ctx.rootDir, sessionKey: "agent:main:relay-" + bound.agent, runId: "relay-m1" });
    expect(check()).toMatchObject({ tier: "delegate" });
    const token = await ctx.access();
    ctx.relayRemote.revokeGrant({ id: grant.id, actor: "legacy" });
    expect(check().tier).toBe("peer");
    expect(ctx.relayService.demoteSender).toHaveBeenCalledWith(bound.agent, "grant_revoked");
    expect(ctx.store().bindings.get(bound.agent)).toBeNull();
    expect((await ctx.exchange(ctx.issuer.sign())).body.error_description).toMatch(/^no_grant:/);
    expect((await ctx.tool(token, "relay_inbox", { as: bound.agent, capability: bound.capability })).httpStatus).toBe(401);
    bridge.close();
  });

  it("revoking a Capy grant's connection revokes the grant, so a new grant can be added", async () => {
    ctx = setup();
    await ctx.grant();
    const grant = ctx.store().grants.liveCapy({ project: "proj_1", user: "user_1" })[0];
    ctx.relayRemote.revokeClient({ clientId: grant.principal.clientId, actor: "legacy" });
    expect(ctx.store().grants.get(grant.id).revokedAt).toBeTruthy();
    expect((await ctx.grant()).status).toBe(200);
  });
});

describe("relay Capy attestation: handoff", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());
  const thread = (code, extra = {}) => ({ thread: code, sub: "org/org_garry/project/proj_1/thread/" + code, ...extra });

  it("an attested holder hands off with no code, and only the named successor thread claims with its own token", async () => {
    ctx = setup();
    await ctx.grant();
    const holder = await ctx.access(thread("ALPH-85"));
    const bound = await ctx.tool(holder, "relay_bind", { webhook_url: kWebhook });
    const handed = await ctx.tool(holder, "relay_handoff", { as: bound.agent, capability: bound.capability, successor_thread: "ALPH-99" });
    expect(handed).toMatchObject({ agent: bound.agent, successor_thread: "ALPH-99" });
    expect(handed.handoff_code).toBeUndefined();
    const stranger = await ctx.access(thread("ALPH-100"));
    expect(await ctx.tool(stranger, "relay_claim", { as: bound.agent, webhook_url: kWebhook })).toMatchObject({ error: "handoff_invalid" });
    const successor = await ctx.access(thread("ALPH-99"));
    const claimed = await ctx.tool(successor, "relay_claim", { as: bound.agent, webhook_url: kWebhook });
    expect(claimed).toMatchObject({ agent: bound.agent, generation: 2, thread_id: "ALPH-99" });
    expect(ctx.store().bindings.get(bound.agent)).toMatchObject({ threadCode: "ALPH-99", threadId: "ALPH-99", generation: 2 });
    expect(await ctx.tool(holder, "relay_inbox", { as: bound.agent, capability: bound.capability })).toMatchObject({ error: "binding_capability_invalid" });
    expect(await ctx.tool(successor, "relay_send", { as: bound.agent, capability: claimed.capability, to: "wintermute", text: "taking over" })).toMatchObject({ trust: "delegate" });
  });

  it("a binding made through the Capy connector moves to an attested machine with its code", async () => {
    ctx = setup();
    await ctx.grant();
    const store = ctx.store();
    store.clients.insert({ client_id: "connector", client_name: "Capy", redirect_uris: ["https://capy.ai/web/callbacks/mcp"] });
    store.clients.markConsented("connector");
    store.bindings.upsert({ agent: "capy-25cf4e98b5b6", threadId: "jam_OLD", clientId: "connector", webhookUrl: kWebhook, until: ctx.clock.now + 24 * 60 * kMinute, capabilityHash: require("../../lib/server/relay/remote-store").sha256("arcap_old"), agentToken: "at_live_box" });
    const tools = ctx.relayRemote.ensureOpen().tools;
    const handed = JSON.parse((await tools.call({ clientId: "connector", name: "relay_handoff", args: { as: "capy-25cf4e98b5b6", capability: "arcap_old", successor_thread: "ALPH-85" } })).content[0].text);
    expect(handed.handoff_code).toMatch(/^arho_/);
    const machine = await ctx.access(thread("ALPH-85"));
    expect(await ctx.tool(machine, "relay_claim", { as: "capy-25cf4e98b5b6", webhook_url: kWebhook })).toMatchObject({ error: "handoff_invalid" });
    const claimed = await ctx.tool(machine, "relay_claim", { as: "capy-25cf4e98b5b6", handoff_code: handed.handoff_code, webhook_url: kWebhook });
    expect(claimed).toMatchObject({ generation: 2, thread_id: "ALPH-85" });
    expect(store.bindings.get("capy-25cf4e98b5b6")).toMatchObject({ threadCode: "ALPH-85", clientId: expect.stringMatching(/^capy_/) });
    expect(ctx.relayRemote.resolveDelegate("capy-25cf4e98b5b6")).toMatchObject({ trust: "delegate", attestationRequired: true });
  });
});

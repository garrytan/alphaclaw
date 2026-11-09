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

const kPublic = "https://box.relay.test";
const kRedirect = "https://capy.ai/web/callbacks/mcp";
const kWebhook = "https://api.capy.ai/webhooks/automations/tok_abcdefghijklmnop";

const createFakeEngine = () => {
  const agents = new Map([["wintermute", "at_live_box"]]);
  const sent = [];
  let nextId = 1000;
  const byToken = (token) => [...agents.entries()].find(([, value]) => value === token)?.[0];
  const unauthorized = () => Object.assign(new Error("401"), { engineStatus: 401 });
  return {
    agents,
    sent,
    registerAgent: async (key, name) => {
      if (agents.has(name)) throw Object.assign(new Error("409"), { engineStatus: 409 });
      const token = "at_live_" + crypto.randomBytes(6).toString("hex");
      agents.set(name, token);
      return { name, token };
    },
    deleteAgent: async (key, name) => agents.delete(name),
    inbox: async (token) => {
      if (!byToken(token)) throw unauthorized();
      return { unread: [], as: byToken(token) };
    },
    sendDm: async (token, to, text) => {
      const from = byToken(token);
      if (!from) throw unauthorized();
      if (!agents.has(to)) throw Object.assign(new Error("404 agent"), { engineStatus: 404 });
      const id = String(nextId++);
      sent.push({ id, from, to, text });
      return { id, conversation_id: "conv-" + [from, to].sort().join("-") };
    },
    reply: async (token, id, text) => ({ id: String(nextId++), in_reply_to: id, text }),
    dmConversations: async () => [],
    dmMessages: async () => [],
    listAgents: async () => [...agents.keys()].map((name) => ({ name, status: "active" })),
    presence: async () => [],
    getMessage: async (key, id) => ({ id, agent_name: "wintermute", text: "the answer", thread_id: "77", metadata: { relay_status: "answered" } }),
  };
};

const setup = ({ env = {}, publicUrl = kPublic, ready = true } = {}) => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-remote-"));
  const paths = relayPaths(rootDir);
  fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
  const engine = createFakeEngine();
  const relayService = {
    config: readRelayConfig({ env }),
    paths,
    engine,
    isReady: () => ready,
    getAuth: () => ({ workspaceKey: "rk_live_workspace", agentName: "wintermute", agentToken: "at_live_box" }),
  };
  const posts = [];
  const lookup = vi.fn(async () => [{ address: "34.120.1.1", family: 4 }]);
  const requestImpl = (options, onResponse) => {
    const { EventEmitter } = require("events");
    const req = new EventEmitter();
    req.destroy = () => {};
    req.end = (body) => {
      posts.push({ options, body: JSON.parse(body) });
      const res = new EventEmitter();
      res.statusCode = posts.statusFor ? posts.statusFor(options) : 202;
      res.resume = () => {};
      setImmediate(() => {
        onResponse(res);
        res.emit("end");
      });
    };
    return req;
  };
  const logger = { log: () => {}, warn: () => {} };
  const relayRemote = createRelayRemote({ relayService, getPublicUrl: () => publicUrl, logger, wakeOptions: { lookup, requestImpl } });
  let identity = { kind: "legacy", role: "admin" };
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json());
  registerRelayRemoteRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    requireAdmin: (req, res, next) => (identity?.role === "admin" ? next() : res.status(403).json({ code: "admin_required" })),
    resolveRequestIdentity: () => identity,
    relayRemote,
    logger,
  });
  return {
    app,
    engine,
    relayRemote,
    posts,
    lookup,
    rootDir,
    setIdentity: (value) => {
      identity = value;
    },
    cleanup: () => {
      relayRemote.stop();
      fs.rmSync(rootDir, { recursive: true, force: true });
    },
  };
};

const pkce = () => {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};

const register = (app, body = {}) =>
  request(app)
    .post("/relay/oauth/register")
    .send({ client_name: "Capy", redirect_uris: [kRedirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], ...body });

const allowConnection = (ctx) => request(ctx.app).post("/api/relay/remote/consent-window");

const connect = async (ctx) => {
  const allowed = await allowConnection(ctx);
  const client = (await register(ctx.app)).body;
  const { verifier, challenge } = pkce();
  const authorize = await request(ctx.app)
    .get("/relay/oauth/authorize")
    .query({ client_id: client.client_id, redirect_uri: kRedirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s1", resource: kPublic + "/relay/mcp" });
  const consentUrl = new URL(authorize.headers.location, kPublic);
  const page = await request(ctx.app).get(consentUrl.pathname + consentUrl.search);
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)[1];
  const requestId = consentUrl.searchParams.get("request");
  const approved = await request(ctx.app)
    .post("/relay/oauth/consent")
    .set("Origin", kPublic)
    .type("form")
    .send({ request: requestId, csrf, decision: "approve", consent_code: allowed.body.code });
  const code = new URL(approved.headers.location).searchParams.get("code");
  const token = await request(ctx.app)
    .post("/relay/oauth/token")
    .type("form")
    .send({ grant_type: "authorization_code", client_id: client.client_id, code, code_verifier: verifier, redirect_uri: kRedirect, resource: kPublic + "/relay/mcp" });
  return { client, authorize, page, approved, token: token.body, tokenRes: token };
};

let rpcId = 1;
const mcp = (app, accessToken, method, params = {}) =>
  request(app)
    .post("/relay/mcp")
    .set("Authorization", "Bearer " + accessToken)
    .set("Accept", "application/json, text/event-stream")
    .send({ jsonrpc: "2.0", id: rpcId++, method, params });
const callTool = async (app, accessToken, name, args) => {
  const res = await mcp(app, accessToken, "tools/call", { name, arguments: args });
  const result = res.body.result;
  return { res, result, data: JSON.parse(result.content[0].text) };
};

describe("relay remote: OAuth and the /relay/mcp endpoint", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("serves RFC 8414 and RFC 9728 metadata unauthenticated, from the configured public URL only", async () => {
    ctx = setup();
    const as = await request(ctx.app).get("/.well-known/oauth-authorization-server").set("Host", "evil.test");
    expect(as.status).toBe(200);
    expect(as.body).toMatchObject({
      issuer: kPublic,
      authorization_endpoint: kPublic + "/relay/oauth/authorize",
      token_endpoint: kPublic + "/relay/oauth/token",
      registration_endpoint: kPublic + "/relay/oauth/register",
      code_challenge_methods_supported: ["S256"],
    });
    const prm = await request(ctx.app).get("/.well-known/oauth-protected-resource/relay/mcp");
    expect(prm.body).toMatchObject({ resource: kPublic + "/relay/mcp", authorization_servers: [kPublic] });
    const unauth = await request(ctx.app).post("/relay/mcp").send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(unauth.status).toBe(401);
    expect(unauth.headers["www-authenticate"]).toContain('resource_metadata="' + kPublic + '/.well-known/oauth-protected-resource/relay/mcp"');
  });

  it("is off (404) with ALPHACLAW_RELAY_REMOTE=off, and names the fix without an https public URL", async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_REMOTE: "off" } });
    expect((await request(ctx.app).get("/.well-known/oauth-authorization-server")).status).toBe(404);
    expect((await request(ctx.app).post("/relay/mcp").send({})).body.code).toBe("remote_disabled");
    ctx.cleanup();
    ctx = setup({ publicUrl: "http://localhost:3000" });
    const res = await request(ctx.app).get("/.well-known/oauth-authorization-server");
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "public_url_missing" });
  });

  it("refuses dynamic registration with a redirect_uri off the allowlist", async () => {
    ctx = setup();
    const res = await register(ctx.app, { redirect_uris: ["https://attacker.test/cb"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_client_metadata");
    const extended = setup({ env: { ALPHACLAW_RELAY_OAUTH_REDIRECT_URIS: "https://partner.test/cb" } });
    expect((await register(extended.app, { redirect_uris: ["https://partner.test/cb"] })).status).toBe(201);
    extended.cleanup();
  });

  it("runs the whole flow: register, authorize, admin consent with CSRF, PKCE token, MCP tools", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    expect(flow.authorize.status).toBe(302);
    expect(flow.authorize.headers.location).toMatch(/^\/relay\/oauth\/consent\?request=/);
    expect(flow.page.status).toBe(200);
    expect(flow.page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(flow.page.headers["content-security-policy"]).toContain("form-action 'self' https://capy.ai");
    expect(flow.page.headers["x-frame-options"]).toBe("DENY");
    expect(flow.page.text).toContain("https://capy.ai");
    expect(flow.approved.status).toBe(303);
    expect(new URL(flow.approved.headers.location).searchParams.get("state")).toBe("s1");
    expect(flow.tokenRes.status).toBe(200);
    expect(flow.token).toMatchObject({ token_type: "bearer", expires_in: 3600, scope: "relay" });
    expect(flow.token.access_token).toMatch(/^arat_/);

    const list = await mcp(ctx.app, flow.token.access_token, "tools/list");
    expect(list.body.result.tools.map((tool) => tool.name)).toEqual([
      "relay_bind",
      "relay_unbind",
      "relay_send",
      "relay_reply",
      "relay_inbox",
      "relay_history",
      "relay_handoff",
      "relay_claim",
      "relay_result",
      "relay_agents",
    ]);

    const bound = await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_01ABC", webhook_url: kWebhook });
    expect(bound.result.isError).toBeFalsy();
    expect(bound.data.agent).toMatch(/^capy-[0-9a-f]{12}$/);
    expect(bound.data.capability).toMatch(/^arcap_/);
    const sent = await callTool(ctx.app, flow.token.access_token, "relay_send", { as: bound.data.agent, capability: bound.data.capability, to: "wintermute", text: "status?" });
    expect(sent.result.isError).toBeFalsy();
    expect(ctx.engine.sent).toEqual([expect.objectContaining({ from: bound.data.agent, to: "wintermute", text: "status?" })]);

    const status = ctx.relayRemote.getStatus();
    expect(status.clients[0]).toMatchObject({ name: "Capy", redirectHosts: ["capy.ai"] });
    expect(status.bindings[0]).toMatchObject({ agent: bound.data.agent, threadId: "jam_01ABC", webhookHost: "api.capy.ai" });
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain(flow.token.access_token);
    expect(serialized).not.toContain(bound.data.capability);
    expect(serialized).not.toContain(kWebhook);
    expect(serialized).not.toMatch(/at_live_/);
    expect(status.audit.map((row) => row.event)).toEqual(expect.arrayContaining(["client_registered", "consent_granted", "token_issued", "binding_created"]));
  });

  it("consent needs an admin session: no session goes to login with a safe next, a member is refused", async () => {
    ctx = setup();
    const client = (await register(ctx.app)).body;
    const { challenge } = pkce();
    const authorize = await request(ctx.app)
      .get("/relay/oauth/authorize")
      .query({ client_id: client.client_id, redirect_uri: kRedirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256" });
    ctx.setIdentity(null);
    const anonymous = await request(ctx.app).get(authorize.headers.location);
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.location).toMatch(/^\/login\.html\?next=%2Frelay%2Foauth%2Fconsent%3Frequest%3D/);
    ctx.setIdentity({ kind: "member", memberId: "m1", role: "member" });
    expect((await request(ctx.app).get(authorize.headers.location)).status).toBe(403);
  });

  it("refuses a consent post with a bad CSRF token or from another origin, and denies with access_denied", async () => {
    ctx = setup();
    const client = (await register(ctx.app)).body;
    const { challenge } = pkce();
    const start = async () => {
      const authorize = await request(ctx.app)
        .get("/relay/oauth/authorize")
        .query({ client_id: client.client_id, redirect_uri: kRedirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "z" });
      const url = new URL(authorize.headers.location, kPublic);
      const page = await request(ctx.app).get(url.pathname + url.search);
      return { request: url.searchParams.get("request"), csrf: /name="csrf" value="([^"]+)"/.exec(page.text)[1] };
    };
    await allowConnection(ctx);
    const first = await start();
    expect((await request(ctx.app).post("/relay/oauth/consent").set("Origin", kPublic).type("form").send({ ...first, csrf: "wrong", decision: "approve" })).status).toBe(403);
    expect((await request(ctx.app).post("/relay/oauth/consent").set("Origin", "https://evil.test").type("form").send({ ...first, decision: "approve" })).status).toBe(403);
    const denied = await request(ctx.app).post("/relay/oauth/consent").set("Origin", kPublic).type("form").send({ ...first, decision: "deny" });
    expect(denied.status).toBe(303);
    expect(new URL(denied.headers.location).searchParams.get("error")).toBe("access_denied");
    const again = await request(ctx.app).post("/relay/oauth/consent").set("Origin", kPublic).type("form").send({ ...first, decision: "approve" });
    expect(again.status).toBe(403);
  });

  it("rejects a wrong PKCE verifier, a reused code and a resource that is not /relay/mcp", async () => {
    ctx = setup();
    const client = (await register(ctx.app)).body;
    const { challenge } = pkce();
    const wrongResource = await request(ctx.app)
      .get("/relay/oauth/authorize")
      .query({ client_id: client.client_id, redirect_uri: kRedirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", resource: "https://other.test/mcp" });
    expect(new URL(wrongResource.headers.location).searchParams.get("error")).toBe("invalid_target");

    const flow = await connect(ctx);
    const code = new URL(flow.approved.headers.location).searchParams.get("code");
    const reuse = await request(ctx.app).post("/relay/oauth/token").type("form").send({ grant_type: "authorization_code", client_id: flow.client.client_id, code, code_verifier: "x".repeat(43), redirect_uri: kRedirect });
    expect(reuse.status).toBe(400);
    expect(reuse.body.error).toBe("invalid_grant");
  });

  it("rotates refresh tokens, and a replayed refresh token revokes the whole family", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const refresh = (token) => request(ctx.app).post("/relay/oauth/token").type("form").send({ grant_type: "refresh_token", client_id: flow.client.client_id, refresh_token: token });
    const second = await refresh(flow.token.refresh_token);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(flow.token.refresh_token);
    expect((await mcp(ctx.app, second.body.access_token, "tools/list")).status).toBe(200);
    const replay = await refresh(flow.token.refresh_token);
    expect(replay.status).toBe(400);
    expect((await mcp(ctx.app, second.body.access_token, "tools/list")).status).toBe(401);
    expect((await refresh(second.body.refresh_token)).status).toBe(400);
    expect(ctx.relayRemote.getStatus().audit.map((row) => row.event)).toContain("refresh_replay");
  });

  it("revoking a client on the Relay page kills its tokens and removes its bindings; humans only", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const boundX = (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_X", webhook_url: kWebhook })).data;
    ctx.setIdentity({ kind: "member", memberId: "m1", role: "member" });
    expect((await request(ctx.app).post("/api/relay/remote/clients/" + flow.client.client_id + "/revoke")).status).toBe(403);
    ctx.setIdentity({ kind: "legacy", role: "admin" });
    const revoked = await request(ctx.app).post("/api/relay/remote/clients/" + flow.client.client_id + "/revoke");
    expect(revoked.body).toMatchObject({ ok: true, bindingsRemoved: [boundX.agent] });
    expect((await mcp(ctx.app, flow.token.access_token, "tools/list")).status).toBe(401);
  });
});

describe("relay remote: bindings and capabilities", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("acting as an agent needs its binding's capability and the same connection; rebinding needs the capability", async () => {
    ctx = setup();
    const a = await connect(ctx);
    const b = await connect(ctx);
    const bound = (await callTool(ctx.app, a.token.access_token, "relay_bind", { thread_id: "jam_A", webhook_url: kWebhook })).data;
    const wrongCap = await callTool(ctx.app, a.token.access_token, "relay_inbox", { as: bound.agent, capability: "arcap_nope" });
    expect(wrongCap.result.isError).toBe(true);
    expect(wrongCap.data.error).toBe("binding_capability_invalid");
    const otherClient = await callTool(ctx.app, b.token.access_token, "relay_inbox", { as: bound.agent, capability: bound.capability });
    expect(otherClient.data.error).toBe("prefix_denied");
    const notCapy = await callTool(ctx.app, a.token.access_token, "relay_send", { as: "wintermute", capability: "x", to: "capy-000000000000", text: "hi" });
    expect(notCapy.data.error).toBe("prefix_denied");
    const unbound = await callTool(ctx.app, a.token.access_token, "relay_inbox", { as: "capy-aaaaaaaaaaaa", capability: "x" });
    expect(unbound.data.error).toBe("not_bound");

    const takeover = await callTool(ctx.app, a.token.access_token, "relay_bind", { thread_id: "jam_A", webhook_url: "https://api.capy.ai/webhooks/automations/attacker" });
    expect(takeover.data.error).toBe("binding_capability_invalid");
    const otherConnection = await callTool(ctx.app, b.token.access_token, "relay_bind", { thread_id: "jam_A", webhook_url: "https://api.capy.ai/webhooks/automations/other" });
    expect(otherConnection.result.isError).toBeFalsy();
    expect(otherConnection.data.agent).not.toBe(bound.agent);
    const renewed = await callTool(ctx.app, a.token.access_token, "relay_bind", { thread_id: "jam_A", webhook_url: kWebhook, capability: bound.capability });
    expect(renewed.result.isError).toBeFalsy();
    expect(renewed.data).toMatchObject({ agent: bound.agent, capability: bound.capability });
    const mine = ctx.relayRemote.getStatus().bindings.find((row) => row.agent === bound.agent);
    expect(mine).toMatchObject({ clientId: a.client.client_id, webhookHost: "api.capy.ai" });
  });

  it("refuses wake URLs that are not https:443 on an allowed host", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    for (const url of [
      "http://api.capy.ai/webhooks/x",
      "https://api.capy.ai:8443/webhooks/x",
      ["https://user", "pw@api.capy.ai/webhooks/x"].join(":"),
      "https://169.254.169.254/latest/meta-data",
      "https://attacker.test/hook",
      "not a url",
    ]) {
      const res = await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_W", webhook_url: url });
      expect(res.data.error, url).toBe("wake_url_refused");
    }
  });
});

describe("relay remote: wake delivery", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  const bindOne = async () => {
    const flow = await connect(ctx);
    return (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_W1", webhook_url: kWebhook })).data;
  };

  it("posts an untrusted wake, pinned to the checked address with SNI for the host, for a message to a bound agent", async () => {
    ctx = setup();
    const bound = await bindOne();
    ctx.relayRemote.onRelayMessage({ kind: "thread.reply", messageId: "501", sender: "wintermute", recipient: bound.agent, threadRoot: "77", text: "the answer" });
    await vi.waitFor(() => expect(ctx.posts).toHaveLength(1));
    const [post] = ctx.posts;
    expect(post.options).toMatchObject({ hostname: "api.capy.ai", port: 443, method: "POST", path: "/webhooks/automations/tok_abcdefghijklmnop" });
    expect(post.body).toMatchObject({ source: "alphaclaw-relay", status: "answered", from: "wintermute", to: bound.agent, message_id: "501", untrusted: true, text: "the answer" });
    const pinned = await new Promise((resolve) => post.options.lookup("api.capy.ai", {}, (err, address) => resolve(address)));
    expect(pinned).toBe("34.120.1.1");
    ctx.relayRemote.onRelayMessage({ kind: "thread.reply", messageId: "501", sender: "wintermute", recipient: bound.agent, threadRoot: "77", text: "dup" });
    ctx.relayRemote.onRelayMessage({ kind: "dm.received", messageId: "502", sender: "wintermute", recipient: "capy-ffffffffffff", threadRoot: "502", text: "nobody" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.posts).toHaveLength(1);
    await vi.waitFor(() => expect(ctx.relayRemote.getStatus().bindings[0].lastWakeStatus).toBe("delivered"));
  });

  it("never posts when the host resolves to a private address, and marks a binding dead on 410", async () => {
    ctx = setup();
    const bound = await bindOne();
    ctx.lookup.mockResolvedValueOnce([{ address: "10.0.0.7", family: 4 }]);
    ctx.relayRemote.onRelayMessage({ kind: "dm.received", messageId: "601", sender: "wintermute", recipient: bound.agent, threadRoot: "601", text: "x" });
    await vi.waitFor(() => expect(ctx.relayRemote.getStatus().bindings[0].lastWakeStatus).toBe("refused"));
    expect(ctx.posts).toHaveLength(0);
    ctx.posts.statusFor = () => 410;
    ctx.relayRemote.onRelayMessage({ kind: "dm.received", messageId: "602", sender: "wintermute", recipient: bound.agent, threadRoot: "602", text: "y" });
    await vi.waitFor(() => expect(ctx.relayRemote.getStatus().bindings[0].deadAt).not.toBeNull());
    expect(ctx.relayRemote.getStatus().audit.map((row) => row.event)).toContain("binding_dead");
  });
});


describe("relay remote: ship review fixes (ALPH-63)", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  const startConsent = async () => {
    const client = (await register(ctx.app)).body;
    const { challenge } = pkce();
    const authorize = await request(ctx.app)
      .get("/relay/oauth/authorize")
      .query({ client_id: client.client_id, redirect_uri: kRedirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "n" });
    const url = new URL(authorize.headers.location, kPublic);
    const page = await request(ctx.app).get(url.pathname + url.search);
    return { page, request: url.searchParams.get("request"), csrf: /name="csrf" value="([^"]+)"/.exec(page.text)[1] };
  };

  it("accepts a real browser's consent post (Origin: null, Sec-Fetch-Site: same-origin) and still refuses a cross-site one", async () => {
    ctx = setup();
    const allowed = await allowConnection(ctx);
    const first = await startConsent();
    expect(first.page.headers["referrer-policy"]).toBe("same-origin");
    expect(first.page.text).toContain("Approve only if you pressed Connect");
    const crossSite = await request(ctx.app).post("/relay/oauth/consent").set("Origin", "null").set("Sec-Fetch-Site", "cross-site").type("form").send({ request: first.request, csrf: first.csrf, decision: "approve" });
    expect(crossSite.status).toBe(403);
    const approved = await request(ctx.app).post("/relay/oauth/consent").set("Origin", "null").set("Sec-Fetch-Site", "same-origin").type("form").send({ request: first.request, csrf: first.csrf, decision: "approve", consent_code: allowed.body.code });
    expect(approved.status).toBe(303);
    expect(new URL(approved.headers.location).searchParams.get("code")).toBeTruthy();
  });

  it("a burst of anonymous registrations never locks out a new one: the oldest waiting registration makes room", async () => {
    ctx = setup();
    const ids = [];
    for (let index = 0; index < 22; index += 1) {
      const res = await register(ctx.app, { client_name: "spam " + index }).set("X-Forwarded-For", "203.0.113." + (index + 1));
      expect(res.status).toBe(201);
      ids.push(res.body.client_id);
    }
    const owner = await register(ctx.app, { client_name: "Capy" }).set("X-Forwarded-For", "198.51.100.7");
    expect(owner.status).toBe(201);
    const store = ctx.relayRemote.ensureOpen().store;
    expect(store.clients.get(ids[0])).toBeNull();
    expect(store.clients.get(owner.body.client_id)).not.toBeNull();
    expect(ctx.relayRemote.getStatus().audit.map((row) => row.event)).toContain("client_evicted");
  });

  it("never reuses an agent: after an unbind the next bind of the same thread gets a new agent", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const first = (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_R", webhook_url: kWebhook })).data;
    const unbound = await callTool(ctx.app, flow.token.access_token, "relay_unbind", { as: first.agent, capability: first.capability });
    expect(unbound.data).toMatchObject({ unbound: true });
    const second = (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_R", webhook_url: kWebhook })).data;
    expect(second.agent).toMatch(/^capy-[0-9a-f]{12}$/);
    expect(second.agent).not.toBe(first.agent);
    const asOld = await callTool(ctx.app, flow.token.access_token, "relay_inbox", { as: first.agent, capability: first.capability });
    expect(asOld.data.error).toBe("not_bound");
  });

  it("two concurrent first binds of one thread: one wins, the other must present the winner's capability", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const [one, two] = await Promise.all([
      callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_C", webhook_url: kWebhook }),
      callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_C", webhook_url: "https://api.capy.ai/webhooks/automations/second" }),
    ]);
    const outcomes = [one, two].map((call) => call.data.error || "ok").sort();
    expect(outcomes).toEqual(["binding_capability_invalid", "ok"]);
    const winner = [one, two].find((call) => !call.data.error).data;
    const inbox = await callTool(ctx.app, flow.token.access_token, "relay_inbox", { as: winner.agent, capability: winner.capability });
    expect(inbox.result.isError).toBeFalsy();
    expect(ctx.relayRemote.getStatus().bindings).toHaveLength(1);
  });

  it("a bind still registering when its client is revoked creates no binding", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    let release;
    const realRegister = ctx.engine.registerAgent;
    ctx.engine.registerAgent = async (...args) => {
      await new Promise((resolve) => { release = resolve; });
      return realRegister(...args);
    };
    const pendingBind = callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_V", webhook_url: kWebhook });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const revoked = await request(ctx.app).post("/api/relay/remote/clients/" + flow.client.client_id + "/revoke");
    expect(revoked.body.ok).toBe(true);
    release();
    const result = await pendingBind;
    expect(result.data.error).toBe("not_bound");
    expect(ctx.relayRemote.getStatus().bindings).toEqual([]);
  });

  it("waits out a DNS outage instead of refusing the wake, and never wakes a binding past its until date", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const bound = (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_D", webhook_url: kWebhook })).data;
    ctx.lookup.mockRejectedValueOnce(Object.assign(new Error("getaddrinfo EAI_AGAIN api.capy.ai"), { code: "EAI_AGAIN" }));
    await ctx.relayRemote.onRelayMessage({ kind: "dm.received", messageId: "701", sender: "wintermute", recipient: bound.agent, threadRoot: "701", text: "x" });
    await vi.waitFor(() => expect(ctx.relayRemote.getStatus().bindings[0].lastWakeStatus).toBe("retrying"));
    expect(ctx.posts).toHaveLength(0);
    const { store, wake } = ctx.relayRemote.ensureOpen();
    const binding = store.bindings.get(bound.agent);
    store.bindings.upsert({ ...binding, until: Date.now() - 1000 });
    const queued = store.wakes.due(10).find((row) => row.messageId === "701") || { id: 1, agent: bound.agent, messageId: "701", payload: {}, attempts: 1 };
    await wake._internal.deliverOne(queued);
    expect(ctx.posts).toHaveLength(0);
    expect(store.wakes.counts()).toMatchObject({ dropped: 1 });
  });

  it("coalesces wakes: while one is pending for a binding, another message does not queue a second", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const bound = (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_F", webhook_url: kWebhook })).data;
    let releaseLookup;
    ctx.lookup.mockImplementationOnce(() => new Promise((resolve) => { releaseLookup = () => resolve([{ address: "34.120.1.1", family: 4 }]); }));
    await ctx.relayRemote.onRelayMessage({ kind: "dm.received", messageId: "801", sender: "wintermute", recipient: bound.agent, threadRoot: "801", text: "one" });
    await vi.waitFor(() => expect(releaseLookup).toBeTypeOf("function"));
    for (let index = 0; index < 5; index += 1) {
      await ctx.relayRemote.onRelayMessage({ kind: "dm.received", messageId: String(802 + index), sender: "wintermute", recipient: bound.agent, threadRoot: "802", text: "flood" });
    }
    releaseLookup();
    await vi.waitFor(() => expect(ctx.posts).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.posts).toHaveLength(1);
  });

  it("uses every backoff step before giving up on a failing webhook", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const bound = (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_B", webhook_url: kWebhook })).data;
    const { store, wake } = ctx.relayRemote.ensureOpen();
    ctx.posts.statusFor = () => 503;
    store.wakes.enqueue({ agent: bound.agent, messageId: "901", payload: { text: "x" } });
    const row = store.wakes.due(10)[0];
    await wake._internal.deliverOne({ ...row, attempts: 5 });
    expect(store.wakes.counts()).toMatchObject({ pending: 1 });
    await wake._internal.deliverOne({ ...row, attempts: 6 });
    expect(store.wakes.counts()).toMatchObject({ failed: 1 });
  });

  it("opens the remote side (and its wake queue) as soon as the relay is ready", () => {
    ctx = setup();
    expect(ctx.relayRemote.getStatus).toBeTypeOf("function");
    ctx.relayRemote.onRelayReady();
    expect(fs.existsSync(path.join(ctx.rootDir, "relay", "remote.db"))).toBe(true);
  });

  it("the agent actor's view of remote connections carries no thread ids, client ids, agent names or audit details", () => {
    const domain = require("../../lib/server/admin-manifest/domains/relay");
    const op = domain.ops.find((entry) => entry.id === "relay.remote");
    const redacted = op.redactResponse({
      ok: true,
      clients: [{ clientId: "c1", name: "Capy", consentedAt: 1 }],
      bindings: [{ agent: "capy-aaaaaaaaaaaa", threadId: "jam_secret", clientId: "c1", webhookHost: "api.capy.ai", expired: false }],
      audit: [{ at: 1, event: "binding_created", clientId: "c1", agent: "capy-aaaaaaaaaaaa", detail: { by: "m1" } }],
    });
    expect(JSON.stringify(redacted)).not.toMatch(/jam_secret|c1|capy-aaaa|m1/);
    expect(redacted.bindings[0]).toMatchObject({ webhookHost: "api.capy.ai" });
    expect(redacted.audit[0]).toEqual({ at: 1, event: "binding_created" });
  });
});

describe("relay wake: absolute deadline", () => {
  it("a webhook that trickles its response forever is cut off at the deadline", async () => {
    const { EventEmitter } = require("events");
    const { postPinned } = require("../../lib/server/relay/wake");
    let destroyed = false;
    const requestImpl = (options, onResponse) => {
      const req = new EventEmitter();
      req.destroy = () => { destroyed = true; };
      req.end = () => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.resume = () => {};
        setImmediate(() => onResponse(res));
      };
      return req;
    };
    const result = await postPinned({ url: new URL(kWebhook), body: "{}", pinned: { address: "34.120.1.1", family: 4 }, timeoutMs: 50, requestImpl });
    expect(result).toMatchObject({ status: 0 });
    expect(result.error).toMatch(/timed out/);
    expect(destroyed).toBe(true);
  });
});



describe("relay remote: ship round 2 fixes (ALPH-63)", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("caps sends per OAuth client: binding new agents, or unbinding and binding again, does not reset the hourly cap", async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_HOURLY_CAP: "2" } });
    const flow = await connect(ctx);
    const token = flow.token.access_token;
    const sendAs = async (bound) => callTool(ctx.app, token, "relay_send", { as: bound.agent, capability: bound.capability, to: "wintermute", text: "hi" });
    const first = (await callTool(ctx.app, token, "relay_bind", { thread_id: "jam_A", webhook_url: kWebhook })).data;
    expect((await sendAs(first)).result.isError).toBeFalsy();
    await callTool(ctx.app, token, "relay_unbind", { as: first.agent, capability: first.capability });
    const second = (await callTool(ctx.app, token, "relay_bind", { thread_id: "jam_A", webhook_url: kWebhook })).data;
    expect((await sendAs(second)).result.isError).toBeFalsy();
    const third = (await callTool(ctx.app, token, "relay_bind", { thread_id: "jam_B", webhook_url: kWebhook })).data;
    const refused = await sendAs(third);
    expect(refused.data.error).toBe("rate_limited");
    expect(ctx.engine.sent).toHaveLength(2);
    const other = await connect(ctx);
    const theirs = (await callTool(ctx.app, other.token.access_token, "relay_bind", { thread_id: "jam_A", webhook_url: kWebhook })).data;
    const allowed = await callTool(ctx.app, other.token.access_token, "relay_send", { as: theirs.agent, capability: theirs.capability, to: "wintermute", text: "hi" });
    expect(allowed.result.isError).toBeFalsy();
  });

  it("wakes a binding at most once a minute: a message right after a delivered wake is held, not posted", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const bound = (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_M", webhook_url: kWebhook })).data;
    await ctx.relayRemote.onRelayMessage({ kind: "dm.received", messageId: "1101", sender: "wintermute", recipient: bound.agent, threadRoot: "1101", text: "one" });
    await vi.waitFor(() => expect(ctx.relayRemote.getStatus().bindings[0].lastWakeStatus).toBe("delivered"));
    for (let index = 0; index < 5; index += 1) {
      await ctx.relayRemote.onRelayMessage({ kind: "dm.received", messageId: String(1102 + index), sender: "wintermute", recipient: bound.agent, threadRoot: "1102", text: "again" });
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.posts).toHaveLength(1);
    const { store } = ctx.relayRemote.ensureOpen();
    expect(store.wakes.counts()).toMatchObject({ delivered: 1, pending: 1 });
    expect(store.wakes.due(10)).toEqual([]);
    expect(store.wakes.nextDueAt()).toBeGreaterThan(Date.now() + 50_000);
  });

  it("a failed wake enqueue rejects, so the bridge keeps its event cursor and reads the event again", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const bound = (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_E", webhook_url: kWebhook })).data;
    const opened = ctx.relayRemote.ensureOpen();
    const realEnqueue = opened.wake.enqueue;
    opened.wake.enqueue = () => {
      throw new Error("database is locked");
    };
    await expect(ctx.relayRemote.onRelayMessage({ kind: "dm.received", messageId: "1201", sender: "wintermute", recipient: bound.agent, threadRoot: "1201", text: "x" })).rejects.toThrow("database is locked");
    opened.wake.enqueue = realEnqueue;
    await ctx.relayRemote.onRelayMessage({ kind: "dm.received", messageId: "1201", sender: "wintermute", recipient: bound.agent, threadRoot: "1201", text: "x" });
    await vi.waitFor(() => expect(ctx.posts).toHaveLength(1));
  });

  it("a client revoked while the wake's DNS lookup is in flight is never posted to", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const bound = (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_L", webhook_url: kWebhook })).data;
    let releaseLookup;
    ctx.lookup.mockImplementationOnce(() => new Promise((resolve) => { releaseLookup = () => resolve([{ address: "34.120.1.1", family: 4 }]); }));
    const { store, wake } = ctx.relayRemote.ensureOpen();
    wake.stop();
    store.wakes.enqueue({ agent: bound.agent, messageId: "1301", payload: { text: "x" } });
    const delivering = wake._internal.deliverOne(store.wakes.due(10)[0]);
    await vi.waitFor(() => expect(releaseLookup).toBeTypeOf("function"));
    store.db.prepare("UPDATE oauth_clients SET revoked_at = ? WHERE client_id = ?").run(Date.now(), flow.client.client_id);
    releaseLookup();
    await delivering;
    expect(ctx.posts).toHaveLength(0);
    expect(store.wakes.counts()).toMatchObject({ dropped: 1 });
  });

  it("consent approved after its client was revoked denies, and issues no code", async () => {
    ctx = setup();
    const allowed = await allowConnection(ctx);
    const client = (await register(ctx.app)).body;
    const { challenge } = pkce();
    const authorize = await request(ctx.app)
      .get("/relay/oauth/authorize")
      .query({ client_id: client.client_id, redirect_uri: kRedirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "r" });
    const consentUrl = new URL(authorize.headers.location, kPublic);
    const page = await request(ctx.app).get(consentUrl.pathname + consentUrl.search);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)[1];
    expect((await request(ctx.app).post("/api/relay/remote/clients/" + client.client_id + "/revoke")).body.ok).toBe(true);
    const approved = await request(ctx.app).post("/relay/oauth/consent").set("Origin", kPublic).type("form").send({ request: consentUrl.searchParams.get("request"), csrf, decision: "approve", consent_code: allowed.body.code });
    const location = new URL(approved.headers.location);
    expect(location.searchParams.get("code")).toBeNull();
    expect(location.searchParams.get("error")).toBe("access_denied");
  });
});

describe("relay remote: fix push after the final /ship (ALPH-63)", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  const startConsent = async () => {
    const client = (await register(ctx.app)).body;
    const { challenge } = pkce();
    const authorize = await request(ctx.app)
      .get("/relay/oauth/authorize")
      .query({ client_id: client.client_id, redirect_uri: kRedirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "w" });
    const url = new URL(authorize.headers.location, kPublic);
    const page = await request(ctx.app).get(url.pathname + url.search);
    return { page, request: url.searchParams.get("request"), csrf: /name="csrf" value="([^"]+)"/.exec(page.text)[1] };
  };
  const approve = (first, code) =>
    request(ctx.app).post("/relay/oauth/consent").set("Origin", kPublic).type("form").send({ request: first.request, csrf: first.csrf, decision: "approve", consent_code: code });

  it("a consent request started before Allow cannot be approved, even with the code; one window admits one approval of a request started inside it", async () => {
    ctx = setup();
    const forwarded = await startConsent();
    expect(forwarded.page.text).toContain("This request cannot be approved");
    expect(forwarded.page.text).toContain("start Connect again from your app");
    expect(forwarded.page.text).not.toContain('value="approve"');
    const refused = await approve(forwarded);
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("This request cannot be approved");
    expect(ctx.relayRemote.getStatus().consentWindowUntil).toBeNull();
    ctx.setIdentity({ kind: "member", memberId: "m1", role: "member" });
    expect((await allowConnection(ctx)).status).toBe(403);
    ctx.setIdentity({ kind: "legacy", role: "admin" });
    const opened = await allowConnection(ctx);
    expect(opened.body).toMatchObject({ ok: true });
    expect(Date.parse(opened.body.until) - Date.now()).toBeGreaterThan(9 * 60 * 1000);
    expect(ctx.relayRemote.getStatus().consentWindowUntil).toBe(opened.body.until);
    const stillForwarded = await request(ctx.app).get("/relay/oauth/consent?request=" + encodeURIComponent(forwarded.request));
    expect(stillForwarded.text).not.toContain('value="approve"');
    expect((await approve(forwarded, opened.body.code)).status).toBe(403);
    expect(ctx.relayRemote.getStatus().consentWindowUntil).toBe(opened.body.until);
    const own = await startConsent();
    expect(own.page.text).toContain('value="approve"');
    const approved = await approve(own, opened.body.code);
    expect(approved.status).toBe(303);
    expect(new URL(approved.headers.location).searchParams.get("code")).toBeTruthy();
    expect(ctx.relayRemote.getStatus().consentWindowUntil).toBeNull();
    const second = await startConsent();
    expect((await approve(second, opened.body.code)).status).toBe(403);
  });

  it("a forwarded authorize link clicked inside an open window cannot be approved without the Relay page's one-time code, and the code works once", async () => {
    ctx = setup();
    const opened = await allowConnection(ctx);
    expect(opened.headers["cache-control"]).toBe("no-store");
    expect(opened.body.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    const status = await request(ctx.app).get("/api/relay/remote");
    expect(JSON.stringify(status.body)).not.toContain(opened.body.code.replace("-", ""));
    expect(JSON.stringify(status.body)).not.toContain(opened.body.code);
    const attacker = await startConsent();
    expect(attacker.page.text).toContain('value="approve"');
    expect(attacker.page.text).toContain('name="consent_code"');
    const noCode = await approve(attacker);
    expect(noCode.status).toBe(403);
    expect(noCode.headers.location).toBeUndefined();
    expect(noCode.text).toContain("The code does not match");
    const wrongCode = await approve(attacker, "AAAA-AAAA" === opened.body.code ? "BBBB-BBBB" : "AAAA-AAAA");
    expect(wrongCode.status).toBe(403);
    expect(wrongCode.headers.location).toBeUndefined();
    expect(ctx.relayRemote.getStatus().consentWindowUntil).toBe(opened.body.until);
    const typed = await approve(attacker, " " + opened.body.code.toLowerCase().replace("-", " ") + " ");
    expect(typed.status).toBe(303);
    expect(new URL(typed.headers.location).searchParams.get("code")).toBeTruthy();
    expect(ctx.relayRemote.getStatus().consentWindowUntil).toBeNull();
    const reopened = await allowConnection(ctx);
    expect(reopened.body.code).not.toBe(opened.body.code);
    const next = await startConsent();
    expect((await approve(next, opened.body.code)).status).toBe(403);
    expect((await approve(next, reopened.body.code)).status).toBe(303);
  });

  it("the consent window closes 10 minutes after it opens", () => {
    const { openRemoteStore } = require("../../lib/server/relay/remote-store");
    const { createRelayOAuthProvider, kConsentWindowMs, kPendingTtlMs } = require("../../lib/server/relay/oauth-provider");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-consent-"));
    const clock = { value: 1_000_000 };
    const store = openRemoteStore({ dbPath: path.join(dir, "remote.db"), now: () => clock.value });
    try {
      const provider = createRelayOAuthProvider({ store, getResourceUrl: () => kPublic + "/relay/mcp", getRedirectAllowlist: () => [kRedirect], now: () => clock.value, logger: { log: () => {}, warn: () => {} } });
      provider.openConsentWindow({ actor: "legacy" });
      expect(kConsentWindowMs).toBe(10 * 60 * 1000);
      const { id } = store.pending.create({ clientId: "c1", params: { redirectUri: kRedirect }, ttlMs: kPendingTtlMs });
      clock.value += kConsentWindowMs - 1;
      expect(provider.consentWindowUntil()).toBeTruthy();
      expect(provider.consentAllowsRequest(id)).toBe(true);
      clock.value += 1;
      expect(provider.consentWindowUntil()).toBeNull();
      expect(provider.consentAllowsRequest(id)).toBe(false);
      expect(() => provider.completeConsent({ requestId: id, approve: true, actor: "legacy" })).toThrow(/No new connection/);
      expect(store.pending.get(id)).toBeTruthy();
    } finally {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the hourly cap holds against one JSON-RPC batch and against parallel POSTs, and a refused send keeps its slot", async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_HOURLY_CAP: "3" } });
    const flow = await connect(ctx);
    const token = flow.token.access_token;
    const bound = (await callTool(ctx.app, token, "relay_bind", { thread_id: "jam_C", webhook_url: kWebhook })).data;
    const args = (to) => ({ as: bound.agent, capability: bound.capability, to, text: "hi" });
    const realSend = ctx.engine.sendDm;
    ctx.engine.sendDm = async (...rest) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return realSend(...rest);
    };
    expect((await callTool(ctx.app, token, "relay_send", args("ghost"))).data.error).toBe("recipient_unknown");
    const batch = await request(ctx.app)
      .post("/relay/mcp")
      .set("Authorization", "Bearer " + token)
      .set("Accept", "application/json, text/event-stream")
      .send(Array.from({ length: 5 }, () => ({ jsonrpc: "2.0", id: rpcId++, method: "tools/call", params: { name: "relay_send", arguments: args("wintermute") } })));
    expect(batch.status).toBe(200);
    expect(ctx.engine.sent).toHaveLength(2);
    const other = await connect(ctx);
    const theirs = (await callTool(ctx.app, other.token.access_token, "relay_bind", { thread_id: "jam_D", webhook_url: kWebhook })).data;
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        callTool(ctx.app, other.token.access_token, "relay_send", { as: theirs.agent, capability: theirs.capability, to: "wintermute", text: "hi" }),
      ),
    );
    expect(results.filter((entry) => !entry.result.isError)).toHaveLength(3);
    expect(results.filter((entry) => entry.data.error === "rate_limited")).toHaveLength(3);
    expect(ctx.engine.sent).toHaveLength(5);
  });

  it("a wake enqueue that keeps failing is dropped after five tries, so later relay events are not held back", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const bound = (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_F", webhook_url: kWebhook })).data;
    const opened = ctx.relayRemote.ensureOpen();
    const realEnqueue = opened.wake.enqueue;
    opened.wake.enqueue = () => {
      throw new Error("disk I/O error");
    };
    const routed = { kind: "dm.received", messageId: "1401", sender: "wintermute", recipient: bound.agent, threadRoot: "1401", text: "x" };
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(ctx.relayRemote.onRelayMessage(routed)).rejects.toThrow("disk I/O error");
    }
    await expect(ctx.relayRemote.onRelayMessage(routed)).resolves.toBeUndefined();
    opened.wake.enqueue = realEnqueue;
    await ctx.relayRemote.onRelayMessage({ ...routed, messageId: "1402", threadRoot: "1402" });
    await vi.waitFor(() => expect(ctx.posts).toHaveLength(1));
  });

  it("a binding read that keeps failing is bounded like the enqueue: five tries, then the event is let through", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    const bound = (await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_G", webhook_url: kWebhook })).data;
    const opened = ctx.relayRemote.ensureOpen();
    const realGet = opened.store.bindings.get;
    opened.store.bindings.get = () => {
      throw new Error("database disk image is malformed");
    };
    const routed = { kind: "dm.received", messageId: "1501", sender: "wintermute", recipient: bound.agent, threadRoot: "1501", text: "x" };
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      await expect(ctx.relayRemote.onRelayMessage(routed)).rejects.toThrow("malformed");
    }
    await expect(ctx.relayRemote.onRelayMessage(routed)).resolves.toBeUndefined();
    opened.store.bindings.get = realGet;
    await ctx.relayRemote.onRelayMessage({ ...routed, messageId: "1502", threadRoot: "1502" });
    await vi.waitFor(() => expect(ctx.posts).toHaveLength(1));
  });

  it("serves only from ALPHACLAW_SETUP_URL: a platform URL alone (RENDER_EXTERNAL_URL) does not open the endpoint", () => {
    const { resolveRelayPublicUrl } = require("../../lib/server/relay/remote");
    const resolveSetupUrl = () => "https://box.onrender.com";
    expect(resolveRelayPublicUrl({ env: { RENDER_EXTERNAL_URL: "https://box.onrender.com" }, resolveSetupUrl })).toBeNull();
    expect(resolveRelayPublicUrl({ env: { ALPHACLAW_SETUP_URL: "  " }, resolveSetupUrl })).toBeNull();
    expect(resolveRelayPublicUrl({ env: { ALPHACLAW_SETUP_URL: "https://box.onrender.com" }, resolveSetupUrl })).toBe("https://box.onrender.com");
  });
});

describe("relay remote: ALPH-71 (M-2 cap accounting, L-12 bind cap, L-13 client secrets)", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("a refused relay_reply probe uses its hourly slot; only an engine or masking outage gives a slot back", async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_HOURLY_CAP: "3" } });
    ctx.engine.conversations = async () => [{ id: "dm_v", channel_id: "dmch_v", type: "1:1", participants: ["wintermute", "capy-victim00000"] }];
    ctx.engine.getMessage = async (key, id) => ({ id, channel_id: "dmch_v", agent_name: "capy-victim00000", metadata: {} });
    const flow = await connect(ctx);
    const token = flow.token.access_token;
    const bound = (await callTool(ctx.app, token, "relay_bind", { thread_id: "jam_P", webhook_url: kWebhook })).data;
    const probe = (id) => callTool(ctx.app, token, "relay_reply", { as: bound.agent, capability: bound.capability, message_id: id, text: "injected" });
    const first = await probe("244705956220485632");
    expect(first.data).toMatchObject({ error: "message_not_found", detail: "Message not found." });
    const realSend = ctx.engine.sendDm;
    const send = () => callTool(ctx.app, token, "relay_send", { as: bound.agent, capability: bound.capability, to: "wintermute", text: "hi" });
    const { RelayError } = require("../../lib/server/relay/errors");
    ctx.engine.sendDm = async () => {
      throw new RelayError("engine_unavailable", "down");
    };
    expect((await send()).data.error).toBe("engine_unavailable");
    expect((await send()).data.error).toBe("engine_unavailable");
    ctx.engine.sendDm = realSend;
    expect((await probe("244705956220485633")).data.error).toBe("message_not_found");
    expect((await send()).result.isError).toBeFalsy();
    expect((await send()).data.error).toBe("rate_limited");
  });

  it("caps active bindings per OAuth client: default 20, ALPHACLAW_RELAY_MAX_BINDINGS_PER_CLIENT from the deployment env only", async () => {
    const { readRelayConfig, kRelayEnvKeys } = require("../../lib/server/relay/config");
    const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");
    expect(readRelayConfig({ env: {} }).maxBindingsPerClient).toBe(20);
    expect(kDeploymentOnlyEnvKeys).toContain(kRelayEnvKeys.maxBindingsPerClient);
    ctx = setup({ env: { ALPHACLAW_RELAY_MAX_BINDINGS_PER_CLIENT: "2" } });
    const flow = await connect(ctx);
    const token = flow.token.access_token;
    const bind = (threadId, extra = {}) => callTool(ctx.app, token, "relay_bind", { thread_id: threadId, webhook_url: kWebhook, ...extra });
    const a = (await bind("jam_A")).data;
    expect((await bind("jam_B")).result.isError).toBeFalsy();
    const refused = await bind("jam_C");
    expect(refused.data.error).toBe("binding_limit");
    const agentsBefore = ctx.engine.agents.size;
    expect((await bind("jam_A", { capability: a.capability })).result.isError).toBeFalsy();
    expect(ctx.engine.agents.size).toBe(agentsBefore);
    await callTool(ctx.app, token, "relay_unbind", { as: a.agent, capability: a.capability });
    expect((await bind("jam_C")).result.isError).toBeFalsy();
    const other = await connect(ctx);
    expect((await callTool(ctx.app, other.token.access_token, "relay_bind", { thread_id: "jam_A", webhook_url: kWebhook })).result.isError).toBeFalsy();
  });

  it("a renewal of an expired binding counts against the cap, so expired bindings cannot be stockpiled past it (ALPH-71 L-12)", async () => {
    ctx = setup({ env: { ALPHACLAW_RELAY_MAX_BINDINGS_PER_CLIENT: "2" } });
    const flow = await connect(ctx);
    const token = flow.token.access_token;
    const bind = (threadId, extra = {}) => callTool(ctx.app, token, "relay_bind", { thread_id: threadId, webhook_url: kWebhook, ...extra });
    const a = (await bind("jam_A")).data;
    expect((await bind("jam_B")).result.isError).toBeFalsy();
    const { store } = ctx.relayRemote.ensureOpen();
    store.bindings.upsert({ ...store.bindings.get(a.agent), until: Date.now() - 1000 });
    const c = (await bind("jam_C")).data;
    expect(c.agent).toBeTruthy();
    expect((await bind("jam_A", { capability: a.capability })).data.error).toBe("binding_limit");
    expect(store.bindings.countActiveForClient(flow.client.client_id)).toBe(2);
    await callTool(ctx.app, token, "relay_unbind", { as: c.agent, capability: c.capability });
    const renewed = (await bind("jam_A", { capability: a.capability })).data;
    expect(renewed.agent).toBe(a.agent);
    expect((await bind("jam_B", {})).data.error).toBe("binding_capability_invalid");
  });

  const connectConfidential = async () => {
    const allowed = await allowConnection(ctx);
    const client = (await register(ctx.app, { token_endpoint_auth_method: "client_secret_post" })).body;
    const { verifier, challenge } = pkce();
    const authorize = await request(ctx.app)
      .get("/relay/oauth/authorize")
      .query({ client_id: client.client_id, redirect_uri: kRedirect, response_type: "code", code_challenge: challenge, code_challenge_method: "S256", state: "s", resource: kPublic + "/relay/mcp" });
    const consentUrl = new URL(authorize.headers.location, kPublic);
    const page = await request(ctx.app).get(consentUrl.pathname + consentUrl.search);
    const csrf = /name="csrf" value="([^"]+)"/.exec(page.text)[1];
    const approved = await request(ctx.app)
      .post("/relay/oauth/consent")
      .set("Origin", kPublic)
      .type("form")
      .send({ request: consentUrl.searchParams.get("request"), csrf, decision: "approve", consent_code: allowed.body.code });
    const code = new URL(approved.headers.location).searchParams.get("code");
    const exchange = (secret) =>
      request(ctx.app)
        .post("/relay/oauth/token")
        .type("form")
        .send({ grant_type: "authorization_code", client_id: client.client_id, ...(secret === undefined ? {} : { client_secret: secret }), code, code_verifier: verifier, redirect_uri: kRedirect, resource: kPublic + "/relay/mcp" });
    return { client, exchange };
  };

  it("a DCR client with a secret is refused with a wrong or missing secret at the token and revoke routes, never skipped", async () => {
    ctx = setup();
    const { client, exchange } = await connectConfidential();
    expect(client.client_secret).toEqual(expect.any(String));
    const stored = JSON.stringify(ctx.relayRemote.ensureOpen().store.clients.get(client.client_id));
    expect(stored).not.toContain(client.client_secret);
    const wrong = await exchange("not-the-secret");
    expect(wrong.status).toBe(401);
    expect(wrong.body.error).toBe("invalid_client");
    const missing = await exchange(undefined);
    expect(missing.status).toBe(401);
    expect(missing.body.error).toBe("invalid_client");
    const right = await exchange(client.client_secret);
    expect(right.status).toBe(200);
    const revoke = (secret) =>
      request(ctx.app).post("/relay/oauth/revoke").type("form").send({ client_id: client.client_id, client_secret: secret, token: right.body.refresh_token });
    expect((await revoke("not-the-secret")).status).toBe(401);
    expect((await mcp(ctx.app, right.body.access_token, "tools/list")).status).toBe(200);
    expect((await revoke(client.client_secret)).status).toBe(200);
    expect((await mcp(ctx.app, right.body.access_token, "tools/list")).status).toBe(401);
  });

  it("a client secret stored in plaintext by an earlier version is checked the same way and rehashed", async () => {
    ctx = setup();
    const { client, exchange } = await connectConfidential();
    const { store } = ctx.relayRemote.ensureOpen();
    const legacyInfo = { ...store.clients.get(client.client_id).info, client_secret: client.client_secret };
    delete legacyInfo.client_secret_sha256;
    store.db.prepare("UPDATE oauth_clients SET info = ? WHERE client_id = ?").run(JSON.stringify(legacyInfo), client.client_id);
    expect((await exchange("not-the-secret")).status).toBe(401);
    expect((await exchange(client.client_secret)).status).toBe(200);
    expect(JSON.stringify(store.clients.get(client.client_id))).not.toContain(client.client_secret);
  });
});


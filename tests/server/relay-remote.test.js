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
const { remoteAgentName } = require("../../lib/server/relay/remote-tools");

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

const connect = async (ctx) => {
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
    .send({ request: requestId, csrf, decision: "approve" });
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
      "relay_agents",
    ]);

    const bound = await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_01ABC", webhook_url: kWebhook });
    expect(bound.result.isError).toBeFalsy();
    expect(bound.data.agent).toBe(remoteAgentName("jam_01ABC"));
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
    await callTool(ctx.app, flow.token.access_token, "relay_bind", { thread_id: "jam_X", webhook_url: kWebhook });
    ctx.setIdentity({ kind: "member", memberId: "m1", role: "member" });
    expect((await request(ctx.app).post("/api/relay/remote/clients/" + flow.client.client_id + "/revoke")).status).toBe(403);
    ctx.setIdentity({ kind: "legacy", role: "admin" });
    const revoked = await request(ctx.app).post("/api/relay/remote/clients/" + flow.client.client_id + "/revoke");
    expect(revoked.body).toMatchObject({ ok: true, bindingsRemoved: [remoteAgentName("jam_X")] });
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

    const takeover = await callTool(ctx.app, b.token.access_token, "relay_bind", { thread_id: "jam_A", webhook_url: "https://api.capy.ai/webhooks/automations/attacker" });
    expect(takeover.data.error).toBe("binding_capability_invalid");
    const moved = await callTool(ctx.app, b.token.access_token, "relay_bind", { thread_id: "jam_A", webhook_url: kWebhook, capability: bound.capability });
    expect(moved.result.isError).toBeFalsy();
    expect(moved.data).toMatchObject({ agent: bound.agent, capability: bound.capability });
    expect(ctx.relayRemote.getStatus().bindings[0].clientId).toBe(b.client.client_id);
  });

  it("refuses wake URLs that are not https:443 on an allowed host", async () => {
    ctx = setup();
    const flow = await connect(ctx);
    for (const url of [
      "http://api.capy.ai/webhooks/x",
      "https://api.capy.ai:8443/webhooks/x",
      "https://user:pw@api.capy.ai/webhooks/x",
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

const {
  kA2aPathPattern,
  kAgentCardPathPattern,
  createIsProxiedPath,
  registerProxyRoutes,
} = require("../../lib/server/routes/proxy");
const http = require("http");
const express = require("express");
const httpProxy = require("http-proxy-3");
const request = require("supertest");
const {
  kStrippedIdentityHeaders,
  kForwardedEvidenceHeaders,
} = require("../../lib/server/proxy-identity");

// The gateway listens on container loopback only, so the front-door proxy is
// the sole route to an enabled A2A channel. These paths must both match a
// forwarding route and be treated as proxied paths, or the body parser
// consumes the JSON-RPC request and the gateway hangs on an empty stream.
describe("A2A proxy paths", () => {
  const isProxiedPath = createIsProxiedPath(["/api/setup"]);
  const proxied = (path) => isProxiedPath({ path });

  it("matches the documented JSON-RPC endpoint", () => {
    expect(kA2aPathPattern.test("/a2a/v1")).toBe(true);
    expect(proxied("/a2a/v1")).toBe(true);
  });

  it("matches both Agent Card discovery spellings", () => {
    // docs/channels/a2a.md serves the modern name and keeps agent.json for
    // older A2A clients.
    expect(kAgentCardPathPattern.test("/.well-known/agent-card.json")).toBe(true);
    expect(kAgentCardPathPattern.test("/.well-known/agent.json")).toBe(true);
    expect(proxied("/.well-known/agent-card.json")).toBe(true);
    expect(proxied("/.well-known/agent.json")).toBe(true);
  });

  // Negative controls: the patterns must not widen the proxied surface.
  it("does not match a bare or look-alike a2a path", () => {
    expect(kA2aPathPattern.test("/a2a")).toBe(false);
    expect(kA2aPathPattern.test("/a2away/v1")).toBe(false);
    expect(proxied("/a2a")).toBe(false);
  });

  it("does not match other well-known paths", () => {
    expect(kAgentCardPathPattern.test("/.well-known/openid-configuration")).toBe(
      false,
    );
    expect(kAgentCardPathPattern.test("/.well-known/agent-card.json.bak")).toBe(
      false,
    );
    expect(proxied("/.well-known/openid-configuration")).toBe(false);
  });

  it.each(["/a2a/v1/", "/a2a/v1/tasks", "/a2a/v2", "/a2a/admin"])(
    "does not match unsupported endpoint %s",
    (path) => {
      expect(kA2aPathPattern.test(path)).toBe(false);
      expect(proxied(path)).toBe(false);
    },
  );

  it("leaves the existing predicate behaviour intact", () => {
    expect(proxied("/openclaw")).toBe(true);
    expect(proxied("/openclaw/anything")).toBe(true);
    expect(proxied("/assets/app.js")).toBe(true);
    expect(proxied("/api/gateway/restart")).toBe(true);
    expect(proxied("/api/setup/status")).toBe(false);
    expect(proxied("/login.html")).toBe(false);
  });
});

describe("A2A HTTP identity boundary", () => {
  let upstream;
  let proxy;
  let app;
  let seen;
  let resolveProxyIdentity;
  let requireAuth;

  beforeEach(async () => {
    seen = [];
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ received: true }));
      });
    });
    await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    proxy = httpProxy.createProxyServer({ changeOrigin: true });
    app = express();
    const isProxiedPath = createIsProxiedPath([]);
    const parser = express.json();
    app.use((req, res, next) =>
      isProxiedPath(req) ? next() : parser(req, res, next),
    );
    resolveProxyIdentity = vi.fn(() => ({ email: "owner@example.test" }));
    requireAuth = vi.fn((_req, res) => res.status(401).end());
    registerProxyRoutes({
      app,
      proxy,
      getGatewayUrl: () => `http://127.0.0.1:${upstream.address().port}`,
      getGatewayToken: () => "different-gateway-token",
      SETUP_API_PREFIXES: [],
      requireAuth,
      resolveProxyIdentity,
      oauthCallbackMiddleware: (_req, res) => res.status(204).end(),
      webhookMiddleware: (_req, res) => res.status(204).end(),
    });
  });

  afterEach(async () => {
    proxy?.close();
    upstream?.closeAllConnections();
    if (upstream) await new Promise((resolve) => upstream.close(resolve));
  });

  it("preserves resolved browser identity on authenticated Control UI requests", async () => {
    requireAuth.mockImplementation((_req, _res, next) => next());
    const res = await request(app).get("/openclaw/fonts/font.css?v=1")
      .set("Cookie", "setup_token=valid-owner-cookie")
      .set("x-alphaclaw-user", "forged-owner")
      .timeout(3000);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("/openclaw/fonts/font.css?v=1");
    expect(seen[0].headers["x-alphaclaw-user"]).toBe("owner@example.test");
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(requireAuth).toHaveBeenCalledOnce();
    expect(resolveProxyIdentity).toHaveBeenCalledOnce();
  });

  it.each([
    ["post", "/a2a/v1?trace=peer"],
    ["get", "/.well-known/agent-card.json"],
    ["get", "/.well-known/agent.json"],
  ])("strips browser authority from %s %s without resolving an owner", async (method, path) => {
    const payload = method === "post" ? '{ "jsonrpc": "2.0", "id": "雪", "method": "GetTask", "params": {"id":"task-1"} }\n' : "";
    const headers = Object.fromEntries(
      [...kStrippedIdentityHeaders, ...kForwardedEvidenceHeaders].map((key) => [
        key,
        "forged-owner",
      ]),
    );
    const req = request(app)[method](path)
      .set(headers)
      .set("Authorization", "Bearer peer-token")
      .set("Cookie", "setup_token=valid-owner-cookie; preference=dark")
      .set("Content-Type", "application/json");
    if (payload) req.send(payload);
    const res = await req.timeout(3000);
    expect(res.status).toBe(200);
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe(path);
    expect(seen[0].body).toBe(payload);
    expect(seen[0].headers.authorization).toBe("Bearer peer-token");
    expect(seen[0].headers.cookie).toBe("preference=dark");
    for (const key of [...kStrippedIdentityHeaders, ...kForwardedEvidenceHeaders]) {
      expect(seen[0].headers[key], key).toBeUndefined();
    }
    expect(requireAuth).not.toHaveBeenCalled();
    expect(resolveProxyIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["get", "/a2a/v1"],
    ["head", "/a2a/v1"],
    ["put", "/a2a/v1"],
    ["post", "/.well-known/agent-card.json"],
    ["head", "/.well-known/agent.json"],
    ["options", "/.well-known/agent-card.json"],
    ["post", "/a2a/v1/"],
    ["post", "/a2a/v2"],
    ["post", "/a2a/admin"],
    ["get", "/.well-known/agent-card.json/"],
  ])("does not forward unsupported %s %s", async (method, path) => {
    const res = await request(app)[method](path).timeout(3000);
    expect(res.status).toBe(404);
    expect(seen).toEqual([]);
    expect(resolveProxyIdentity).not.toHaveBeenCalled();
  });
});

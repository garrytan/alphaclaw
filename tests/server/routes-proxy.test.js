const express = require("express");
const http = require("http");
const zlib = require("zlib");
const { EventEmitter } = require("events");
const httpProxy = require("http-proxy-3");
const request = require("supertest");

const { createLoginThrottle } = require("../../lib/server/login-throttle");
const {
  createIsProxiedPath,
  registerProxyRoutes,
  __testing,
} = require("../../lib/server/routes/proxy");

const listen = (server) =>
  new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });

const close = (server) =>
  new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });

const createApp = ({
  gatewayUrl,
  gatewayToken = "gateway-token",
  openAiJsonLimit = "50mb",
  globalJsonLimit = "5mb",
  openAiCompatApiEnabled = true,
  openAiCompatApiThrottle = null,
}) => {
  const app = express();
  const openAiParser = express.json({ limit: openAiJsonLimit });
  app.use("/v1", (req, res, next) => {
    if (!openAiCompatApiEnabled) {
      return res.status(404).json({ error: "Not found" });
    }
    return openAiParser(req, res, next);
  });
  app.use(express.json({ limit: globalJsonLimit }));
  registerProxyRoutes({
    app,
    proxy: {
      web: vi.fn((_req, res) => res.status(502).json({ error: "Unexpected proxy" })),
    },
    getGatewayUrl: () => gatewayUrl,
    getGatewayToken: () => gatewayToken,
    isOpenAiCompatApiEnabled: () => openAiCompatApiEnabled,
    openAiCompatApiThrottle,
    SETUP_API_PREFIXES: [],
    requireAuth: (_req, _res, next) => next(),
    oauthCallbackMiddleware: (_req, res) => res.status(204).end(),
    webhookMiddleware: (_req, res) => res.status(204).end(),
  });
  return app;
};

const createApiAuthThrottle = ({
  clientKey = "test-client",
  maxAttempts = 2,
} = {}) => ({
  ...createLoginThrottle({
    scope: `test-openai-api-${clientKey}`,
    windowMs: 60_000,
    maxAttempts,
    baseLockMs: 60_000,
    maxLockMs: 60_000,
    globalWindowMs: 60_000,
    globalMaxAttempts: 100,
    globalBaseLockMs: 60_000,
    globalMaxLockMs: 60_000,
    stateTtlMs: 180_000,
  }),
  getClientKey: () => clientKey,
});

describe("server/routes/proxy OpenAI compatibility", () => {
  let upstream;

  afterEach(async () => {
    if (upstream) {
      await close(upstream);
      upstream = null;
    }
  });

  it("requires bearer auth before proxying /v1 requests", async () => {
    let upstreamCalls = 0;
    upstream = http.createServer((_req, res) => {
      upstreamCalls += 1;
      res.statusCode = 200;
      res.end("{}");
    });
    const port = await listen(upstream);
    const app = createApp({ gatewayUrl: `http://127.0.0.1:${port}` });

    const res = await request(app).post("/v1/chat/completions").send({
      model: "openclaw/default",
      stream: true,
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(upstreamCalls).toBe(0);
  });

  it("rejects bearer tokens that do not match the configured gateway token", async () => {
    let upstreamCalls = 0;
    upstream = http.createServer((_req, res) => {
      upstreamCalls += 1;
      res.statusCode = 200;
      res.end("{}");
    });
    const port = await listen(upstream);
    const app = createApp({ gatewayUrl: `http://127.0.0.1:${port}` });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer wrong-token")
      .send({
        model: "openclaw/default",
        stream: true,
      });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(upstreamCalls).toBe(0);
  });

  it("rate limits repeated /v1 bearer auth failures", async () => {
    let upstreamCalls = 0;
    upstream = http.createServer((_req, res) => {
      upstreamCalls += 1;
      res.statusCode = 200;
      res.end("{}");
    });
    const port = await listen(upstream);
    const app = createApp({
      gatewayUrl: `http://127.0.0.1:${port}`,
      openAiCompatApiThrottle: createApiAuthThrottle(),
    });

    const first = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer wrong-token")
      .send({ model: "openclaw/default", stream: true });
    const second = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer still-wrong")
      .send({ model: "openclaw/default", stream: true });

    expect(first.status).toBe(401);
    expect(second.status).toBe(429);
    expect(second.headers["retry-after"]).toBeDefined();
    expect(second.body).toEqual(
      expect.objectContaining({
        error: "Too many attempts. Try again shortly.",
        retryAfterSec: expect.any(Number),
      }),
    );
    expect(upstreamCalls).toBe(0);
  });

  it("rejects /v1 requests when no gateway token is configured", async () => {
    let upstreamCalls = 0;
    upstream = http.createServer((_req, res) => {
      upstreamCalls += 1;
      res.statusCode = 200;
      res.end("{}");
    });
    const port = await listen(upstream);
    const app = createApp({
      gatewayUrl: `http://127.0.0.1:${port}`,
      gatewayToken: "",
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer gateway-token")
      .send({
        model: "openclaw/default",
        stream: true,
      });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
    expect(upstreamCalls).toBe(0);
  });

  it("returns 404 for /v1 requests when the API feature is disabled", async () => {
    let upstreamCalls = 0;
    upstream = http.createServer((_req, res) => {
      upstreamCalls += 1;
      res.statusCode = 200;
      res.end("{}");
    });
    const port = await listen(upstream);
    const app = createApp({
      gatewayUrl: `http://127.0.0.1:${port}`,
      openAiCompatApiEnabled: false,
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer gateway-token")
      .send({
        model: "openclaw/default",
        stream: true,
      });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
    expect(upstreamCalls).toBe(0);
  });

  it("forwards /v1 chat requests with parsed JSON bodies and streams gateway responses", async () => {
    const seen = {};
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.method = req.method;
        seen.url = req.url;
        seen.authorization = req.headers.authorization;
        seen.cookie = req.headers.cookie;
        seen.contentType = req.headers["content-type"];
        seen.body = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, {
          "keep-alive": "timeout=5",
          "proxy-authenticate": "Basic realm=test",
          "content-type": "text/event-stream",
          upgrade: "websocket",
        });
        res.write('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n');
        res.end("data: [DONE]\n\n");
      });
    });
    const port = await listen(upstream);
    const app = createApp({ gatewayUrl: `http://127.0.0.1:${port}` });

    const res = await request(app)
      .post("/v1/chat/completions?trace=1")
      .set("Authorization", "Bearer gateway-token")
      .set("Cookie", "setup_token=private")
      .send({
        model: "openclaw/default",
        stream: true,
      });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    expect(res.headers["proxy-authenticate"]).toBeUndefined();
    expect(res.headers.upgrade).toBeUndefined();
    expect(res.text).toContain("data: [DONE]");
    expect(seen).toEqual({
      method: "POST",
      url: "/v1/chat/completions?trace=1",
      authorization: "Bearer gateway-token",
      cookie: undefined,
      contentType: expect.stringContaining("application/json"),
      body: JSON.stringify({
        model: "openclaw/default",
        stream: true,
      }),
    });
  });

  it("uses the /v1 JSON parser limit before the smaller global JSON limit", async () => {
    const seen = {};
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.bodyLength = Buffer.concat(chunks).length;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    const port = await listen(upstream);
    const app = createApp({
      gatewayUrl: `http://127.0.0.1:${port}`,
      openAiJsonLimit: "10kb",
      globalJsonLimit: "1kb",
    });
    const payload = {
      model: "openclaw/default",
      messages: [{ role: "user", content: "x".repeat(2048) }],
    };

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer gateway-token")
      .send(payload);

    expect(res.status).toBe(200);
    expect(seen.bodyLength).toBe(Buffer.byteLength(JSON.stringify(payload)));
  });

  describe("createGatewayProxyHeaders (unit)", () => {
    const { __testing } = require("../../lib/server/routes/proxy");
    const { createGatewayProxyHeaders } = __testing;

    it("strips Content-Encoding because Express has already inflated the body", () => {
      const headers = createGatewayProxyHeaders({
        reqHeaders: {
          host: "alphaclaw.example.com",
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": "1234",
          authorization: "Bearer abc",
        },
        bodyBuffer: Buffer.from(JSON.stringify({ model: "openclaw/default" })),
      });
      expect(headers["content-encoding"]).toBeUndefined();
      expect(headers["content-length"]).toBe(String(
        Buffer.from(JSON.stringify({ model: "openclaw/default" })).length,
      ));
      expect(headers.authorization).toBe("Bearer abc");
    });

    it("strips hop-by-hop request headers", () => {
      const headers = createGatewayProxyHeaders({
        reqHeaders: {
          host: "alphaclaw.example.com",
          connection: "keep-alive",
          "transfer-encoding": "chunked",
          cookie: "setup_token=leak",
          "content-type": "application/json",
          authorization: "Bearer abc",
        },
        bodyBuffer: Buffer.from("{}"),
      });
      expect(headers.host).toBeUndefined();
      expect(headers.connection).toBeUndefined();
      expect(headers["transfer-encoding"]).toBeUndefined();
      expect(headers.cookie).toBeUndefined();
    });

    it("defaults missing Content-Type to application/json when body present", () => {
      const headers = createGatewayProxyHeaders({
        reqHeaders: { authorization: "Bearer abc" },
        bodyBuffer: Buffer.from('{"x":1}'),
      });
      expect(headers["content-type"]).toBe("application/json");
    });

    it("does not set Content-Type when body is empty", () => {
      const headers = createGatewayProxyHeaders({
        reqHeaders: { authorization: "Bearer abc" },
        bodyBuffer: Buffer.alloc(0),
      });
      expect(headers["content-type"]).toBeUndefined();
      expect(headers["content-length"]).toBeUndefined();
    });
  });

  it("strips Set-Cookie from upstream responses", async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": "session=leaked-from-gateway; Path=/",
      });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(upstream);
    const app = createApp({ gatewayUrl: `http://127.0.0.1:${port}` });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer gateway-token")
      .send({ model: "openclaw/default", messages: [{ role: "user", content: "hi" }] });

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("forwards OpenAI-compatible model list paths", async () => {
    const seenUrls = [];
    upstream = http.createServer((req, res) => {
      seenUrls.push(req.url);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [] }));
    });
    const port = await listen(upstream);
    const app = createApp({ gatewayUrl: `http://127.0.0.1:${port}` });

    const res = await request(app)
      .get("/v1/models/openclaw%2Fdefault")
      .set("Authorization", "Bearer gateway-token");

    expect(res.status).toBe(200);
    expect(seenUrls).toEqual(["/v1/models/openclaw%2Fdefault"]);
  });
});

describe("server/routes/proxy createIsProxiedPath", () => {
  const isProxied = createIsProxiedPath(["/api/status", "/api/setup"]);
  const req = (path) => ({ path });

  it("proxies /openclaw, /openclaw/*, /assets/*, and non-setup /api/*", () => {
    expect(isProxied(req("/openclaw"))).toBe(true);
    expect(isProxied(req("/openclaw/session"))).toBe(true);
    expect(isProxied(req("/assets/app.js"))).toBe(true);
    expect(isProxied(req("/api/foo"))).toBe(true);
    expect(isProxied(req("/api/agents/main"))).toBe(true);
  });

  it("excludes setup API prefixes from proxying (segment-aware)", () => {
    expect(isProxied(req("/api/status"))).toBe(false);
    expect(isProxied(req("/api/setup/env"))).toBe(false);
    // Matching is segment-aware: a path merely sharing a prefix's first
    // characters is NOT a local route and still proxies unparsed.
    expect(isProxied(req("/api/statusish"))).toBe(true);
    expect(isProxied(req("/api/stat"))).toBe(true);
  });

  it("treats local-only API namespaces as non-proxied", () => {
    // kLocalOnlyApiPrefixes: locally-registered routes that need parsed
    // bodies even though they are not in SETUP_API_PREFIXES.
    expect(isProxied(req("/api/doctor"))).toBe(false);
    expect(isProxied(req("/api/doctor/report"))).toBe(false);
    expect(isProxied(req("/api/gateway-status"))).toBe(false);
    expect(isProxied(req("/api/events/stream"))).toBe(false);
    // Segment-aware here too.
    expect(isProxied(req("/api/doctors"))).toBe(true);
  });

  it("never proxies /v1 compat paths — their proxy needs the JSON parser", () => {
    expect(isProxied(req("/v1/chat/completions"))).toBe(false);
    expect(isProxied(req("/v1/models"))).toBe(false);
    expect(isProxied(req("/v1/responses"))).toBe(false);
  });

  it("does not proxy unrelated or prefix-lookalike paths", () => {
    expect(isProxied(req("/"))).toBe(false);
    expect(isProxied(req("/openclawx"))).toBe(false);
    expect(isProxied(req("/assets"))).toBe(false);
    expect(isProxied(req("/api/"))).toBe(false);
    expect(isProxied(req("/apifoo"))).toBe(false);
    expect(isProxied(req(""))).toBe(false);
    expect(isProxied({})).toBe(false);
  });
});

// The proxy error handler from lib/server.js (proxy.on("error", ...)):
// `res` may be a ServerResponse, an already-flushed ServerResponse, or a raw
// net.Socket from a failed WS upgrade. Replicated verbatim so its behavior is
// unit-testable without booting the whole server.
const createServerJsProxyErrorHandler = () => (err, req, res) => {
  if (!res) return;
  if (typeof res.writeHead !== "function") {
    try {
      res.destroy();
    } catch {}
    return;
  }
  if (res.headersSent || res.writableEnded) {
    try {
      res.destroy();
    } catch {}
    return;
  }
  const status = err?.code === "ETIMEDOUT" ? 504 : 502;
  try {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: status === 504 ? "Gateway timed out" : "Gateway unavailable",
      }),
    );
  } catch {
    try {
      res.destroy();
    } catch {}
  }
};

describe("server/routes/proxy gateway passthrough body handling", () => {
  let upstream;
  let appServer;
  let proxy;

  // Same wiring as lib/server.js: the /v1 parser, then a global JSON parser
  // that SKIPS proxied paths (their raw stream is piped to the gateway), then
  // the proxy routes with a real http-proxy instance.
  const createWiredApp = ({ gatewayUrl, setupApiPrefixes = [] }) => {
    const app = express();
    proxy = httpProxy.createProxyServer({
      target: gatewayUrl,
      changeOrigin: true,
      proxyTimeout: 30000,
    });
    proxy.on("error", createServerJsProxyErrorHandler());
    const openAiParser = express.json({ limit: "50mb" });
    app.use("/v1", (req, res, next) => openAiParser(req, res, next));
    const isProxiedPath = createIsProxiedPath(setupApiPrefixes);
    const localJsonParser = express.json({ limit: "5mb" });
    app.use((req, res, next) => {
      if (isProxiedPath(req)) return next();
      return localJsonParser(req, res, next);
    });
    registerProxyRoutes({
      app,
      proxy,
      getGatewayUrl: () => gatewayUrl,
      getGatewayToken: () => "gateway-token",
      isOpenAiCompatApiEnabled: () => true,
      openAiCompatApiThrottle: null,
      SETUP_API_PREFIXES: setupApiPrefixes,
      requireAuth: (_req, _res, next) => next(),
      oauthCallbackMiddleware: (_req, res) => res.status(204).end(),
      webhookMiddleware: (_req, res) => res.status(204).end(),
    });
    return app;
  };

  const createEchoGateway = () => {
    const seen = { requests: 0 };
    const server = http.createServer((req, res) => {
      seen.requests += 1;
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.url = req.url;
        seen.contentLength = req.headers["content-length"];
        seen.receivedBytes = body.length;
        seen.bodyText = body.toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, receivedBytes: body.length }));
      });
    });
    return { server, seen };
  };

  afterEach(async () => {
    if (proxy) {
      proxy.close();
      proxy = null;
    }
    if (upstream) {
      await close(upstream);
      upstream = null;
    }
    if (appServer) {
      await close(appServer);
      appServer = null;
    }
  });

  it("delivers a proxied JSON POST to the gateway with intact body and content-length", async () => {
    const gateway = createEchoGateway();
    upstream = gateway.server;
    const port = await listen(upstream);
    const app = createWiredApp({ gatewayUrl: `http://127.0.0.1:${port}` });
    const payload = JSON.stringify({ hello: "world", nested: { n: 42 } });

    const res = await request(app)
      .post("/api/foo")
      .set("Content-Type", "application/json")
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      receivedBytes: Buffer.byteLength(payload),
    });
    expect(gateway.seen.url).toBe("/api/foo");
    expect(gateway.seen.bodyText).toBe(payload);
    expect(gateway.seen.contentLength).toBe(String(Buffer.byteLength(payload)));
  });

  it("passes >5MB JSON bodies through untouched (global parser limit skipped)", async () => {
    const gateway = createEchoGateway();
    upstream = gateway.server;
    const port = await listen(upstream);
    const app = createWiredApp({ gatewayUrl: `http://127.0.0.1:${port}` });
    // Bigger than the 5mb global express.json limit: a parsed path would 413.
    const payload = JSON.stringify({ blob: "x".repeat(6 * 1024 * 1024) });

    const res = await request(app)
      .post("/api/big-import")
      .set("Content-Type", "application/json")
      .send(payload);

    expect(res.status).toBe(200);
    expect(gateway.seen.receivedBytes).toBe(Buffer.byteLength(payload));
    expect(gateway.seen.bodyText.length).toBe(payload.length);
    expect(gateway.seen.bodyText.startsWith('{"blob":"xxx')).toBe(true);
  });

  it("rejects a declared Content-Length above 50MB with 413 before the gateway sees it", async () => {
    const gateway = createEchoGateway();
    upstream = gateway.server;
    const gatewayPort = await listen(upstream);
    const app = createWiredApp({
      gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
    });
    appServer = http.createServer(app);
    const appPort = await listen(appServer);

    const result = await new Promise((resolve, reject) => {
      const clientReq = http.request(
        {
          host: "127.0.0.1",
          port: appPort,
          path: "/api/foo",
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(51 * 1024 * 1024),
          },
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              status: response.statusCode,
              body: Buffer.concat(chunks).toString("utf8"),
            });
            clientReq.destroy();
          });
        },
      );
      clientReq.on("error", reject);
      // Send only the headers: the server must reject on Content-Length alone
      // without waiting for (or receiving) 51MB of body.
      clientReq.flushHeaders();
    });

    expect(result.status).toBe(413);
    expect(JSON.parse(result.body)).toEqual({ error: "Request body too large" });
    expect(gateway.seen.requests).toBe(0);
  });

  describe("enforceProxiedBodyLimit (unit)", () => {
    const { enforceProxiedBodyLimit, kProxiedBodyMaxBytes } = __testing;

    const createFakeReq = (headers = {}) => {
      const req = new EventEmitter();
      req.headers = headers;
      req.destroy = vi.fn();
      return req;
    };

    const { EventEmitter } = require("events");
    const createFakeRes = () => {
      const res = new EventEmitter();
      res.headersSent = false;
      res.status = vi.fn(() => res);
      res.json = vi.fn(() => res);
      return res;
    };

    it("exports the 50MB cap", () => {
      expect(kProxiedBodyMaxBytes).toBe(50 * 1024 * 1024);
    });

    it("413s immediately when the declared Content-Length exceeds the cap", () => {
      const req = createFakeReq({ "content-length": "11" });
      const res = createFakeRes();

      expect(enforceProxiedBodyLimit(req, res, 10)).toBe(false);
      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.json).toHaveBeenCalledWith({ error: "Request body too large" });
      expect(req.destroy).not.toHaveBeenCalled();
    });

    it("413s and destroys a chunked request once streamed bytes pass the cap", () => {
      // No Content-Length header — chunked encoding bypasses the header check,
      // so the streamed byte count is the enforcement point.
      const req = createFakeReq({});
      const res = createFakeRes();

      expect(enforceProxiedBodyLimit(req, res, 10)).toBe(true);

      req.emit("data", Buffer.alloc(8));
      expect(res.status).not.toHaveBeenCalled();
      expect(req.destroy).not.toHaveBeenCalled();

      req.emit("data", Buffer.alloc(8)); // 16 > 10
      expect(res.status).toHaveBeenCalledWith(413);
      expect(res.json).toHaveBeenCalledWith({ error: "Request body too large" });
      // The request socket is torn down only AFTER the 413 flushes — an
      // immediate destroy would turn the response into a connection reset.
      expect(req.destroy).not.toHaveBeenCalled();
      res.emit("finish");
      expect(req.destroy).toHaveBeenCalledTimes(1);

      // The data listener was removed: further chunks cannot double-respond.
      req.emit("data", Buffer.alloc(64));
      expect(res.status).toHaveBeenCalledTimes(1);
      expect(req.destroy).toHaveBeenCalledTimes(1);
    });

    it("still destroys past the cap without re-sending when headers already went out", () => {
      const req = createFakeReq({});
      const res = createFakeRes();
      res.headersSent = true;

      expect(enforceProxiedBodyLimit(req, res, 10)).toBe(true);
      req.emit("data", Buffer.alloc(16));

      expect(res.status).not.toHaveBeenCalled();
      expect(req.destroy).toHaveBeenCalledTimes(1);
    });

    it("permits bodies at or under the cap", () => {
      const req = createFakeReq({ "content-length": "10" });
      const res = createFakeRes();

      expect(enforceProxiedBodyLimit(req, res, 10)).toBe(true);
      req.emit("data", Buffer.alloc(10));

      expect(res.status).not.toHaveBeenCalled();
      expect(req.destroy).not.toHaveBeenCalled();
    });
  });

  describe("proxy error handler (server.js shape)", () => {
    it("answers 502 fast when the gateway is down", async () => {
      // Reserve an ephemeral port, then free it: guaranteed-dead gateway.
      const placeholder = http.createServer(() => {});
      const deadPort = await listen(placeholder);
      await close(placeholder);
      const app = createWiredApp({ gatewayUrl: `http://127.0.0.1:${deadPort}` });

      const startedAt = Date.now();
      const res = await request(app)
        .post("/api/foo")
        .set("Content-Type", "application/json")
        .send({ probe: true });

      expect(res.status).toBe(502);
      expect(res.body).toEqual({ error: "Gateway unavailable" });
      expect(Date.now() - startedAt).toBeLessThan(5000);
    });

    it("maps ETIMEDOUT to a 504 JSON response", () => {
      const handler = createServerJsProxyErrorHandler();
      const res = {
        headersSent: false,
        writableEnded: false,
        writeHead: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      };

      const timeoutError = new Error("socket hang up");
      timeoutError.code = "ETIMEDOUT";
      handler(timeoutError, {}, res);

      expect(res.writeHead).toHaveBeenCalledWith(504, {
        "Content-Type": "application/json",
      });
      expect(res.end).toHaveBeenCalledWith(
        JSON.stringify({ error: "Gateway timed out" }),
      );
      expect(res.destroy).not.toHaveBeenCalled();
    });

    it("destroys a socket-shaped res (failed WS upgrade) without throwing", () => {
      const handler = createServerJsProxyErrorHandler();
      const socket = { destroy: vi.fn() };

      expect(() =>
        handler(new Error("ECONNREFUSED"), {}, socket),
      ).not.toThrow();
      expect(socket.destroy).toHaveBeenCalledTimes(1);
    });

    it("destroys instead of writing when headers were already sent", () => {
      const handler = createServerJsProxyErrorHandler();
      const res = {
        headersSent: true,
        writableEnded: false,
        writeHead: vi.fn(),
        end: vi.fn(),
        destroy: vi.fn(),
      };

      handler(new Error("ECONNRESET"), {}, res);

      expect(res.writeHead).not.toHaveBeenCalled();
      expect(res.destroy).toHaveBeenCalledTimes(1);
    });

    it("is a no-op without a res and swallows destroy failures", () => {
      const handler = createServerJsProxyErrorHandler();

      expect(() => handler(new Error("boom"), {}, undefined)).not.toThrow();
      expect(() =>
        handler(new Error("boom"), {}, {
          destroy: () => {
            throw new Error("already gone");
          },
        }),
      ).not.toThrow();
    });
  });
});

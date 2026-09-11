const express = require("express");
const http = require("http");
const { Readable, Writable } = require("stream");
const request = require("supertest");

const { createLoginThrottle } = require("../../lib/server/login-throttle");
const {
  kOpenAiCompatProxyPathPattern,
  registerProxyRoutes,
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

// `register` lets the legacy-mount block wire an app from a re-required copy
// of routes/proxy (kControlUiMount is fixed at module load) while sharing
// these defaults with every other test.
const registerDefaults = ({ app, register = registerProxyRoutes, ...overrides }) => {
  register({
    app,
    proxy: { web: vi.fn() },
    getGatewayUrl: () => "http://127.0.0.1:1",
    getGatewayToken: () => "gateway-token",
    SETUP_API_PREFIXES: [],
    requireAuth: (_req, _res, next) => next(),
    oauthCallbackMiddleware: (_req, res) => res.status(204).end(),
    webhookMiddleware: (_req, res) => res.status(204).end(),
    ...overrides,
  });
};

const createApiAuthThrottle = ({
  clientKey = "coverage-client",
  maxAttempts = 2,
} = {}) => ({
  ...createLoginThrottle({
    scope: `coverage-openai-api-${clientKey}-${Math.random()}`,
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

describe("server/routes/proxy coverage", () => {
  let upstream;

  afterEach(async () => {
    if (upstream) {
      await close(upstream);
      upstream = null;
    }
  });

  describe("gateway passthrough routes", () => {
    const createProxyApp = ({ SETUP_API_PREFIXES = [] } = {}) => {
      const app = express();
      const proxy = {
        web: vi.fn((req, res, options) =>
          res.status(200).json({ url: req.url, target: options.target }),
        ),
      };
      registerDefaults({
        app,
        proxy,
        getGatewayUrl: () => "http://gateway.internal:18789",
        SETUP_API_PREFIXES,
      });
      return { app, proxy };
    };

    // Verbatim mount contract (control-ui-mount.js): the gateway serves the
    // Control UI under gateway.controlUi.basePath=/openclaw and resolves every
    // resource URL from the base path it stamps, so AlphaClaw must forward the
    // request-target UNTOUCHED — stripping the prefix (the pre-fix behavior)
    // is what made fonts/themes/sw.js 404 at AlphaClaw's root.
    it("forwards /openclaw to the gateway verbatim (no prefix strip)", async () => {
      const { app, proxy } = createProxyApp();
      const res = await request(app).get("/openclaw");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        url: "/openclaw",
        target: "http://gateway.internal:18789",
      });
      expect(proxy.web).toHaveBeenCalledTimes(1);
    });

    it("preserves the /openclaw prefix and query on nested paths", async () => {
      const { app } = createProxyApp();
      const res = await request(app).get("/openclaw/chat?tab=1");
      expect(res.status).toBe(200);
      expect(res.body.url).toBe("/openclaw/chat?tab=1");
    });

    it("forwards the trailing-slash form /openclaw/ as-is", async () => {
      const { app } = createProxyApp();
      const res = await request(app).get("/openclaw/");
      expect(res.status).toBe(200);
      expect(res.body.url).toBe("/openclaw/");
    });

    it("keeps the query on /openclaw/?x=1 (the old exact-match handler dropped it)", async () => {
      const { app } = createProxyApp();
      const res = await request(app).get("/openclaw/?x=1");
      expect(res.status).toBe(200);
      expect(res.body.url).toBe("/openclaw/?x=1");
    });

    it("forwards Control UI resource paths with their exact path and query", async () => {
      // The resources the UI resolves from the stamped base path — the ones
      // that 404'd under the strip and tripped "Styles failed to load".
      const { app, proxy } = createProxyApp();
      const kResourcePaths = [
        "/openclaw/fonts/jetbrains-mono.css?v=b1",
        "/openclaw/themes/dash.css?v=b1",
        "/openclaw/assets/index-abc.css",
        "/openclaw/sw.js",
        "/openclaw/__openclaw/control-ui-config.json",
        "/openclaw/avatar/main",
      ];
      for (const path of kResourcePaths) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(200);
        expect(res.body.url, path).toBe(path);
      }
      expect(proxy.web).toHaveBeenCalledTimes(kResourcePaths.length);
    });

    it("forwards /assets paths unchanged", async () => {
      const { app } = createProxyApp();
      const res = await request(app).get("/assets/app.js");
      expect(res.status).toBe(200);
      expect(res.body.url).toBe("/assets/app.js");
    });

    describe("traversal guard", () => {
      // supertest's client (superagent) parses the target with the WHATWG URL
      // parser, which collapses BOTH a literal `..` AND `%2e%2e` before the
      // request leaves the client — Express would see `/v1/models` and the
      // guard would never run, so a supertest matrix would pass vacuously.
      // Node's http client sends `path` verbatim, so the matrix goes over a
      // real listening socket. The e2e file repeats the `..\` form over a
      // raw net socket against the whole server.
      const rawGet = (port, path) =>
        new Promise((resolve, reject) => {
          const clientReq = http.request(
            { host: "127.0.0.1", port, path, method: "GET" },
            (res) => {
              const chunks = [];
              res.on("data", (chunk) => chunks.push(chunk));
              res.on("end", () =>
                resolve({
                  status: res.statusCode,
                  body: Buffer.concat(chunks).toString("utf8"),
                }),
              );
            },
          );
          clientReq.on("error", reject);
          clientReq.end();
        });

      const withListeningApp = async (app, run) => {
        const server = http.createServer(app);
        const port = await listen(server);
        try {
          return await run(port);
        } finally {
          await close(server);
        }
      };

      // Every form the gateway's WHATWG parser would fold back into a root
      // path: dot segments (literal and percent-encoded) and backslashes
      // (literal and percent-encoded, since WHATWG treats `\` as `/`), on
      // BOTH gateway-UI namespaces.
      const kTraversalPaths = [
        "/openclaw/../v1/models",
        "/openclaw/%2e%2e/v1/models",
        "/openclaw/%5c..%5cv1/models",
        "/openclaw/..\\v1/models",
        "/assets/../v1/models",
        "/assets/%2e%2e/x",
      ];

      it.each(kTraversalPaths)(
        "answers 404 for %s without calling proxy.web",
        async (path) => {
          const { app, proxy } = createProxyApp();
          const res = await withListeningApp(app, (port) => rawGet(port, path));
          expect(res.status).toBe(404);
          expect(JSON.parse(res.body)).toEqual({ error: "Not found" });
          expect(proxy.web).not.toHaveBeenCalled();
        },
      );

      it("still forwards a dot segment that lives only in the query", async () => {
        // `?v=..` is a legitimate cache buster; the gateway never normalizes
        // the query, so the guard must not be over-broad.
        const { app, proxy } = createProxyApp();
        const res = await withListeningApp(app, (port) =>
          rawGet(port, "/openclaw/fonts/x.css?v=.."),
        );
        expect(res.status).toBe(200);
        expect(JSON.parse(res.body).url).toBe("/openclaw/fonts/x.css?v=..");
        expect(proxy.web).toHaveBeenCalledTimes(1);
      });
    });

    describe("legacy mount (ALPHACLAW_CONTROL_UI_MOUNT=legacy)", () => {
      // kControlUiMount is resolved once at module load, so the rollback mode
      // needs a fresh copy of control-ui-mount AND routes/proxy required under
      // the env. The env is restored and both cache entries dropped as soon as
      // the copy is captured (mirrors loadFresh in control-ui-mount.test.js):
      // the legacy closure lives on in `legacyRegisterProxyRoutes`, while any
      // later require in this process sees the default mode again.
      const kMountModulePath = require.resolve("../../lib/server/control-ui-mount");
      const kProxyModulePath = require.resolve("../../lib/server/routes/proxy");
      let legacyRegisterProxyRoutes;

      const dropModeModules = () => {
        delete require.cache[kMountModulePath];
        delete require.cache[kProxyModulePath];
      };

      beforeAll(() => {
        const saved = process.env.ALPHACLAW_CONTROL_UI_MOUNT;
        process.env.ALPHACLAW_CONTROL_UI_MOUNT = "legacy";
        dropModeModules();
        try {
          ({ registerProxyRoutes: legacyRegisterProxyRoutes } = require(kProxyModulePath));
        } finally {
          if (saved === undefined) delete process.env.ALPHACLAW_CONTROL_UI_MOUNT;
          else process.env.ALPHACLAW_CONTROL_UI_MOUNT = saved;
          dropModeModules();
        }
      });

      afterAll(() => {
        legacyRegisterProxyRoutes = undefined;
        dropModeModules();
      });

      const createLegacyProxyApp = () => {
        const app = express();
        const proxy = {
          web: vi.fn((req, res) => res.status(200).json({ url: req.url })),
        };
        registerDefaults({
          app,
          proxy,
          register: legacyRegisterProxyRoutes,
          getGatewayUrl: () => "http://gateway.internal:18789",
        });
        return { app, proxy };
      };

      it("strips the /openclaw prefix the way the pre-fix proxy did", async () => {
        const { app, proxy } = createLegacyProxyApp();
        const kStripCases = [
          ["/openclaw", "/"],
          ["/openclaw/chat?tab=1", "/chat?tab=1"],
          ["/openclaw/fonts/x.css", "/fonts/x.css"],
          // The legacy strip keeps the query too (the old exact-match handler
          // dropped it).
          ["/openclaw/?x=1", "/?x=1"],
        ];
        for (const [requested, forwarded] of kStripCases) {
          const res = await request(app).get(requested);
          expect(res.status, requested).toBe(200);
          expect(res.body.url, requested).toBe(forwarded);
        }
        expect(proxy.web).toHaveBeenCalledTimes(kStripCases.length);
      });

      it("keeps the traversal guard in legacy mode", async () => {
        // %5c survives superagent's URL normalization, so supertest is enough.
        const { app, proxy } = createLegacyProxyApp();
        const res = await request(app).get("/openclaw/%5c..%5cv1/models");
        expect(res.status).toBe(404);
        expect(res.body).toEqual({ error: "Not found" });
        expect(proxy.web).not.toHaveBeenCalled();
      });

      it("does not leak the legacy mode into the module the rest of this file uses", async () => {
        const { app } = createProxyApp();
        const res = await request(app).get("/openclaw/chat?tab=1");
        expect(res.body.url).toBe("/openclaw/chat?tab=1");
        // The file-level proxy import can never observe the leak (it was
        // bound at load). What CAN leak is process.env and require.cache —
        // a fresh require must resolve to basepath and the env must be clear.
        expect(process.env.ALPHACLAW_CONTROL_UI_MOUNT).toBeUndefined();
        delete require.cache[kMountModulePath];
        expect(require(kMountModulePath).kControlUiMount).toBe("basepath");
        delete require.cache[kMountModulePath];
      });
    });

    it("proxies /api paths except reserved setup prefixes", async () => {
      const { app, proxy } = createProxyApp({
        SETUP_API_PREFIXES: ["/api/setup"],
      });

      const proxied = await request(app).get("/api/gateway/thing");
      expect(proxied.status).toBe(200);
      expect(proxied.body.url).toBe("/api/gateway/thing");

      const reserved = await request(app).get("/api/setup/status");
      expect(reserved.status).toBe(404);
      expect(proxy.web).toHaveBeenCalledTimes(1);
    });

    it("routes hooks, webhook, and oauth paths to their middleware", async () => {
      const { app } = createProxyApp();
      expect((await request(app).post("/hooks/gmail")).status).toBe(204);
      expect((await request(app).post("/webhook/gmail")).status).toBe(204);
      expect((await request(app).get("/oauth/abc123")).status).toBe(204);
    });
  });

  it("returns 404 from the /v1 route itself when the API is disabled", async () => {
    const app = express();
    app.use(express.json());
    registerDefaults({ app, isOpenAiCompatApiEnabled: () => false });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer gateway-token")
      .send({ model: "openclaw/default" });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "Not found" });
  });

  it("returns 502 when the gateway URL is unparseable", async () => {
    const app = express();
    app.use(express.json());
    registerDefaults({ app, getGatewayUrl: () => "not a url" });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer gateway-token")
      .send({ model: "openclaw/default" });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Gateway unavailable" });
  });

  it("returns 502 when the gateway connection fails before headers", async () => {
    // Reserve a port, then close it so the connection is refused.
    const placeholder = http.createServer(() => {});
    const port = await listen(placeholder);
    await close(placeholder);

    const app = express();
    app.use(express.json());
    registerDefaults({ app, getGatewayUrl: () => `http://127.0.0.1:${port}` });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer gateway-token")
      .send({ model: "openclaw/default" });

    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "Gateway unavailable" });
  });

  it("forwards raw string bodies and empty bodies", async () => {
    const seen = [];
    upstream = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        seen.push({
          url: req.url,
          body: Buffer.concat(chunks).toString("utf8"),
          contentLength: req.headers["content-length"],
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
      });
    });
    const port = await listen(upstream);

    // Text parser produces string bodies.
    const textApp = express();
    textApp.use(express.text({ type: "text/plain" }));
    registerDefaults({ app: textApp, getGatewayUrl: () => `http://127.0.0.1:${port}` });

    const textRes = await request(textApp)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer gateway-token")
      .set("Content-Type", "text/plain")
      .send("raw-string-body");
    expect(textRes.status).toBe(200);

    // Without any body parser, req.body stays undefined and no body is sent.
    const bareApp = express();
    registerDefaults({ app: bareApp, getGatewayUrl: () => `http://127.0.0.1:${port}` });
    const emptyRes = await request(bareApp)
      .get("/v1/models")
      .set("Authorization", "Bearer gateway-token");
    expect(emptyRes.status).toBe(200);

    expect(seen[0].body).toBe("raw-string-body");
    expect(seen[0].contentLength).toBe(String("raw-string-body".length));
    expect(seen[1].url).toBe("/v1/models");
    expect(seen[1].body).toBe("");
    expect(seen[1].contentLength).toBeUndefined();
  });

  it("blocks locked clients before checking credentials", async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    const port = await listen(upstream);

    const app = express();
    app.use(express.json());
    registerDefaults({
      app,
      getGatewayUrl: () => `http://127.0.0.1:${port}`,
      openAiCompatApiThrottle: createApiAuthThrottle(),
    });

    const send = (token) =>
      request(app)
        .post("/v1/chat/completions")
        .set("Authorization", `Bearer ${token}`)
        .send({ model: "openclaw/default" });

    expect((await send("wrong-1")).status).toBe(401);
    // The second failure locks the client.
    expect((await send("wrong-2")).status).toBe(429);
    // The third request is blocked up-front by the evaluate step, even with
    // the correct token.
    const blocked = await send("gateway-token");
    expect(blocked.status).toBe(429);
    expect(blocked.headers["retry-after"]).toBeDefined();
  });

  it("records successful bearer auth with the throttle", async () => {
    upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const port = await listen(upstream);

    const throttle = createApiAuthThrottle();
    const successSpy = vi.spyOn(throttle, "recordLoginSuccess");
    const app = express();
    app.use(express.json());
    registerDefaults({
      app,
      getGatewayUrl: () => `http://127.0.0.1:${port}`,
      openAiCompatApiThrottle: throttle,
    });

    const res = await request(app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer gateway-token")
      .send({ model: "openclaw/default" });

    expect(res.status).toBe(200);
    expect(successSpy).toHaveBeenCalledWith("coverage-client");
  });

  describe("proxy response handling (unit)", () => {
    const getOpenAiHandler = (overrides = {}) => {
      const routes = [];
      const fakeApp = {
        all: (pattern, ...handlers) => routes.push({ pattern, handlers }),
      };
      registerDefaults({ app: fakeApp, ...overrides });
      const route = routes.find(
        (entry) => entry.pattern === kOpenAiCompatProxyPathPattern,
      );
      return route.handlers[route.handlers.length - 1];
    };

    const createFakeRes = () => {
      const res = new Writable({
        write(chunk, _encoding, callback) {
          res.chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      res.chunks = [];
      res.headers = {};
      res.headersSent = false;
      res.setHeader = vi.fn((key, value) => {
        res.headers[key.toLowerCase()] = value;
      });
      res.set = vi.fn(() => res);
      res.status = vi.fn(() => res);
      res.json = vi.fn(() => res);
      return res;
    };

    const createFakeReq = ({ originalUrl } = {}) => ({
      method: "POST",
      url: "/v1/chat/completions",
      ...(originalUrl === undefined ? {} : { originalUrl }),
      headers: { authorization: "Bearer gateway-token" },
      body: { model: "openclaw/default" },
    });

    const stubHttpRequest = () => {
      const state = { proxyReq: null, callback: null, options: null };
      vi.spyOn(http, "request").mockImplementation((options, callback) => {
        state.options = options;
        state.callback = callback;
        state.proxyReq = {
          handlers: {},
          on(event, handler) {
            this.handlers[event] = handler;
            return this;
          },
          write: vi.fn(),
          end: vi.fn(),
        };
        return state.proxyReq;
      });
      return state;
    };

    it("skips null header values and defaults missing status codes to 502", async () => {
      const state = stubHttpRequest();
      const handler = getOpenAiHandler();
      const req = createFakeReq({ originalUrl: "/v1/chat/completions?x=1" });
      const res = createFakeRes();

      handler(req, res);
      expect(state.options.path).toBe("/v1/chat/completions?x=1");
      expect(state.proxyReq.write).toHaveBeenCalled();
      expect(state.proxyReq.end).toHaveBeenCalled();

      const proxyRes = new Readable({ read() {} });
      proxyRes.statusCode = 0;
      proxyRes.headers = {
        "x-null-header": null,
        "x-kept": "yes",
        connection: "keep-alive",
        "set-cookie": "leak=1",
      };
      const finished = new Promise((resolve) => res.on("finish", resolve));
      state.callback(proxyRes);
      proxyRes.push("body");
      proxyRes.push(null);
      await finished;

      expect(res.statusCode).toBe(502);
      expect(res.headers["x-kept"]).toBe("yes");
      expect(res.headers["x-null-header"]).toBeUndefined();
      expect(res.headers.connection).toBeUndefined();
      expect(res.headers["set-cookie"]).toBeUndefined();
      expect(Buffer.concat(res.chunks).toString("utf8")).toBe("body");
    });

    it("falls back to req.url when originalUrl is missing", () => {
      const state = stubHttpRequest();
      const handler = getOpenAiHandler();
      handler(createFakeReq(), createFakeRes());
      expect(state.options.path).toBe("/v1/chat/completions");
    });

    it("ends the response when the gateway drops after headers were sent", () => {
      const state = stubHttpRequest();
      const handler = getOpenAiHandler();
      const req = createFakeReq();
      const res = createFakeRes();
      const endSpy = vi.spyOn(res, "end");

      handler(req, res);
      res.headersSent = true;
      state.proxyReq.handlers.error(new Error("socket hang up"));

      expect(endSpy).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});

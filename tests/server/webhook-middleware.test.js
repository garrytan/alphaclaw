const http = require("http");
const express = require("express");
const request = require("supertest");

const {
  createWebhookMiddleware,
  resolveHookIngress,
} = require("../../lib/server/webhook-middleware");

const createGatewaySpyServer = async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        bodyText: Buffer.concat(chunks).toString("utf8"),
      });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });

  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  const gatewayUrl = `http://127.0.0.1:${address.port}`;
  return { server, calls, gatewayUrl };
};

const createHookApp = ({ gatewayUrl, insertRequest = () => {} }) => {
  const app = express();
  app.use(["/hooks", "/webhook"], express.raw({ type: "*/*", limit: "5mb" }));
  app.use(
    createWebhookMiddleware({
      gatewayUrl,
      insertRequest,
      maxPayloadBytes: 1024 * 64,
    }),
  );
  return app;
};

describe("server/webhook-middleware", () => {
  // MW2: /hooks/* is unauthenticated; a Set-Cookie or hop-by-hop header from
  // the gateway must not cross back to the caller's browser.
  it("does not forward Set-Cookie or hop-by-hop headers from the gateway (MW2)", async () => {
    const server = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.setHeader("set-cookie", "session=leaked; Path=/");
        res.setHeader("connection", "keep-alive");
        res.setHeader("x-safe-header", "keep-me");
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const gatewayUrl = `http://127.0.0.1:${server.address().port}`;
    const app = createHookApp({ gatewayUrl });

    try {
      const response = await request(app).post("/hooks/any").send({ a: 1 });
      expect(response.status).toBe(200);
      expect(response.headers["set-cookie"]).toBeUndefined();
      expect(response.headers.connection).not.toBe("keep-alive");
      // A benign header still passes through.
      expect(response.headers["x-safe-header"]).toBe("keep-me");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("maps hook query params into forwarded JSON body", async () => {
    const { server, calls, gatewayUrl } = await createGatewaySpyServer();
    const app = createHookApp({ gatewayUrl });

    try {
      const response = await request(app).get(
        "/hooks/schwab-oauth?code=AUTH_CODE&session=SESSION_ID",
      );
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].url).toBe("/hooks/schwab-oauth?code=AUTH_CODE&session=SESSION_ID");
      expect(calls[0].headers["content-type"]).toContain("application/json");
      expect(JSON.parse(calls[0].bodyText)).toEqual({
        code: "AUTH_CODE",
        session: "SESSION_ID",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("keeps explicit JSON body values over query params", async () => {
    const { server, calls, gatewayUrl } = await createGatewaySpyServer();
    const app = createHookApp({ gatewayUrl });

    try {
      const response = await request(app)
        .post("/hooks/schwab-oauth?code=AUTH_CODE&session=SESSION_ID")
        .set("content-type", "application/json")
        .send(
          JSON.stringify({
            code: "BODY_CODE",
            extra: "from-body",
          }),
        );
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(JSON.parse(calls[0].bodyText)).toEqual({
        code: "BODY_CODE",
        session: "SESSION_ID",
        extra: "from-body",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("redacts oauth-style secrets in stored payload logs", async () => {
    const { server, calls, gatewayUrl } = await createGatewaySpyServer();
    const loggedRequests = [];
    const app = createHookApp({
      gatewayUrl,
      insertRequest: (entry) => loggedRequests.push(entry),
    });

    try {
      const response = await request(app).get(
        "/hooks/schwab-oauth?code=AUTH_CODE&session=SESSION_ID&refresh_token=REFRESH_TOKEN",
      );
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(JSON.parse(calls[0].bodyText)).toEqual({
        code: "AUTH_CODE",
        session: "SESSION_ID",
        refresh_token: "REFRESH_TOKEN",
      });

      expect(loggedRequests).toHaveLength(1);
      expect(JSON.parse(loggedRequests[0].payload)).toEqual({
        code: "[REDACTED]",
        session: "SESSION_ID",
        refresh_token: "[REDACTED]",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("moves query token into authorization header without body logging leak", async () => {
    const { server, calls, gatewayUrl } = await createGatewaySpyServer();
    const loggedRequests = [];
    const app = createHookApp({
      gatewayUrl,
      insertRequest: (entry) => loggedRequests.push(entry),
    });

    try {
      const response = await request(app).get("/hooks/schwab-oauth?token=SECRET_TOKEN");
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].headers.authorization).toBe("Bearer SECRET_TOKEN");
      expect(calls[0].url).toBe("/hooks/schwab-oauth");
      expect(calls[0].bodyText).toBe("{}");

      expect(loggedRequests).toHaveLength(1);
      expect(loggedRequests[0].headers.authorization).toBeUndefined();
      expect(loggedRequests[0].payload).toBe("{}");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("drops query token when authorization header already exists", async () => {
    const { server, calls, gatewayUrl } = await createGatewaySpyServer();
    const loggedRequests = [];
    const app = createHookApp({
      gatewayUrl,
      insertRequest: (entry) => loggedRequests.push(entry),
    });

    try {
      const response = await request(app)
        .get("/hooks/schwab-oauth?token=SECRET_TOKEN&session=SESSION_ID")
        .set("authorization", "Bearer HEADER_TOKEN");
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe("POST");
      expect(calls[0].headers.authorization).toBe("Bearer HEADER_TOKEN");
      expect(calls[0].url).toBe("/hooks/schwab-oauth?session=SESSION_ID");
      expect(JSON.parse(calls[0].bodyText)).toEqual({
        session: "SESSION_ID",
      });

      expect(loggedRequests).toHaveLength(1);
      expect(loggedRequests[0].headers.authorization).toBe("[REDACTED]");
      expect(JSON.parse(loggedRequests[0].payload)).toEqual({
        session: "SESSION_ID",
      });
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("flags a 200 that drops the durable-ingress header after a hook proved durable", async () => {
    // Spy gateway: return the durable header on the first request, then omit it.
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        requestCount += 1;
        res.statusCode = 200;
        if (requestCount === 1) {
          res.setHeader("x-openclaw-delivery-accepted", "durable");
        }
        res.end("");
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const gatewayUrl = `http://127.0.0.1:${server.address().port}`;

    const logged = [];
    const app = createHookApp({
      gatewayUrl,
      insertRequest: (entry) => logged.push(entry),
    });

    try {
      await request(app).post("/hooks/telegram").send({ update_id: 1 });
      await request(app).post("/hooks/telegram").send({ update_id: 2 });

      expect(logged).toHaveLength(2);
      // First request proved durable ingress — no annotation.
      expect(logged[0].gatewayBody).not.toContain("[NOT DURABLY ACCEPTED]");
      // Second dropped the header on a 200 — flagged.
      expect(logged[1].gatewayBody).toContain("[NOT DURABLY ACCEPTED]");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("strips identity, forwarded-evidence, and setup_token cookie from gateway-bound headers", async () => {
    const { server, calls, gatewayUrl } = await createGatewaySpyServer();
    const app = createHookApp({ gatewayUrl });

    try {
      const response = await request(app)
        .post("/hooks/schwab-oauth")
        .set("content-type", "application/json")
        .set("x-alphaclaw-user", "spoofed-operator")
        .set("x-openclaw-scopes", "operator.admin")
        .set("x-forwarded-for", "203.0.113.7")
        .set("forwarded", "for=203.0.113.7")
        .set("x-forwarded-server", "edge.example.com")
        .set("x-forwarded-port", "443")
        .set("x-real-ip", "203.0.113.7")
        .set("cookie", "theme=dark; setup_token=abc.def")
        .set("x-hook-custom", "kept")
        .send(JSON.stringify({ hello: "world" }));
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);

      const forwarded = calls[0].headers;
      // Identity headers must never reach a trusted-proxy gateway.
      expect(forwarded["x-alphaclaw-user"]).toBeUndefined();
      expect(forwarded["x-openclaw-scopes"]).toBeUndefined();
      // Client-controlled forwarded evidence must be stripped too — including
      // x-forwarded-server, added to the evidence list by the merge resolution.
      expect(forwarded["x-forwarded-for"]).toBeUndefined();
      expect(forwarded.forwarded).toBeUndefined();
      expect(forwarded["x-forwarded-server"]).toBeUndefined();
      expect(forwarded["x-forwarded-port"]).toBeUndefined();
      expect(forwarded["x-real-ip"]).toBeUndefined();
      // The AlphaClaw session cookie is removed; other cookies survive.
      expect(forwarded.cookie).toBe("theme=dark");
      // Benign headers still pass through.
      expect(forwarded["x-hook-custom"]).toBe("kept");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("does not flag hooks that never used durable ingress", async () => {
    const { server, gatewayUrl } = await createGatewaySpyServer();
    const logged = [];
    const app = createHookApp({
      gatewayUrl,
      insertRequest: (entry) => logged.push(entry),
    });
    try {
      await request(app).post("/hooks/discord").send({ x: 1 });
      expect(logged[0].gatewayBody).not.toContain("[NOT DURABLY ACCEPTED]");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("drops the cookie header entirely when setup_token is the only cookie", async () => {
    const { server, calls, gatewayUrl } = await createGatewaySpyServer();
    const app = createHookApp({ gatewayUrl });

    try {
      const response = await request(app)
        .post("/hooks/schwab-oauth")
        .set("content-type", "application/json")
        .set("cookie", "setup_token=abc.def")
        .send(JSON.stringify({ hello: "world" }));
      expect(response.status).toBe(200);
      expect(calls).toHaveLength(1);
      expect(calls[0].headers.cookie).toBeUndefined();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

// Fix wave F058/F149/F151/F211 — the ingress is unauthenticated, so it is
// exercised here exactly as production mounts it (routes/proxy.js:
// app.all(/^\/hooks\/.+/) + express.raw) with RAW http requests, because
// supertest/superagent normalize dot segments client-side and would hide the
// traversal.
const kHooksPathPattern = /^\/hooks\/.+/;
const kWebhookPathPattern = /^\/webhook\/.+/;

const createProductionShapedApp = ({ gatewayUrl, insertRequest = () => {}, gatewayTimeoutMs }) => {
  const app = express();
  app.use(["/webhook", "/hooks"], express.raw({ type: "*/*", limit: "5mb" }));
  const middleware = createWebhookMiddleware({
    gatewayUrl,
    insertRequest,
    maxPayloadBytes: 1024 * 64,
    ...(gatewayTimeoutMs ? { gatewayTimeoutMs } : {}),
  });
  app.all(kHooksPathPattern, middleware);
  app.all(kWebhookPathPattern, middleware);
  // Distinguish the middleware's own 404 from Express falling through.
  app.use((req, res) => res.status(404).json({ error: "fallthrough" }));
  return app;
};

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const rawRequest = ({ port, method = "POST", path, headers = {}, body = "{}" }) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          ...headers,
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8"), headers: res.headers }),
        );
        res.on("aborted", () => resolve({ status: res.statusCode, body: null, aborted: true }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });

describe("server/webhook-middleware ingress containment (raw request-targets)", () => {
  let gateway;
  let appServer;
  let port;
  let rows;
  let warn;

  beforeEach(async () => {
    gateway = await createGatewaySpyServer();
    rows = [];
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    appServer = http.createServer(
      createProductionShapedApp({
        gatewayUrl: gateway.gatewayUrl,
        insertRequest: (row) => rows.push(row),
      }),
    );
    port = await listen(appServer);
  });

  afterEach(async () => {
    await new Promise((resolve) => appServer.close(resolve));
    await new Promise((resolve) => gateway.server.close(resolve));
  });

  const rejected = [
    ["dot-segment traversal", "/hooks/../tools/invoke", 404],
    ["percent-encoded dot segment", "/hooks/%2e%2e/tools/invoke", 404],
    ["double-encoded dot segment", "/hooks/%252e%252e/x", 404],
    ["nested traversal", "/hooks/a/../../v1/chat/completions", 404],
    ["encoded slash", "/hooks/a%2Fb", 404],
    ["encoded backslash", "/hooks/a%5Cb", 404],
    ["NUL byte", "/hooks/a%00b", 404],
    ["empty segment (double slash)", "/hooks//gmail", 404],
    ["too many segments", "/hooks/a/b/c/d", 404],
    ["single dot", "/hooks/./x", 404],
    ["malformed percent encoding", "/hooks/%zz", 400],
  ];

  for (const [label, path, status] of rejected) {
    it(`rejects ${label} (${path} → ${status}) without touching the gateway`, async () => {
      const response = await rawRequest({ port, path: `${path}?token=SECRET_QS` });
      expect(response.status).toBe(status);
      expect(response.body).not.toBe(JSON.stringify({ error: "fallthrough" }));
      expect(gateway.calls).toHaveLength(0);
      expect(rows).toHaveLength(0);
      // One audit line, with the path but never the query string.
      expect(warn).toHaveBeenCalledTimes(1);
      const line = String(warn.mock.calls[0][0]);
      expect(line).toContain("[hooks] rejected ingress reason=");
      expect(line).not.toContain("SECRET_QS");
    });
  }

  it("strips control characters from the audited path (no log injection)", async () => {
    await rawRequest({ port, path: "/hooks/%0a%0d[alphaclaw]%20forged%20line/../x" });
    const line = String(warn.mock.calls[0][0]);
    expect(line).not.toMatch(/[\r\n]/);
    expect(line).toContain("reason=");
  });

  it("forwards a valid hook, rebuilding the gateway path from the validated segment", async () => {
    const response = await rawRequest({ port, path: "/hooks/gmail?x=1" });
    expect(response.status).toBe(200);
    expect(gateway.calls).toHaveLength(1);
    expect(gateway.calls[0].url).toBe("/hooks/gmail?x=1");
    expect(rows).toHaveLength(1);
    expect(rows[0].hookName).toBe("gmail");
    expect(warn).not.toHaveBeenCalled();
  });

  it("maps the legacy /webhook prefix and keeps bounded nested segments", async () => {
    await rawRequest({ port, path: "/webhook/schwab-oauth" });
    await rawRequest({ port, path: "/hooks/agent/wake" });
    expect(gateway.calls.map((call) => call.url)).toEqual(["/hooks/schwab-oauth", "/hooks/agent/wake"]);
  });

  it("re-encodes a segment that decodes cleanly (encoded hyphen round-trips)", async () => {
    await rawRequest({ port, path: "/hooks/schwab%2Doauth" });
    expect(gateway.calls[0].url).toBe("/hooks/schwab-oauth");
  });

  it("redacts x-openclaw-token and the Telegram secret header in the stored request log (F149)", async () => {
    await rawRequest({
      port,
      path: "/hooks/telegram",
      headers: {
        "x-openclaw-token": "hook-token-plaintext",
        "x-telegram-bot-api-secret-token": "tg-secret",
        "x-webhook-token": "legacy",
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].headers["x-openclaw-token"]).toBe("[REDACTED]");
    expect(rows[0].headers["x-telegram-bot-api-secret-token"]).toBe("[REDACTED]");
    expect(rows[0].headers["x-webhook-token"]).toBe("[REDACTED]");
    expect(JSON.stringify(rows[0])).not.toContain("hook-token-plaintext");
    // The gateway still receives the real header — only the LOG is redacted.
    expect(gateway.calls[0].headers["x-openclaw-token"]).toBe("hook-token-plaintext");
  });
});

describe("server/webhook-middleware forwarder robustness (F151)", () => {
  const withSockets = (server) => {
    const sockets = new Set();
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    return () => {
      for (const socket of sockets) socket.destroy();
    };
  };

  it("answers 504 and logs a row when the gateway is listening but never responds", async () => {
    const stalled = http.createServer(() => {
      /* hold the request open forever */
    });
    const destroySockets = withSockets(stalled);
    const gatewayPort = await listen(stalled);
    const rows = [];
    const appServer = http.createServer(
      createProductionShapedApp({
        gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
        insertRequest: (row) => rows.push(row),
        gatewayTimeoutMs: 150,
      }),
    );
    const port = await listen(appServer);
    try {
      const response = await rawRequest({ port, path: "/hooks/slow" });
      expect(response.status).toBe(504);
      expect(rows).toHaveLength(1);
      expect(rows[0].gatewayStatus).toBe(504);
      expect(rows[0].gatewayBody).toContain("did not answer within 150ms");
    } finally {
      destroySockets();
      await new Promise((resolve) => appServer.close(resolve));
      await new Promise((resolve) => stalled.close(resolve));
    }
  });

  it("logs a 499 row and drops the upstream request when the caller hangs up first", async () => {
    let upstreamAborted = false;
    const slow = http.createServer((req) => {
      req.on("aborted", () => {
        upstreamAborted = true;
      });
      req.on("close", () => {
        upstreamAborted = true;
      });
      // never answers within the test window
    });
    const destroySockets = withSockets(slow);
    const gatewayPort = await listen(slow);
    const rows = [];
    const appServer = http.createServer(
      createProductionShapedApp({
        gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
        insertRequest: (row) => rows.push(row),
        gatewayTimeoutMs: 5000,
      }),
    );
    const port = await listen(appServer);
    try {
      const body = "{}";
      const req = http.request({
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/hooks/abandoned",
        headers: { "content-type": "application/json", "content-length": body.length },
      });
      req.on("error", () => {});
      req.end(body);
      await new Promise((resolve) => setTimeout(resolve, 60));
      req.destroy();
      await vi.waitFor(() => expect(rows).toHaveLength(1), { timeout: 2000 });
      expect(rows[0].gatewayStatus).toBe(499);
      expect(rows[0].gatewayBody).toContain("client closed");
      await vi.waitFor(() => expect(upstreamAborted).toBe(true), { timeout: 2000 });
    } finally {
      destroySockets();
      await new Promise((resolve) => appServer.close(resolve));
      await new Promise((resolve) => slow.close(resolve));
    }
  });

  it("logs an upstream-abort row when the gateway dies mid-response", async () => {
    const flaky = http.createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json", "content-length": "1000" });
        res.write('{"partial":');
        setTimeout(() => res.socket.destroy(), 20);
      });
    });
    const gatewayPort = await listen(flaky);
    const rows = [];
    const appServer = http.createServer(
      createProductionShapedApp({
        gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
        insertRequest: (row) => rows.push(row),
      }),
    );
    const port = await listen(appServer);
    try {
      await rawRequest({ port, path: "/hooks/flaky" }).catch(() => null);
      await vi.waitFor(() => expect(rows).toHaveLength(1), { timeout: 2000 });
      expect(rows[0].gatewayBody).toMatch(/\[UPSTREAM (ABORTED|ERROR)\]/);
    } finally {
      await new Promise((resolve) => appServer.close(resolve));
      await new Promise((resolve) => flaky.close(resolve));
    }
  });
});

describe("server/webhook-middleware resolveHookIngress (unit)", () => {
  it("accepts one to three clean segments and rebuilds the gateway path", () => {
    expect(resolveHookIngress("/hooks/gmail?x=1")).toMatchObject({
      ok: true,
      hookName: "gmail",
      gatewayPath: "/hooks/gmail",
    });
    expect(resolveHookIngress("/webhook/a/b_c/d.e")).toMatchObject({
      ok: true,
      hookName: "a",
      gatewayPath: "/hooks/a/b_c/d.e",
    });
  });

  it("names a distinct reason per rejection class", () => {
    expect(resolveHookIngress("/hooks/../x").reason).toBe("dot_segment");
    expect(resolveHookIngress("/hooks/%2e%2e/x").reason).toBe("dot_segment");
    expect(resolveHookIngress("/hooks/%252e%252e/x").reason).toBe("double_encoded");
    expect(resolveHookIngress("/hooks/a%2Fb").reason).toBe("segment_chars");
    expect(resolveHookIngress("/hooks/a/b/c/d").reason).toBe("too_many_segments");
    expect(resolveHookIngress("/hooks//x").reason).toBe("empty_segment");
    expect(resolveHookIngress("/hooks/%zz")).toMatchObject({ status: 400, reason: "bad_percent_encoding" });
    expect(resolveHookIngress("/api/status").reason).toBe("prefix");
    expect(resolveHookIngress("hooks/x").reason).toBe("shape");
  });
});

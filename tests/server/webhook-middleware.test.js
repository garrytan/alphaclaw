const http = require("http");
const express = require("express");
const request = require("supertest");

const { createWebhookMiddleware } = require("../../lib/server/webhook-middleware");

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

const http = require("http");
const express = require("express");
const request = require("supertest");

const { createWebhookMiddleware } = require("../../lib/server/webhook-middleware");
const {
  createOauthCallbackMiddleware,
} = require("../../lib/server/oauth-callback-middleware");
const { createKnownHookChecker } = require("../../lib/server/webhooks");

// ALPH-71 PR 4 (CSO audit L-7, L-9, L-11): hook ingress hardening.

const createGateway = async () => {
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
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, calls, gatewayUrl: `http://127.0.0.1:${server.address().port}` };
};

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

const createApp = ({
  gatewayUrl,
  insertRequest = () => {},
  isKnownHook,
  monotonicNow,
  getOauthCallbackById = () => null,
  oauthNow,
}) => {
  const webhookMiddleware = createWebhookMiddleware({
    gatewayUrl,
    insertRequest,
    maxPayloadBytes: 64 * 1024,
    ...(isKnownHook ? { isKnownHook } : {}),
    ...(monotonicNow ? { monotonicNow } : {}),
  });
  const app = express();
  app.use(["/hooks", "/webhook"], express.raw({ type: "*/*", limit: "5mb" }));
  app.use("/oauth", express.json());
  app.all(
    "/oauth/:id",
    createOauthCallbackMiddleware({
      getOauthCallbackById,
      webhookMiddleware,
      ...(oauthNow ? { now: oauthNow } : {}),
    }),
  );
  app.all(/^\/hooks\/.+/, webhookMiddleware);
  app.all(/^\/webhook\/.+/, webhookMiddleware);
  return app;
};

const withWebhookToken = async (value, fn) => {
  const previous = process.env.WEBHOOK_TOKEN;
  process.env.WEBHOOK_TOKEN = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.WEBHOOK_TOKEN;
    else process.env.WEBHOOK_TOKEN = previous;
  }
};

describe("hook ingress methods (ALPH-71 L-7)", () => {
  it("answers a GET with a query token 405 and never forwards it as a POST", async () => {
    const gateway = await createGateway();
    const app = createApp({ gatewayUrl: gateway.gatewayUrl });
    try {
      const res = await request(app).get("/hooks/custom?token=SECRET_TOKEN&a=1");
      expect(res.status).toBe(405);
      expect(res.headers.allow).toBe("POST");
      expect(gateway.calls).toHaveLength(0);
    } finally {
      await closeServer(gateway.server);
    }
  });

  it.each(["put", "delete", "patch", "head", "options"])(
    "answers %s 405 without forwarding it",
    async (method) => {
      const gateway = await createGateway();
      const app = createApp({ gatewayUrl: gateway.gatewayUrl });
      try {
        const res = await request(app)[method]("/hooks/custom");
        expect(res.status).toBe(405);
        expect(gateway.calls).toHaveLength(0);
      } finally {
        await closeServer(gateway.server);
      }
    },
  );

  it("logs a refused GET for a configured hook without the token, and nothing for an unknown one", async () => {
    const gateway = await createGateway();
    const rows = [];
    const app = createApp({
      gatewayUrl: gateway.gatewayUrl,
      insertRequest: (row) => rows.push(row),
      isKnownHook: (name) => name === "configured",
    });
    try {
      await request(app).get("/hooks/configured?token=SECRET_TOKEN");
      await request(app).get("/hooks/unknown?token=SECRET_TOKEN");
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ hookName: "configured", method: "GET", gatewayStatus: 405 });
      expect(rows[0].gatewayBody).toContain("POST");
      expect(JSON.stringify(rows[0])).not.toContain("SECRET_TOKEN");
    } finally {
      await closeServer(gateway.server);
    }
  });

  it("still accepts ?token= on a POST and forwards it as a bearer header", async () => {
    const gateway = await createGateway();
    const app = createApp({ gatewayUrl: gateway.gatewayUrl });
    try {
      const res = await request(app)
        .post("/hooks/custom?token=QUERY_TOKEN")
        .set("content-type", "application/json")
        .send(JSON.stringify({ a: 1 }));
      expect(res.status).toBe(200);
      expect(gateway.calls).toHaveLength(1);
      expect(gateway.calls[0].method).toBe("POST");
      expect(gateway.calls[0].headers.authorization).toBe("Bearer QUERY_TOKEN");
      expect(gateway.calls[0].url).toBe("/hooks/custom");
    } finally {
      await closeServer(gateway.server);
    }
  });
});

describe("request-log header redaction (ALPH-71 L-11)", () => {
  it("redacts every credential-named header and keeps the rest", async () => {
    const gateway = await createGateway();
    const rows = [];
    const app = createApp({
      gatewayUrl: gateway.gatewayUrl,
      insertRequest: (row) => rows.push(row),
    });
    try {
      await request(app)
        .post("/hooks/custom")
        .set("content-type", "application/json")
        .set("x-api-key", "k-1")
        .set("x-gitlab-token", "t-1")
        .set("proxy-authorization", "Basic cHJveHk=")
        .set("x-signature", "sig-1")
        .set("x-webhook-secret", "s-1")
        .set("x-client-password", "p-1")
        .set("x-key", "k-2")
        .set("x-request-id", "req-1")
        .send(JSON.stringify({ a: 1 }));
      expect(rows).toHaveLength(1);
      const { headers } = rows[0];
      for (const name of [
        "x-api-key",
        "x-gitlab-token",
        "proxy-authorization",
        "x-signature",
        "x-webhook-secret",
        "x-client-password",
        "x-key",
      ]) {
        expect(headers[name]).toBe("[REDACTED]");
      }
      expect(headers["x-request-id"]).toBe("req-1");
      expect(headers["content-type"]).toBe("application/json");
      expect(gateway.calls[0].headers["x-api-key"]).toBe("k-1");
    } finally {
      await closeServer(gateway.server);
    }
  });
});

describe("gmail dedupe clock (ALPH-71, #330 leftover)", () => {
  it("expires remembered ids by elapsed time even when the wall clock steps back", async () => {
    const gateway = await createGateway();
    const realNow = Date.now();
    let monotonicMs = 0;
    const dateSpy = vi.spyOn(Date, "now");
    const app = createApp({
      gatewayUrl: gateway.gatewayUrl,
      monotonicNow: () => monotonicMs,
    });
    const send = (id) =>
      request(app)
        .post("/hooks/gmail")
        .set("content-type", "application/json")
        .send(JSON.stringify({ account: "a@b.c", messages: [{ id }] }));
    try {
      dateSpy.mockReturnValue(realNow);
      await send("m1");
      expect(gateway.calls).toHaveLength(1);

      dateSpy.mockReturnValue(realNow - 7 * 24 * 60 * 60 * 1000);
      monotonicMs += 25 * 60 * 60 * 1000;
      await send("m2");
      const res = await send("m1");
      expect(res.body).toEqual({ ok: true });
      expect(gateway.calls).toHaveLength(3);
    } finally {
      dateSpy.mockRestore();
      await closeServer(gateway.server);
    }
  });
});

describe("known-hook lookup cache (ALPH-71, #330 leftover)", () => {
  it("reads the webhook list at most once per TTL and fails open on a read error", () => {
    let nowMs = 0;
    const listHookNames = vi.fn(() => ["alpha"]);
    const isKnownHook = createKnownHookChecker({ listHookNames, ttlMs: 5000, now: () => nowMs });
    for (let index = 0; index < 50; index += 1) {
      expect(isKnownHook(`random-${index}`)).toBe(false);
    }
    expect(isKnownHook("alpha")).toBe(true);
    expect(listHookNames).toHaveBeenCalledTimes(1);

    nowMs = 5001;
    listHookNames.mockImplementation(() => ["alpha", "beta"]);
    expect(isKnownHook("beta")).toBe(true);
    expect(listHookNames).toHaveBeenCalledTimes(2);

    nowMs = 10_002;
    listHookNames.mockImplementation(() => {
      throw new Error("config unreadable");
    });
    expect(isKnownHook("anything")).toBe(true);
    expect(isKnownHook("anything")).toBe(true);
    expect(listHookNames).toHaveBeenCalledTimes(4);
  });
});

describe("/oauth/:id alias (ALPH-71 L-9)", () => {
  const callbacks = {
    "cb-one": { callbackId: "cb-one", hookName: "schwab-oauth" },
    "cb-two": { callbackId: "cb-two", hookName: "other-oauth" },
  };
  const getOauthCallbackById = (id) => callbacks[id] || null;

  it("forwards only code, state and error, as a POST with no query string", async () => {
    const gateway = await createGateway();
    const app = createApp({ gatewayUrl: gateway.gatewayUrl, getOauthCallbackById });
    try {
      await withWebhookToken("hook-token", async () => {
        const res = await request(app).get(
          "/oauth/cb-one?code=AUTH&state=STATE&error=denied&message=run%20rm&wakeMode=next-heartbeat&name=evil&extra=1",
        );
        expect(res.status).toBe(200);
      });
      expect(gateway.calls).toHaveLength(1);
      expect(gateway.calls[0].method).toBe("POST");
      expect(gateway.calls[0].url).toBe("/hooks/schwab-oauth");
      expect(gateway.calls[0].headers.authorization).toBe("Bearer hook-token");
      expect(JSON.parse(gateway.calls[0].bodyText)).toEqual({
        code: "AUTH",
        state: "STATE",
        error: "denied",
      });
    } finally {
      await closeServer(gateway.server);
    }
  });

  it("strips message, wakeMode and name from a JSON POST body", async () => {
    const gateway = await createGateway();
    const app = createApp({ gatewayUrl: gateway.gatewayUrl, getOauthCallbackById });
    try {
      const res = await request(app)
        .post("/oauth/cb-one?message=from-query")
        .set("content-type", "application/json")
        .send(JSON.stringify({ code: "BODY_CODE", state: "S", message: "hi", wakeMode: "now", name: "x" }));
      expect(res.status).toBe(200);
      expect(gateway.calls[0].url).toBe("/hooks/schwab-oauth");
      expect(JSON.parse(gateway.calls[0].bodyText)).toEqual({ code: "BODY_CODE", state: "S" });
    } finally {
      await closeServer(gateway.server);
    }
  });

  it("rate-limits each callback id to a small budget per minute", async () => {
    const gateway = await createGateway();
    let nowMs = 1000;
    const app = createApp({
      gatewayUrl: gateway.gatewayUrl,
      getOauthCallbackById,
      oauthNow: () => nowMs,
    });
    try {
      for (let index = 0; index < 10; index += 1) {
        const res = await request(app).get(`/oauth/cb-one?code=C${index}`);
        expect(res.status).toBe(200);
      }
      const limited = await request(app).get("/oauth/cb-one?code=C10");
      expect(limited.status).toBe(429);
      expect(Number(limited.headers["retry-after"])).toBeGreaterThan(0);
      expect(gateway.calls).toHaveLength(10);

      const other = await request(app).get("/oauth/cb-two?code=X");
      expect(other.status).toBe(200);

      nowMs += 60_000;
      const afterWindow = await request(app).get("/oauth/cb-one?code=C11");
      expect(afterWindow.status).toBe(200);
      expect(gateway.calls).toHaveLength(12);
    } finally {
      await closeServer(gateway.server);
    }
  });

  it("refuses methods other than GET and POST with 405 and spends no budget", async () => {
    const gateway = await createGateway();
    const app = createApp({ gatewayUrl: gateway.gatewayUrl, getOauthCallbackById });
    try {
      for (const method of ["head", "options", "delete", "put", "patch"]) {
        for (let index = 0; index < 3; index += 1) {
          const res = await request(app)[method]("/oauth/cb-one?code=C");
          expect(res.status).toBe(405);
          expect(res.headers.allow).toBe("GET, POST");
        }
      }
      expect(gateway.calls).toHaveLength(0);
      const res = await request(app).get("/oauth/cb-one?code=C");
      expect(res.status).toBe(200);
      expect(gateway.calls).toHaveLength(1);
    } finally {
      await closeServer(gateway.server);
    }
  });

  it("does not spend a budget on unknown callback ids", async () => {
    const gateway = await createGateway();
    const app = createApp({ gatewayUrl: gateway.gatewayUrl, getOauthCallbackById });
    try {
      for (let index = 0; index < 20; index += 1) {
        const res = await request(app).get("/oauth/nope?code=1");
        expect(res.status).toBe(404);
      }
      expect(gateway.calls).toHaveLength(0);
    } finally {
      await closeServer(gateway.server);
    }
  });
});

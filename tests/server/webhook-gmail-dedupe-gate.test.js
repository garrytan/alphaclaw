const http = require("http");
const express = require("express");
const request = require("supertest");

const { createWebhookMiddleware } = require("../../lib/server/webhook-middleware");

// GST-1743: /hooks/gmail is unauthenticated and the gateway checks the hook
// token only after AlphaClaw forwards. Dedupe ids must be remembered only for
// deliveries the gateway accepted, and the memory they take must stay bounded.

const createGateway = async ({ status = 200 } = {}) => {
  const calls = [];
  const state = { status };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls.push(Buffer.concat(chunks).toString("utf8"));
      res.statusCode = state.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: state.status < 300 }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, calls, state, gatewayUrl: `http://127.0.0.1:${server.address().port}` };
};

const createApp = ({ gatewayUrl, insertRequest = () => {}, isKnownHook }) => {
  const middleware = createWebhookMiddleware({
    gatewayUrl,
    insertRequest,
    maxPayloadBytes: 1024 * 64,
    ...(isKnownHook ? { isKnownHook } : {}),
  });
  const app = express();
  app.use(["/hooks", "/webhook"], express.raw({ type: "*/*", limit: "5mb" }));
  app.all(/^\/hooks\/.+/, middleware);
  app.all(/^\/webhook\/.+/, middleware);
  return { app, middleware };
};

const messageIds = (prefix, count) =>
  Array.from({ length: count }, (_, index) => ({ id: `${prefix}-${index}` }));

const postGmail = (app, body, path = "/hooks/gmail") =>
  request(app).post(path).set("content-type", "application/json").send(JSON.stringify(body));

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

describe("server/webhook-middleware gmail dedupe gate (GST-1743)", { retry: 1 }, () => {
  it("remembers no ids from deliveries the gateway rejects for auth", async () => {
    const gateway = await createGateway({ status: 401 });
    const { app, middleware } = createApp({ gatewayUrl: gateway.gatewayUrl });
    try {
      for (let round = 0; round < 3; round += 1) {
        const response = await postGmail(app, {
          account: "victim@example.com",
          messages: messageIds(`r${round}`, 2000),
        });
        expect(response.status).toBe(401);
        expect(middleware.getGmailDedupeSize()).toBe(0);
      }
      const replay = await postGmail(
        app,
        { account: "victim@example.com", messages: messageIds("r0", 2000) },
        "/webhook/gmail",
      );
      expect(replay.status).toBe(401);
      expect(middleware.getGmailDedupeSize()).toBe(0);
      expect(gateway.calls).toHaveLength(4);
      expect(JSON.parse(gateway.calls[3]).messages).toHaveLength(2000);
    } finally {
      await closeServer(gateway.server);
    }
  });

  it("marks ids after a 2xx and dedupes a later retry", async () => {
    const gateway = await createGateway({ status: 401 });
    const { app, middleware } = createApp({ gatewayUrl: gateway.gatewayUrl });
    const body = { account: "a@b.c", messages: messageIds("m", 3) };
    try {
      expect((await postGmail(app, body)).status).toBe(401);
      expect(middleware.getGmailDedupeSize()).toBe(0);

      gateway.state.status = 202;
      expect((await postGmail(app, body)).status).toBe(202);
      expect(middleware.getGmailDedupeSize()).toBe(3);
      expect(JSON.parse(gateway.calls[1]).messages).toHaveLength(3);

      const retry = await postGmail(app, body);
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual({ ok: true, deduped: true });
      expect(gateway.calls).toHaveLength(2);
    } finally {
      await closeServer(gateway.server);
    }
  });

  it("forwards a genuine delivery that overlaps a forged one carrying the same ids", async () => {
    const calls = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        calls.push(Buffer.concat(chunks).toString("utf8"));
        const authorized = req.headers.authorization === "Bearer hook-token";
        setTimeout(() => {
          res.statusCode = authorized ? 200 : 401;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ ok: authorized }));
        }, 50);
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { app, middleware } = createApp({ gatewayUrl: `http://127.0.0.1:${server.address().port}` });
    const body = JSON.stringify({ account: "a@b.c", messages: messageIds("live", 2) });
    try {
      const [forged, genuine] = await Promise.all([
        request(app).post("/hooks/gmail").set("content-type", "application/json").send(body),
        request(app)
          .post("/hooks/gmail")
          .set("content-type", "application/json")
          .set("authorization", "Bearer hook-token")
          .send(body),
      ]);
      expect(forged.status).toBe(401);
      expect(genuine.status).toBe(200);
      expect(calls).toHaveLength(2);
      expect(calls.every((call) => JSON.parse(call).messages.length === 2)).toBe(true);
      expect(middleware.getGmailDedupeSize()).toBe(2);
    } finally {
      await closeServer(server);
    }
  });

  it("dedupe-marks at most 500 ids per request and forwards the rest unmarked", async () => {
    const gateway = await createGateway();
    const { app, middleware } = createApp({ gatewayUrl: gateway.gatewayUrl });
    const body = { account: "a@b.c", messages: messageIds("bulk", 1200) };
    try {
      expect((await postGmail(app, body)).status).toBe(200);
      expect(JSON.parse(gateway.calls[0]).messages).toHaveLength(1200);
      expect(middleware.getGmailDedupeSize()).toBe(500);

      expect((await postGmail(app, body)).status).toBe(200);
      const forwarded = JSON.parse(gateway.calls[1]).messages;
      expect(forwarded).toHaveLength(700);
      expect(forwarded[0]).toEqual({ id: "bulk-500" });
      expect(middleware.getGmailDedupeSize()).toBe(1000);
    } finally {
      await closeServer(gateway.server);
    }
  });

  it("still filters already-seen ids past the per-request marking cap", async () => {
    const gateway = await createGateway();
    const { app, middleware } = createApp({ gatewayUrl: gateway.gatewayUrl });
    try {
      await postGmail(app, { account: "a@b.c", messages: [{ id: "already-seen" }] });
      expect(middleware.getGmailDedupeSize()).toBe(1);

      await postGmail(app, {
        account: "a@b.c",
        messages: [...messageIds("fresh", 500), { id: "already-seen" }],
      });
      const forwarded = JSON.parse(gateway.calls[1]).messages;
      expect(forwarded).toHaveLength(500);
      expect(forwarded).not.toContainEqual({ id: "already-seen" });
      expect(middleware.getGmailDedupeSize()).toBe(501);
    } finally {
      await closeServer(gateway.server);
    }
  });

  it("dedupes an oversized account by digest and never remembers oversized ids", async () => {
    const gateway = await createGateway();
    const { app, middleware } = createApp({ gatewayUrl: gateway.gatewayUrl });
    const account = `${"a".repeat(64 * 1024)}@example.com`;
    const longId = "x".repeat(129);
    try {
      await postGmail(app, { account, messages: [{ id: "m1" }, { id: longId }] });
      expect(middleware.getGmailDedupeSize()).toBe(1);

      await postGmail(app, { account, messages: [{ id: "m1" }, { id: longId }] });
      expect(JSON.parse(gateway.calls[1]).messages).toEqual([{ id: longId }]);
      expect(middleware.getGmailDedupeSize()).toBe(1);
    } finally {
      await closeServer(gateway.server);
    }
  });

  it("caps the dedupe map at 50,000 entries, evicting the oldest first", async () => {
    const gateway = await createGateway();
    const { app, middleware } = createApp({ gatewayUrl: gateway.gatewayUrl });
    try {
      for (let round = 0; round < 101; round += 1) {
        await postGmail(app, { account: "a@b.c", messages: messageIds(`c${round}`, 500) });
      }
      expect(middleware.getGmailDedupeSize()).toBe(50_000);

      const newest = await postGmail(app, { account: "a@b.c", messages: messageIds("c100", 1) });
      expect(newest.body).toEqual({ ok: true, deduped: true });

      const oldest = await postGmail(app, { account: "a@b.c", messages: messageIds("c0", 1) });
      expect(oldest.body).toEqual({ ok: true });
      expect(middleware.getGmailDedupeSize()).toBe(50_000);
    } finally {
      await closeServer(gateway.server);
    }
  }, 60_000);
});

describe("server/webhook-middleware request log for unknown hooks (GST-1743)", { retry: 1 }, () => {
  const deliver = async ({ status, known, method = "post" }) => {
    const gateway = await createGateway({ status });
    const rows = [];
    const { app } = createApp({
      gatewayUrl: gateway.gatewayUrl,
      insertRequest: (row) => rows.push(row),
      isKnownHook: (hookName) => (known ? hookName === "random-name" : false),
    });
    try {
      const response = await request(app)[method]("/hooks/random-name")
        .set("content-type", "application/json")
        .send(JSON.stringify({ a: 1 }));
      expect(response.status).toBe(status);
      return rows;
    } finally {
      await closeServer(gateway.server);
    }
  };

  it.each([400, 401, 403, 404, 405, 429, 500])(
    "writes no row when the gateway answers %i for an unknown hook",
    async (status) => {
      expect(await deliver({ status, known: false })).toHaveLength(0);
    },
  );

  it("writes no row for a non-POST method the gateway refuses with 405 before its token check", async () => {
    expect(await deliver({ status: 405, known: false, method: "put" })).toHaveLength(0);
  });

  it("writes no row for an unknown hook when the gateway is unreachable", async () => {
    const gateway = await createGateway();
    const { gatewayUrl } = gateway;
    await closeServer(gateway.server);
    const rows = [];
    const { app } = createApp({
      gatewayUrl,
      insertRequest: (row) => rows.push(row),
      isKnownHook: () => false,
    });
    const response = await postGmail(app, { a: 1 }, "/hooks/random-name");
    expect(response.status).toBe(502);
    expect(rows).toHaveLength(0);
  });

  it.each([401, 405, 429])("still logs a %i for a configured hook", async (status) => {
    const rows = await deliver({ status, known: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hookName: "random-name", gatewayStatus: status });
  });

  it("still logs an accepted delivery for an unknown hook", async () => {
    const rows = await deliver({ status: 200, known: false });
    expect(rows).toHaveLength(1);
    expect(rows[0].gatewayStatus).toBe(200);
  });
});

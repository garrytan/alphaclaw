const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const crypto = require("crypto");
const express = require("express");
const request = require("supertest");

const { createWebhookMiddleware } = require("../../lib/server/webhook-middleware");
const { createOauthCallbackMiddleware } = require("../../lib/server/oauth-callback-middleware");
const { createHookIngress } = require("../../lib/server/hook-ingress");
const { hookIngressSecretsPath } = require("../../lib/server/hook-ingress/policy");
const { backupHookIngress, kHookIngressBackupMarker } = require("../../lib/server/hook-ingress/backup");
const { registerWebhookRoutes } = require("../../lib/server/routes/webhooks");
const webhooksDb = require("../../lib/server/db/webhooks");

// GST-2134 PR 2: per-sender verification, replay suppression, the 24 h
// shared-token overlap and fail-closed policy and secrets.

const kShared = ["shared", "hook", "value"].join("-");
const kHour = 60 * 60 * 1000;
const kDay = 24 * kHour;
const kTokenRef = "$" + "{WEBHOOK_TOKEN}";
const randomSecret = () => crypto.randomBytes(24).toString("base64url");
const bearer = (value) => ["Bearer", value].join(" ");
const hmacHex = (key, text) => crypto.createHmac("sha256", key).update(text).digest("hex");
const hmacB64 = (key, text) => crypto.createHmac("sha256", key).update(text).digest("base64");

const createGateway = async ({ delayMs = 0, status = 200 } = {}) => {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      setTimeout(() => {
        res.statusCode = gateway.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      }, delayMs);
    });
  });
  const gateway = { server, calls, status };
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  gateway.gatewayUrl = "http://127.0.0.1:" + server.address().port;
  return gateway;
};

const scratch = [];
const mkdir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-senders-"));
  scratch.push(dir);
  return dir;
};

const createHarness = async ({ knownHooks = ["calendar", "meetings", "phone", "cams", "gmail"], gatewayOptions = {}, dirs = null, replayOverride = null } = {}) => {
  const gateway = await createGateway(gatewayOptions);
  const openclawDir = dirs?.openclawDir || mkdir();
  const rootDir = dirs?.rootDir || mkdir();
  webhooksDb.initWebhooksDb({ rootDir });
  const rows = [];
  const notices = [];
  const clock = { now: Date.parse("2026-11-09T12:00:00Z") };
  const isKnownHook = (name) => knownHooks.includes(name);
  const hookIngress = createHookIngress({
    openclawDir,
    rootDir,
    readOpenclawConfig: () => ({ hooks: { enabled: true, token: kTokenRef } }),
    getLaunchEnv: () => ({ WEBHOOK_TOKEN: kShared }),
    insertRequest: (row) => rows.push(row),
    isKnownHook,
    hasReplayKey: webhooksDb.hasReplayKey,
    recordReplayKey: replayOverride || webhooksDb.recordReplayKey,
    deleteReplayKeysByHook: webhooksDb.deleteReplayKeysByHook,
    countAuthMethods: (name) => {
      const counts = {};
      for (const row of rows.filter((item) => item.hookName === name)) {
        const kind = String(row.authMethod || "").startsWith("rejected:") ? "rejected" : row.authMethod;
        counts[kind] = (counts[kind] || 0) + 1;
      }
      return counts;
    },
    listHookNames: () => knownHooks,
    getHookSources: () => [],
    notify: async (message, opts) => notices.push({ message, ...opts }),
    getSetupUrl: () => "https://box.example",
    nowMs: () => clock.now,
    logger: { warn: () => {}, log: () => {}, error: () => {} },
  });
  hookIngress.runBuiltinMigration();
  hookIngress.runHooksPolicyMigration();
  const webhookMiddleware = createWebhookMiddleware({
    gatewayUrl: gateway.gatewayUrl,
    insertRequest: (row) => rows.push(row),
    isKnownHook,
    hookIngress,
  });
  const app = express();
  app.use(["/hooks", "/webhook"], hookIngress.preParseGate, express.raw({ type: "*/*", limit: "5mb" }));
  app.use("/oauth", express.json());
  app.all("/oauth/:id", createOauthCallbackMiddleware({
    getOauthCallbackById: (id) => {
      if (id === "cb1") return { hookName: "meetings", ownerConfirmedAt: null };
      if (id === "cb2") return { hookName: "meetings", ownerConfirmedAt: "2026-11-09T12:00:00.000Z" };
      if (id === "cb3") return { hookName: "calendar", ownerConfirmedAt: null };
      return null;
    },
    webhookMiddleware,
  }));
  app.all(/^\/hooks\/.+/, webhookMiddleware);
  return {
    app,
    gateway,
    rows,
    notices,
    clock,
    hookIngress,
    openclawDir,
    rootDir,
    close: () => new Promise((resolve) => gateway.server.close(resolve)),
  };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));
const policyOf = (h, name) =>
  JSON.parse(fs.readFileSync(path.join(h.openclawDir, "alphaclaw.json"), "utf8")).hooksIngress.hooks[name];

const circlebackPost = (h, { secret, body, headers = {}, query = "" }) => {
  const req = request(h.app).post("/hooks/meetings" + query).set("content-type", "application/json");
  req.set("x-signature", hmacHex(secret, body));
  for (const [key, value] of Object.entries(headers)) req.set(key, value);
  return req.send(body);
};

afterEach(() => {
  webhooksDb.closeWebhooksDb();
});
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("signed forwarding", () => {
  it("forwards only the verified bytes, no query string and AlphaClaw's own header set", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    const body = JSON.stringify({ id: 7, title: "Weekly" });
    const res = await circlebackPost(h, {
      secret,
      body,
      query: "?token=" + kShared + "&extra=1",
      headers: { "x-event-type": "meeting.done", "x-delivery-id": "d-1", "x-custom": "c" },
    });
    expect(res.status).toBe(200);
    expect(h.gateway.calls).toHaveLength(1);
    const call = h.gateway.calls[0];
    expect(call.url).toBe("/hooks/meetings");
    expect(call.body.toString("utf8")).toBe(body);
    expect(call.headers.authorization).toBe(bearer(kShared));
    expect(call.headers["idempotency-key"]).toBe("circleback:" + hmacHex(secret, body));
    expect(call.headers["content-type"]).toBe("application/json");
    for (const name of ["x-signature", "x-event-type", "x-delivery-id", "x-custom", "x-openclaw-token"]) {
      expect(call.headers[name]).toBeUndefined();
    }
    await flush();
    expect(h.rows.at(-1)).toMatchObject({ hookName: "meetings", authMethod: "signed", gatewayStatus: 200 });
    await h.close();
  });

  it("gives the transform byte-identical input when unsigned headers change", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    const first = JSON.stringify({ n: 1 });
    await circlebackPost(h, { secret, body: first, headers: { "x-event-type": "a", "x-delivery-id": "1" } });
    webhooksDb.deleteReplayKeysByHook("meetings");
    await request(h.app)
      .post("/hooks/meetings?x=2")
      .set("content-type", "text/plain")
      .set("x-signature", hmacHex(secret, first))
      .set("x-event-type", "b")
      .set("x-delivery-id", "2")
      .send(first);
    expect(h.gateway.calls).toHaveLength(2);
    const strip = ({ host, connection, ...rest }) => rest;
    expect(strip(h.gateway.calls[1].headers)).toEqual(strip(h.gateway.calls[0].headers));
    expect(h.gateway.calls[1].body.equals(h.gateway.calls[0].body)).toBe(true);
    expect(h.gateway.calls[1].url).toBe(h.gateway.calls[0].url);
    await h.close();
  });

  it("forwards Quo's signed webhook-id and webhook-timestamp, and accepts its legacy signature", async () => {
    const h = await createHarness();
    const key = crypto.randomBytes(32);
    const secret = "whsec_" + key.toString("base64");
    h.hookIngress.setIngress("phone", { preset: "quo", secret });
    const body = JSON.stringify({ type: "call.completed" });
    const ts = String(Math.floor(h.clock.now / 1000));
    const res = await request(h.app)
      .post("/hooks/phone")
      .set("content-type", "application/json")
      .set("webhook-id", "msg_1")
      .set("webhook-timestamp", ts)
      .set("webhook-signature", "v1," + hmacB64(key, "msg_1." + ts + "." + body))
      .send(body);
    expect(res.status).toBe(200);
    expect(h.gateway.calls[0].headers["webhook-id"]).toBe("msg_1");
    expect(h.gateway.calls[0].headers["webhook-timestamp"]).toBe(ts);
    expect(h.gateway.calls[0].headers["webhook-signature"]).toBeUndefined();
    expect(h.gateway.calls[0].headers["idempotency-key"]).toBe("quo:msg_1");
    const ms = String(h.clock.now);
    const legacy = JSON.stringify({ type: "message.received" });
    const legacyRes = await request(h.app)
      .post("/hooks/phone")
      .set("content-type", "application/json")
      .set("openphone-signature", "hmac;1;" + ms + ";" + hmacB64(key, ms + "." + legacy))
      .send(legacy);
    expect(legacyRes.status).toBe(200);
    expect(h.gateway.calls).toHaveLength(2);
    expect(h.gateway.calls[1].headers["webhook-timestamp"]).toBeUndefined();
    await h.close();
  });

  it("forwards Verkada's signed timestamp and refuses a stale one", async () => {
    const h = await createHarness();
    const { secret } = h.hookIngress.generateIngressSecret("cams", { preset: "verkada" });
    const body = JSON.stringify({ event: "motion" });
    const ts = String(Math.floor(h.clock.now / 1000));
    const ok = await request(h.app).post("/hooks/cams").set("content-type", "application/json")
      .set("verkada-signature", ts + "|" + hmacHex(secret, body + "|" + ts)).send(body);
    expect(ok.status).toBe(200);
    expect(h.gateway.calls[0].headers["webhook-timestamp"]).toBe(ts);
    const old = String(Math.floor(h.clock.now / 1000) - 301);
    const stale = await request(h.app).post("/hooks/cams").set("content-type", "application/json")
      .set("verkada-signature", old + "|" + hmacHex(secret, body + "|" + old)).send(body);
    expect(stale.status).toBe(401);
    expect(h.rows.at(-1)).toMatchObject({ authMethod: "rejected:stale_timestamp" });
    expect(h.gateway.calls).toHaveLength(1);
    await h.close();
  });

  it("refuses a wrong signature and a compressed body, alerting the owner once", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    const body = JSON.stringify({ a: 1 });
    const bad = await circlebackPost(h, { secret: randomSecret(), body });
    expect(bad.status).toBe(401);
    expect(h.rows.at(-1)).toMatchObject({ authMethod: "rejected:bad_signature" });
    const gz = await request(h.app).post("/hooks/meetings").set("content-type", "application/octet-stream")
      .set("content-encoding", "gzip").set("x-signature", hmacHex(secret, body)).send(zlib.gzipSync(body));
    expect(gz.status).toBe(415);
    expect(h.gateway.calls).toHaveLength(0);
    await flush();
    expect(h.notices.filter((n) => n.message.includes("refused a delivery to /hooks/meetings"))).toHaveLength(1);
    expect(h.hookIngress.ingressStatus("meetings").alert).toMatchObject({ reason: "rejected" });
    await h.close();
  });

  it("counts failed signatures toward the per-client limiter", async () => {
    const h = await createHarness();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret: randomSecret() });
    let last;
    for (let i = 0; i < 21; i += 1) last = await circlebackPost(h, { secret: randomSecret(), body: "{}" });
    expect(last.status).toBe(429);
    expect(last.headers["retry-after"]).toBeTruthy();
    await h.close();
  });
});

describe("replay suppression", () => {
  it("answers a known duplicate 200 without dispatch, also after the DB reopens", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    const body = JSON.stringify({ meeting: 1 });
    expect((await circlebackPost(h, { secret, body })).status).toBe(200);
    const again = await circlebackPost(h, { secret, body });
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ ok: true, deduped: true });
    webhooksDb.closeWebhooksDb();
    webhooksDb.initWebhooksDb({ rootDir: h.rootDir });
    expect((await circlebackPost(h, { secret, body })).body).toEqual({ ok: true, deduped: true });
    expect(h.gateway.calls).toHaveLength(1);
    expect(h.rows.some((row) => row.authMethod === "rejected:replayed")).toBe(true);
    await h.close();
  });

  it("stores no key when the gateway refuses, so the sender's retry goes through", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    h.gateway.status = 500;
    expect((await circlebackPost(h, { secret, body: "{}" })).status).toBe(500);
    h.gateway.status = 200;
    expect((await circlebackPost(h, { secret, body: "{}" })).status).toBe(200);
    expect(h.gateway.calls).toHaveLength(2);
    await h.close();
  });

  it("lets one retry through again when the key cannot be stored after the gateway's 2xx", async () => {
    const h = await createHarness({ replayOverride: () => { throw new Error("disk full"); } });
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    expect((await circlebackPost(h, { secret, body: "{}" })).status).toBe(200);
    expect((await circlebackPost(h, { secret, body: "{}" })).status).toBe(200);
    expect(h.gateway.calls).toHaveLength(2);
    await h.close();
  });

  it("answers a concurrent duplicate 409 with Retry-After, never 2xx", async () => {
    const h = await createHarness({ gatewayOptions: { delayMs: 300 } });
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    const body = JSON.stringify({ c: 1 });
    const first = circlebackPost(h, { secret, body }).then((res) => res);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await circlebackPost(h, { secret, body });
    expect(second.status).toBe(409);
    expect(second.headers["retry-after"]).toBe("5");
    expect((await first).status).toBe(200);
    expect(h.gateway.calls).toHaveLength(1);
    await h.close();
  });
});

describe("shared-token overlap (D2)", () => {
  it("keeps the shared token until the first admitted signed delivery, then for a fixed 24 h", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    expect(h.hookIngress.ingressStatus("meetings").state).toBe("waiting");
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(200);
    await flush();
    expect(h.notices).toHaveLength(0);
    expect((await circlebackPost(h, { secret, body: JSON.stringify({ first: true }) })).status).toBe(200);
    await flush();
    const entry = policyOf(h, "meetings");
    expect(entry.firstAdmittedAt).toBe("2026-11-09T12:00:00.000Z");
    expect(entry.closesAt).toBe("2026-11-10T12:00:00.000Z");
    h.clock.now += 23 * kHour;
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(200);
    await flush();
    expect(h.notices.some((n) => n.message.includes("still received a delivery with the shared webhook token"))).toBe(true);
    expect(policyOf(h, "meetings").closesAt).toBe("2026-11-10T12:00:00.000Z");
    h.clock.now += 2 * kHour;
    const refused = await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}");
    expect(refused.status).toBe(401);
    expect(h.rows.at(-1)).toMatchObject({ authMethod: "rejected:shared_token_retired" });
    await flush();
    expect(h.notices.some((n) => n.message.includes("this hook now takes only verified deliveries"))).toBe(true);
    expect(h.hookIngress.ingressStatus("meetings")).toMatchObject({ state: "closed", sharedTokenAccepted: false, closedAt: "2026-11-10T12:00:00.000Z" });
    expect((await circlebackPost(h, { secret, body: JSON.stringify({ later: true }) })).status).toBe(200);
    h.hookIngress.reopenIngress("meetings");
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(200);
    expect(h.hookIngress.ingressStatus("meetings").state).toBe("overlap");
    await h.close();
  });

  it("keeps a closed hook closed when its signing secret is replaced or its method changes", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    expect((await circlebackPost(h, { secret, body: JSON.stringify({ first: true }) })).status).toBe(200);
    await flush();
    h.clock.now += 25 * kHour;
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(401);
    const replaced = randomSecret();
    expect(h.hookIngress.setIngress("meetings", { preset: "circleback", secret: replaced })).toMatchObject({ state: "closed", sharedTokenAccepted: false });
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(401);
    expect((await circlebackPost(h, { secret, body: JSON.stringify({ old: true }) })).status).toBe(401);
    expect((await circlebackPost(h, { secret: replaced, body: JSON.stringify({ next: true }) })).status).toBe(200);
    h.hookIngress.generateIngressSecret("meetings", { preset: "per_hook_token" });
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(401);
    expect(policyOf(h, "meetings")).toMatchObject({ firstAdmittedAt: "2026-11-09T12:00:00.000Z", closesAt: "2026-11-10T12:00:00.000Z" });
    h.hookIngress.reopenIngress("meetings");
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(200);
    await h.close();
  });

  it("starts the window from a duplicate when the first admission could not be stored", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    const body = JSON.stringify({ only: true });
    expect((await circlebackPost(h, { secret, body })).status).toBe(200);
    await flush();
    const configPath = path.join(h.openclawDir, "alphaclaw.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.hooksIngress.hooks.meetings = { ...cfg.hooksIngress.hooks.meetings, firstAdmittedAt: null, closesAt: null };
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    h.clock.now += kHour;
    const again = await circlebackPost(h, { secret, body });
    expect(again.body).toMatchObject({ deduped: true });
    expect(h.gateway.calls).toHaveLength(1);
    expect(policyOf(h, "meetings")).toMatchObject({ firstAdmittedAt: "2026-11-09T13:00:00.000Z", closesAt: "2026-11-10T13:00:00.000Z" });
    await h.close();
  });

  it("does not start the window when the gateway refuses the signed delivery", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    h.gateway.status = 400;
    await circlebackPost(h, { secret, body: "{}" });
    expect(policyOf(h, "meetings").firstAdmittedAt).toBeNull();
    await h.close();
  });

  it("starts a per-hook token's window at its first admitted own-token delivery", async () => {
    const h = await createHarness();
    const { secret: own } = h.hookIngress.generateIngressSecret("gmail", { preset: "per_hook_token" });
    const res = await request(h.app).post("/hooks/gmail?token=" + own).send(JSON.stringify({ x: 1 }));
    expect(res.status).toBe(200);
    expect(h.gateway.calls[0].headers.authorization).toBe(bearer(kShared));
    await flush();
    expect(h.rows.at(-1)).toMatchObject({ authMethod: "per_hook_token" });
    expect(policyOf(h, "gmail").firstAdmittedAt).toBeTruthy();
    expect((await request(h.app).post("/hooks/gmail?token=wrong-value").send("{}")).status).toBe(401);
    h.clock.now += kDay + 1;
    expect((await request(h.app).post("/hooks/gmail?token=" + kShared).send("{}")).status).toBe(401);
    expect((await request(h.app).post("/hooks/gmail").set("x-openclaw-token", own).send("{}")).status).toBe(200);
    await h.close();
  });
});

describe("fail closed", () => {
  it("refuses a signed hook whose secret is gone and alerts, instead of reverting to the shared token", async () => {
    const h = await createHarness();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret: randomSecret() });
    fs.rmSync(hookIngressSecretsPath(h.rootDir));
    const res = await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}");
    expect(res.status).toBe(503);
    expect(h.gateway.calls).toHaveLength(0);
    await flush();
    expect(h.notices.some((n) => n.message.includes("cannot be read (secret_missing)"))).toBe(true);
    expect(h.hookIngress.ingressStatus("meetings").state).toBe("misconfigured");
    await h.close();
  });

  it("refuses a hook whose policy entry vanished while its secret remains, and an unreadable policy", async () => {
    const h = await createHarness();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret: randomSecret() });
    const configPath = path.join(h.openclawDir, "alphaclaw.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    delete cfg.hooksIngress.hooks.meetings;
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(503);
    expect((await request(h.app).post("/hooks/calendar?token=" + kShared).send("{}")).status).toBe(200);
    fs.writeFileSync(configPath, "{ not json");
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(503);
    expect((await request(h.app).post("/hooks/calendar?token=" + kShared).send("{}")).status).toBe(200);
    await h.close();
  });

  it("refuses a shared-token entry that still has a signing secret behind it (a restored or reverted policy)", async () => {
    const h = await createHarness();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret: randomSecret() });
    const configPath = path.join(h.openclawDir, "alphaclaw.json");
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    cfg.hooksIngress.hooks.meetings = { mode: "token", changedAt: "2026-11-01T00:00:00.000Z" };
    fs.writeFileSync(configPath, JSON.stringify(cfg));
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(503);
    expect(h.gateway.calls).toHaveLength(0);
    expect(h.hookIngress.ingressStatus("meetings")).toMatchObject({ state: "misconfigured", sharedTokenAccepted: false });
    h.hookIngress.setIngress("meetings", { preset: "token" });
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(200);
    await h.close();
  });

  it("treats hook names that match Object members as ordinary hooks", async () => {
    const h = await createHarness({ knownHooks: ["calendar", "constructor"] });
    expect(policyOf(h, "constructor")).toMatchObject({ mode: "token" });
    expect((await request(h.app).post("/hooks/constructor?token=" + kShared).send("{}")).status).toBe(200);
    for (const name of ["toString", "valueOf", "hasOwnProperty"]) {
      const res = await request(h.app).post("/hooks/" + name).set("x-signature", "x").send("{}");
      expect(res.status).toBe(401);
    }
    await flush();
    expect(h.notices).toHaveLength(0);
    await h.close();
  });

  it("keeps a hook with no entry and no secret on the shared token (mappings added outside the Webhooks page)", async () => {
    const h = await createHarness({ knownHooks: ["calendar", "meetings", "phone", "cams", "gmail", "imported"] });
    expect((await request(h.app).post("/hooks/imported?token=" + kShared).send("{}")).status).toBe(200);
    await h.close();
  });
});

describe("oauth alias, hook lifecycle and migration", () => {
  it("delivers an OAuth callback to a signed hook only through an alias a person confirmed", async () => {
    const h = await createHarness();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret: randomSecret() });
    const refused = await request(h.app).get("/oauth/cb1?code=abc&state=s");
    expect(refused.status).toBe(403);
    expect(h.gateway.calls).toHaveLength(0);
    await flush();
    expect(h.rows.at(-1)).toMatchObject({ authMethod: "rejected:alias_unconfirmed" });
    expect(h.notices.some((n) => n.message.includes("Rotate the callback URL once"))).toBe(true);
    const res = await request(h.app).get("/oauth/cb2?code=abc&state=s");
    expect(res.status).toBe(200);
    expect(h.gateway.calls[0].headers.authorization).toBe(bearer(kShared));
    await flush();
    expect(h.rows.at(-1)).toMatchObject({ authMethod: "oauth_alias" });
    expect((await request(h.app).get("/oauth/cb3?code=abc&state=s")).status).toBe(200);
    await h.close();
  });

  it("forgets policy, secret and replay keys when a hook is deleted or recreated", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    await circlebackPost(h, { secret, body: "{}" });
    h.hookIngress.resetHookIngress("meetings");
    expect(policyOf(h, "meetings")).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(hookIngressSecretsPath(h.rootDir), "utf8")).hooks.meetings).toBeUndefined();
    expect(webhooksDb.hasReplayKey("meetings", hmacHex(secret, "{}"))).toBe(false);
    const own = h.hookIngress.resetHookIngress("meetings", { created: true });
    expect(policyOf(h, "meetings")).toMatchObject({ mode: "per_hook_token", closesAt: "2026-11-09T12:00:00.000Z" });
    expect((await request(h.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(401);
    expect((await request(h.app).post("/hooks/meetings?token=" + own).send("{}")).status).toBe(200);
    await h.close();
  });

  it("writes an explicit shared-token entry for every existing hook once", async () => {
    const h = await createHarness();
    const cfg = JSON.parse(fs.readFileSync(path.join(h.openclawDir, "alphaclaw.json"), "utf8"));
    expect(cfg.hooksIngress.version).toBe(1);
    expect(Object.keys(cfg.hooksIngress.hooks).sort()).toEqual(["calendar", "cams", "gmail", "meetings", "phone"]);
    expect(cfg.hooksIngress.builtins.migration.version).toBe(1);
    expect(h.hookIngress.runHooksPolicyMigration()).toMatchObject({ ran: false, reason: "already_ran" });
    await h.close();
  });

  it("stores secrets 0600 outside .env and never returns them from the status", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    const status = h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    expect(JSON.stringify(status)).not.toContain(secret);
    expect(status).toMatchObject({ preset: "circleback", hasSecret: true, state: "waiting", signedUrl: "https://box.example/hooks/meetings" });
    expect(fs.statSync(hookIngressSecretsPath(h.rootDir)).mode & 0o777).toBe(0o600);
    expect(() => h.hookIngress.setIngress("meetings", { preset: "circleback", secret: "" })).toThrow(/not valid/);
    expect(() => h.hookIngress.setIngress("nope", { preset: "token" })).toThrow(/not found/);
    await h.close();
  });
});

describe("backup", () => {
  it("saves policy and secrets as one unit; a restore keeps a closed hook closed, and one without secrets fails closed", async () => {
    const h = await createHarness();
    const secret = randomSecret();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret });
    await circlebackPost(h, { secret, body: JSON.stringify({ go: 1 }) });
    await flush();
    h.clock.now += kDay + 1;
    const backupsDir = mkdir();
    const result = backupHookIngress({
      rootDir: h.rootDir,
      openclawDir: h.openclawDir,
      backupsDir,
      archivePath: path.join(backupsDir, "2026-11-10T12-00-01.000Z-openclaw-backup.tar.gz"),
    });
    expect(result.ok).toBe(true);
    expect(path.basename(result.path)).toBe("2026-11-10T12-00-01.000Z-hook-ingress-backup");
    expect(JSON.parse(fs.readFileSync(path.join(result.path, "manifest.json"), "utf8")).marker).toBe(kHookIngressBackupMarker);
    expect(fs.statSync(path.join(result.path, "secrets.json")).mode & 0o777).toBe(0o600);
    const now = h.clock.now;
    await h.close();
    webhooksDb.closeWebhooksDb();

    const restoredOpenclaw = mkdir();
    const restoredRoot = mkdir();
    const { hooksIngress } = JSON.parse(fs.readFileSync(path.join(result.path, "policy.json"), "utf8"));
    fs.writeFileSync(path.join(restoredOpenclaw, "alphaclaw.json"), JSON.stringify({ hooksIngress }));
    fs.mkdirSync(path.dirname(hookIngressSecretsPath(restoredRoot)), { recursive: true });
    fs.copyFileSync(path.join(result.path, "secrets.json"), hookIngressSecretsPath(restoredRoot));
    const restored = await createHarness({ dirs: { openclawDir: restoredOpenclaw, rootDir: restoredRoot } });
    restored.clock.now = now;
    expect((await request(restored.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(401);
    expect((await circlebackPost(restored, { secret, body: JSON.stringify({ go: 2 }) })).status).toBe(200);
    await restored.close();
    webhooksDb.closeWebhooksDb();

    const bareOpenclaw = mkdir();
    fs.writeFileSync(path.join(bareOpenclaw, "alphaclaw.json"), JSON.stringify({ hooksIngress }));
    const bare = await createHarness({ dirs: { openclawDir: bareOpenclaw, rootDir: mkdir() } });
    expect((await request(bare.app).post("/hooks/meetings?token=" + kShared).send("{}")).status).toBe(503);
    await flush();
    expect(bare.notices.some((n) => n.message.includes("secret_missing"))).toBe(true);
    await bare.close();
  });

  it("reports a backup directory it cannot create as a failure instead of throwing", async () => {
    const h = await createHarness();
    h.hookIngress.setIngress("meetings", { preset: "circleback", secret: randomSecret() });
    const fsModule = { ...fs, mkdirSync: () => { throw new Error("EACCES: permission denied"); } };
    const result = backupHookIngress({ rootDir: h.rootDir, openclawDir: h.openclawDir, backupsDir: mkdir(), fsModule });
    expect(result).toMatchObject({ ok: false, error: "EACCES: permission denied" });
    await h.close();
  });
});

describe("ingress routes", () => {
  const createRoutesApp = (actorType) => {
    const calls = [];
    const fake = {
      ingressStatus: (name) => ({
        preset: name === "meetings" ? "circleback" : "token",
        state: { meetings: "closed", phone: "misconfigured" }[name] || "token",
        name,
      }),
      setIngress: (name, body) => { calls.push(["set", name, body]); return { preset: body.preset }; },
      generateIngressSecret: (name, body) => { calls.push(["gen", name, body]); return { secret: "s", ingress: { preset: body.preset } }; },
      reopenIngress: (name) => { calls.push(["reopen", name]); return { preset: "circleback" }; },
      builtinStatus: () => ({}),
    };
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      req.alphaclawActor = { type: actorType };
      next();
    });
    registerWebhookRoutes({
      app,
      fs,
      constants: { OPENCLAW_DIR: mkdir() },
      getBaseUrl: () => "https://box.example",
      webhooksDb: {},
      restartRequiredState: { markRequired: () => {}, getSnapshot: async () => ({ restartRequired: false }) },
      hookIngress: fake,
    });
    return { app, calls };
  };

  it("lets a person read and change sender verification, with no-store", async () => {
    const { app, calls } = createRoutesApp("user");
    const read = await request(app).get("/api/webhooks/meetings/ingress");
    expect(read.status).toBe(200);
    expect(read.headers["cache-control"]).toBe("no-store");
    expect((await request(app).put("/api/webhooks/meetings/ingress").send({ preset: "circleback", secret: "x" })).status).toBe(200);
    expect((await request(app).post("/api/webhooks/cams/ingress/generate-secret").send({ preset: "verkada" })).body.secret).toBe("s");
    expect((await request(app).post("/api/webhooks/meetings/ingress/reopen")).status).toBe(200);
    expect(calls.map((c) => c[0])).toEqual(["set", "gen", "reopen"]);
    expect((await request(app).get("/api/webhooks/Bad..Name/ingress")).status).toBe(500);
  });

  it("refuses the agent actor on every sender verification route", async () => {
    const { app, calls } = createRoutesApp("agent");
    expect((await request(app).get("/api/webhooks/meetings/ingress")).status).toBe(403);
    expect((await request(app).put("/api/webhooks/meetings/ingress").send({ preset: "token" })).status).toBe(403);
    expect((await request(app).post("/api/webhooks/cams/ingress/generate-secret").send({ preset: "verkada" })).status).toBe(403);
    expect((await request(app).post("/api/webhooks/meetings/ingress/reopen")).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("lets only a person add an OAuth callback alias to a hook that has moved off the shared token", async () => {
    const agent = createRoutesApp("agent").app;
    expect((await request(agent).post("/api/webhooks/meetings/oauth-callback")).body).toMatchObject({ error: "humans_only" });
    expect((await request(agent).post("/api/webhooks/phone/oauth-callback")).body).toMatchObject({ error: "humans_only" });
    const pastGate = { ok: false, error: "Could not read openclaw.json" };
    expect((await request(agent).post("/api/webhooks/calendar/oauth-callback")).body).toEqual(pastGate);
    expect((await request(createRoutesApp("person").app).post("/api/webhooks/meetings/oauth-callback")).body).toEqual(pastGate);
  });
});

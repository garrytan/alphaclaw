const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const express = require("express");
const request = require("supertest");

const { createWebhookMiddleware } = require("../../lib/server/webhook-middleware");
const { createOauthCallbackMiddleware } = require("../../lib/server/oauth-callback-middleware");
const { createHookIngress } = require("../../lib/server/hook-ingress");
const {
  builtinSharedWindow,
  extractHookToken,
  hasCredentialHint,
  resolveHookCredential,
} = require("../../lib/server/hook-ingress/verify");
const { hookIngressSecretsPath } = require("../../lib/server/hook-ingress/policy");
const { buildGatewayBindCard } = require("../../lib/server/doctor/gateway-bind-card");

// GST-2134 PR 1: one edge decision for /hooks, built-ins closed by default.

const kShared = "shared-hook-token-value";
const kHour = 60 * 60 * 1000;
const kDay = 24 * kHour;

const createGateway = async () => {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      calls.push({ url: req.url, headers: req.headers, bodyText: Buffer.concat(chunks).toString("utf8") });
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, calls, gatewayUrl: "http://127.0.0.1:" + server.address().port };
};

const scratch = [];
const mkdir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-ingress-"));
  scratch.push(dir);
  return dir;
};

const createHarness = async ({
  hooks = { enabled: true, token: "${WEBHOOK_TOKEN}" },
  launchEnv = { WEBHOOK_TOKEN: kShared },
  knownHooks = ["calendar", "gmail"],
  accepted = [],
  migrate = true,
} = {}) => {
  const gateway = await createGateway();
  const openclawDir = mkdir();
  const rootDir = mkdir();
  const rows = [];
  const notices = [];
  const clock = { now: Date.parse("2026-11-09T12:00:00Z") };
  let env = launchEnv;
  const isKnownHook = (name) => knownHooks.includes(name);
  const hookIngress = createHookIngress({
    openclawDir,
    rootDir,
    readOpenclawConfig: () => ({ hooks }),
    getLaunchEnv: () => env,
    insertRequest: (row) => rows.push(row),
    isKnownHook,
    hasAcceptedRequest: (name) => accepted.includes(name),
    notify: async (message, opts) => notices.push({ message, ...opts }),
    getSetupUrl: () => "https://box.example",
    nowMs: () => clock.now,
    logger: { warn: () => {}, log: () => {}, error: () => {} },
  });
  if (migrate) hookIngress.runBuiltinMigration();
  const webhookMiddleware = createWebhookMiddleware({
    gatewayUrl: gateway.gatewayUrl,
    insertRequest: (row) => rows.push(row),
    isKnownHook,
    hookIngress,
  });
  const app = express();
  app.use(["/hooks", "/webhook"], hookIngress.preParseGate, express.raw({ type: "*/*", limit: "5mb" }));
  app.use("/oauth", express.json());
  app.all(
    "/oauth/:id",
    createOauthCallbackMiddleware({
      getOauthCallbackById: (id) => (id === "cb1" ? { hookName: "calendar" } : null),
      webhookMiddleware,
    }),
  );
  app.all(/^\/hooks\/.+/, webhookMiddleware);
  app.all(/^\/webhook\/.+/, webhookMiddleware);
  return {
    app,
    gateway,
    rows,
    notices,
    clock,
    hookIngress,
    openclawDir,
    rootDir,
    setLaunchEnv: (next) => {
      env = next;
    },
    close: () => new Promise((resolve) => gateway.server.close(resolve)),
  };
};

const flush = () => new Promise((resolve) => setImmediate(resolve));

afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("hook credential resolution (verify.js)", () => {
  it("reads Bearer first, then x-openclaw-token, like OpenClaw's extractHookToken", () => {
    expect(extractHookToken({ authorization: "Bearer  abc ", "x-openclaw-token": "x" })).toBe("abc");
    expect(extractHookToken({ authorization: "Basic abc", "x-openclaw-token": " x " })).toBe("x");
    expect(extractHookToken({ authorization: "Bearer " })).toBe("");
  });

  it("resolves the standard ${WEBHOOK_TOKEN} reference from the launch environment", () => {
    expect(resolveHookCredential({ hooks: { enabled: true, token: "${WEBHOOK_TOKEN}" }, launchEnv: { WEBHOOK_TOKEN: "t1" } }))
      .toMatchObject({ ok: true, value: "t1", source: "reference" });
    expect(resolveHookCredential({ hooks: { enabled: true, token: "pre-${A:-dflt}-post" }, launchEnv: {} }))
      .toMatchObject({ ok: true, value: "pre-dflt-post" });
    expect(resolveHookCredential({ hooks: { enabled: true, token: "$${A}" }, launchEnv: { A: "x" } }))
      .toMatchObject({ ok: true, value: "${A}", source: "literal" });
  });

  it("uses a literal as is and leaves an unresolvable reference to the gateway", () => {
    expect(resolveHookCredential({ hooks: { enabled: true, token: " lit " }, launchEnv: null })).toMatchObject({ ok: true, value: "lit" });
    expect(resolveHookCredential({ hooks: { enabled: true, token: "${WEBHOOK_TOKEN}" }, launchEnv: {} }))
      .toMatchObject({ ok: false, reason: "reference_unresolved" });
    expect(resolveHookCredential({ hooks: { enabled: true, token: "${WEBHOOK_TOKEN}" }, launchEnv: null }))
      .toMatchObject({ ok: false, reason: "no_launch_env" });
    expect(resolveHookCredential({ hooks: { enabled: false, token: "x" }, launchEnv: {} })).toMatchObject({ ok: false });
  });

  it("closes a built-in's shared-token window at the earlier of own token + 24 h and turn-on + 7 days", () => {
    const on = Date.parse("2026-11-01T00:00:00Z");
    const turnedOnAt = new Date(on).toISOString();
    expect(builtinSharedWindow({ enabled: true, turnedOnAt }, on + 6 * kDay).open).toBe(true);
    expect(builtinSharedWindow({ enabled: true, turnedOnAt }, on + 7 * kDay).open).toBe(false);
    const firstOwnTokenAt = new Date(on + kDay).toISOString();
    expect(builtinSharedWindow({ enabled: true, turnedOnAt, firstOwnTokenAt }, on + kDay + 23 * kHour).open).toBe(true);
    expect(builtinSharedWindow({ enabled: true, turnedOnAt, firstOwnTokenAt }, on + 2 * kDay).open).toBe(false);
    expect(builtinSharedWindow({ enabled: true }, on).open).toBe(false);
    expect(builtinSharedWindow({ enabled: false, turnedOnAt }, on).open).toBe(false);
  });

  it("sees a token, a token query or a signature header as a credential hint", () => {
    expect(hasCredentialHint({ headers: {}, url: "/hooks/x" })).toBe(false);
    expect(hasCredentialHint({ headers: {}, url: "/hooks/x?token=a" })).toBe(true);
    expect(hasCredentialHint({ headers: { "x-signature": "ab" }, url: "/hooks/x" })).toBe(true);
    expect(hasCredentialHint({ headers: { "x-openclaw-token": "a" }, url: "/hooks/x" })).toBe(true);
  });
});

describe("edge decision for configured hooks", () => {
  it("admits the shared token from ?token= and forwards it as Bearer with auth=shared_token", async () => {
    const h = await createHarness();
    try {
      const res = await request(h.app).post("/hooks/calendar?token=" + kShared).send({ a: 1 });
      expect(res.status).toBe(200);
      expect(h.gateway.calls).toHaveLength(1);
      expect(h.gateway.calls[0].headers.authorization).toBe("Bearer " + kShared);
      expect(h.rows.at(-1)).toMatchObject({ hookName: "calendar", auth: "shared_token", gatewayStatus: 200 });
      expect(typeof h.rows.at(-1).gatewayMs).toBe("number");
    } finally {
      await h.close();
    }
  });

  it("refuses a wrong credential at the edge, never reaching the gateway", async () => {
    const h = await createHarness();
    try {
      const res = await request(h.app).post("/hooks/calendar").set("Authorization", "Bearer wrong").send({ a: 1 });
      expect(res.status).toBe(401);
      expect(h.gateway.calls).toHaveLength(0);
      expect(h.rows.at(-1)).toMatchObject({ hookName: "calendar", gatewayStatus: 401, auth: "rejected:bad_credential" });
    } finally {
      await h.close();
    }
  });

  it("throttles a client after 20 failures but never refuses a matching credential", async () => {
    const h = await createHarness();
    try {
      const statuses = [];
      for (let i = 0; i < 25; i += 1) {
        statuses.push((await request(h.app).post("/hooks/calendar").set("x-openclaw-token", "bad-" + i).send({})).status);
      }
      expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
      expect(statuses.slice(20).every((s) => s === 429)).toBe(true);
      const ok = await request(h.app).post("/hooks/calendar").set("Authorization", "Bearer " + kShared).send({});
      expect(ok.status).toBe(200);
      expect(h.gateway.calls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it("writes at most one refused row per hook per 10 s, carrying the suppressed count", async () => {
    const h = await createHarness();
    try {
      for (let i = 0; i < 5; i += 1) await request(h.app).post("/hooks/calendar").set("x-openclaw-token", "bad").send({});
      expect(h.rows.filter((row) => row.auth?.startsWith("rejected:"))).toHaveLength(1);
      h.clock.now += 10_000;
      await request(h.app).post("/hooks/calendar").set("x-openclaw-token", "bad").send({});
      const refused = h.rows.filter((row) => row.auth?.startsWith("rejected:"));
      expect(refused).toHaveLength(2);
      expect(refused[1].gatewayBody).toContain("4 more refused");
    } finally {
      await h.close();
    }
  });

  it("judges against the launch environment, so an Envars edit before a restart changes nothing", async () => {
    const h = await createHarness();
    const previous = process.env.WEBHOOK_TOKEN;
    process.env.WEBHOOK_TOKEN = "edited-but-not-restarted";
    try {
      expect((await request(h.app).post("/hooks/calendar").set("Authorization", "Bearer " + kShared).send({})).status).toBe(200);
      expect((await request(h.app).post("/hooks/calendar").set("Authorization", "Bearer edited-but-not-restarted").send({})).status).toBe(401);
    } finally {
      if (previous === undefined) delete process.env.WEBHOOK_TOKEN;
      else process.env.WEBHOOK_TOKEN = previous;
      await h.close();
    }
  });

  it("uses a literal hooks.token that differs from WEBHOOK_TOKEN", async () => {
    const h = await createHarness({ hooks: { enabled: true, token: "literal-token" } });
    try {
      expect((await request(h.app).post("/hooks/calendar").set("Authorization", "Bearer literal-token").send({})).status).toBe(200);
      expect((await request(h.app).post("/hooks/calendar").set("Authorization", "Bearer " + kShared).send({})).status).toBe(401);
    } finally {
      await h.close();
    }
  });

  it("leaves the decision to the gateway when the reference is not in the launch environment", async () => {
    const h = await createHarness({ launchEnv: {} });
    try {
      const res = await request(h.app).post("/hooks/calendar").set("Authorization", "Bearer anything").send({});
      expect(res.status).toBe(200);
      expect(h.gateway.calls).toHaveLength(1);
      expect(h.rows.at(-1).auth).toBe("unchecked");
    } finally {
      await h.close();
    }
  });

  it("refuses a POST with no credential before its body is parsed", async () => {
    const h = await createHarness();
    try {
      const res = await request(h.app).post("/hooks/calendar").set("Content-Type", "application/json").send(JSON.stringify({ big: "x".repeat(1000) }));
      expect(res.status).toBe(401);
      expect(res.headers.connection).toBe("close");
      expect(h.gateway.calls).toHaveLength(0);
      expect(h.rows.at(-1)).toMatchObject({ auth: "rejected:no_credential", payloadSize: 0 });
    } finally {
      await h.close();
    }
  });

  it("forwards an OAuth alias with the gateway's credential and auth=oauth_alias", async () => {
    const h = await createHarness();
    try {
      const res = await request(h.app).get("/oauth/cb1?code=abc&state=s1");
      expect(res.status).toBe(200);
      expect(h.gateway.calls[0].headers.authorization).toBe("Bearer " + kShared);
      expect(h.rows.at(-1).auth).toBe("oauth_alias");
    } finally {
      await h.close();
    }
  });

  it("runs the Gmail dedupe only after auth, so a refused delivery cannot mark ids seen", async () => {
    const h = await createHarness();
    try {
      const body = { messages: [{ id: "m1" }], account: "a@example.com" };
      expect((await request(h.app).post("/hooks/gmail").set("x-openclaw-token", "bad").send(body)).status).toBe(401);
      expect((await request(h.app).post("/hooks/gmail").set("x-openclaw-token", kShared).send(body)).status).toBe(200);
      expect(h.gateway.calls).toHaveLength(1);
    } finally {
      await h.close();
    }
  });
});

describe("built-in /hooks/agent and /hooks/wake", () => {
  it("migrates to off when the log shows no accepted delivery, and refuses with a notice", async () => {
    const h = await createHarness();
    try {
      const res = await request(h.app).post("/hooks/agent").set("Authorization", "Bearer " + kShared).send({ message: "hi" });
      expect(res.status).toBe(404);
      expect(h.gateway.calls).toHaveLength(0);
      await request(h.app).post("/hooks/agent").set("Authorization", "Bearer " + kShared).send({ message: "hi" });
      await flush();
      expect(h.rows.filter((row) => row.hookName === "agent")).toHaveLength(1);
      expect(h.rows.at(-1).auth).toBe("rejected:builtin_off");
      const offNotices = h.notices.filter((notice) => notice.id.startsWith("hook-ingress-builtin-off-agent"));
      expect(offNotices.length).toBeGreaterThan(0);
      expect(new Set(offNotices.map((notice) => notice.id)).size).toBe(1);
      expect(offNotices[0].message).toContain("https://box.example/#/webhooks");
      expect(h.hookIngress.builtinStatus().migration).toMatchObject({ version: 1, verdicts: { agent: "unknown", wake: "unknown" } });
    } finally {
      await h.close();
    }
  });

  it("keeps a built-in on when the log shows it accepted, and runs the migration only once", async () => {
    const h = await createHarness({ accepted: ["wake"] });
    try {
      const status = h.hookIngress.builtinStatus();
      expect(status.hooks.wake).toMatchObject({ enabled: true, sharedTokenOpen: true });
      expect(status.hooks.agent.enabled).toBe(false);
      await flush();
      expect(h.notices.some((notice) => notice.id === "hook-ingress-builtin-migrated-wake")).toBe(true);
      h.hookIngress.setBuiltinEnabled("wake", false);
      expect(h.hookIngress.runBuiltinMigration()).toMatchObject({ ran: false, reason: "already_ran" });
      expect(h.hookIngress.builtinStatus().hooks.wake.enabled).toBe(false);
    } finally {
      await h.close();
    }
  });

  it("forwards the own token with the gateway's credential and records the first own-token delivery", async () => {
    const h = await createHarness();
    try {
      h.hookIngress.setBuiltinEnabled("agent", true);
      const own = h.hookIngress.mintToken("agent");
      const mode = fs.statSync(hookIngressSecretsPath(h.rootDir)).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(fs.readFileSync(hookIngressSecretsPath(h.rootDir), "utf8")).not.toContain(own);
      const res = await request(h.app).post("/hooks/agent?token=" + own).send({ message: "hi" });
      expect(res.status).toBe(200);
      expect(h.gateway.calls[0].headers.authorization).toBe("Bearer " + kShared);
      expect(h.rows.at(-1).auth).toBe("per_hook_token");
      expect(h.hookIngress.builtinStatus().hooks.agent.firstOwnTokenAt).toBeTruthy();
    } finally {
      await h.close();
    }
  });

  it("refuses the shared token 24 h after the first own-token delivery, however often it is still sent", async () => {
    const h = await createHarness();
    try {
      h.hookIngress.setBuiltinEnabled("agent", true);
      const own = h.hookIngress.mintToken("agent");
      expect((await request(h.app).post("/hooks/agent").set("Authorization", "Bearer " + own).send({})).status).toBe(200);
      for (let i = 0; i < 5; i += 1) {
        h.clock.now += 4 * kHour;
        expect((await request(h.app).post("/hooks/agent").set("Authorization", "Bearer " + kShared).send({})).status).toBe(200);
      }
      h.clock.now += 4 * kHour + 1;
      const refused = await request(h.app).post("/hooks/agent").set("Authorization", "Bearer " + kShared).send({});
      expect(refused.status).toBe(401);
      expect(h.rows.at(-1).auth).toBe("rejected:shared_token_retired");
      expect((await request(h.app).post("/hooks/agent").set("Authorization", "Bearer " + own).send({})).status).toBe(200);
      await flush();
      expect(h.notices.some((notice) => notice.id.startsWith("hook-ingress-builtin-shared-agent"))).toBe(true);
      expect(h.notices.some((notice) => notice.id.startsWith("hook-ingress-builtin-retired-agent"))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("refuses the shared token 7 days after turn-on even if the own token was never used, until a person reopens it", async () => {
    const h = await createHarness();
    try {
      h.hookIngress.setBuiltinEnabled("wake", true);
      h.clock.now += 7 * kDay - 1;
      expect((await request(h.app).post("/hooks/wake").set("Authorization", "Bearer " + kShared).send({})).status).toBe(200);
      h.clock.now += 1;
      expect((await request(h.app).post("/hooks/wake").set("Authorization", "Bearer " + kShared).send({})).status).toBe(401);
      h.hookIngress.reopenBuiltinSharedToken("wake");
      expect((await request(h.app).post("/hooks/wake").set("Authorization", "Bearer " + kShared).send({})).status).toBe(200);
    } finally {
      await h.close();
    }
  });

  it("keeps the built-ins closed when alphaclaw.json is unreadable", async () => {
    const h = await createHarness();
    try {
      h.hookIngress.setBuiltinEnabled("agent", true);
      fs.writeFileSync(path.join(h.openclawDir, "alphaclaw.json"), "{ not json");
      const res = await request(h.app).post("/hooks/agent").set("Authorization", "Bearer " + kShared).send({});
      expect(res.status).toBe(404);
      expect(h.rows.at(-1).auth).toBe("rejected:builtin_policy_unreadable");
    } finally {
      await h.close();
    }
  });

  it("refuses an enabled built-in when the gateway credential cannot be resolved", async () => {
    const h = await createHarness({ launchEnv: {} });
    try {
      h.hookIngress.setBuiltinEnabled("agent", true);
      const res = await request(h.app).post("/hooks/agent").set("Authorization", "Bearer " + kShared).send({});
      expect(res.status).toBe(503);
      expect(h.gateway.calls).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it("takes a built-in's own token only on the built-in itself, never on a mapping path under it", async () => {
    const h = await createHarness();
    try {
      h.hookIngress.setBuiltinEnabled("wake", true);
      const own = h.hookIngress.mintToken("wake");
      const refused = await request(h.app).post("/hooks/wake/crm?source=crm").set("Authorization", "Bearer " + own).send({});
      expect(refused.status).toBe(401);
      expect(h.gateway.calls).toHaveLength(0);
      const shared = await request(h.app).post("/hooks/wake/crm").set("Authorization", "Bearer " + kShared).send({});
      expect(shared.status).toBe(200);
      expect(h.gateway.calls[0].url).toBe("/hooks/wake/crm");
      expect(h.gateway.calls[0].headers.authorization).toBe("Bearer " + kShared);
      const underClosedBuiltin = await request(h.app).post("/hooks/agent/crm").set("Authorization", "Bearer " + kShared).send({});
      expect(underClosedBuiltin.status).toBe(200);
      expect(h.gateway.calls[1].url).toBe("/hooks/agent/crm");
    } finally {
      await h.close();
    }
  });
});

describe("Doctor gateway.bind card", () => {
  it("fires only when gateway.bind is set to something other than loopback", () => {
    expect(buildGatewayBindCard("loopback")).toBeNull();
    expect(buildGatewayBindCard(undefined)).toBeNull();
    const card = buildGatewayBindCard("lan");
    expect(card.sourceKey).toBe("det:gateway-bind-exposed:lan");
    expect(card.summary).toContain('"lan"');
  });
});

describe("request log auth and gateway_ms columns", () => {
  it("adds the columns to a webhooks.db from before and stores both", () => {
    const { DatabaseSync } = require("node:sqlite");
    const rootDir = mkdir();
    fs.mkdirSync(path.join(rootDir, "db"), { recursive: true });
    const old = new DatabaseSync(path.join(rootDir, "db", "webhooks.db"));
    old.exec(`CREATE TABLE webhook_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, hook_name TEXT NOT NULL, method TEXT, headers TEXT,
      payload TEXT, payload_truncated INTEGER DEFAULT 0, payload_size INTEGER, source_ip TEXT,
      gateway_status INTEGER, gateway_body TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))`);
    old.exec("INSERT INTO webhook_requests (hook_name, gateway_status) VALUES ('agent', 200)");
    old.close();
    const db = require("../../lib/server/db/webhooks");
    db.initWebhooksDb({ rootDir });
    try {
      expect(db.hasAcceptedRequest("agent")).toBe(true);
      expect(db.hasAcceptedRequest("wake")).toBe(false);
      db.insertRequest({ hookName: "calendar", method: "POST", headers: {}, payload: "", payloadSize: 0, sourceIp: "1.2.3.4", gatewayStatus: 200, gatewayBody: "", auth: "shared_token", gatewayMs: 12.6 });
      const [row] = db.getRequests("calendar");
      expect(row).toMatchObject({ auth: "shared_token", gatewayMs: 13 });
      expect(db.getRequests("agent")[0]).toMatchObject({ auth: null, gatewayMs: null });
    } finally {
      db.closeWebhooksDb();
    }
  });
});

describe("built-in hook routes", () => {
  const buildApp = (actor) => {
    const { registerWebhookRoutes } = require("../../lib/server/routes/webhooks");
    const calls = [];
    const hookIngress = {
      builtinStatus: () => ({ hooks: {} }),
      setBuiltinEnabled: (name, enabled) => { calls.push(["set", name, enabled]); return { hooks: {} }; },
      mintToken: (name) => { calls.push(["mint", name]); return "minted"; },
      reopenBuiltinSharedToken: (name) => { calls.push(["reopen", name]); return { hooks: {} }; },
    };
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { if (actor) req.alphaclawActor = actor; next(); });
    registerWebhookRoutes({ app, fs, constants: {}, getBaseUrl: () => "", webhooksDb: {}, hookIngress });
    return { app, calls };
  };

  it("refuses every mutation from the agent actor", async () => {
    const { app, calls } = buildApp({ type: "agent" });
    expect((await request(app).put("/api/hook-ingress/builtins/agent").send({ enabled: true })).status).toBe(403);
    expect((await request(app).post("/api/hook-ingress/builtins/agent/token")).status).toBe(403);
    expect((await request(app).post("/api/hook-ingress/builtins/agent/reopen")).status).toBe(403);
    expect(calls).toHaveLength(0);
  });

  it("lets a person turn a built-in on and returns a minted token once, uncached", async () => {
    const { app, calls } = buildApp(null);
    expect((await request(app).put("/api/hook-ingress/builtins/agent").send({ enabled: "yes" })).status).toBe(400);
    expect((await request(app).put("/api/hook-ingress/builtins/agent").send({ enabled: true })).status).toBe(200);
    const minted = await request(app).post("/api/hook-ingress/builtins/agent/token");
    expect(minted.body.token).toBe("minted");
    expect(minted.headers["cache-control"]).toBe("no-store");
    expect(calls).toEqual([["set", "agent", true], ["mint", "agent"]]);
  });
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { createHookIngress } = require("../../lib/server/hook-ingress");
const { registerWebhookRoutes } = require("../../lib/server/routes/webhooks");
const { listWebhooks } = require("../../lib/server/webhooks");
const webhooksDomain = require("../../lib/server/admin-manifest/domains/webhooks");
const webhooksDb = require("../../lib/server/db/webhooks");

// GST-2134 PR 3: new hooks take their own token, Gmail push gets its own
// token, and a hook off the shared token is the owner's: the agent may not
// delete it or touch its OAuth callback alias, and only an alias a person made
// while the hook was verifying delivers to it.

const kShared = ["shared", "hook", "value"].join("-");
const kTokenRef = "$" + "{WEBHOOK_TOKEN}";
const kTokenEnvName = "WEBHOOK_TOKEN";
const scratch = [];
const mkdir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hook-own-"));
  scratch.push(dir);
  return dir;
};

const createHarness = () => {
  const openclawDir = mkdir();
  const rootDir = mkdir();
  fs.writeFileSync(path.join(openclawDir, "openclaw.json"), JSON.stringify({ hooks: { enabled: true, token: kTokenRef, mappings: [] } }));
  webhooksDb.initWebhooksDb({ rootDir });
  const clock = { now: Date.parse("2026-11-10T12:00:00Z") };
  const constants = { OPENCLAW_DIR: openclawDir };
  const hookIngress = createHookIngress({
    openclawDir,
    rootDir,
    readOpenclawConfig: () => ({ hooks: { enabled: true, token: kTokenRef } }),
    getLaunchEnv: () => ({ WEBHOOK_TOKEN: kShared }),
    listHookNames: () => listWebhooks({ fs, constants }).map((hook) => hook.name),
    deleteReplayKeysByHook: webhooksDb.deleteReplayKeysByHook,
    clearAliasConfirmation: webhooksDb.clearOauthCallbackConfirmation,
    nowMs: () => clock.now,
    logger: { warn: () => {}, log: () => {}, error: () => {} },
  });
  const actor = { type: "user" };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.alphaclawActor = { ...actor };
    next();
  });
  registerWebhookRoutes({
    app,
    fs,
    constants,
    getBaseUrl: () => "https://box.example",
    webhooksDb,
    restartRequiredState: { markRequired: () => {}, getSnapshot: async () => ({ restartRequired: false }) },
    hookIngress,
  });
  const verdict = (hookName, token) =>
    hookIngress.authenticateHookDelivery({ headers: {}, socket: { remoteAddress: "10.0.0.4" } }, {
      hookName,
      gatewayPath: "/hooks/" + hookName,
      gatewayHeaders: { authorization: ["Bearer", token].join(" ") },
    });
  return { app, actor, hookIngress, openclawDir, rootDir, clock, verdict };
};

beforeEach(() => {
  process.env[kTokenEnvName] = kShared;
});
afterEach(() => {
  webhooksDb.closeWebhooksDb();
  delete process.env[kTokenEnvName];
});
afterAll(() => {
  for (const dir of scratch) fs.rmSync(dir, { recursive: true, force: true });
});

describe("new hooks take their own token", () => {
  it("returns the own token once with ready URLs, and the shared token never works on the new hook", async () => {
    const h = createHarness();
    const res = await request(h.app).post("/api/webhooks").send({ name: "orders" });
    expect(res.status).toBe(201);
    const { webhook } = res.body;
    expect(webhook.ingress).toEqual({ preset: "per_hook_token" });
    expect(webhook.ownToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(webhook.queryStringUrl).toBe("https://box.example/hooks/orders?token=" + webhook.ownToken);
    expect(webhook.authHeaderValue).toContain(webhook.ownToken);
    expect(webhook.authHeaderValue).not.toContain(kShared);
    expect(h.verdict("orders", kShared)).toMatchObject({ ok: false, status: 401, reason: "shared_token_retired" });
    expect(h.verdict("orders", webhook.ownToken)).toMatchObject({ ok: true, authMethod: "per_hook_token" });
    expect(h.hookIngress.ingressStatus("orders")).toMatchObject({ preset: "per_hook_token", state: "closed", sharedTokenAccepted: false });

    const detail = await request(h.app).get("/api/webhooks/orders");
    expect(detail.body.webhook.queryStringUrl).toBe("https://box.example/hooks/orders?token=<this hook's token>");
    expect(JSON.stringify(detail.body)).not.toContain(webhook.ownToken);
    expect(JSON.stringify(detail.body)).not.toContain(kShared);
    expect(detail.body.webhook.authNote).toContain("its own token");
  });

  it("does not hand the agent the own token or a moved hook's callback URL", () => {
    const masked = webhooksDomain.ops.find((op) => op.id === "webhooks.create").redactResponse({
      ok: true,
      webhook: {
        ownToken: "x".repeat(43),
        hasHookToken: true,
        hasRuntimeToken: true,
        queryStringUrl: "https://box.example/hooks/orders?token=" + "x".repeat(43),
        authHeaderValue: "Authorization: Bearer " + "x".repeat(43),
        ingress: { preset: "per_hook_token" },
        oauthCallbackId: "cb-1",
        oauthCallbackUrl: "https://box.example/oauth/cb-1",
      },
    });
    expect(JSON.stringify(masked)).not.toContain("x".repeat(43));
    expect(JSON.stringify(masked)).not.toContain("cb-1");
    expect(masked.webhook.queryStringUrl).toBe("https://box.example/hooks/orders?token=<this hook's token>");
    const tokenHook = webhooksDomain.ops.find((op) => op.id === "webhooks.detail").redactResponse({
      ok: true,
      webhook: { hasRuntimeToken: true, ingress: { preset: "token" }, oauthCallbackId: "cb-2", oauthCallbackUrl: "https://box.example/oauth/cb-2", queryStringUrl: "u?token=" + kShared, authHeaderValue: "a" },
    });
    expect(tokenHook.webhook.oauthCallbackUrl).toBe("https://box.example/oauth/cb-2");
    expect(JSON.stringify(tokenHook)).not.toContain(kShared);
  });

  it("masks a moved hook's callback URL for the agent when it changes the hook's destination", async () => {
    const h = createHarness();
    await request(h.app).post("/api/webhooks").send({ name: "orders", oauthCallback: true });
    const callbackId = webhooksDb.getOauthCallbackByHook("orders").callbackId;
    h.actor.type = "agent";
    const res = await request(h.app).put("/api/webhooks/orders/destination").send({ destination: null });
    expect(res.status).toBe(200);
    expect(res.body.webhook.authNote).toContain("its own token");
    const masked = webhooksDomain.ops.find((op) => op.id === "webhooks.destination-update").redactResponse(res.body);
    expect(JSON.stringify(masked)).not.toContain(callbackId);
    expect(masked.webhook.oauthCallbackUrl).toBe("••• (owner only)");
  });

  it("confirms an OAuth alias made by a person with the hook, and not one made by the agent", async () => {
    const h = createHarness();
    await request(h.app).post("/api/webhooks").send({ name: "crm", oauthCallback: true });
    expect(webhooksDb.getOauthCallbackByHook("crm").ownerConfirmedAt).toBeTruthy();
    h.actor.type = "agent";
    await request(h.app).post("/api/webhooks").send({ name: "crm2", oauthCallback: true });
    expect(webhooksDb.getOauthCallbackByHook("crm2").ownerConfirmedAt).toBeNull();
  });
});

describe("a hook off the shared token is the owner's", () => {
  it("refuses the agent deleting it, rotating or adding its alias; a person's rotation confirms the alias", async () => {
    const h = createHarness();
    await request(h.app).post("/api/webhooks").send({ name: "crm", oauthCallback: true });
    h.actor.type = "agent";
    expect((await request(h.app).delete("/api/webhooks/crm")).status).toBe(403);
    expect((await request(h.app).post("/api/webhooks/crm/oauth-callback/rotate")).status).toBe(403);
    await request(h.app).delete("/api/webhooks/crm/oauth-callback");
    expect((await request(h.app).post("/api/webhooks/crm/oauth-callback")).status).toBe(403);
    h.actor.type = "user";
    expect((await request(h.app).post("/api/webhooks/crm/oauth-callback")).status).toBe(201);
    expect(webhooksDb.getOauthCallbackByHook("crm").ownerConfirmedAt).toBeTruthy();
    const rotated = await request(h.app).post("/api/webhooks/crm/oauth-callback/rotate");
    expect(rotated.status).toBe(200);
    expect(webhooksDb.getOauthCallbackById(rotated.body.oauthCallbackId).ownerConfirmedAt).toBeTruthy();
    expect((await request(h.app).delete("/api/webhooks/crm")).status).toBe(200);
  });

  it("forgets a person's alias confirmation when the hook goes back to the shared token", async () => {
    const h = createHarness();
    await request(h.app).post("/api/webhooks").send({ name: "crm", oauthCallback: true });
    const aliasVerdict = () =>
      h.hookIngress.authenticateHookDelivery({ headers: {}, socket: { remoteAddress: "10.0.0.4" } }, {
        hookName: "crm",
        gatewayPath: "/hooks/crm",
        gatewayHeaders: {},
        internal: "oauth_alias",
        aliasConfirmed: !!webhooksDb.getOauthCallbackByHook("crm").ownerConfirmedAt,
      });
    expect(aliasVerdict().ok).toBe(true);
    h.hookIngress.setIngress("crm", { preset: "token" });
    expect(webhooksDb.getOauthCallbackByHook("crm").ownerConfirmedAt).toBeNull();
    h.hookIngress.generateIngressSecret("crm", { preset: "per_hook_token" });
    expect(aliasVerdict()).toMatchObject({ ok: false, status: 403 });
    await request(h.app).post("/api/webhooks/crm/oauth-callback/rotate");
    expect(aliasVerdict().ok).toBe(true);
  });

  it("forgets a confirmation left on a hook already on the shared token when the hook leaves it", async () => {
    const h = createHarness();
    await request(h.app).post("/api/webhooks").send({ name: "crm", oauthCallback: true });
    const olderBuild = createHookIngress({
      openclawDir: h.openclawDir,
      rootDir: h.rootDir,
      listHookNames: () => ["crm"],
      logger: { warn: () => {}, log: () => {}, error: () => {} },
    });
    olderBuild.setIngress("crm", { preset: "token" });
    expect(webhooksDb.getOauthCallbackByHook("crm").ownerConfirmedAt).toBeTruthy();
    h.hookIngress.generateIngressSecret("crm", { preset: "per_hook_token" });
    expect(webhooksDb.getOauthCallbackByHook("crm").ownerConfirmedAt).toBeNull();
  });

  it("keeps the hook where it was when the confirmation cannot be cleared", () => {
    const h = createHarness();
    let locked = false;
    const failing = createHookIngress({
      openclawDir: h.openclawDir,
      rootDir: h.rootDir,
      listHookNames: () => ["crm"],
      clearAliasConfirmation: () => {
        if (locked) throw new Error("database is locked");
        return 0;
      },
      logger: { warn: () => {}, log: () => {}, error: () => {} },
    });
    failing.generateIngressSecret("crm", { preset: "per_hook_token" });
    locked = true;
    expect(() => failing.setIngress("crm", { preset: "token" })).toThrow("database is locked");
    expect(failing.ingressStatus("crm").preset).toBe("per_hook_token");
  });

  it("leaves a hook on the shared token to the agent as before, with an unconfirmed alias", async () => {
    const h = createHarness();
    await request(h.app).post("/api/webhooks").send({ name: "legacy", oauthCallback: true });
    h.hookIngress.setIngress("legacy", { preset: "token" });
    h.actor.type = "agent";
    const rotated = await request(h.app).post("/api/webhooks/legacy/oauth-callback/rotate");
    expect(rotated.status).toBe(200);
    expect(webhooksDb.getOauthCallbackById(rotated.body.oauthCallbackId).ownerConfirmedAt).toBeNull();
    expect((await request(h.app).delete("/api/webhooks/legacy")).status).toBe(200);
  });
});

describe("Gmail push takes its own token", () => {
  it("mints the Gmail hook's own token once and keeps the shared token until 24 h after its first own-token delivery", async () => {
    const h = createHarness();
    const first = h.hookIngress.ensureInternalHookToken("gmail");
    expect(h.hookIngress.ensureInternalHookToken("gmail")).toBe(first);
    expect(h.hookIngress.ingressStatus("gmail")).toMatchObject({ preset: "per_hook_token", state: "waiting" });
    expect(h.verdict("gmail", kShared)).toMatchObject({ ok: true, authMethod: "shared_token" });
    const own = h.verdict("gmail", first);
    expect(own).toMatchObject({ ok: true, authMethod: "per_hook_token" });
    own.onAdmitted();
    h.clock.now += 24 * 60 * 60 * 1000 + 1;
    expect(h.verdict("gmail", kShared)).toMatchObject({ ok: false, reason: "shared_token_retired" });
    expect(h.verdict("gmail", first)).toMatchObject({ ok: true });
    const secrets = JSON.parse(fs.readFileSync(path.join(h.rootDir, "hook-ingress", "secrets.json"), "utf8"));
    expect(secrets.hooks.gmail.token).toBe(first);
    expect(JSON.stringify(h.hookIngress.ingressStatus("gmail"))).not.toContain(first);
  });
});

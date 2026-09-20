const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { DatabaseSync } = require("node:sqlite");
const { registerOpenclawBackupPolicyRoutes } = require("../../lib/server/routes/openclaw-backup-policy");
const { readAlphaclawConfig, updateAlphaclawConfig } = require("../../lib/server/alphaclaw-config");
const { initAgentAdminDb, closeAgentAdminDb } = require("../../lib/server/db/agent-admin");
const { createConfirmService } = require("../../lib/server/agent-admin/confirm-service");
const { findOp } = require("../../lib/server/admin-manifest");

const kUrl = "/api/openclaw/backup-policy";
const kToken = "a".repeat(64);
const kDefaults = { excludes: ["node_modules", "*.heapsnapshot", "*.tmp", "logs/**/*.gz"], rootExcludes: [] };
const empty = { excludes: [], rootExcludes: [] };
let root;
let configPath;

const createApp = ({ buildInventory, noEnforcement = false, member = false, confirmService } = {}) => {
  vi.stubEnv("SETUP_PASSWORD", "secret");
  const authPath = require.resolve("../../lib/server/routes/auth");
  delete require.cache[authPath];
  const { registerAuthRoutes } = require(authPath);
  const { createAgentAdminEnforcement } = require("../../lib/server/agent-admin/enforcement");
  const app = express();
  app.use(express.json());
  const throttle = {
    getClientKey: () => "policy-client", getOrCreateLoginAttemptState: () => ({ attempts: 0 }),
    evaluateLoginThrottle: () => ({ blocked: false, retryAfterSec: 0 }),
    recordLoginFailure: () => ({ lockMs: 0, locked: false }), recordLoginSuccess: () => {},
    cleanupLoginAttemptStates: () => {},
  };
  const { requireAdmin, resolveRequestActor } = registerAuthRoutes({ app, loginThrottle: throttle,
    agentAdmin: { isEnabled: () => true, readToken: () => kToken, throttle, onAuthEvent: () => {} } });
  if (!noEnforcement) app.use("/api", createAgentAdminEnforcement({ resolveRequestActor, confirmService }));
  if (member) app.use(kUrl, (req, _res, next) => { req.alphaclawIdentity = { role: "member" }; next(); });
  if (noEnforcement) app.use(kUrl, (req, _res, next) => { req.alphaclawGrant = { method: req.method, path: req.path }; next(); });
  registerOpenclawBackupPolicyRoutes({ app, requireAdmin, OPENCLAW_DIR: root, buildInventory,
    getSourceContext: () => ({ stateDir: root, spawnEnv: {} }) });
  return app;
};
const admin = async (app) => {
  const signedIn = await request(app).post("/api/auth/login").send({ password: "secret" });
  expect(signedIn.status).toBe(200);
  return signedIn.headers["set-cookie"][0].split(";")[0];
};
const bearer = (req) => req.set("Authorization", `Bearer ${kToken}`);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-backup-policy-"));
  configPath = path.join(root, "alphaclaw.json");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  closeAgentAdminDb();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("backup exclusion policy API", () => {
  it("returns defaults without writing, persists empty arrays, and restores defaults explicitly", async () => {
    const app = createApp(); const cookie = await admin(app);
    const initial = await request(app).get(kUrl).set("Cookie", cookie);
    expect(initial.status).toBe(200);
    expect(initial.body).toEqual({ ok: true, policy: kDefaults, defaults: kDefaults, refusedExcludes: [] });
    expect(fs.existsSync(configPath)).toBe(false);
    expect((await request(app).put(kUrl).set("Cookie", cookie).send(empty)).status).toBe(200);
    expect(readAlphaclawConfig({ openclawDir: root }).updates.openclaw.backup).toEqual(empty);
    expect((await request(app).get(kUrl).set("Cookie", cookie)).body.policy).toEqual(empty);
    const restored = await request(app).put(kUrl).set("Cookie", cookie).send(kDefaults);
    expect(restored.status).toBe(200);
    expect(restored.body.policy).toEqual(kDefaults);
  });

  it("rejects malformed bodies and unsafe rules atomically", async () => {
    fs.writeFileSync(configPath, '{"untouched":true}');
    const app = createApp(); const cookie = await admin(app);
    for (const body of [{}, { excludes: [] }, { excludes: "node_modules", rootExcludes: [] },
      { excludes: ["safe", "../state"], rootExcludes: [] }, { excludes: [], rootExcludes: ["state"] },
      { excludes: [], rootExcludes: ["credentials"] }, { excludes: [], rootExcludes: ["/outside"] },
      { excludes: Array.from({ length: 65 }, (_, index) => `scratch-${index}`), rootExcludes: [] }]) {
      const response = await request(app).put(kUrl).set("Cookie", cookie).send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.code).toBe("invalid_backup_policy");
      expect(fs.readFileSync(configPath, "utf8")).toBe('{"untouched":true}');
    }
  });

  it("protects configured custom database ancestors during saves", async () => {
    const agentDir = path.join(root, "state", "security-planning", "stronghold-state");
    fs.mkdirSync(agentDir, { recursive: true });
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite")); db.close();
    fs.writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({ agents: { list: [{ id: "custom", agentDir }] } }));
    const app = createApp(); const cookie = await admin(app);
    const rejected = await request(app).put(kUrl).set("Cookie", cookie).send({ ...empty, rootExcludes: ["state/security-planning/stronghold-*"] });
    expect(rejected.status).toBe(400);
    expect(rejected.body.refusedExcludes[0]).toMatchObject({ scope: "root", pattern: "state/security-planning/stronghold-*", reason: expect.stringContaining("protected") });
    expect(fs.existsSync(configPath)).toBe(false);
    const allowed = await request(app).put(kUrl).set("Cookie", cookie).send({ ...empty, rootExcludes: ["state/security-planning/scratch-*"] });
    expect(allowed.status).toBe(200);
  });

  it("reports refused hand-edited rules without rewriting them", async () => {
    const raw = JSON.stringify({ updates: { openclaw: { backup: { excludes: ["node_modules", "*.sqlite"], rootExcludes: ["state"] } } } });
    fs.writeFileSync(configPath, raw);
    const app = createApp(); const cookie = await admin(app);
    const response = await request(app).get(kUrl).set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body.policy).toEqual({ excludes: ["node_modules"], rootExcludes: [] });
    expect(response.body.refusedExcludes).toHaveLength(2);
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
  });

  it("reports the effective policy when a hand-edited rule covers a configured database ancestor", async () => {
    const agentDir = path.join(root, "state", "security-planning", "stronghold-state");
    fs.mkdirSync(agentDir, { recursive: true });
    const db = new DatabaseSync(path.join(agentDir, "openclaw-agent.sqlite")); db.close();
    fs.writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({ agents: { list: [{ id: "custom", agentDir }] } }));
    const unsafe = "state/security-planning/stronghold-*";
    const safe = "state/security-planning/scratch-*";
    const raw = JSON.stringify({ updates: { openclaw: { backup: { excludes: [], rootExcludes: [unsafe, safe] } } } });
    fs.writeFileSync(configPath, raw);
    const app = createApp(); const cookie = await admin(app);

    const response = await request(app).get(kUrl).set("Cookie", cookie);

    expect(response.status).toBe(200);
    expect(response.body.policy).toEqual({ excludes: [], rootExcludes: [safe] });
    expect(response.body.defaults).toEqual(kDefaults);
    expect(response.body.refusedExcludes).toEqual([
      { scope: "root", pattern: unsafe, reason: 'covers the protected asset or ancestor "state/security-planning/stronghold-state"' },
    ]);
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
  });

  it.each(['{"broken":', '[]', 'null'])("refuses corrupt settings %s before GET or PUT and preserves bytes", async (raw) => {
    fs.writeFileSync(configPath, raw);
    const app = createApp(); const cookie = await admin(app);
    for (const method of ["get", "put"]) {
      const call = request(app)[method](kUrl).set("Cookie", cookie);
      const response = await (method === "put" ? call.send(empty) : call);
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ ok: false, code: "config_unreadable", file: "alphaclaw.json" });
      expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
    }
  });

  it("rechecks damaged settings under the write lock after inventory discovery", async () => {
    fs.writeFileSync(configPath, "{}");
    const app = createApp({ buildInventory: async () => {
      fs.writeFileSync(configPath, '{"torn":');
      return { stateDir: root, protectedPaths: [] };
    } });
    const cookie = await admin(app);
    const response = await request(app).put(kUrl).set("Cookie", cookie).send(empty);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("config_unreadable");
    expect(fs.readFileSync(configPath, "utf8")).toBe('{"torn":');
  });

  it("does not replace a dangling settings symlink with default configuration", async () => {
    fs.symlinkSync(path.join(root, "missing-settings.json"), configPath);
    const app = createApp(); const cookie = await admin(app);
    const response = await request(app).put(kUrl).set("Cookie", cookie).send(empty);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("config_unreadable");
    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
  });

  it("merges into the current locked document after another settings writer", async () => {
    const app = createApp({ buildInventory: async () => {
      updateAlphaclawConfig({ openclawDir: root, mutate: (cfg) => { cfg.keep = { otherWriter: true }; } });
      return { stateDir: root, protectedPaths: [] };
    } });
    const cookie = await admin(app);
    expect((await request(app).put(kUrl).set("Cookie", cookie).send(empty)).status).toBe(200);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toMatchObject({ keep: { otherWriter: true }, updates: { openclaw: { backup: empty } } });
  });

  it("fails closed on GET and PUT if protected source discovery fails", async () => {
    const app = createApp({ buildInventory: async () => { throw new Error("unreadable registry"); } });
    const cookie = await admin(app);
    for (const method of ["get", "put"]) {
      const call = request(app)[method](kUrl).set("Cookie", cookie);
      const response = await (method === "put" ? call.send(empty) : call);
      expect(response.status).toBe(503);
      expect(response.body.code).toBe("backup_policy_unavailable");
      expect(response.body.policy).toBeUndefined();
    }
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

describe("backup policy authorization", () => {
  it("requires authentication for reads and adds an admin gate only on writes", async () => {
    const app = createApp({ member: true });
    expect((await request(app).get(kUrl)).status).toBe(401);
    const cookie = await admin(app);
    // This identity is injected after the global member-scope middleware.
    // Production members remain default-denied by that middleware; the local
    // read route does not add a second role gate.
    expect((await request(app).get(kUrl).set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).put(kUrl).set("Cookie", cookie).send(empty)).status).toBe(403);
  });
  it("allows safe agent reads, requires dangerous confirmation, then admits the granted PUT", async () => {
    initAgentAdminDb({ rootDir: root });
    let code;
    const confirmService = createConfirmService({ hasAdminTargets: () => true, deliver: (delivery) => { code = delivery.code; } });
    const app = createApp({ confirmService });
    expect(findOp("GET", kUrl).tier).toBe("safe");
    expect(findOp("PUT", kUrl)).toMatchObject({ tier: "dangerous", readOp: "updates.backup-policy.read" });
    expect((await bearer(request(app).get(kUrl))).status).toBe(200);
    expect((await bearer(request(app).put(kUrl).send(empty))).status).toBe(428);
    expect(fs.existsSync(configPath)).toBe(false);
    expect((await bearer(request(app).put(kUrl).set("X-AlphaClaw-Confirm", code).send(empty))).status).toBe(200);
  });
  it("does not accept a forged grant without the enforcement layer", async () => {
    const app = createApp({ noEnforcement: true });
    expect((await bearer(request(app).get(kUrl))).status).toBe(200);
    expect((await bearer(request(app).put(kUrl).send(empty))).status).toBe(403);
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

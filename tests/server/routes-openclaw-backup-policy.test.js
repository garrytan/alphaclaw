const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { registerOpenclawBackupPolicyRoutes } = require("../../lib/server/routes/openclaw-backup-policy");
const { initAgentAdminDb, closeAgentAdminDb } = require("../../lib/server/db/agent-admin");
const { createConfirmService } = require("../../lib/server/agent-admin/confirm-service");
const { findOp } = require("../../lib/server/admin-manifest");

const kUrl = "/api/openclaw/backup-policy";
const kToken = "a".repeat(64);
const kDefaults = { excludes: ["node_modules", "*.heapsnapshot", "*.tmp", "logs/**/*.gz"],
  rootExcludes: ["worktrees/**", "workspace/.openclaw/**", "wiki/**", "logs/**", "**/*.sqlite.corrupt-*", "**/*.sqlite.migrated*"] };
let root;
let configPath;

const createApp = ({ getBackupPreflight, buildInventory, getSourceContext, fsModule = fs,
  noEnforcement = false, member = false, confirmService } = {}) => {
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
  registerOpenclawBackupPolicyRoutes({ app, requireAdmin, OPENCLAW_DIR: root,
    getBackupPreflight, buildInventory, getSourceContext, fsModule });
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

describe("backup preflight API", () => {
  const url = "/api/openclaw/backup-preflight";
  const diagnosis = { directories: { complete: true, entries: 407321, bytes: 12000000000,
    stateDir: "/private/state", rootSymlink: true, absoluteSymlinkCount: 2,
    absoluteSymlinks: [{ path: ".env", target: "/private/.env" }, { path: "wiki/index", target: "/private/notes" }],
    topLevel: [{ path: "worktrees", entries: 152243, bytes: 5800000000 }],
    topEntries: [{ path: "worktrees", entries: 152243, bytes: 5800000000 }], topBytes: [],
  }, sources: [{ path: "/private/state/main.sqlite" }] };

  it("returns config checkpoint measurements without private paths and disables HTTP caching", async () => {
    const getBackupPreflight = vi.fn(async () => ({ profile: "config_only", blocked: false,
      checkpoint: { bytes: 1234, fileCount: 7, files: [{ path: "/private/openclaw.json" }] },
      databaseCount: 3, databaseBytes: 9000, stateDir: "/private/state" }));
    const app = createApp({ getBackupPreflight }); const cookie = await admin(app);
    const response = await request(app).get(url).set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ ok: true, profile: "config_only", blocked: false, reason: null,
      checkpoint: { bytes: 1234, fileCount: 7, maxBytes: 16 * 1024 * 1024 }, databaseCount: 3,
      databaseBytes: 9000, coverage: { config: "complete", databases: "omitted", workspace: "omitted" } });
    expect(JSON.stringify(response.body)).not.toContain("/private");
    expect(getBackupPreflight).toHaveBeenCalledOnce();
  });

  it("never claims complete configuration coverage for a blocked checkpoint measurement", async () => {
    const app = createApp({ getBackupPreflight: async () => ({ profile: "config_only", blocked: true,
      reason: "checkpoint_limit", checkpoint: { bytes: 99, fileCount: 1 },
      coverage: { config: "complete", databases: "complete", workspace: "complete" } }) });
    const response = await bearer(request(app).get(url));
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.coverage).toEqual({ config: "unknown", databases: "omitted", workspace: "omitted" });
  });

  it.each([null, { bytes: -1, fileCount: 1 }, { bytes: 1, fileCount: -1 },
    { bytes: "123", fileCount: 1 }, { bytes: 1, fileCount: 0.5 }])("fails closed on malformed checkpoint measurements %j", async (checkpoint) => {
    const app = createApp({ getBackupPreflight: async () => ({ profile: "config_only", blocked: false, checkpoint }) });
    const response = await request(app).get(url).set("Cookie", await admin(app));
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("backup_preflight_unavailable");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.coverage).toBeUndefined();
  });

  it("keeps compatibility with the old diagnostic shape without mutating config", async () => {
    const getBackupPreflight = vi.fn(async () => ({ diagnosis, blocked: true, reason: "Selected tree exceeds budget" }));
    const app = createApp({ getBackupPreflight }); const cookie = await admin(app);
    const response = await request(app).get(url).set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ ok: true, diagnosis, blocked: true, reason: "Selected tree exceeds budget" });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("requires authentication and redacts absolute paths for read-tier agents", async () => {
    const app = createApp({ getBackupPreflight: async () => ({ diagnosis, blocked: false, reason: null }) });
    expect((await request(app).get(url)).status).toBe(401);
    expect(findOp("GET", url).tier).toBe("safe");
    const response = await bearer(request(app).get(url));
    expect(response.status).toBe(200);
    expect(response.body.diagnosis.directories).toMatchObject({ entries: 407321, bytes: 12000000000,
      absoluteSymlinks: [{ path: ".env", target: "[redacted]" }, { path: "wiki/index", target: "[redacted]" }] });
    expect(JSON.stringify(response.body)).not.toContain("/private");
  });

  it("never exposes live process command arguments through preflight", async () => {
    const app = createApp({ getBackupPreflight: async () => ({
      diagnosis: { ...diagnosis, otherProcesses: [{ pid: 123, cmdline: "openclaw --token fixture-only-secret" }] }, blocked: false,
    }) });
    const response = await request(app).get(url).set("Cookie", await admin(app));
    expect(response.status).toBe(200);
    expect(response.body.diagnosis.otherProcesses).toEqual([{ pid: 123 }]);
    expect(JSON.stringify(response.body)).not.toContain("fixture-only-secret");
    expect(findOp("GET", url).redactResponse({ diagnosis: { otherProcesses: [{ pid: 123, cmdline: "private argv" }] } })
      .diagnosis.otherProcesses).toEqual([{ pid: 123, cmdline: "[redacted]" }]);
  });

  it.each([undefined, async () => { throw new Error("private /path failure"); }, async () => ({ diagnosis: {} })])(
    "fails closed when the preflight cannot complete", async (getBackupPreflight) => {
      const app = createApp({ getBackupPreflight }); const cookie = await admin(app);
      const response = await request(app).get(url).set("Cookie", cookie);
      expect(response.status).toBe(503);
      expect(response.body).toMatchObject({ ok: false, code: "backup_preflight_unavailable" });
      expect(response.body.message).toContain("has not been paused");
      expect(JSON.stringify(response.body)).not.toContain("/path");
    },
  );
});

describe("retired backup policy mutations", () => {
  it("admits the write-tier agent only far enough to report retired scratch policy without mutation", async () => {
    const raw = '{"updates":{"openclaw":{"backup":{"excludes":[],"rootExcludes":[],"custom":"preserved"}}}}';
    fs.writeFileSync(configPath, raw);
    const app = createApp();
    const url = `${kUrl}/scratch-excludes`;
    expect(findOp("POST", url)).toMatchObject({ tier: "write", readOp: "updates.backup-policy.read" });
    const response = await bearer(request(app).post(url).send({ rootExcludes: ["worktrees/**", "workspace/.openclaw/**"] }));
    expect(response.status).toBe(410);
    expect(response.body.code).toBe("backup_policy_retired");
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
  });

  it("returns retired defaults without creating a missing settings file", async () => {
    const buildInventory = vi.fn(() => { throw new Error("owner discovery must not run"); });
    const app = createApp({ buildInventory });
    const response = await request(app).get(kUrl).set("Cookie", await admin(app));
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, retired: true, policy: kDefaults, defaults: kDefaults, refusedExcludes: [] });
    expect(fs.existsSync(configPath)).toBe(false);
    expect(buildInventory).not.toHaveBeenCalled();
  });

  it.each([
    { rootExcludes: [] }, { rootExcludes: ["state/**"] }, { rootExcludes: ["worktrees/**"], excludes: [] },
    { rootExcludes: ["worktrees/*"] }, { rootExcludes: ["../worktrees/**"] }, { rootExcludes: "worktrees/**" },
  ])("returns retirement for old scratch mutation body %j without rewriting historical bytes", async (body) => {
    const raw = '{ "updates": { "openclaw": { "backup": { "excludes": [], "rootExcludes": ["state/scratch-*"], "custom": "preserved" } } } }\n';
    fs.writeFileSync(configPath, raw);
    const buildInventory = vi.fn();
    const getSourceContext = vi.fn();
    const app = createApp({ buildInventory, getSourceContext });
    const response = await bearer(request(app).post(`${kUrl}/scratch-excludes`).send(body));
    expect(response.status).toBe(410);
    expect(response.body.code).toBe("backup_policy_retired");
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
    expect(buildInventory).not.toHaveBeenCalled();
    expect(getSourceContext).not.toHaveBeenCalled();
  });

  it("rejects all retired PUT bodies without reading, validating or rewriting the settings", async () => {
    const raw = '{"untouched":true}\n'; fs.writeFileSync(configPath, raw);
    const readFileSync = vi.fn(() => { throw new Error("retired mutation read config"); });
    const writeFileSync = vi.fn(() => { throw new Error("retired mutation wrote config"); });
    const buildInventory = vi.fn();
    const app = createApp({ fsModule: { ...fs, readFileSync, writeFileSync }, buildInventory });
    const cookie = await admin(app);
    for (const body of [{}, { excludes: [] }, { excludes: "node_modules", rootExcludes: [] },
      { excludes: ["safe", "../state"], rootExcludes: [] }, { excludes: [], rootExcludes: ["state"] },
      { excludes: [], rootExcludes: ["credentials"] }, { excludes: [], rootExcludes: ["/outside"] },
      { excludes: Array.from({ length: 65 }, (_, i) => `scratch-${i}`), rootExcludes: [] }]) {
      const response = await request(app).put(kUrl).set("Cookie", cookie).send(body);
      expect(response.status).toBe(410);
      expect(response.body.code).toBe("backup_policy_retired");
      expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
    }
    expect(readFileSync).not.toHaveBeenCalled();
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(buildInventory).not.toHaveBeenCalled();
  });

  it("preserves historical custom database exclusions without traversing configured owners", async () => {
    const raw = JSON.stringify({ updates: { openclaw: { backup: { excludes: [],
      rootExcludes: ["state/security-planning/stronghold-*", "state/security-planning/scratch-*"] } } } });
    fs.writeFileSync(configPath, raw);
    fs.writeFileSync(path.join(root, "openclaw.json"), JSON.stringify({ agents: { list: [{ id: "custom", agentDir: "/private/unreachable" }] } }));
    const buildInventory = vi.fn(() => { throw new Error("must not discover owners"); });
    const app = createApp({ buildInventory }); const cookie = await admin(app);
    const response = await request(app).get(kUrl).set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ retired: true, policy: { excludes: [],
      rootExcludes: ["state/security-planning/stronghold-*", "state/security-planning/scratch-*"] } });
    expect((await request(app).put(kUrl).set("Cookie", cookie).send({ excludes: [], rootExcludes: [] })).status).toBe(410);
    expect(buildInventory).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
  });

  it("reports syntactically refused historical rules without rewriting them", async () => {
    const raw = JSON.stringify({ updates: { openclaw: { backup: { excludes: ["node_modules", "*.sqlite"], rootExcludes: ["state"] } } } });
    fs.writeFileSync(configPath, raw);
    const app = createApp();
    const response = await request(app).get(kUrl).set("Cookie", await admin(app));
    expect(response.status).toBe(200);
    expect(response.body.policy).toEqual({ excludes: ["node_modules"], rootExcludes: [] });
    expect(response.body.refusedExcludes).toHaveLength(2);
    expect(response.body.retired).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
  });

  it("returns historical settings without inventory discovery", async () => {
    const raw = JSON.stringify({ updates: { openclaw: { backup: { excludes: ["*.tmp"], rootExcludes: ["worktrees/**"] } } } });
    fs.writeFileSync(configPath, raw);
    const getBackupPreflight = vi.fn(async () => { throw new Error("must not be called"); });
    const app = createApp({ getBackupPreflight }); const cookie = await admin(app);
    const response = await request(app).get(kUrl).set("Cookie", cookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ ok: true, retired: true,
      policy: { excludes: ["*.tmp"], rootExcludes: ["worktrees/**"] } });
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
    expect(getBackupPreflight).not.toHaveBeenCalled();
  });

  it.each(['{"broken":', '[]', 'null'])("keeps GET fail-closed on corrupt configuration %s while mutations return410", async (raw) => {
    fs.writeFileSync(configPath, raw);
    const app = createApp();
    const cookie = await admin(app);
    const response = await request(app).get(kUrl).set("Cookie", cookie);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("config_unreadable");
    expect((await request(app).put(kUrl).set("Cookie", cookie).send({})).status).toBe(410);
    expect((await request(app).post(`${kUrl}/scratch-excludes`).set("Cookie", cookie).send({})).status).toBe(410);
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
  });

  it("does not replace a dangling settings symlink or inspect its missing target", async () => {
    fs.symlinkSync(path.join(root, "missing.json"), configPath);
    const buildInventory = vi.fn();
    const app = createApp({ buildInventory }); const cookie = await admin(app);
    expect((await request(app).put(kUrl).set("Cookie", cookie).send({})).status).toBe(410);
    expect((await request(app).post(`${kUrl}/scratch-excludes`).set("Cookie", cookie).send({})).status).toBe(410);
    expect(fs.lstatSync(configPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(configPath)).toBe(path.join(root, "missing.json"));
    expect(buildInventory).not.toHaveBeenCalled();
  });

  it("never executes former discovery callbacks that would mutate or tear the settings under a lock", async () => {
    const raw = '{"operator":"saved elsewhere","updates":{"openclaw":{"backup":{"excludes":[],"rootExcludes":[]}}}}';
    fs.writeFileSync(configPath, raw);
    const buildInventory = vi.fn(async () => { fs.writeFileSync(configPath, '{"torn":'); return { stateDir: root, protectedPaths: [] }; });
    const app = createApp({ buildInventory }); const cookie = await admin(app);
    expect((await request(app).put(kUrl).set("Cookie", cookie).send(kDefaults)).status).toBe(410);
    expect((await request(app).post(`${kUrl}/scratch-excludes`).set("Cookie", cookie).send({ rootExcludes: ["worktrees/**"] })).status).toBe(410);
    expect((await request(app).get(kUrl).set("Cookie", cookie)).status).toBe(200);
    expect(buildInventory).not.toHaveBeenCalled();
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
  });

  it.each([
    ["PUT", kUrl, { excludes: [], rootExcludes: [] }],
    ["POST", `${kUrl}/scratch-excludes`, { rootExcludes: ["worktrees/**"] }],
  ])("returns 410 for %s even with corrupt historical settings, without inventory or file changes", async (method, url, body) => {
    const raw = '{"torn":'; fs.writeFileSync(configPath, raw);
    const buildInventory = vi.fn(async () => { throw new Error("must not be called"); });
    const app = createApp({ buildInventory, getBackupPreflight: buildInventory }); const cookie = await admin(app);
    const response = await request(app)[method.toLowerCase()](url).set("Cookie", cookie).send(body);
    expect(response.status).toBe(410);
    expect(response.body.code).toBe("backup_policy_retired");
    expect(fs.readFileSync(configPath, "utf8")).toBe(raw);
    expect(buildInventory).not.toHaveBeenCalled();
  });
});

describe("backup policy authorization", () => {
  it("requires authentication for reads and enforces admin access before retired mutation responses", async () => {
    const app = createApp({ member: true });
    expect((await request(app).get(kUrl)).status).toBe(401);
    expect((await request(app).put(kUrl).send({})).status).toBe(401);
    expect((await request(app).post(`${kUrl}/scratch-excludes`).send({})).status).toBe(401);
    const cookie = await admin(app);
    expect((await request(app).get(kUrl).set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).put(kUrl).set("Cookie", cookie).send({})).status).toBe(403);
    expect((await request(app).post(`${kUrl}/scratch-excludes`).set("Cookie", cookie).send({})).status).toBe(403);
  });

  it("preserves safe agent reads, dangerous confirmation, and denies the confirmed retired mutation", async () => {
    initAgentAdminDb({ rootDir: root });
    let code;
    const confirmService = createConfirmService({ hasAdminTargets: () => true, deliver: (delivery) => { code = delivery.code; } });
    const app = createApp({ confirmService });
    expect(findOp("GET", kUrl).tier).toBe("safe");
    expect(findOp("PUT", kUrl)).toMatchObject({ tier: "dangerous", readOp: "updates.backup-policy.read" });
    expect((await bearer(request(app).get(kUrl))).status).toBe(200);
    expect((await bearer(request(app).put(kUrl).send({ excludes: [], rootExcludes: [] }))).status).toBe(428);
    expect(fs.existsSync(configPath)).toBe(false);
    const confirmed = await bearer(request(app).put(kUrl).set("X-AlphaClaw-Confirm", code).send({ excludes: [], rootExcludes: [] }));
    expect(confirmed.status).toBe(410);
    expect(confirmed.body.code).toBe("backup_policy_retired");
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it("does not accept a forged grant without the enforcement layer", async () => {
    const app = createApp({ noEnforcement: true });
    expect((await bearer(request(app).get(kUrl))).status).toBe(200);
    expect((await bearer(request(app).put(kUrl).send({}))).status).toBe(403);
    expect((await bearer(request(app).post(`${kUrl}/scratch-excludes`).send({}))).status).toBe(403);
    expect(fs.existsSync(configPath)).toBe(false);
  });
});

afterEach(() => {
  closeAgentAdminDb();
  fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

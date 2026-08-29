const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const {
  initAgentAdminDb,
  closeAgentAdminDb,
} = require("../../lib/server/db/agent-admin");
const {
  createConfirmService,
} = require("../../lib/server/agent-admin/confirm-service");

const kToken = "a".repeat(64);
// Supertest sends this verbatim; node lowercases it to match kConfirmHeader.
const kConfirmHeaderName = "X-AlphaClaw-Confirm";

// Copied from agent-admin-e2e.test.js: fresh auth + enforcement modules per app
// so no module-level actor/route state leaks between composed apps.
const loadModules = () => {
  vi.resetModules();
  const authPath = require.resolve("../../lib/server/routes/auth");
  delete require.cache[authPath];
  const enforcePath = require.resolve("../../lib/server/agent-admin/enforcement");
  delete require.cache[enforcePath];
  return {
    registerAuthRoutes: require(authPath).registerAuthRoutes,
    createAgentAdminEnforcement: require(enforcePath).createAgentAdminEnforcement,
  };
};

const createThrottleMock = () => ({
  getClientKey: vi.fn(() => "client-key"),
  getOrCreateLoginAttemptState: vi.fn(() => ({ attempts: 0 })),
  evaluateLoginThrottle: vi.fn(() => ({ blocked: false, retryAfterSec: 0 })),
  recordLoginFailure: vi.fn(() => ({ lockMs: 0, locked: false })),
  recordLoginSuccess: vi.fn(),
  cleanupLoginAttemptStates: vi.fn(),
});

// Same composition as register-server-routes / agent-admin-e2e: registerAuthRoutes
// mounts requireAuth on /api, then the enforcement layer mounts immediately after
// (both under app.use("/api", ...), so req.path is mount-trimmed inside the
// middleware). Stub routes are registered AFTER the enforcement mount so the
// enforcement layer's res.json wrap (redaction) is in place before a handler runs.
const createApp = ({
  enabled = true,
  confirmService = null,
  notifyAdmins = null,
} = {}) => {
  process.env.SETUP_PASSWORD = "secret";
  const { registerAuthRoutes, createAgentAdminEnforcement } = loadModules();

  const app = express();
  app.use(express.json());
  const throttle = createThrottleMock();
  const agentAdmin = {
    isEnabled: () => enabled,
    readToken: () => kToken,
    throttle,
    onAuthEvent: vi.fn(),
  };
  const { resolveRequestActor } = registerAuthRoutes({
    app,
    loginThrottle: throttle,
    agentAdmin,
  });
  const insertWatchdogEvent = vi.fn();
  app.use(
    "/api",
    createAgentAdminEnforcement({
      resolveRequestActor,
      insertWatchdogEvent,
      confirmService,
      notifyAdmins,
    }),
  );

  // Real-shaped stub routes at manifest paths — registered AFTER the enforcement
  // mount so its res.json wrapper is active (redaction path, note in test 6).
  const echo = (req, res) => res.json({ ok: true, echoed: req.body || null });
  app.get("/api/status", echo); // safe
  app.put("/api/env", echo); // restart (body-aware; empty .env ⇒ restart)
  app.delete("/api/agents/:id", echo); // dangerous
  app.post("/api/unmapped/thing", echo); // NOT in the manifest
  // env.list: safe read carrying a secret VALUE the middleware must strip.
  app.get("/api/env", (req, res) =>
    res.json({
      vars: [{ key: "ANTHROPIC_API_KEY", value: "sk-secret", present: true }],
    }),
  );

  return { app, insertWatchdogEvent };
};

const withBearer = (req) => req.set("Authorization", `Bearer ${kToken}`);

// Let res "finish" handlers (outcome audit + notifyAdmins) run before asserting.
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("agent-admin composed enforcement (confirm flow + audit + redaction + hooks)", () => {
  let dbRoot = null;

  // A REAL confirm service backed by a fresh on-disk DB per test. `state.lastCode`
  // captures whatever deliver() would send to the admin channel.
  const useRealConfirmService = ({ hasAdminTargets = () => true } = {}) => {
    dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-confirm-e2e-"));
    // initAgentAdminDb opens <root>/db/agent-admin.db but never mkdirs db/.
    fs.mkdirSync(path.join(dbRoot, "db"), { recursive: true });
    initAgentAdminDb({ rootDir: dbRoot });
    const state = { lastCode: null };
    const confirmService = createConfirmService({
      now: () => Date.now(),
      hasAdminTargets,
      deliver: (d) => {
        state.lastCode = d.code;
      },
    });
    return { confirmService, state };
  };

  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
    closeAgentAdminDb(); // no-op when no DB was opened
    if (dbRoot) {
      fs.rmSync(dbRoot, { recursive: true, force: true });
      dbRoot = null;
    }
  });

  // 1. The headline dangerous end-to-end path, driven entirely through the
  // middleware + confirm service + header (never unit-tested before).
  it("DANGEROUS end-to-end: 428 mints a code, same request + header passes, different path is confirm_invalid", async () => {
    const { confirmService, state } = useRealConfirmService();
    const { app } = createApp({ confirmService });

    // First contact: no confirm → 428, a code is minted and delivered.
    const first = await withBearer(request(app).delete("/api/agents/foo"));
    expect(first.status).toBe(428);
    expect(first.body.code).toBe("confirm_required");
    expect(first.body.confirmId).toBeTruthy();
    expect(state.lastCode).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);

    // Byte-identical request + the delivered code → passes through to the stub.
    const retry = await withBearer(
      request(app).delete("/api/agents/foo"),
    ).set(kConfirmHeaderName, state.lastCode);
    expect(retry.status).toBe(200);
    expect(retry.body.ok).toBe(true);

    // A different path hashes to a different paramsHash: the code cannot replay.
    const wrongPath = await withBearer(
      request(app).delete("/api/agents/bar"),
    ).set(kConfirmHeaderName, state.lastCode);
    expect(wrongPath.status).toBe(403);
    expect(wrongPath.body.code).toBe("confirm_invalid");
  });

  // 2. Redemption normalizes case + dashes so a relayed code still works.
  it("redeems a confirm code case-insensitively and with dashes stripped", async () => {
    const { confirmService, state } = useRealConfirmService();
    const { app } = createApp({ confirmService });

    // Lowercased code (fresh confirm).
    await withBearer(request(app).delete("/api/agents/foo"));
    const lowered = state.lastCode.toLowerCase();
    const r1 = await withBearer(
      request(app).delete("/api/agents/foo"),
    ).set(kConfirmHeaderName, lowered);
    expect(r1.status).toBe(200);

    // Dashes stripped — single-use means we must mint a fresh confirm first.
    await withBearer(request(app).delete("/api/agents/foo"));
    const nodash = state.lastCode.replace(/-/g, "");
    const r2 = await withBearer(
      request(app).delete("/api/agents/foo"),
    ).set(kConfirmHeaderName, nodash);
    expect(r2.status).toBe(200);
  });

  // 3. Dangerous tier with no confirm service wired at all.
  it("blocks a dangerous op when no confirm service is wired (403 dangerous_op_requires_confirmation)", async () => {
    const { app } = createApp({ confirmService: null });
    const res = await withBearer(request(app).delete("/api/agents/foo"));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("dangerous_op_requires_confirmation");
  });

  // 4. Dangerous tier, service present, but no admin channel to relay the code.
  it("blocks a dangerous op when no admin targets are configured (409 no_admin_targets)", async () => {
    const { confirmService } = useRealConfirmService({
      hasAdminTargets: () => false,
    });
    const { app } = createApp({ confirmService });
    const res = await withBearer(request(app).delete("/api/agents/foo"));
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("no_admin_targets");
  });

  // 5a. Audit: a denied op writes one "denied" agent_admin row with the code.
  it("audits a denied op as an agent_admin 'denied' row carrying op_not_in_manifest", async () => {
    const { app, insertWatchdogEvent } = createApp();
    const res = await withBearer(request(app).post("/api/unmapped/thing"));
    expect(res.status).toBe(403);

    const events = insertWatchdogEvent.mock.calls.map((c) => c[0]);
    const denied = events.find((e) => e.details?.phase === "denied");
    expect(denied).toBeTruthy();
    expect(denied.eventType).toBe("agent_admin");
    expect(denied.details.code).toBe("op_not_in_manifest");
    expect(denied.details.httpStatus).toBe(403);
    // paramsSummary is present and redacted even on the deny path.
    expect(denied.details.paramsSummary.redacted).toBe(true);
  });

  // 5b. Audit: a restart-tier op writes BOTH an intent and an outcome row, the
  // outcome carries httpStatus, and paramsSummary redacts to keys-only.
  it("audits a restart-tier op with intent + outcome phases (outcome carries httpStatus), params redacted to keys", async () => {
    const { app, insertWatchdogEvent } = createApp();
    const secret = "sekret-value-123";
    const res = await withBearer(request(app).put("/api/env")).send({
      vars: [{ key: "FOO", value: secret }],
    });
    expect(res.status).toBe(200);
    await tick(); // let the "finish" outcome row land

    const events = insertWatchdogEvent.mock.calls.map((c) => c[0]);
    for (const e of events) expect(e.eventType).toBe("agent_admin");

    const phases = events.map((e) => e.details?.phase);
    expect(phases).toContain("intent");
    expect(phases).toContain("outcome");

    const outcome = events.find((e) => e.details?.phase === "outcome");
    expect(outcome.details.httpStatus).toBe(200);

    const intent = events.find((e) => e.details?.phase === "intent");
    // Body keys only — never the secret value.
    expect(intent.details.paramsSummary).toEqual({
      keys: ["vars"],
      redacted: true,
    });
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  // 6. Redaction wired through the middleware: env.list's redactResponse strips
  // values to present/absent. The stub is registered AFTER the enforcement mount
  // (see createApp) so res.json is already wrapped when it runs.
  it("strips secret values from an env.list read through the middleware", async () => {
    const { app } = createApp();
    const res = await withBearer(request(app).get("/api/env"));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("sk-secret");
    expect(res.body.vars[0].key).toBe("ANTHROPIC_API_KEY");
    expect(res.body.vars[0].present).toBe(true);
    expect(res.body.vars[0].value).toBeUndefined();
  });

  // 7. notifyAdmins fires only on a successful mutating op, never on a deny.
  it("calls notifyAdmins after a successful restart-tier op", async () => {
    const notifyAdmins = vi.fn();
    const { app } = createApp({ notifyAdmins });
    const res = await withBearer(request(app).put("/api/env")).send({
      vars: [{ key: "FOO", value: "bar" }],
    });
    expect(res.status).toBe(200);
    await tick(); // notifyAdmins is attached to res "finish"

    expect(notifyAdmins).toHaveBeenCalledTimes(1);
    const arg = notifyAdmins.mock.calls[0][0];
    expect(arg.op.id).toBe("env.update");
    expect(arg.tier).toBe("restart");
  });

  it("does not call notifyAdmins after a denied op", async () => {
    const notifyAdmins = vi.fn();
    const { app } = createApp({ notifyAdmins });
    const res = await withBearer(request(app).post("/api/unmapped/thing"));
    expect(res.status).toBe(403);
    await tick();

    expect(notifyAdmins).not.toHaveBeenCalled();
  });
});

const express = require("express");
const request = require("supertest");

const kToken = "a".repeat(64);

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

// Mirrors how register-server-routes wires the /api surface: registerAuthRoutes
// mounts requireAuth on /api internally, then the agent-admin enforcement layer
// mounts immediately after — both under app.use("/api", ...), so req.path is
// mount-trimmed to "/status" inside the middleware (A19).
const createApp = ({ enabled = true, confirmService = null } = {}) => {
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
    }),
  );

  // Real-shaped stub routes at manifest paths. Each just echoes.
  const echo = (req, res) => res.json({ ok: true, echoed: req.body || null });
  app.get("/api/status", echo); // safe
  app.put("/api/watchdog/settings", echo); // write
  app.put("/api/env", echo); // restart (body-aware)
  app.delete("/api/agents/:id", echo); // dangerous
  app.get("/api/channels/accounts/token", echo); // denied
  app.post("/api/unmapped/thing", echo); // NOT in the manifest

  return { app, insertWatchdogEvent };
};

const withBearer = (req) => req.set("Authorization", `Bearer ${kToken}`);

describe("agent-admin composed enforcement (mount order + tier matrix)", () => {
  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
  });

  it("lets a safe op through as 200 — proving A19 mount-path matching", async () => {
    const { app } = createApp();
    // Enforcement is mounted at app.use("/api", ...), so inside the middleware
    // req.path is "/status", not "/api/status". The op is only found because
    // findOp matches on req.baseUrl + req.path. If it matched req.path alone it
    // would miss and wrongly return op_not_in_manifest — so a 200 here IS the
    // A19 regression assertion.
    const res = await withBearer(request(app).get("/api/status"));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("passes a write-tier op (PUT /api/watchdog/settings)", async () => {
    const { app } = createApp();
    const res = await withBearer(
      request(app).put("/api/watchdog/settings"),
    ).send({ foo: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("blocks a dangerous op with no confirm service (403 dangerous_op_requires_confirmation)", async () => {
    const { app } = createApp({ confirmService: null });
    const res = await withBearer(request(app).delete("/api/agents/foo"));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("dangerous_op_requires_confirmation");
  });

  it("denies an agent-forbidden op (GET /api/channels/accounts/token → denied)", async () => {
    const { app } = createApp();
    const res = await withBearer(
      request(app).get("/api/channels/accounts/token"),
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("denied");
  });

  it("denies any path outside the manifest (A20 deny-by-default)", async () => {
    const { app } = createApp();
    const res = await withBearer(request(app).post("/api/unmapped/thing"));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("op_not_in_manifest");
  });

  it("leaves the human path untouched: no bearer, no cookie → plain 401", async () => {
    const { app } = createApp();
    const res = await request(app).get("/api/status");
    expect(res.status).toBe(401);
    // Normal unauthorized, not an agent-specific enforcement code.
    expect(res.body.code).toBeUndefined();
    expect(res.body.error).toBe("Unauthorized");
  });

  it("a valid-bearer request does not leak actor state into a later no-actor request", async () => {
    const { app } = createApp();
    const agentRes = await withBearer(request(app).get("/api/status"));
    expect(agentRes.status).toBe(200);

    const humanRes = await request(app).get("/api/status");
    expect(humanRes.status).toBe(401);
    expect(humanRes.body.code).toBeUndefined();
  });

  it("never reaches enforcement when the flag is off (agent_admin_disabled)", async () => {
    const { app } = createApp({ enabled: false });
    const res = await withBearer(request(app).get("/api/status"));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("agent_admin_disabled");
  });
});

const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

// registerAdminRoutes composed with the real auth layer: registerAuthRoutes
// mounts requireAuth on /api (so bearer/cookie auth actually runs), then the
// admin routes register on top. No enforcement middleware here — these tests
// exercise the admin routes' OWN flagGate + humanOnly guards (defense-in-depth,
// independent of the tier enforcement layer).
const loadModules = () => {
  vi.resetModules();
  return {
    registerAuthRoutes: require("../../lib/server/routes/auth").registerAuthRoutes,
    registerAdminRoutes: require("../../lib/server/routes/admin").registerAdminRoutes,
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

const kToken = "a".repeat(64);

const createApp = ({ enabled = true, confirmService = null, tokenStore } = {}) => {
  process.env.SETUP_PASSWORD = "secret";
  const { registerAuthRoutes, registerAdminRoutes } = loadModules();

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

  // A live audit-store stub: shape mirrors getAgentAdminEvents (events list, or
  // a summary when summary=1). Assertions check the route threads the query
  // params straight through.
  const getAgentAdminEvents = vi.fn((args) =>
    args?.summary
      ? {
          summary: {
            total: 2,
            byOp: { "env.list": 2 },
            byCode: { ok: 2 },
            byTier: { safe: 2 },
            byStatus: { success: 2 },
          },
          scanWindow: 1000,
        }
      : {
          events: [
            { id: 1, status: "success", details: { op: "env.list" }, createdAt: "t0" },
          ],
          scanWindow: 1000,
        },
  );

  const insertWatchdogEvent = vi.fn();
  const openclawDir = path.join(
    os.tmpdir(),
    `admin-routes-${process.pid}-${Math.random().toString(36).slice(2)}`,
    ".openclaw",
  );
  const store = tokenStore || { rotateToken: vi.fn() };

  registerAdminRoutes({
    app,
    isAgentAdminEnabled: () => enabled,
    resolveRequestActor,
    tokenStore: store,
    openclawDir,
    getAgentAdminEvents,
    confirmService,
    insertWatchdogEvent,
  });

  return {
    app,
    agentAdmin,
    throttle,
    getAgentAdminEvents,
    insertWatchdogEvent,
    tokenStore: store,
    openclawDir,
  };
};

const withBearer = (req) => req.set("Authorization", `Bearer ${kToken}`);

// Mint a real signed setup_token cookie via the login route (the simplest way
// to get a human/operator session — no bearer, so resolveRequestActor is null).
const loginCookie = async (app) => {
  const res = await request(app).post("/api/auth/login").send({ password: "secret" });
  expect(res.status).toBe(200);
  const setCookie = res.headers["set-cookie"];
  return setCookie[0].split(";")[0];
};

describe("server/routes/admin (agent-admin namespace)", () => {
  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
  });

  it("returns a generic 404 for the manifest when the flag is off (no feature leak)", async () => {
    // Human cookie: bearer would 401 with agent_admin_disabled before the route
    // even runs, so a cookie session is the only way to reach the flagGate.
    const { app } = createApp({ enabled: false });
    const cookie = await loginCookie(app);

    const res = await request(app).get("/api/admin/manifest").set("Cookie", cookie);

    expect(res.status).toBe(404);
    // Exact body: must NOT advertise "agent_admin_disabled" — indistinguishable
    // from an unmounted route.
    expect(res.body).toEqual({ ok: false, error: "Not found" });
  });

  it("returns the live manifest for an authed request when the flag is on", async () => {
    const { app } = createApp();

    const res = await withBearer(request(app).get("/api/admin/manifest"));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.source).toBe("live");
    expect(typeof res.body.manifestVersion).toBe("string");
    expect(res.body.manifestVersion.length).toBeGreaterThan(0);
    expect(Array.isArray(res.body.ops)).toBe(true);
    expect(res.body.ops.length).toBeGreaterThan(0);
  });

  it("filters the manifest to a single domain via ?domain=env", async () => {
    const { app } = createApp();

    const res = await withBearer(request(app).get("/api/admin/manifest?domain=env"));

    expect(res.status).toBe(200);
    expect(res.body.ops.length).toBeGreaterThan(0);
    expect(res.body.ops.every((op) => op.domain === "env")).toBe(true);
  });

  it("filters the manifest to a single op via ?op=env.list", async () => {
    const { app } = createApp();

    const res = await withBearer(request(app).get("/api/admin/manifest?op=env.list"));

    expect(res.status).toBe(200);
    expect(res.body.ops).toHaveLength(1);
    expect(res.body.ops[0].id).toBe("env.list");
  });

  it("returns audit events for an authed request, threading query params through", async () => {
    const { app, getAgentAdminEvents } = createApp();

    const res = await withBearer(request(app).get("/api/admin/audit?op=env.list"));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.events).toBeDefined();
    expect(typeof res.body.manifestVersion).toBe("string");
    expect(getAgentAdminEvents).toHaveBeenCalledWith(
      expect.objectContaining({ op: "env.list", summary: false }),
    );
  });

  it("returns an audit summary when ?summary=1", async () => {
    const { app, getAgentAdminEvents } = createApp();

    const res = await withBearer(request(app).get("/api/admin/audit?summary=1"));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.summary).toBeDefined();
    expect(res.body.summary.total).toBe(2);
    expect(getAgentAdminEvents).toHaveBeenCalledWith(
      expect.objectContaining({ summary: true }),
    );
  });

  it("denies token rotation to the agent actor (humanOnly guard)", async () => {
    const { app, tokenStore } = createApp();

    const res = await withBearer(request(app).post("/api/admin/token/rotate"));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("denied");
    expect(tokenStore.rotateToken).not.toHaveBeenCalled();
  });

  it("rotates the token for a human session", async () => {
    const { app, tokenStore, openclawDir, insertWatchdogEvent } = createApp();
    const cookie = await loginCookie(app);

    const res = await request(app)
      .post("/api/admin/token/rotate")
      .set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.rotatedAt).toBe("string");
    expect(tokenStore.rotateToken).toHaveBeenCalledWith({ openclawDir });
    expect(insertWatchdogEvent).toHaveBeenCalled();
  });

  it("returns 500 when token rotation throws", async () => {
    const rotateToken = vi.fn(() => {
      throw new Error("disk full");
    });
    const { app } = createApp({ tokenStore: { rotateToken } });
    const cookie = await loginCookie(app);

    const res = await request(app)
      .post("/api/admin/token/rotate")
      .set("Cookie", cookie);

    expect(res.status).toBe(500);
    expect(res.body.code).toBe("rotate_failed");
    expect(rotateToken).toHaveBeenCalledTimes(1);
  });

  it("denies confirms listing to the agent actor (humanOnly guard)", async () => {
    const confirmService = { listPending: vi.fn(() => []) };
    const { app } = createApp({ confirmService });

    const res = await withBearer(request(app).get("/api/admin/confirms"));

    expect(res.status).toBe(403);
    expect(res.body.code).toBe("denied");
    expect(confirmService.listPending).not.toHaveBeenCalled();
  });

  it("lists pending confirms for a human session", async () => {
    const row = { id: "c1", op: "agents.delete", tier: "dangerous" };
    const confirmService = { listPending: vi.fn(() => [row]) };
    const { app } = createApp({ confirmService });
    const cookie = await loginCookie(app);

    const res = await request(app).get("/api/admin/confirms").set("Cookie", cookie);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.confirms).toEqual([row]);
    expect(confirmService.listPending).toHaveBeenCalled();
  });
});

const express = require("express");
const request = require("supertest");

const loadAuthRoutes = () => {
  vi.resetModules();
  const modulePath = require.resolve("../../lib/server/routes/auth");
  delete require.cache[modulePath];
  return require(modulePath);
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

const createApp = ({
  enabled = true,
  storedToken = kToken,
  loginThrottle,
  agentThrottle,
  onAuthEvent,
} = {}) => {
  process.env.SETUP_PASSWORD = "secret";
  const { registerAuthRoutes } = loadAuthRoutes();
  const app = express();
  app.use(express.json());
  const login = loginThrottle || createThrottleMock();
  const agentAdmin = {
    isEnabled: () => enabled,
    readToken: () => storedToken,
    throttle: agentThrottle || login,
    onAuthEvent: onAuthEvent || vi.fn(),
  };
  const registered = registerAuthRoutes({ app, loginThrottle: login, agentAdmin });
  // Expose the actor + an allowBearer=false gate to mimic the WS-upgrade path.
  app.get("/api/protected", (req, res) =>
    res.json({ ok: true, actor: registered.resolveRequestActor(req) }),
  );
  app.get("/ws-style", (req, res) =>
    res.json({ ok: registered.isAuthorizedRequest(req, { allowBearer: false }) }),
  );
  return { app, agentAdmin, login };
};

describe("agent-admin bearer auth", () => {
  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
  });

  it("authorizes a valid bearer and tags the request as an agent actor", async () => {
    const { app } = createApp();
    const res = await request(app)
      .get("/api/protected")
      .set("Authorization", `Bearer ${kToken}`);
    expect(res.status).toBe(200);
    expect(res.body.actor).toEqual({ type: "agent" });
  });

  it("rejects an invalid bearer with a distinct unauthorized code and records failure", async () => {
    const throttle = createThrottleMock();
    const { app } = createApp({ agentThrottle: throttle });
    const res = await request(app)
      .get("/api/protected")
      .set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthorized");
    expect(throttle.recordLoginFailure).toHaveBeenCalledTimes(1);
  });

  it("returns agent_admin_disabled (not unauthorized) when the flag is off, even with a valid token", async () => {
    const { app } = createApp({ enabled: false });
    const res = await request(app)
      .get("/api/protected")
      .set("Authorization", `Bearer ${kToken}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("agent_admin_disabled");
  });

  it("returns agent_admin_unavailable when the flag is on but no token exists", async () => {
    const { app } = createApp({ storedToken: null });
    const res = await request(app)
      .get("/api/protected")
      .set("Authorization", `Bearer ${kToken}`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("agent_admin_unavailable");
  });

  it("does not throw on a length-mismatched token (sha256 before compare)", async () => {
    const { app } = createApp({ storedToken: kToken });
    const res = await request(app)
      .get("/api/protected")
      .set("Authorization", "Bearer short");
    expect(res.status).toBe(401);
    expect(res.body.code).toBe("unauthorized");
  });

  it("emits a watchdog event on bearer lockout (F7)", async () => {
    const throttle = createThrottleMock();
    throttle.recordLoginFailure.mockReturnValue({ lockMs: 60000, locked: true });
    const onAuthEvent = vi.fn();
    const { app } = createApp({ agentThrottle: throttle, onAuthEvent });
    const res = await request(app)
      .get("/api/protected")
      .set("Authorization", "Bearer wrong");
    expect(res.status).toBe(429);
    expect(onAuthEvent).toHaveBeenCalledWith(
      expect.objectContaining({ event: "bearer_lockout" }),
    );
  });

  it("never accepts a bearer on the WS-style allowBearer=false path (A16)", async () => {
    const { app } = createApp();
    const res = await request(app)
      .get("/ws-style")
      .set("Authorization", `Bearer ${kToken}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false); // bearer ignored, no cookie → unauthorized
  });

  it("leaves cookie (human) requests unaffected — no actor tag", async () => {
    const { app } = createApp();
    // No bearer, no cookie → 401 but via the normal path, not agent codes.
    const res = await request(app).get("/api/protected");
    expect(res.status).toBe(401);
    expect(res.body.code).toBeUndefined();
  });
});

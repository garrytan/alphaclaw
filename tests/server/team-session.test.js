const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerAuthRoutes } = require("../../lib/server/routes/auth");
const { createTeamService } = require("../../lib/server/team-service");
const { updateTeamConfig } = require("../../lib/server/alphaclaw-config");
const { setOperators } = require("../../lib/server/operators-store");

const kPassword = "team-test-password";

const createLoginThrottleMock = () => ({
  getClientKey: vi.fn(() => "client-key"),
  getOrCreateLoginAttemptState: vi.fn(() => ({ attempts: 0 })),
  evaluateLoginThrottle: vi.fn(() => ({ blocked: false, retryAfterSec: 0 })),
  recordLoginFailure: vi.fn(() => ({ lockMs: 0, locked: false })),
  recordLoginSuccess: vi.fn(),
  cleanupLoginAttemptStates: vi.fn(),
});

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-team-session-test-"));

const createTestApp = ({ openclawDir }) => {
  process.env.SETUP_PASSWORD = kPassword;
  const teamService = createTeamService({ fsModule: fs, openclawDir });
  const app = express();
  app.use(express.json());
  const { requireAuth, resolveRequestOperator } = registerAuthRoutes({
    app,
    loginThrottle: createLoginThrottleMock(),
    teamService,
  });
  app.get("/api/whoami", (req, res) => {
    res.json({ operator: resolveRequestOperator(req) });
  });
  return { app, teamService, requireAuth };
};

const extractSessionCookie = (loginResponse) => {
  const setCookie = loginResponse.headers["set-cookie"] || [];
  const raw = setCookie.find((cookie) => cookie.startsWith("setup_token="));
  return raw ? raw.split(";")[0] : "";
};

const decodeSessionClaims = (cookie) => {
  const token = cookie.replace(/^setup_token=/, "");
  const payload = decodeURIComponent(token).split(".")[0];
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
};

describe("server team session identity (sub/opsv claims)", () => {
  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
  });

  it("round-trips sub/opsv claims for a valid operator login", async () => {
    const openclawDir = createTempOpenclawDir();
    updateTeamConfig({ openclawDir, enabled: true });
    setOperators({ openclawDir, operators: [{ id: "garry", name: "Garry" }] });
    const { app } = createTestApp({ openclawDir });

    const login = await request(app)
      .post("/api/auth/login")
      .send({ password: kPassword, operatorId: "garry" });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ ok: true, operatorId: "garry" });

    const cookie = extractSessionCookie(login);
    const claims = decodeSessionClaims(cookie);
    expect(claims.sub).toBe("garry");
    expect(claims.opsv).toBe(1);

    const whoami = await request(app).get("/api/whoami").set("Cookie", cookie);
    expect(whoami.status).toBe(200);
    expect(whoami.body.operator).toEqual({
      id: "garry",
      name: "Garry",
      email: "",
      avatar: "",
    });
  });

  it("treats an unknown operatorId as an anonymous login (identity is not auth)", async () => {
    const openclawDir = createTempOpenclawDir();
    updateTeamConfig({ openclawDir, enabled: true });
    setOperators({ openclawDir, operators: [{ id: "garry" }] });
    const { app } = createTestApp({ openclawDir });

    const login = await request(app)
      .post("/api/auth/login")
      .send({ password: kPassword, operatorId: "ghost" });
    expect(login.status).toBe(200);
    expect(login.body).toEqual({ ok: true });
    const claims = decodeSessionClaims(extractSessionCookie(login));
    expect(claims.sub).toBeUndefined();
    expect(claims.opsv).toBeUndefined();
  });

  it("ignores operatorId while team mode is off", async () => {
    const openclawDir = createTempOpenclawDir();
    setOperators({ openclawDir, operators: [{ id: "garry" }] });
    const { app } = createTestApp({ openclawDir });

    const login = await request(app)
      .post("/api/auth/login")
      .send({ password: kPassword, operatorId: "garry" });
    expect(login.status).toBe(200);
    const claims = decodeSessionClaims(extractSessionCookie(login));
    expect(claims.sub).toBeUndefined();

    const cookie = extractSessionCookie(login);
    const whoami = await request(app).get("/api/whoami").set("Cookie", cookie);
    expect(whoami.body.operator).toBeNull();
  });

  it("keeps legacy cookies (no sub/opsv) valid as anonymous sessions", async () => {
    const openclawDir = createTempOpenclawDir();
    const { app } = createTestApp({ openclawDir });

    // Legacy-shaped session: created before team mode existed.
    const login = await request(app)
      .post("/api/auth/login")
      .send({ password: kPassword });
    const cookie = extractSessionCookie(login);
    const claims = decodeSessionClaims(cookie);
    expect(claims.sub).toBeUndefined();

    // Team mode turns on later; the old cookie still authenticates.
    updateTeamConfig({ openclawDir, enabled: true });
    setOperators({ openclawDir, operators: [{ id: "garry" }] });

    const whoami = await request(app).get("/api/whoami").set("Cookie", cookie);
    expect(whoami.status).toBe(200);
    expect(whoami.body.operator).toBeNull();
  });

  it("downgrades to anonymous — never a logout — when the operator is removed (opsv bump)", async () => {
    const openclawDir = createTempOpenclawDir();
    updateTeamConfig({ openclawDir, enabled: true });
    setOperators({ openclawDir, operators: [{ id: "garry" }, { id: "diana" }] });
    const { app } = createTestApp({ openclawDir });

    const login = await request(app)
      .post("/api/auth/login")
      .send({ password: kPassword, operatorId: "diana" });
    const cookie = extractSessionCookie(login);

    // Remove diana: bumps operatorsVersion, so the cookie's opsv is stale.
    setOperators({ openclawDir, operators: [{ id: "garry" }] });

    const whoami = await request(app).get("/api/whoami").set("Cookie", cookie);
    expect(whoami.status).toBe(200); // still authenticated
    expect(whoami.body.operator).toBeNull(); // but anonymous
  });

  it("downgrades every pre-removal cookie, even for surviving operators", async () => {
    const openclawDir = createTempOpenclawDir();
    updateTeamConfig({ openclawDir, enabled: true });
    setOperators({ openclawDir, operators: [{ id: "garry" }, { id: "diana" }] });
    const { app, teamService } = createTestApp({ openclawDir });

    const login = await request(app)
      .post("/api/auth/login")
      .send({ password: kPassword, operatorId: "garry" });
    const cookie = extractSessionCookie(login);

    setOperators({ openclawDir, operators: [{ id: "garry" }] });

    const whoami = await request(app).get("/api/whoami").set("Cookie", cookie);
    expect(whoami.status).toBe(200);
    expect(whoami.body.operator).toBeNull();

    // A fresh login binds again at the new version.
    const relogin = await request(app)
      .post("/api/auth/login")
      .send({ password: kPassword, operatorId: "garry" });
    const reloginCookie = extractSessionCookie(relogin);
    expect(decodeSessionClaims(reloginCookie).opsv).toBe(
      teamService.getOperatorsVersion(),
    );
    const whoami2 = await request(app)
      .get("/api/whoami")
      .set("Cookie", reloginCookie);
    expect(whoami2.body.operator?.id).toBe("garry");
  });

  it("resolveOperatorForSession rejects a current-version claim for a missing sub", () => {
    const openclawDir = createTempOpenclawDir();
    updateTeamConfig({ openclawDir, enabled: true });
    setOperators({ openclawDir, operators: [{ id: "garry" }] });
    const teamService = createTeamService({ fsModule: fs, openclawDir });
    expect(
      teamService.resolveOperatorForSession({ sub: "ghost", opsv: 1 }),
    ).toBeNull();
    expect(
      teamService.resolveOperatorForSession({ sub: "garry", opsv: 1 })?.id,
    ).toBe("garry");
  });

  describe("GET /api/team/login-info (unauthenticated)", () => {
    it("returns names only when team mode is on", async () => {
      const openclawDir = createTempOpenclawDir();
      updateTeamConfig({ openclawDir, enabled: true });
      setOperators({
        openclawDir,
        operators: [{ id: "garry", name: "Garry", email: "secret@example.com" }],
      });
      const { app } = createTestApp({ openclawDir });

      const res = await request(app).get("/api/team/login-info");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        teamEnabled: true,
        operators: [{ id: "garry", name: "Garry" }],
      });
      expect(JSON.stringify(res.body)).not.toContain("secret@example.com");
    });

    it("reports team off without leaking operators", async () => {
      const openclawDir = createTempOpenclawDir();
      setOperators({ openclawDir, operators: [{ id: "garry" }] });
      const { app } = createTestApp({ openclawDir });

      const res = await request(app).get("/api/team/login-info");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ teamEnabled: false, operators: [] });
    });
  });
});

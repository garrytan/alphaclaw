const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { initAgentAdminDb, closeAgentAdminDb } = require("../../lib/server/db/agent-admin");
const { createConfirmService } = require("../../lib/server/agent-admin/confirm-service");
const { kGenericServerError } = require("../../lib/server/agent-admin/redact");

const kToken = "a".repeat(64);
const kConfirmHeaderName = "X-AlphaClaw-Confirm";

// Fresh auth + enforcement modules per app (same reason as agent-admin-e2e).
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

const kRawServerError =
  "Command failed: /usr/bin/openclaw status --json\n/root/.openclaw/openclaw.json: ENOENT";
const kRawClientError = "Invalid setting for token=abc123secret (Bearer eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl)";

// Production composition: registerAuthRoutes mounts requireAuth on /api, the
// enforcement layer mounts right after, route handlers come last. Two routes are
// deliberately registered BEFORE the enforcement mount to model the failure
// modes the grant exists for (a requireAdmin route with no enforcement in front,
// and a forged plain-property "grant").
const createApp = ({ confirmService = null } = {}) => {
  process.env.SETUP_PASSWORD = "secret";
  const { registerAuthRoutes, createAgentAdminEnforcement } = loadModules();

  const app = express();
  app.use(express.json());
  const throttle = createThrottleMock();
  const agentAdmin = {
    isEnabled: () => true,
    readToken: () => kToken,
    throttle,
    onAuthEvent: vi.fn(),
  };
  const { resolveRequestActor, requireAdmin } = registerAuthRoutes({
    app,
    loginThrottle: throttle,
    agentAdmin,
  });

  const echo = (req, res) => res.json({ ok: true, echoed: req.body || null, query: req.query });

  // (a) requireAdmin with NO enforcement in front: the mount below never runs.
  app.get("/api/team/presence", requireAdmin, echo);
  // (b) a forged plain property that copies the grant's public shape.
  app.post(
    "/api/team/forged",
    (req, _res, next) => {
      req.alphaclawGrant = {
        opId: "team.status",
        method: req.method,
        path: `${req.baseUrl}${req.path}`,
        paramsDigest: "x",
        bodyDigest: "y",
      };
      next();
    },
    requireAdmin,
    echo,
  );

  const insertWatchdogEvent = vi.fn();
  app.use(
    "/api",
    createAgentAdminEnforcement({ resolveRequestActor, insertWatchdogEvent, confirmService }),
  );

  app.get("/api/team", requireAdmin, echo); // team.status — safe, requireAdmin
  app.post("/api/team/disable", requireAdmin, echo); // team.disable — dangerous, requireAdmin
  // team.invites.create — write; a later middleware rewrites the body AFTER the grant.
  app.post(
    "/api/team/invites",
    (req, _res, next) => {
      req.body = { ...(req.body || {}), role: "admin" };
      next();
    },
    requireAdmin,
    echo,
  );
  // Error hygiene fixtures at manifest paths (safe + write tiers).
  app.get("/api/status", (_req, res) =>
    res.status(500).json({ ok: false, error: kRawServerError, code: "status_failed", hint: "See Watchdog." }),
  );
  app.put("/api/watchdog/settings", (_req, res) =>
    res.status(400).json({ ok: false, error: kRawClientError, code: "invalid_setting" }),
  );

  return { app, insertWatchdogEvent };
};

const withBearer = (req) => req.set("Authorization", `Bearer ${kToken}`);

const loginAsHumanAdmin = async (app) => {
  const login = await request(app).post("/api/auth/login").send({ password: "secret" });
  expect(login.status).toBe(200);
  const setCookie = login.headers["set-cookie"]?.[0] || "";
  expect(setCookie).toMatch(/^setup_token=/);
  return setCookie.split(";")[0];
};

describe("agent-admin enforcement grant end-to-end (F067: requireAdmin and the agent actor)", () => {
  let dbRoot = null;

  const useRealConfirmService = () => {
    dbRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-grant-e2e-"));
    fs.mkdirSync(path.join(dbRoot, "db"), { recursive: true });
    initAgentAdminDb({ rootDir: dbRoot });
    const state = { lastCode: null };
    const confirmService = createConfirmService({
      now: () => Date.now(),
      hasAdminTargets: () => true,
      deliver: (d) => {
        state.lastCode = d.code;
      },
    });
    return { confirmService, state };
  };

  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
    closeAgentAdminDb();
    if (dbRoot) {
      fs.rmSync(dbRoot, { recursive: true, force: true });
      dbRoot = null;
    }
  });

  it("admits the agent to a requireAdmin route once the manifest tier passed (safe team.status)", async () => {
    const { app } = createApp();
    const res = await withBearer(request(app).get("/api/team?verbose=1"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, query: { verbose: "1" } });
  });

  it("DANGEROUS requireAdmin route: 428 mints a code, the confirmed retry passes requireAdmin", async () => {
    const { confirmService, state } = useRealConfirmService();
    const { app } = createApp({ confirmService });

    const first = await withBearer(request(app).post("/api/team/disable").send({}));
    expect(first.status).toBe(428);
    expect(first.body.code).toBe("confirm_required");
    expect(state.lastCode).toBeTruthy();

    const confirmed = await withBearer(
      request(app).post("/api/team/disable").set(kConfirmHeaderName, state.lastCode).send({}),
    );
    expect(confirmed.status).toBe(200);
    expect(confirmed.body).toMatchObject({ ok: true });
  });

  it("a requireAdmin route with NO enforcement in front stays 403 for the agent", async () => {
    const { app } = createApp();
    const res = await withBearer(request(app).get("/api/team/presence"));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("admin_required");
  });

  it("a forged plain-property grant is ignored (403)", async () => {
    const { app } = createApp();
    const res = await withBearer(request(app).post("/api/team/forged").send({ a: 1 }));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("admin_required");
  });

  it("a body rewritten after the grant no longer matches (403)", async () => {
    const { app } = createApp();
    const res = await withBearer(
      request(app).post("/api/team/invites").send({ email: "a@example.com", role: "member" }),
    );
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("admin_required");
  });

  it("human admin sessions pass requireAdmin exactly as before, with or without enforcement in front", async () => {
    const { app } = createApp();
    const cookie = await loginAsHumanAdmin(app);
    const behind = await request(app).get("/api/team").set("Cookie", cookie);
    expect(behind.status).toBe(200);
    const inFront = await request(app).get("/api/team/presence").set("Cookie", cookie);
    expect(inFront.status).toBe(200);
    const forged = await request(app).post("/api/team/forged").set("Cookie", cookie).send({});
    expect(forged.status).toBe(200);
  });

  it("an unauthenticated caller is still 401 before any of this runs", async () => {
    const { app } = createApp();
    const res = await request(app).get("/api/team");
    expect(res.status).toBe(401);
  });
});

describe("agent-visible error hygiene end-to-end (5xx generic, 4xx scrubbed, humans untouched)", () => {
  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
  });

  it("agent sees a fixed sentence for a 5xx, with code and hint intact", async () => {
    const { app } = createApp();
    const res = await withBearer(request(app).get("/api/status"));
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      ok: false,
      error: kGenericServerError,
      code: "status_failed",
      hint: "See Watchdog.",
    });
  });

  it("agent sees a 4xx message with token params and secret shapes scrubbed", async () => {
    const { app } = createApp();
    const res = await withBearer(request(app).put("/api/watchdog/settings").send({ autoRepair: true }));
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_setting");
    expect(res.body.error).not.toMatch(/abc123secret|eyJ/);
    expect(res.body.error).toMatch(/^Invalid setting for token=\*\*\* \(\*\*\*\)$/);
  });

  it("a human admin sees the raw messages (dashboard behavior unchanged)", async () => {
    const { app } = createApp();
    const cookie = await loginAsHumanAdmin(app);
    const five = await request(app).get("/api/status").set("Cookie", cookie);
    expect(five.status).toBe(500);
    expect(five.body.error).toBe(kRawServerError);
    const four = await request(app).put("/api/watchdog/settings").set("Cookie", cookie).send({});
    expect(four.status).toBe(400);
    expect(four.body.error).toBe(kRawClientError);
  });
});

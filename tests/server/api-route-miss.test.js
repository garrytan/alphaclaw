const express = require("express");
const request = require("supertest");

const { kApiCatchAllPathPattern, isLocalApiPath } = require("../../lib/server/routes/proxy");
const { SETUP_API_PREFIXES } = require("../../lib/server/constants");
const { apiRouteMissHandler } = require("../../lib/server/api-route-miss");

// Unknown /api routes: 404 (405 for a routed path under another method) for
// authenticated callers, while real routes keep their 401/403 and an
// unauthenticated caller gets the same 401 for real and unknown paths alike.
// Composition mirrors production: requireAuth + member scope on /api, then
// the agent enforcement layer, then routes, the proxy catch-all, and the JSON
// miss handler last (server.js).

const kToken = "b".repeat(64);
const kPassword = "route-miss-secret";

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

const createApp = () => {
  process.env.SETUP_PASSWORD = kPassword;
  const { registerAuthRoutes, createAgentAdminEnforcement } = loadModules();
  const app = express();
  app.use(express.json());
  const throttle = createThrottleMock();
  const { resolveRequestActor } = registerAuthRoutes({
    app,
    loginThrottle: throttle,
    agentAdmin: {
      isEnabled: () => true,
      readToken: () => kToken,
      throttle,
      onAuthEvent: vi.fn(),
    },
  });
  const insertWatchdogEvent = vi.fn();
  app.use("/api", createAgentAdminEnforcement({ resolveRequestActor, insertWatchdogEvent }));

  const ok = (req, res) => res.json({ ok: true });
  app.get("/api/watchdog/events", ok); // manifest op (safe)
  app.get("/api/watchdog/incidents/:id", ok); // manifest op with a param
  app.get("/api/onboard/status", ok); // real route, outside the manifest
  app.all(kApiCatchAllPathPattern, (req, res, next) => {
    // Stand-in for the gateway forward: proxy.js forwards exactly the paths
    // isLocalApiPath rejects.
    if (isLocalApiPath(req.path, SETUP_API_PREFIXES)) return next();
    return res.status(502).json({ forwarded: true });
  });
  app.use("/api", apiRouteMissHandler);
  return { app, insertWatchdogEvent };
};

const withBearer = (req) => req.set("Authorization", `Bearer ${kToken}`);

const loginCookie = async (app) => {
  const res = await request(app).post("/api/auth/login").send({ password: kPassword });
  expect(res.status).toBe(200);
  return String(res.headers["set-cookie"]).split(";")[0];
};

const kProbes = [
  ["GET", "/api/watchdog/events"], // real
  ["GET", "/api/watchdog/history"], // unknown, local namespace
  ["POST", "/api/watchdog/events"], // real path, wrong method
  ["GET", "/api/doctor/nope"], // unknown, local-only namespace
  ["GET", "/api/v1/admin/rpc"], // gateway namespace
  ["DELETE", "/api/onboard/status"],
];

describe("unknown /api routes: 404 for authenticated callers, 401 unchanged", () => {
  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
  });

  it("gives an unauthenticated caller the identical 401 for real and unknown routes", async () => {
    const { app } = createApp();
    const answers = [];
    for (const [method, url] of kProbes) {
      const res = await request(app)[method.toLowerCase()](url);
      answers.push({ status: res.status, body: res.body, allow: res.headers.allow });
    }
    for (const answer of answers) {
      expect(answer).toEqual({ status: 401, body: { error: "Unauthorized" }, allow: undefined });
    }
    const badBearer = await request(app)
      .get("/api/watchdog/history")
      .set("Authorization", "Bearer wrong");
    const badBearerReal = await request(app)
      .get("/api/watchdog/events")
      .set("Authorization", "Bearer wrong");
    expect(badBearer.status).toBe(badBearerReal.status);
    expect(badBearer.body).toEqual(badBearerReal.body);
  });

  it("answers the agent 404 route_not_found for an unknown path and audits it", async () => {
    const { app, insertWatchdogEvent } = createApp();
    for (const url of [
      "/api/watchdog/history",
      "/api/doctor/nope",
      "/api/DOCTOR/nope",
      "/api/watchdog/incidents/1/extra",
    ]) {
      const res = await withBearer(request(app).get(url));
      expect(res.status, url).toBe(404);
      expect(res.body).toMatchObject({ ok: false, code: "route_not_found" });
      expect(res.body.hint).toContain("alphaclaw admin manifest");
    }
    const audited = insertWatchdogEvent.mock.calls.map(([row]) => row.details);
    expect(audited[0]).toMatchObject({ phase: "denied", code: "route_not_found", httpStatus: 404 });
  });

  it("answers the agent 405 with Allow for a real path under another method", async () => {
    const { app } = createApp();
    const res = await withBearer(request(app).post("/api/watchdog/events").send({}));
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe("GET, HEAD");
    expect(res.body).toMatchObject({ ok: false, code: "method_not_allowed", allow: ["GET", "HEAD"] });
  });

  it("keeps 403 op_not_in_manifest for a real unmanifested route and the gateway's /api space", async () => {
    const { app } = createApp();
    const real = await withBearer(request(app).get("/api/onboard/status"));
    expect(real.status).toBe(403);
    expect(real.body.code).toBe("op_not_in_manifest");
    const gateway = await withBearer(request(app).get("/api/v1/admin/rpc"));
    expect(gateway.status).toBe(403);
    expect(gateway.body.code).toBe("op_not_in_manifest");
    expect(gateway.body.hint).toContain("OpenClaw gateway");
  });

  it("still serves manifest ops to the agent", async () => {
    const { app } = createApp();
    expect((await withBearer(request(app).get("/api/watchdog/events"))).status).toBe(200);
    expect((await withBearer(request(app).get("/api/watchdog/incidents/3"))).status).toBe(200);
  });

  it("answers a signed-in human JSON 404/405 in local namespaces and still forwards gateway paths", async () => {
    const { app } = createApp();
    const cookie = await loginCookie(app);
    const unknown = await request(app).get("/api/watchdog/history").set("Cookie", cookie);
    expect(unknown.status).toBe(404);
    expect(unknown.headers["content-type"]).toMatch(/application\/json/);
    expect(unknown.body.code).toBe("route_not_found");
    for (const url of ["/api/doctor/nope", "/api/Doctor/nope", "/api/"]) {
      const res = await request(app).get(url).set("Cookie", cookie);
      expect(res.status, url).toBe(404);
      expect(res.body.code, url).toBe("route_not_found");
    }
    const wrongMethod = await request(app).put("/api/watchdog/events").set("Cookie", cookie);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("GET, HEAD");
    const gateway = await request(app).get("/api/v1/admin/rpc").set("Cookie", cookie);
    expect(gateway.status).toBe(502);
    expect(gateway.body).toEqual({ forwarded: true });
    const real = await request(app).get("/api/watchdog/events").set("Cookie", cookie);
    expect(real.status).toBe(200);
  });
});

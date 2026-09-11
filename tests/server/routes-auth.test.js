const crypto = require("crypto");
const express = require("express");
const request = require("supertest");
const { createLoginThrottle } = require("../../lib/server/login-throttle");
const {
  kLoginCleanupIntervalMs,
  kLoginGlobalMaxAttempts,
} = require("../../lib/server/constants");
const { getClientKey } = require("../../lib/server/helpers");

const loadAuthRoutes = () => {
  vi.resetModules();
  const modulePath = require.resolve("../../lib/server/routes/auth");
  delete require.cache[modulePath];
  return require(modulePath);
};

const createLoginThrottleMock = () => ({
  getClientKey: vi.fn(() => "client-key"),
  getOrCreateLoginAttemptState: vi.fn(() => ({ attempts: 0 })),
  evaluateLoginThrottle: vi.fn(() => ({ blocked: false, retryAfterSec: 0 })),
  recordLoginFailure: vi.fn(() => ({ lockMs: 0, locked: false })),
  recordLoginSuccess: vi.fn(),
  cleanupLoginAttemptStates: vi.fn(),
});

const getTestIp = (index) =>
  `203.0.${Math.floor(index / 250)}.${(index % 250) + 1}`;

const createTestApp = ({ setupPassword, loginThrottle, trustProxy } = {}) => {
  if (typeof setupPassword === "string") {
    process.env.SETUP_PASSWORD = setupPassword;
  } else {
    delete process.env.SETUP_PASSWORD;
  }

  const { registerAuthRoutes } = loadAuthRoutes();
  const app = express();
  if (trustProxy !== undefined) app.set("trust proxy", trustProxy);
  app.use(express.json());
  const throttle = loginThrottle || createLoginThrottleMock();
  const { requireAuth } = registerAuthRoutes({ app, loginThrottle: throttle });

  // /setup and /api are guarded by registerAuthRoutes' own app.use mounts.
  app.get("/api/protected", (req, res) => res.json({ ok: true }));
  app.get("/setup/protected", (req, res) => res.json({ ok: true }));
  // The Control UI proxies are NOT — registerProxyRoutes wires requireAuth
  // per-route (app.all(/^\/openclaw(?:\/.*)?$/, requireAuth, …)), so mirror
  // that here to exercise the resource-vs-document response rule.
  app.all(/^\/openclaw(?:\/.*)?$/, requireAuth, (req, res) =>
    res.json({ ok: true, url: req.originalUrl }),
  );

  return { app, throttle };
};

// Logs in and returns the "setup_token=…" cookie pair for authenticated cases.
const loginCookie = async (app, password) => {
  const login = await request(app).post("/api/auth/login").send({ password });
  expect(login.status).toBe(200);
  const setCookieHeader = login.headers["set-cookie"]?.[0] || "";
  expect(setCookieHeader).toMatch(/setup_token=[^;]+/);
  return setCookieHeader.split(";")[0];
};

describe("server/routes/auth", () => {
  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
  });

  it("returns 503 when setup password is unset", async () => {
    const { app, throttle } = createTestApp({ setupPassword: "" });

    const login = await request(app).post("/api/auth/login").send({ password: "any" });
    expect(login.status).toBe(503);
    expect(login.body.ok).toBe(false);

    const protectedRes = await request(app).get("/api/protected");
    expect(protectedRes.status).toBe(503);
    expect(throttle.getClientKey).not.toHaveBeenCalled();
  });

  it("returns 429 and retry-after header when throttle blocks", async () => {
    const { app, throttle } = createTestApp({ setupPassword: "secret" });
    throttle.evaluateLoginThrottle.mockReturnValue({
      blocked: true,
      retryAfterSec: 12,
    });

    const res = await request(app).post("/api/auth/login").send({ password: "wrong" });

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("12");
    expect(res.body.ok).toBe(false);
    expect(throttle.recordLoginFailure).not.toHaveBeenCalled();
  });

  it("returns 401 for invalid credentials and records failure", async () => {
    const { app, throttle } = createTestApp({ setupPassword: "secret" });

    const res = await request(app).post("/api/auth/login").send({ password: "wrong" });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false, error: "Invalid credentials" });
    expect(throttle.recordLoginFailure).toHaveBeenCalledTimes(1);
  });

  it("applies global throttling when proxy-derived client keys rotate", async () => {
    const { app } = createTestApp({
      setupPassword: "secret",
      trustProxy: 1,
      loginThrottle: { ...createLoginThrottle(), getClientKey },
    });

    for (let i = 0; i < kLoginGlobalMaxAttempts - 1; i += 1) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", getTestIp(i))
        .send({ password: "wrong" });
      expect(res.status).toBe(401);
    }

    const res = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", getTestIp(kLoginGlobalMaxAttempts))
      .send({ password: "wrong" });

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBeTruthy();
  });

  it("sets auth cookie on success and allows protected API by cookie", async () => {
    const { app, throttle } = createTestApp({ setupPassword: "secret" });

    const login = await request(app).post("/api/auth/login").send({ password: "secret" });

    expect(login.status).toBe(200);
    expect(login.body).toEqual({ ok: true });
    expect(throttle.recordLoginSuccess).toHaveBeenCalledTimes(1);

    const setCookieHeader = login.headers["set-cookie"]?.[0] || "";
    const tokenMatch = setCookieHeader.match(/setup_token=([^;]+)/);
    expect(tokenMatch).toBeTruthy();
    const cookie = setCookieHeader.split(";")[0];
    const protectedRes = await request(app).get("/api/protected").set("Cookie", cookie);
    expect(protectedRes.status).toBe(200);
    expect(protectedRes.body).toEqual({ ok: true });
  });

  it("rejects query-string token auth", async () => {
    const { app } = createTestApp({ setupPassword: "secret" });
    const login = await request(app).post("/api/auth/login").send({ password: "secret" });
    const setCookieHeader = login.headers["set-cookie"]?.[0] || "";
    const tokenMatch = setCookieHeader.match(/setup_token=([^;]+)/);
    expect(tokenMatch).toBeTruthy();

    const protectedRes = await request(app).get(`/api/protected?token=${tokenMatch[1]}`);
    expect(protectedRes.status).toBe(401);
    expect(protectedRes.body).toEqual({ error: "Unauthorized" });
  });

  it("rejects a correctly signed token whose payload is not JSON", async () => {
    const { app } = createTestApp({ setupPassword: "secret" });
    const payload = Buffer.from("definitely-not-json").toString("base64url");
    const signature = crypto
      .createHmac("sha256", "secret")
      .update(payload)
      .digest("base64url");

    const res = await request(app)
      .get("/api/protected")
      .set("Cookie", `setup_token=${payload}.${signature}`);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: "Unauthorized" });
  });

  it("returns 503 text for non-API paths when setup password is unset", async () => {
    const { app } = createTestApp({ setupPassword: "" });

    const res = await request(app).get("/setup/protected");

    expect(res.status).toBe(503);
    expect(res.text).toContain("Setup auth is not configured");
  });

  it("redirects unauthenticated non-API requests to the login page", async () => {
    const { app } = createTestApp({ setupPassword: "secret" });

    const res = await request(app).get("/setup/protected");

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/login.html");
  });

  it("reports auth status and clears the session cookie on logout", async () => {
    const { app } = createTestApp({ setupPassword: "secret" });

    const status = await request(app).get("/api/auth/status");
    expect(status.status).toBe(200);
    expect(status.body).toEqual(
      expect.objectContaining({
        authEnabled: true,
        team: expect.objectContaining({ enabled: false }),
      }),
    );

    const logout = await request(app).post("/api/auth/logout").send({});
    expect(logout.status).toBe(200);
    expect(logout.body).toEqual({ ok: true });
    expect(logout.headers["set-cookie"]?.[0]).toContain("setup_token=;");

    const disabled = createTestApp({ setupPassword: "" });
    const disabledStatus = await request(disabled.app).get("/api/auth/status");
    expect(disabledStatus.body).toEqual(
      expect.objectContaining({ authEnabled: false }),
    );
  });

  it("cleans up throttle state on the scheduled interval", async () => {
    vi.useFakeTimers();
    try {
      const { throttle } = createTestApp({ setupPassword: "secret" });

      vi.advanceTimersByTime(kLoginCleanupIntervalMs + 1);

      expect(throttle.cleanupLoginAttemptStates).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("Control UI resources: 401 for resources, login redirect for documents", () => {
    // Why (control-ui-mount.js classifier): the pinned Control UI service
    // worker caches ANY `ok` response under the requested URL, and browsers
    // refuse text/html as a stylesheet. A 302 → /login.html (200) for an
    // expired-session font or chunk fetch would therefore be cached forever
    // under the asset URL and trip "Styles failed to load"; a 401 is never
    // `ok`. Documents keep the redirect so a stale tab lands on the login page.
    const kUnauthorized = { error: "Unauthorized" };

    it("answers 401 for an asset-shaped path with no headers at all", async () => {
      const { app } = createTestApp({ setupPassword: "secret" });
      const res = await request(app).get("/openclaw/fonts/x.css");
      expect(res.status).toBe(401);
      expect(res.body).toEqual(kUnauthorized);
      expect(res.headers.location).toBeUndefined();
    });

    it("keeps 401 for an asset-shaped path even when Sec-Fetch-Dest says document", async () => {
      // Rule 2 (asset namespace) beats fetch metadata: /openclaw/assets/* is
      // never a document, so no header can make the redirect correct.
      const { app } = createTestApp({ setupPassword: "secret" });
      const res = await request(app)
        .get("/openclaw/assets/c.js")
        .set("Sec-Fetch-Dest", "document");
      expect(res.status).toBe(401);
      expect(res.body).toEqual(kUnauthorized);
    });

    it("redirects a document-shaped path fetched as a document", async () => {
      const { app } = createTestApp({ setupPassword: "secret" });
      const res = await request(app)
        .get("/openclaw/dashboards")
        .set("Sec-Fetch-Dest", "document");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login.html");
    });

    it("answers 401 for a document-shaped path fetched as a non-document (fetch/XHR)", async () => {
      const { app } = createTestApp({ setupPassword: "secret" });
      const res = await request(app)
        .get("/openclaw/dashboards")
        .set("Sec-Fetch-Dest", "empty");
      expect(res.status).toBe(401);
      expect(res.body).toEqual(kUnauthorized);
    });

    it("redirects a document-shaped path with no fetch metadata (curl, Node, old browsers)", async () => {
      const { app } = createTestApp({ setupPassword: "secret" });
      const res = await request(app).get("/openclaw/dashboards");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login.html");
    });

    it("answers 401 when Accept leads with a resource media type and no metadata is present", async () => {
      const { app } = createTestApp({ setupPassword: "secret" });
      const res = await request(app)
        .get("/openclaw/dashboards")
        .set("Accept", "text/css,*/*;q=0.1");
      expect(res.status).toBe(401);
      expect(res.body).toEqual(kUnauthorized);
    });

    it("always redirects HEAD — the UI's stale-chunk recovery probe must reach the login page", async () => {
      // The UI probes its own URL with fetch(href, { method: "HEAD" })
      // (Sec-Fetch-Dest: empty) before reloading; sw.js ignores non-GET, so
      // the redirect can never poison its cache.
      const { app } = createTestApp({ setupPassword: "secret" });
      const res = await request(app)
        .head("/openclaw/")
        .set("Sec-Fetch-Dest", "empty");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/login.html");
    });

    it("leaves paths outside the Control UI namespace on the login redirect", async () => {
      // The classifier only applies under /openclaw* and /assets/*; a
      // resource-looking fetch elsewhere keeps today's behavior.
      const { app } = createTestApp({ setupPassword: "secret" });
      const plain = await request(app).get("/setup/protected");
      expect(plain.status).toBe(302);
      expect(plain.headers.location).toBe("/login.html");

      const styled = await request(app)
        .get("/setup/protected")
        .set("Sec-Fetch-Dest", "style");
      expect(styled.status).toBe(302);
      expect(styled.headers.location).toBe("/login.html");
    });

    it("lets an authenticated session through to the Control UI resource handler", async () => {
      const { app } = createTestApp({ setupPassword: "secret" });
      const cookie = await loginCookie(app, "secret");
      const res = await request(app)
        .get("/openclaw/fonts/x.css")
        .set("Cookie", cookie);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, url: "/openclaw/fonts/x.css" });
    });
  });
});

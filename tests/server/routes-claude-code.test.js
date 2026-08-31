const express = require("express");
const request = require("supertest");
const { registerClaudeCodeRoutes } = require("../../lib/server/routes/claude-code");

const createDeps = (overrides = {}) => ({
  requireAuth: (req, res, next) => next(),
  claudeCodeService: {
    getAvailability: vi.fn(() => ({ available: true })),
    createSession: vi.fn(async () => ({
      ok: true,
      sessionId: "session_01ABC",
      sessionUrl: "https://claude.ai/code/session_01ABC",
    })),
  },
  ...overrides,
});

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerClaudeCodeRoutes({ app, ...deps });
  return app;
};

describe("GET /api/claude-code/status", () => {
  it("returns the service availability (local block additive, null when unwired)", async () => {
    const res = await request(createApp(createDeps())).get("/api/claude-code/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, availability: { available: true }, local: null });
  });

  it("merges the local snapshot when the rescue service is wired", async () => {
    const deps = createDeps({
      claudeCodeLocalService: {
        getStatusSnapshot: vi.fn(() => ({ enabled: true, state: "ready" })),
      },
    });
    const res = await request(createApp(deps)).get("/api/claude-code/status");
    expect(res.status).toBe(200);
    expect(res.body.local).toEqual({ enabled: true, state: "ready" });
    expect(res.body.availability).toEqual({ available: true });
  });

  it("keeps the routine availability when the local snapshot throws", async () => {
    const deps = createDeps({
      claudeCodeLocalService: {
        getStatusSnapshot: vi.fn(() => {
          throw new Error("boom");
        }),
      },
    });
    const res = await request(createApp(deps)).get("/api/claude-code/status");
    expect(res.status).toBe(200);
    expect(res.body.local).toBeNull();
    expect(res.body.availability).toEqual({ available: true });
  });

  it("surfaces not_configured / invalid_config shapes verbatim", async () => {
    const deps = createDeps();
    deps.claudeCodeService.getAvailability.mockReturnValue({
      available: false,
      reason: "invalid_config",
      message: "CLAUDE_CODE_ROUTINE_TOKEN is not set",
    });
    const res = await request(createApp(deps)).get("/api/claude-code/status");
    expect(res.status).toBe(200);
    expect(res.body.availability.reason).toBe("invalid_config");
  });

  it("degrades honestly when not wired", async () => {
    const res = await request(createApp(createDeps({ claudeCodeService: null }))).get(
      "/api/claude-code/status",
    );
    expect(res.status).toBe(200);
    expect(res.body.availability).toEqual({ available: false, reason: "not_wired" });
  });
});

describe("POST /api/claude-code/session", () => {
  it("returns the session on success", async () => {
    const deps = createDeps();
    const res = await request(createApp(deps)).post("/api/claude-code/session").send({ confirmed: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      sessionId: "session_01ABC",
      sessionUrl: "https://claude.ai/code/session_01ABC",
    });
    expect(deps.claudeCodeService.createSession).toHaveBeenCalledWith({ confirmed: true });
  });

  it("passes confirmed:false for a missing body", async () => {
    const deps = createDeps();
    await request(createApp(deps)).post("/api/claude-code/session");
    expect(deps.claudeCodeService.createSession).toHaveBeenCalledWith({ confirmed: false });
  });

  it("treats non-boolean confirmed values as false", async () => {
    const deps = createDeps();
    await request(createApp(deps)).post("/api/claude-code/session").send({ confirmed: "yes" });
    expect(deps.claudeCodeService.createSession).toHaveBeenCalledWith({ confirmed: false });
  });

  it("503s with a message when not wired", async () => {
    const res = await request(createApp(createDeps({ claudeCodeService: null }))).post(
      "/api/claude-code/session",
    );
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("not_wired");
    expect(res.body.message).toBeTruthy();
  });

  // The full refusal map. Upstream auth failures must NEVER surface as our
  // own 401/403 — authFetch treats a 401 as session expiry and force-logs
  // the operator out of AlphaClaw.
  const refusals = [
    ["not_configured", 409],
    ["invalid_config", 409],
    ["confirm_required", 409],
    ["busy", 409],
    ["cooldown", 429],
    ["timeout", 504],
    ["upstream_429", 429],
    ["upstream_401", 502],
    ["upstream_403", 502],
    ["upstream_400", 502],
    ["upstream_404", 502],
    ["upstream_500", 502],
    ["network", 502],
    ["bad_upstream_response", 502],
  ];

  for (const [code, expectedStatus] of refusals) {
    it(`maps ${code} → ${expectedStatus} with a human message`, async () => {
      const deps = createDeps();
      deps.claudeCodeService.createSession.mockResolvedValue({
        ok: false,
        code,
        message: "service-level message naming Envars",
        ...(code === "cooldown" || code === "upstream_429" ? { retryAfterSec: 7 } : {}),
      });
      const res = await request(createApp(deps))
        .post("/api/claude-code/session")
        .send({ confirmed: true });
      expect(res.status).toBe(expectedStatus);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.body.ok).toBe(false);
      expect(res.body.error).toBe(code);
      expect(String(res.body.message || "").length).toBeGreaterThan(0);
      if (expectedStatus === 429) {
        expect(res.headers["retry-after"]).toBe("7");
      }
    });
  }

  it("passes the service's own message through for config-class refusals", async () => {
    const deps = createDeps();
    deps.claudeCodeService.createSession.mockResolvedValue({
      ok: false,
      code: "invalid_config",
      message: "CLAUDE_CODE_ROUTINE_URL must be a trig_… id (Envars).",
    });
    const res = await request(createApp(deps))
      .post("/api/claude-code/session")
      .send({ confirmed: true });
    expect(res.body.message).toContain("CLAUDE_CODE_ROUTINE_URL");
  });

  it("names Envars in the revoked-token copy", async () => {
    const deps = createDeps();
    deps.claudeCodeService.createSession.mockResolvedValue({ ok: false, code: "upstream_401" });
    const res = await request(createApp(deps))
      .post("/api/claude-code/session")
      .send({ confirmed: true });
    expect(res.body.message).toContain("Envars");
  });
});

describe("claude-code admin-manifest classification (security pin)", () => {
  it("keeps the fire op denied to the agent actor and status safe", () => {
    // Flipping session to "write" would let the agent-admin actor start
    // billable autonomous claude.ai runs — this pin makes that a red test,
    // not a silent one-word regression.
    const domain = require("../../lib/server/admin-manifest/domains/claude-code");
    const byPath = Object.fromEntries(domain.ops.map((op) => [op.path, op]));
    expect(byPath["/api/claude-code/session"].tier).toBe("denied");
    expect(byPath["/api/claude-code/session"].method).toBe("POST");
    expect(byPath["/api/claude-code/status"].tier).toBe("safe");
  });

  it("keeps EVERY local rescue op denied to the agent actor", () => {
    // An agent starting/steering a remote-controlled acceptEdits shell on
    // the box is privilege escalation — same rationale as the fire op.
    const domain = require("../../lib/server/admin-manifest/domains/claude-code");
    const localOps = domain.ops.filter((op) => op.path.startsWith("/api/claude-code/local/"));
    expect(localOps.length).toBe(7);
    for (const op of localOps) {
      expect(op.tier, `${op.path} must be denied`).toBe("denied");
    }
  });

  it("strips sessionUrl, oauthUrl, error tail, and warnings from agent-read status", () => {
    const domain = require("../../lib/server/admin-manifest/domains/claude-code");
    const statusOp = domain.ops.find((op) => op.id === "claude-code.status");
    const redacted = statusOp.redactResponse({
      ok: true,
      availability: { available: true },
      local: {
        state: "error",
        sessionUrl: "https://claude.ai/code/secret",
        socketPath: "/data/claude-code-local/tmux.sock",
        login: { phase: "awaiting_code", oauthUrl: "https://claude.com/cai/oauth/x" },
        error: { code: "url_extract_timeout", message: "m", tailSanitized: "box content" },
        warnings: ["w"],
      },
    });
    expect(redacted.local.sessionUrl).toBeUndefined();
    expect(redacted.local.socketPath).toBeUndefined();
    expect(redacted.local.login.oauthUrl).toBeUndefined();
    expect(redacted.local.login.phase).toBe("awaiting_code");
    expect(redacted.local.error.tailSanitized).toBeUndefined();
    expect(redacted.local.error.code).toBe("url_extract_timeout");
    expect(redacted.local.warnings).toBeUndefined();
    expect(redacted.availability).toEqual({ available: true });
    // Null/absent local blocks pass through untouched.
    expect(statusOp.redactResponse({ ok: true, local: null }).local).toBeNull();
  });

  it("registers the launcher and all five local env vars in the known-vars registry", () => {
    const { kKnownKeys } = require("../../lib/server/constants");
    expect(kKnownKeys.has("CLAUDE_CODE_ROUTINE_URL")).toBe(true);
    expect(kKnownKeys.has("CLAUDE_CODE_ROUTINE_TOKEN")).toBe(true);
    for (const key of [
      "CLAUDE_CODE_LOCAL_ENABLED",
      "CLAUDE_CODE_LOCAL_AUTOSTART",
      "CLAUDE_CODE_LOCAL_PERMISSION_MODE",
      "CLAUDE_CODE_LOCAL_CWD",
      "CLAUDE_CODE_LOCAL_SPAWN_ON_INCIDENT",
    ]) {
      expect(kKnownKeys.has(key), `${key} must be a known var`).toBe(true);
    }
  });
});

describe("local rescue endpoints", () => {
  const createLocalDeps = (overrides = {}) =>
    createDeps({
      claudeCodeLocalService: {
        getStatusSnapshot: vi.fn(() => ({ enabled: true, state: "ready" })),
        startSession: vi.fn(async () => ({ ok: true, status: "starting" })),
        stopSession: vi.fn(async () => ({ ok: true })),
        startLogin: vi.fn(async () => ({ ok: true, status: "starting" })),
        submitLoginCode: vi.fn(async () => ({ ok: true, status: "verifying" })),
        cancelLogin: vi.fn(async () => ({ ok: true })),
        logout: vi.fn(async () => ({ ok: true })),
        getTail: vi.fn(async () => ({ ok: true, source: "session", tail: "tail" })),
        ...overrides,
      },
    });

  it("202s on starting and 200s with the URL when already running", async () => {
    const deps = createLocalDeps();
    const app = createApp(deps);
    const starting = await request(app)
      .post("/api/claude-code/local/session")
      .send({ confirmed: true });
    expect(starting.status).toBe(202);
    expect(starting.body).toEqual({ ok: true, status: "starting" });
    expect(deps.claudeCodeLocalService.startSession).toHaveBeenCalledWith({
      confirmed: true,
      source: "click",
    });

    deps.claudeCodeLocalService.startSession.mockResolvedValue({
      ok: true,
      status: "running",
      sessionId: "sess_abc123def",
      sessionUrl: "https://claude.ai/code/sess_abc123def",
    });
    const running = await request(app)
      .post("/api/claude-code/local/session")
      .send({ confirmed: true });
    expect(running.status).toBe(200);
    expect(running.body.sessionUrl).toBe("https://claude.ai/code/sess_abc123def");
  });

  it("enforces the strict-boolean consent handshake", async () => {
    const deps = createLocalDeps();
    await request(createApp(deps))
      .post("/api/claude-code/local/session")
      .send({ confirmed: "yes" });
    expect(deps.claudeCodeLocalService.startSession).toHaveBeenCalledWith({
      confirmed: false,
      source: "click",
    });
  });

  // Full refusal map: 4xx are caller-fixable (the launcher falls back to the
  // routine on the 409 trio), 502 closes the popup with NO routine fallback.
  const localRefusals = [
    ["disabled", 409],
    ["not_installed", 409],
    ["needs_login", 409],
    ["login_in_progress", 409],
    ["confirm_required", 409],
    ["busy", 409],
    ["memory_floor", 409],
    ["spawn_failed", 502],
    ["url_extract_timeout", 502],
    ["hosting_unavailable", 502],
    ["adopted_without_url", 502],
    ["env_conflict", 502],
    ["subscription_required", 502],
  ];
  for (const [code, expectedStatus] of localRefusals) {
    it(`maps ${code} → ${expectedStatus}`, async () => {
      const deps = createLocalDeps();
      deps.claudeCodeLocalService.startSession.mockResolvedValue({
        ok: false,
        code,
        message: "detail",
      });
      const res = await request(createApp(deps))
        .post("/api/claude-code/local/session")
        .send({ confirmed: true });
      expect(res.status).toBe(expectedStatus);
      expect(res.status).not.toBe(401);
      expect(res.status).not.toBe(403);
      expect(res.body.error).toBe(code);
    });
  }

  it("maps login-code validation to 400 and missing login to 409", async () => {
    const deps = createLocalDeps();
    const app = createApp(deps);
    for (const [code, expectedStatus] of [
      ["empty_code", 400],
      ["invalid_code", 400],
      ["no_login_in_progress", 409],
    ]) {
      deps.claudeCodeLocalService.submitLoginCode.mockResolvedValue({ ok: false, code });
      const res = await request(app)
        .post("/api/claude-code/local/login/code")
        .send({ code: "x" });
      expect(res.status).toBe(expectedStatus);
      expect(res.body.error).toBe(code);
    }
  });

  it("runs the login lifecycle endpoints", async () => {
    const deps = createLocalDeps();
    const app = createApp(deps);
    expect((await request(app).post("/api/claude-code/local/login")).status).toBe(202);
    expect(
      (await request(app).post("/api/claude-code/local/login/code").send({ code: "abc" })).status,
    ).toBe(200);
    expect((await request(app).post("/api/claude-code/local/login/cancel")).status).toBe(200);
    expect((await request(app).post("/api/claude-code/local/logout")).status).toBe(200);
    expect((await request(app).post("/api/claude-code/local/session/stop")).status).toBe(200);
  });

  it("refuses logout while the session runs", async () => {
    const deps = createLocalDeps();
    deps.claudeCodeLocalService.logout.mockResolvedValue({
      ok: false,
      code: "session_running",
      message: "Stop the rescue session before logging out.",
    });
    const res = await request(createApp(deps)).post("/api/claude-code/local/logout");
    expect(res.status).toBe(409);
  });

  it("serves the tail with a validated source and 404s when empty", async () => {
    const deps = createLocalDeps();
    const app = createApp(deps);
    await request(app).get("/api/claude-code/local/tail?source=login");
    expect(deps.claudeCodeLocalService.getTail).toHaveBeenCalledWith({ source: "login" });
    await request(app).get("/api/claude-code/local/tail?source=../../etc");
    expect(deps.claudeCodeLocalService.getTail).toHaveBeenLastCalledWith({ source: "session" });
    deps.claudeCodeLocalService.getTail.mockResolvedValue({ ok: false, code: "no_buffer" });
    expect((await request(app).get("/api/claude-code/local/tail")).status).toBe(404);
  });

  it("503s every local endpoint when the service is not wired", async () => {
    const app = createApp(createDeps());
    for (const [method, url] of [
      ["post", "/api/claude-code/local/session"],
      ["post", "/api/claude-code/local/session/stop"],
      ["post", "/api/claude-code/local/login"],
      ["post", "/api/claude-code/local/login/code"],
      ["post", "/api/claude-code/local/login/cancel"],
      ["post", "/api/claude-code/local/logout"],
      ["get", "/api/claude-code/local/tail"],
    ]) {
      const res = await request(app)[method](url);
      expect(res.status, url).toBe(503);
      expect(res.body.error).toBe("not_wired");
    }
  });
});

describe("GET /api/claude-code/status failure envelope", () => {
  it("returns the surface's own envelope when the service throws", async () => {
    const deps = createDeps();
    deps.claudeCodeService.getAvailability.mockImplementation(() => {
      throw new Error("boom with secrets");
    });
    const res = await request(createApp(deps)).get("/api/claude-code/status");
    expect(res.status).toBe(500);
    // Machine code + fixed human copy; raw exception prose stays server-side.
    expect(res.body).toEqual({
      ok: false,
      error: "status_failed",
      message: "Could not read the launcher status.",
    });
  });
});

describe("POST /api/claude-code/session message precedence", () => {
  it("lets the service's richer per-instance message win over the static map", async () => {
    const deps = createDeps();
    deps.claudeCodeService.createSession.mockResolvedValue({
      ok: false,
      code: "timeout",
      message:
        "Timed out after 15s — the session may still have been created (the fire endpoint has no idempotency); check claude.ai/code before retrying.",
    });
    const res = await request(createApp(deps))
      .post("/api/claude-code/session")
      .send({ confirmed: true });
    expect(res.status).toBe(504);
    expect(res.body.message).toContain("may still have been created");
  });
});

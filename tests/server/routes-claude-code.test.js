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
  it("returns the service availability", async () => {
    const res = await request(createApp(createDeps())).get("/api/claude-code/status");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, availability: { available: true } });
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

  it("registers both launcher env vars in the known-vars registry", () => {
    const { kKnownKeys } = require("../../lib/server/constants");
    expect(kKnownKeys.has("CLAUDE_CODE_ROUTINE_URL")).toBe(true);
    expect(kKnownKeys.has("CLAUDE_CODE_ROUTINE_TOKEN")).toBe(true);
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

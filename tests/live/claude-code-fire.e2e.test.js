// LIVE — fires a REAL Claude Code routine on a REAL claude.ai account through
// the full local stack (Express route → service → api.anthropic.com) and
// validates the returned session. THIS BILLS: every run of the paid test
// starts one autonomous Claude Code cloud run against the token owner's
// claude.ai subscription and consumes a daily routine-run credit.
//
// Because of that, this file is gated harder than the rest of tests/live/**:
//   OPENCLAW_LIVE_E2E=1            → the shared live-tier gate
//   CLAUDE_CODE_LIVE_FIRE=1        → explicit consent to bill one session
//   CLAUDE_CODE_ROUTINE_URL/TOKEN  → real credentials in the environment
// All three or the suite skips. Convenience: `npm run test:live:claude-code`.
//
// What it proves that the hermetic suite cannot: the documented contract of
// Anthropic's experimental fire endpoint (headers, response shape, session
// URL format) still holds against production. What it cannot prove: that the
// session is interactive — claude.ai exposes no session-read API, so the test
// prints the session URL for a human to open in a logged-in browser.
const express = require("express");
const request = require("supertest");

const { kLiveEnabled } = require("./live-helpers");
const {
  createClaudeCodeService,
} = require("../../lib/server/claude-code-service");
const {
  registerClaudeCodeRoutes,
} = require("../../lib/server/routes/claude-code");

const kFireConsent = process.env.CLAUDE_CODE_LIVE_FIRE === "1";
const kHasCredentials =
  !!String(process.env.CLAUDE_CODE_ROUTINE_URL || "").trim() &&
  !!String(process.env.CLAUDE_CODE_ROUTINE_TOKEN || "").trim();

const kRunnable = kLiveEnabled && kFireConsent && kHasCredentials;
if (kLiveEnabled && !kRunnable) {
  // eslint-disable-next-line no-console
  console.log(
    `[claude-code-fire.e2e] skipped: ${
      !kFireConsent
        ? "set CLAUDE_CODE_LIVE_FIRE=1 to consent to billing one session"
        : "set CLAUDE_CODE_ROUTINE_URL and CLAUDE_CODE_ROUTINE_TOKEN"
    }`,
  );
}

const describeLive = kRunnable ? describe : describe.skip;

const createApp = () => {
  const app = express();
  app.use(express.json());
  registerClaudeCodeRoutes({
    app,
    requireAuth: (req, res, next) => next(),
    // Real env, real fetch, real logger — the whole production wiring except
    // the auth middleware (session auth is covered hermetically).
    claudeCodeService: createClaudeCodeService(),
  });
  return app;
};

describeLive("live claude-code fire (BILLS ONE SESSION)", () => {
  it("resolves the real config as available", async () => {
    const res = await request(createApp()).get("/api/claude-code/status");
    expect(res.status).toBe(200);
    expect(res.body.availability).toEqual({ available: true });
  });

  it("refuses an unconfirmed fire before touching the network (free)", async () => {
    const res = await request(createApp())
      .post("/api/claude-code/session")
      .send({ confirmed: false });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("confirm_required");
  });

  it(
    "fires the routine and returns a real claude.ai session URL (PAID)",
    { timeout: 30_000 },
    async () => {
      const res = await request(createApp())
        .post("/api/claude-code/session")
        .send({ confirmed: true });

      // A 429 means the account's daily routine-run allowance is exhausted —
      // report it honestly instead of failing the contract assertion.
      if (res.status === 429) {
        throw new Error(
          `routine-run allowance exhausted (429${
            res.headers["retry-after"] ? `, Retry-After ${res.headers["retry-after"]}s` : ""
          }) — the endpoint is alive but the fire could not run; retry later`,
        );
      }

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.sessionId).toMatch(/^session_[A-Za-z0-9_-]+$/);
      expect(res.body.sessionUrl).toMatch(
        /^https:\/\/claude\.ai\/code\/session_[A-Za-z0-9_-]+$/,
      );
      expect(res.body.sessionUrl.endsWith(res.body.sessionId)).toBe(true);

      // The human half of "responsive": open this in a browser logged into
      // the token owner's claude.ai account and watch the run.
      // eslint-disable-next-line no-console
      console.log(
        `\n[claude-code-fire.e2e] LIVE SESSION STARTED (billed): ${res.body.sessionUrl}\n`,
      );
    },
  );
});

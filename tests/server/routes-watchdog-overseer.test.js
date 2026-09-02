const express = require("express");
const request = require("supertest");
const { registerWatchdogRoutes } = require("../../lib/server/routes/watchdog");

const createDeps = (overrides = {}) => ({
  requireAuth: (req, res, next) => next(),
  watchdog: { getStatus: vi.fn(() => ({})) },
  watchdogNotifier: { notify: vi.fn() },
  getRecentEvents: vi.fn(() => []),
  readLogTail: vi.fn(() => ""),
  watchdogTerminal: {},
  watchdogOverseer: {
    getAvailability: vi.fn(async () => ({ available: true, reason: null })),
    getSituation: vi.fn(() => ({
      current: { state: "done", verdict: "watch", at: 1 },
      lastVerdict: { state: "done", verdict: "watch", at: 1 },
      nextManualAt: null,
      inFlight: false,
    })),
    requestReview: vi.fn(async () => ({
      ok: true,
      ran: true,
      mode: "incident",
      incidentId: 3,
      record: { state: "done" },
      persisted: true,
    })),
  },
  readWatchdogOverseerEnabled: vi.fn(() => true),
  updateWatchdogOverseerEnabled: vi.fn(() => ({ changed: true })),
  ...overrides,
});

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerWatchdogRoutes({ app, ...deps });
  return app;
};

describe("GET /api/watchdog/overseer", () => {
  it("returns enabled + availability", async () => {
    const res = await request(createApp(createDeps())).get(
      "/api/watchdog/overseer",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      enabled: true,
      availability: { available: true, reason: null },
    });
  });

  it("degrades honestly when not wired", async () => {
    const res = await request(
      createApp(createDeps({ watchdogOverseer: null })),
    ).get("/api/watchdog/overseer");
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(false);
    expect(res.body.availability.reason).toBe("not_wired");
  });
});

describe("PUT /api/watchdog/overseer", () => {
  it("rejects non-boolean enabled with 400 invalid_setting", async () => {
    const app = createApp(createDeps());
    for (const body of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).put("/api/watchdog/overseer").send(body);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_setting");
    }
  });

  it("persists a strict boolean", async () => {
    const deps = createDeps();
    const res = await request(createApp(deps))
      .put("/api/watchdog/overseer")
      .send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enabled: true });
    expect(deps.updateWatchdogOverseerEnabled).toHaveBeenCalledWith({
      enabled: true,
    });
  });
});

describe("GET /api/watchdog/overseer/situation", () => {
  it("returns the projected slot plus the rate-limit timing", async () => {
    const res = await request(createApp(createDeps())).get(
      "/api/watchdog/overseer/situation",
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      current: { state: "done", verdict: "watch", at: 1 },
      lastVerdict: { state: "done", verdict: "watch", at: 1 },
      nextManualAt: null,
      inFlight: false,
    });
  });

  it("503s when the overseer is not wired (or too old to expose the slot)", async () => {
    const unwired = await request(
      createApp(createDeps({ watchdogOverseer: null })),
    ).get("/api/watchdog/overseer/situation");
    expect(unwired.status).toBe(503);
    expect(unwired.body.error).toBe("not_wired");
    const legacy = await request(
      createApp(createDeps({ watchdogOverseer: { getAvailability: vi.fn() } })),
    ).get("/api/watchdog/overseer/situation");
    expect(legacy.status).toBe(503);
  });
});

describe("POST /api/watchdog/overseer/review", () => {
  it("starts a review and returns the result (mode, record, persisted)", async () => {
    const deps = createDeps();
    const res = await request(createApp(deps))
      .post("/api/watchdog/overseer/review")
      .send({ incidentId: 3 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.result).toMatchObject({ mode: "incident", record: { state: "done" }, persisted: true });
    expect(res.body.message).toBeUndefined();
    expect(deps.watchdogOverseer.requestReview).toHaveBeenCalledWith({
      incidentId: 3,
    });
  });

  it("runs a situation report with no incidentId in any watchdog state", async () => {
    const deps = createDeps();
    deps.watchdogOverseer.requestReview.mockResolvedValue({
      ok: true,
      ran: true,
      mode: "situation",
      record: { state: "done", verdict: "all_clear" },
      persisted: true,
    });
    const res = await request(createApp(deps)).post("/api/watchdog/overseer/review").send({});
    expect(res.status).toBe(200);
    expect(res.body.result.mode).toBe("situation");
    expect(deps.watchdogOverseer.requestReview).toHaveBeenCalledWith({ incidentId: null });
  });

  it("still answers 200 with the record and an honest message when the report could not be saved", async () => {
    const deps = createDeps();
    deps.watchdogOverseer.requestReview.mockResolvedValue({
      ok: true,
      ran: true,
      mode: "situation",
      record: { state: "done", verdict: "watch" },
      persisted: false,
    });
    const res = await request(createApp(deps)).post("/api/watchdog/overseer/review").send({});
    expect(res.status).toBe(200);
    expect(res.body.result.persisted).toBe(false);
    // A `warning` envelope, never `error`/`code` at the top level: the admin
    // CLI treats a top-level error as failure, and this body is a success.
    expect(res.body.error).toBeUndefined();
    expect(res.body.warning).toEqual({
      code: "persist_failed",
      message: "Report displayed but not saved (database write failed).",
    });
  });

  it("carries the persist warning on a failed run too", async () => {
    const deps = createDeps();
    deps.watchdogOverseer.requestReview.mockResolvedValue({
      ok: false,
      code: "review_failed",
      failed: true,
      mode: "situation",
      record: { state: "failed" },
      persisted: false,
    });
    const res = await request(createApp(deps)).post("/api/watchdog/overseer/review").send({});
    expect(res.status).toBe(500);
    expect(res.body.warning.code).toBe("persist_failed");
  });

  it("names the remaining wait on a rate-limit refusal and sets Retry-After", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-29T12:00:00Z"));
    const now = Date.now();
    const deps = createDeps();
    const app = createApp(deps);
    for (const [nextManualAt, expected, retryAfter] of [
      [now + 90_000, "Manual reviews are limited to one every 2 minutes — try again in about 2m.", "90"],
      [now + 61_000, "Manual reviews are limited to one every 2 minutes — try again in about 1m.", "61"],
      [now + 15_000, "Manual reviews are limited to one every 2 minutes — try again in about 15s.", "15"],
      [now - 1_000, "Manual reviews are limited to one every 2 minutes.", "1"],
    ]) {
      deps.watchdogOverseer.requestReview.mockResolvedValue({
        ok: false,
        code: "rate_limited",
        nextManualAt,
        rateLimitMs: 120_000,
      });
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).post("/api/watchdog/overseer/review").send({});
      expect(res.status).toBe(429);
      expect(res.body.message).toBe(expected);
      expect(res.headers["retry-after"]).toBe(retryAfter);
    }
    // Without timing the generic rule is still a full sentence.
    deps.watchdogOverseer.requestReview.mockResolvedValue({ ok: false, code: "rate_limited" });
    const bare = await request(app).post("/api/watchdog/overseer/review").send({});
    expect(bare.body.message).toBe("Manual reviews are limited to one every 2 minutes.");
    vi.useRealTimers();
  });

  it("500s when getSituation throws", async () => {
    const deps = createDeps();
    deps.watchdogOverseer.getSituation.mockImplementation(() => {
      throw new Error("db locked");
    });
    const res = await request(createApp(deps)).get("/api/watchdog/overseer/situation");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: "db locked" });
  });

  it("maps refusal codes: 409 for busy/disabled/open-incident, 429 rate-limit, 404 for no incident", async () => {
    for (const [code, status] of [
      ["busy", 409],
      ["rate_limited", 429],
      ["incident_open", 409],
      ["disabled", 409],
      ["no_incident", 404],
      ["incident_missing", 404],
      ["query_failed", 500],
      ["review_failed", 500],
      // Upstream claude failures are not server bugs.
      ["spawn_failed", 502],
      ["timed_out", 504],
      // Missing-infrastructure class: the overseer can't run at all.
      ["no_anthropic_credential", 503],
      ["claude_not_found", 503],
      ["home_isolation_failed", 503],
      ["probe_failed", 503],
      ["cli_flags_unverifiable", 503],
      ["redaction_sources_unreadable", 503],
    ]) {
      const deps = createDeps();
      deps.watchdogOverseer.requestReview.mockResolvedValue({ ok: false, code });
      // eslint-disable-next-line no-await-in-loop
      const res = await request(createApp(deps))
        .post("/api/watchdog/overseer/review")
        .send({});
      expect(res.status).toBe(status);
      expect(res.body.error).toBe(code);
      // Machine code always ships with its OWN human-readable message — the
      // generic fallback would mean the refusal map lost an entry.
      expect(typeof res.body.message).toBe("string");
      expect(res.body.message.length).toBeGreaterThan(0);
      expect(res.body.message).not.toBe("Review refused.");
    }
  });

  it("validates incidentId and 503s when not wired", async () => {
    const app = createApp(createDeps());
    const bad = await request(app)
      .post("/api/watchdog/overseer/review")
      .send({ incidentId: "garbage" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("invalid_id");
    const unwired = await request(createApp(createDeps({ watchdogOverseer: null })))
      .post("/api/watchdog/overseer/review")
      .send({});
    expect(unwired.status).toBe(503);
  });
});

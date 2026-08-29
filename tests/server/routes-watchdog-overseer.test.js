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
    requestReview: vi.fn(async () => ({ ok: true, ran: true, incidentId: 3 })),
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

describe("POST /api/watchdog/overseer/review", () => {
  it("starts a review and returns the result", async () => {
    const deps = createDeps();
    const res = await request(createApp(deps))
      .post("/api/watchdog/overseer/review")
      .send({ incidentId: 3 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(deps.watchdogOverseer.requestReview).toHaveBeenCalledWith({
      incidentId: 3,
    });
  });

  it("maps refusal codes: 409 for busy/rate-limit/steady-state, 404 for no incident", async () => {
    for (const [code, status] of [
      ["busy", 409],
      ["rate_limited", 429],
      ["not_steady_state", 409],
      ["disabled", 409],
      ["no_incident", 404],
      ["query_failed", 500],
      ["review_failed", 500],
    ]) {
      const deps = createDeps();
      deps.watchdogOverseer.requestReview.mockResolvedValue({ ok: false, code });
      // eslint-disable-next-line no-await-in-loop
      const res = await request(createApp(deps))
        .post("/api/watchdog/overseer/review")
        .send({});
      expect(res.status).toBe(status);
      expect(res.body.error).toBe(code);
      // Machine code always ships with a human-readable message.
      expect(typeof res.body.message).toBe("string");
      expect(res.body.message.length).toBeGreaterThan(0);
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

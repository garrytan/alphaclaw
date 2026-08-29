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
  incidentsDb: {
    listIncidents: vi.fn(() => [
      { id: 2, incidentKey: "gateway_crash", status: "resolved" },
    ]),
    getIncidentById: vi.fn((id) =>
      id === 7 ? { id: 7, incidentKey: "crash_loop", status: "resolved" } : null,
    ),
    getIncidentEvents: vi.fn(() => ({
      totalCount: 205,
      events: Array.from({ length: 200 }, (_, i) => ({ id: i + 1 })),
    })),
  },
  ...overrides,
});

const createApp = (deps) => {
  const app = express();
  app.use(express.json());
  registerWatchdogRoutes({ app, ...deps });
  return app;
};

describe("GET /api/watchdog/incidents", () => {
  it("returns incidents and passes limit/before through to the db clamp", async () => {
    const deps = createDeps();
    const app = createApp(deps);
    const res = await request(app).get(
      "/api/watchdog/incidents?limit=5&before=10",
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.incidents).toHaveLength(1);
    expect(deps.incidentsDb.listIncidents).toHaveBeenCalledWith({
      limit: "5",
      before: 10,
    });
  });

  it("rejects a non-integer before cursor with 400", async () => {
    const app = createApp(createDeps());
    for (const bad of ["abc", "1.5", "-3", "1e3", "12garbage"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(
        `/api/watchdog/incidents?before=${bad}`,
      );
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "invalid_before" });
    }
  });

  it("returns 503 when the incidents db is not wired", async () => {
    const app = createApp(createDeps({ incidentsDb: null }));
    const res = await request(app).get("/api/watchdog/incidents");
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("incidents_unavailable");
  });

  it("returns 500 with the error message when the db throws", async () => {
    const deps = createDeps();
    deps.incidentsDb.listIncidents.mockImplementation(() => {
      throw new Error("db exploded");
    });
    const res = await request(createApp(deps)).get("/api/watchdog/incidents");
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ ok: false, error: "db exploded" });
  });
});

describe("GET /api/watchdog/incidents/:id", () => {
  it("returns the incident with capped events and an honest truncation marker", async () => {
    const app = createApp(createDeps());
    const res = await request(app).get("/api/watchdog/incidents/7");
    expect(res.status).toBe(200);
    expect(res.body.incident.id).toBe(7);
    expect(res.body.events).toHaveLength(200);
    expect(res.body.totalCount).toBe(205);
    expect(res.body.truncated).toBe(true);
    expect(res.body.omittedCount).toBe(5);
  });

  it("rejects garbage ids with 400 before touching the db", async () => {
    const deps = createDeps();
    const app = createApp(deps);
    for (const bad of ["abc", "0", "-1", "1.5", "7x"]) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app).get(`/api/watchdog/incidents/${bad}`);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ ok: false, error: "invalid_id" });
    }
    expect(deps.incidentsDb.getIncidentById).not.toHaveBeenCalled();
  });

  it("returns 404 for an unknown incident", async () => {
    const app = createApp(createDeps());
    const res = await request(app).get("/api/watchdog/incidents/9999");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("incident_not_found");
  });
});

describe("GET /api/watchdog/events byte-compatibility", () => {
  it("keeps the legacy shape (explicit projection — no incident_id leak)", async () => {
    const deps = createDeps({
      getRecentEvents: vi.fn(() => [
        {
          id: 1,
          eventType: "crash",
          source: "exit_event",
          status: "failed",
          details: { code: 1 },
          correlationId: "c1",
          createdAt: "2026-08-29T00:00:00.000Z",
        },
      ]),
    });
    const res = await request(createApp(deps)).get("/api/watchdog/events");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.events[0]).sort()).toEqual([
      "correlationId",
      "createdAt",
      "details",
      "eventType",
      "id",
      "source",
      "status",
    ]);
  });
});

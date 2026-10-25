const express = require("express");
const request = require("supertest");

const { registerSidecarRoutes } = require("../../lib/server/routes/sidecars");
const { getManifest } = require("../../lib/server/admin-manifest");

const makeApp = (sidecarService) => {
  const app = express();
  app.use(express.json());
  registerSidecarRoutes({ app, requireAuth: (req, res, next) => next(), sidecarService });
  return app;
};

const makeSupervisor = (name, { enabled = true } = {}) => {
  const calls = [];
  return {
    entry: { name, enabled },
    calls,
    start: () => calls.push("start"),
    stop: async ({ reason }) => calls.push(`stop:${reason}`),
    restart: async () => calls.push("restart"),
    getStatus: () => ({ status: "running", pid: 42 }),
  };
};

describe("sidecar routes", () => {
  const guard = makeSupervisor("guard");
  const off = makeSupervisor("off", { enabled: false });
  const service = {
    getStatus: () => ({ configured: true, sidecars: [{ name: "guard", envKeys: ["HOME"] }] }),
    find: (name) => ({ guard, off })[name] || null,
  };
  const app = makeApp(service);

  it("GET /api/sidecars returns the service status", async () => {
    const res = await request(app).get("/api/sidecars");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, configured: true, sidecars: [{ name: "guard", envKeys: ["HOME"] }] });
  });

  it("start, stop and restart reach the supervisor", async () => {
    for (const action of ["start", "stop", "restart"]) {
      const res = await request(app).post(`/api/sidecars/guard/${action}`);
      expect(res.status).toBe(200);
      expect(res.body.sidecar).toEqual({ name: "guard", status: "running", pid: 42 });
    }
    expect(guard.calls).toEqual(["start", "stop:stopped from the API", "restart"]);
  });

  it("rejects unknown sidecars, bad names, unknown actions and disabled entries", async () => {
    expect((await request(app).post("/api/sidecars/nope/restart")).status).toBe(404);
    expect((await request(app).post("/api/sidecars/Bad%20Name/restart")).status).toBe(400);
    expect((await request(app).post("/api/sidecars/guard/kill")).status).toBe(404);
    const disabled = await request(app).post("/api/sidecars/off/start");
    expect(disabled.status).toBe(409);
    expect(off.calls).toEqual([]);
  });

  it("the agent may read sidecars but never act on them", () => {
    const ops = getManifest().ops.filter((op) => op.domain === "sidecars");
    expect(ops.map((op) => [op.method, op.path, op.tier])).toEqual([
      ["GET", "/api/sidecars", "safe"],
      ["POST", "/api/sidecars/:name/:action", "denied"],
    ]);
  });
});

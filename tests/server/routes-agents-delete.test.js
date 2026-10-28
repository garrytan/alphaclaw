const express = require("express");
const request = require("supertest");

const { registerAgentRoutes } = require("../../lib/server/routes/agents");
const { DeleteAgentError } = require("../../lib/server/agents/delete-agent");
const { OpenclawConfigWriteBlockedError } = require("../../lib/server/openclaw-config");

const makeApp = (agentDeleter, agentsService = {}) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.alphaclawIdentity = { id: "u" };
    next();
  });
  registerAgentRoutes({ app, agentsService, agentDeleter, restartRequiredState: { markRequired: vi.fn() } });
  return app;
};

const deleterMock = (overrides = {}) => ({
  preview: vi.fn(async (id) => ({ agentId: id, state: "configured" })),
  deleteAgent: vi.fn(async (id) => ({ agentId: id, outcome: "deleted", archive: null })),
  finishDelete: vi.fn(async (id) => ({ agentId: id, outcome: "deleted" })),
  listDeletions: vi.fn(() => ({ deletions: [], running: null })),
  ...overrides,
});

describe("Delete Agent routes", () => {
  it("DELETE defaults to a snapshot and passes the actor", async () => {
    const deleter = deleterMock();
    const res = await request(makeApp(deleter)).delete("/api/agents/ops");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, outcome: "deleted" });
    expect(deleter.deleteAgent).toHaveBeenCalledWith("ops", { snapshot: true, actor: "human" });
  });

  it.each([
    ["snapshot=false", false],
    ["snapshot=0", false],
    ["keepWorkspace=false", false],
    ["keepWorkspace=true", true],
    ["snapshot=true&keepWorkspace=true", true],
  ])("?%s → snapshot %s", async (query, expected) => {
    const deleter = deleterMock();
    await request(makeApp(deleter)).delete(`/api/agents/ops?${query}`);
    expect(deleter.deleteAgent).toHaveBeenCalledWith("ops", expect.objectContaining({ snapshot: expected }));
  });

  it("400 when snapshot and keepWorkspace disagree", async () => {
    const deleter = deleterMock();
    const res = await request(makeApp(deleter)).delete("/api/agents/ops?snapshot=true&keepWorkspace=false");
    expect(res.status).toBe(400);
    expect(deleter.deleteAgent).not.toHaveBeenCalled();
  });

  it.each([
    ["deleted", 200, true],
    ["cleanup_incomplete", 200, true],
    ["config_only", 200, true],
    ["unknown", 202, false],
    ["not_deleted", 502, false],
  ])("outcome %s answers %i (ok %s)", async (outcome, status, ok) => {
    const deleter = deleterMock({ deleteAgent: vi.fn(async () => ({ agentId: "ops", outcome, message: "m" })) });
    const res = await request(makeApp(deleter)).delete("/api/agents/ops");
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ ok, outcome });
  });

  it.each([
    [new DeleteAgentError("The default main agent cannot be deleted"), 400, "refused"],
    [new DeleteAgentError('Agent "ghost" not found', { status: 404, code: "not_found" }), 404, "not_found"],
    [new DeleteAgentError("The gateway isn't running.", { status: 409, code: "gateway_not_serving" }), 409, "gateway_not_serving"],
    [new DeleteAgentError("Not enough disk", { status: 507, code: "snapshot_no_space" }), 507, "snapshot_no_space"],
  ])("a refusal before the send keeps its status: %s", async (error, status, code) => {
    const deleter = deleterMock({ deleteAgent: vi.fn(async () => { throw error; }) });
    const res = await request(makeApp(deleter)).delete("/api/agents/ops");
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ ok: false, code, error: error.message });
  });

  it("preview, finish-delete and the deletions list", async () => {
    const deleter = deleterMock({ listDeletions: vi.fn(() => ({ deletions: [{ agentId: "ops", outcome: "cleanup_incomplete" }], running: null })) });
    const app = makeApp(deleter);
    expect((await request(app).get("/api/agents/ops/delete-preview")).body).toEqual({ ok: true, preview: { agentId: "ops", state: "configured" } });
    expect((await request(app).post("/api/agents/ops/finish-delete")).body).toMatchObject({ ok: true, outcome: "deleted" });
    expect(deleter.finishDelete).toHaveBeenCalledWith("ops", { actor: "human" });
    expect((await request(app).get("/api/agent-deletions")).body).toEqual({ ok: true, deletions: [{ agentId: "ops", outcome: "cleanup_incomplete" }], running: null });
    deleter.preview.mockRejectedValueOnce(new DeleteAgentError("nope", { status: 404, code: "not_found" }));
    expect((await request(app).get("/api/agents/ghost/delete-preview")).status).toBe(404);
  });

  it("an agent or binding write blocked by an in-flight delete answers 409", async () => {
    const agentsService = {
      updateAgent: vi.fn(() => {
        throw new OpenclawConfigWriteBlockedError("An agent is being deleted. Try again in a moment.");
      }),
      addBinding: vi.fn(() => {
        throw new OpenclawConfigWriteBlockedError("An agent is being deleted. Try again in a moment.");
      }),
    };
    const app = makeApp(deleterMock(), agentsService);
    const update = await request(app).put("/api/agents/main").send({ name: "x" });
    expect(update.status).toBe(409);
    expect(update.body.error).toBe("An agent is being deleted. Try again in a moment.");
    expect((await request(app).post("/api/agents/main/bindings").send({ channel: "telegram" })).status).toBe(409);
  });
});

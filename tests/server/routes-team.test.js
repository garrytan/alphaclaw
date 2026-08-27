const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");

const { registerTeamRoutes } = require("../../lib/server/routes/team");
const { createTeamService } = require("../../lib/server/team-service");
const {
  isTeamEnabled,
  updateTeamConfig,
} = require("../../lib/server/alphaclaw-config");
const { setOperators } = require("../../lib/server/operators-store");

const kGatewayUrl = "http://127.0.0.1:18789";

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-routes-team-test-"));

const writeConfig = (openclawDir, config) => {
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify(config, null, 2),
  );
};

const readConfig = (openclawDir) =>
  JSON.parse(fs.readFileSync(path.join(openclawDir, "openclaw.json"), "utf8"));

const createAcceptAllRequest = () =>
  vi.fn(async ({ url }) =>
    url.endsWith("/health") || url.endsWith("/tools/invoke")
      ? { status: url.endsWith("/health") ? 200 : 400, error: null }
      : { status: 404, error: null },
  );

const createTestApp = ({
  openclawDir,
  restartGateway = vi.fn(async () => {}),
  probeRequest = createAcceptAllRequest(),
} = {}) => {
  const teamService = createTeamService({
    fsModule: fs,
    openclawDir,
    env: { OPENCLAW_GATEWAY_TOKEN: "shared-token" },
    restartGateway,
    getGatewayUrl: () => kGatewayUrl,
    request: probeRequest,
    probeOptions: { healthAttempts: 1, healthRetryDelayMs: 1 },
    logger: { warn: vi.fn() },
  });
  const app = express();
  app.use(express.json());
  registerTeamRoutes({ app, teamService });
  return { app, teamService, restartGateway };
};

describe("server/routes/team", () => {
  it("GET /api/team reports the disabled default with no probe", async () => {
    const openclawDir = createTempOpenclawDir();
    const { app } = createTestApp({ openclawDir });

    const res = await request(app).get("/api/team");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      enabled: false,
      operatorCount: 0,
      identityProbe: null,
    });
  });

  it("manages the operator roster via GET/PUT /api/team/operators", async () => {
    const openclawDir = createTempOpenclawDir();
    const { app } = createTestApp({ openclawDir });

    const put = await request(app)
      .put("/api/team/operators")
      .send({
        operators: [
          { id: "garry", name: "Garry", email: "g@example.com", avatar: "" },
        ],
      });
    expect(put.status).toBe(200);
    expect(put.body.operatorsVersion).toBe(1);

    const get = await request(app).get("/api/team/operators");
    expect(get.status).toBe(200);
    expect(get.body.operators).toEqual([
      { id: "garry", name: "Garry", email: "g@example.com", avatar: "" },
    ]);
  });

  it("rejects invalid operator payloads", async () => {
    const openclawDir = createTempOpenclawDir();
    const { app } = createTestApp({ openclawDir });

    expect(
      (await request(app).put("/api/team/operators").send({ operators: "nope" }))
        .status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put("/api/team/operators")
          .send({ operators: [{ id: "bad id with spaces" }] })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .put("/api/team/operators")
          .send({ operators: [{ id: "dup" }, { id: "dup" }] })
      ).status,
    ).toBe(400);
  });

  it("PUT /api/team enables team mode through the gateway transition", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    });
    setOperators({ openclawDir, operators: [{ id: "garry" }] });
    const { app, restartGateway } = createTestApp({ openclawDir });

    const res = await request(app).put("/api/team").send({ enabled: true });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enabled: true, changed: true });
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(isTeamEnabled({ openclawDir })).toBe(true);
    expect(readConfig(openclawDir).gateway.auth.mode).toBe("trusted-proxy");

    const status = await request(app).get("/api/team");
    expect(status.body.enabled).toBe(true);
    expect(status.body.operatorCount).toBe(1);
    expect(status.body.identityProbe.ok).toBe(true);
    expect(status.body.identityProbe.checkedAt).toEqual(expect.any(String));
  });

  it("PUT /api/team returns 502 and restores config when the probe fails", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    });
    setOperators({ openclawDir, operators: [{ id: "garry" }] });
    const probeRequest = vi.fn(async ({ url }) =>
      url.endsWith("/health")
        ? { status: 200, error: null }
        : { status: 401, error: null },
    );
    const { app } = createTestApp({ openclawDir, probeRequest });

    const res = await request(app).put("/api/team").send({ enabled: true });
    expect(res.status).toBe(502);
    expect(res.body.ok).toBe(false);
    expect(res.body.restored).toBe(true);
    expect(isTeamEnabled({ openclawDir })).toBe(false);
    expect(readConfig(openclawDir).gateway.auth).toEqual({
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    });
  });

  it("PUT /api/team disables team mode and restores token auth", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    });
    setOperators({ openclawDir, operators: [{ id: "garry" }] });
    const { app } = createTestApp({ openclawDir });

    await request(app).put("/api/team").send({ enabled: true });
    const res = await request(app).put("/api/team").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enabled: false, changed: true });
    expect(isTeamEnabled({ openclawDir })).toBe(false);
    expect(readConfig(openclawDir).gateway.auth).toEqual({
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    });
  });

  it("PUT /api/team is a no-op when the flag already matches", async () => {
    const openclawDir = createTempOpenclawDir();
    const { app, restartGateway } = createTestApp({ openclawDir });
    const res = await request(app).put("/api/team").send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, enabled: false, changed: false });
    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("refuses to enable team mode with no operators", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {});
    const { app } = createTestApp({ openclawDir });
    const res = await request(app).put("/api/team").send({ enabled: true });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/operator/i);
    expect(isTeamEnabled({ openclawDir })).toBe(false);
  });

  it("refuses to empty the roster while team mode is on", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {});
    setOperators({ openclawDir, operators: [{ id: "garry" }] });
    updateTeamConfig({ openclawDir, enabled: true });
    const { app } = createTestApp({ openclawDir });

    const res = await request(app)
      .put("/api/team/operators")
      .send({ operators: [] });
    expect(res.status).toBe(400);
  });

  it("syncs gateway allowUsers when operators change while enabled", async () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
    });
    setOperators({ openclawDir, operators: [{ id: "garry" }] });
    const { app } = createTestApp({ openclawDir });

    await request(app).put("/api/team").send({ enabled: true });
    await request(app)
      .put("/api/team/operators")
      .send({ operators: [{ id: "garry" }, { id: "diana" }] });

    expect(readConfig(openclawDir).gateway.auth.trustedProxy.allowUsers).toEqual([
      "garry",
      "diana",
    ]);
  });

  it("validates the enabled flag type", async () => {
    const openclawDir = createTempOpenclawDir();
    const { app } = createTestApp({ openclawDir });
    const res = await request(app).put("/api/team").send({ enabled: "yes" });
    expect(res.status).toBe(400);
  });
});

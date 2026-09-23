const express = require("express");
const request = require("supertest");
const fs = require("fs");
const { registerSystemRoutes } = require("../../lib/server/routes/system");
const { createAgentAdminEnforcement } = require("../../lib/server/agent-admin/enforcement");
const { kDeploymentOnlyEnvKeys } = require("../../lib/server/deployment-only-env");
const { ENV_FILE_PATH } = require("../../lib/server/constants");

describe("agent Envars authority boundary", () => {
  let app;
  let writes;
  let savedPassword;
  const token = "a".repeat(64);

  beforeEach(() => {
    savedPassword = process.env.SETUP_PASSWORD;
    process.env.SETUP_PASSWORD = "synthetic-owner-password";
    const authPath = require.resolve("../../lib/server/routes/auth");
    delete require.cache[authPath];
    const { registerAuthRoutes } = require(authPath);
    const readFile = fs.readFileSync.bind(fs);
    vi.spyOn(fs, "readFileSync").mockImplementation((file, ...args) =>
      file === ENV_FILE_PATH ? "CUSTOM_FLAG=before" : readFile(file, ...args),
    );
    app = express();
    app.use(express.json());
    const throttle = {
      getClientKey: () => "synthetic-client",
      getOrCreateLoginAttemptState: () => ({ attempts: 0 }),
      evaluateLoginThrottle: () => ({ blocked: false, retryAfterSec: 0 }),
      recordLoginFailure: vi.fn(),
      recordLoginSuccess: vi.fn(),
      cleanupLoginAttemptStates: vi.fn(),
    };
    const { resolveRequestActor } = registerAuthRoutes({
      app,
      loginThrottle: throttle,
      agentAdmin: { isEnabled: () => true, readToken: () => token, throttle },
    });
    app.use("/api", createAgentAdminEnforcement({ resolveRequestActor }));
    writes = vi.fn();
    registerSystemRoutes({
      app,
      fs,
      readEnvFile: () => [{ key: "CUSTOM_FLAG", value: "before" }],
      writeEnvFile: writes,
      reloadEnv: () => true,
      kKnownVars: [],
      kKnownKeys: new Set(),
      syncChannelConfig: vi.fn(),
      isOnboarded: () => false,
      isGatewayRunning: async () => false,
      getChannelStatus: () => ({}),
      OPENCLAW_DIR: "/synthetic/openclaw",
      restartRequiredState: {},
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedPassword === undefined) delete process.env.SETUP_PASSWORD;
    else process.env.SETUP_PASSWORD = savedPassword;
  });

  it("rejects every deployment-only key through bearer auth and enforcement, not a confirm flow", async () => {
    for (const key of kDeploymentOnlyEnvKeys) {
      const result = await request(app).put("/api/env")
        .set("Authorization", `Bearer ${token}`)
        .send({ vars: [{ key: ` ${key} `, value: "synthetic-file-value" }] });
      expect(result.status, key).toBe(400);
      expect(result.body.error).toContain(key);
      expect(result.body.error).toContain("deployment environment");
      expect(result.body.error).not.toContain("synthetic-file-value");
    }
    expect(writes).not.toHaveBeenCalled();
    const saved = await request(app).put("/api/env")
      .set("Authorization", `Bearer ${token}`)
      .send({ vars: [{ key: "CUSTOM_FLAG", value: "after" }] });
    expect(saved.status).toBe(200);
    expect(writes).toHaveBeenCalledExactlyOnceWith([{ key: "CUSTOM_FLAG", value: "after" }]);
  });

  it("exposes reserved names without values to the agent and still requires bearer authentication", async () => {
    expect((await request(app).put("/api/env").send({ vars: [] })).status).toBe(401);
    const listed = await request(app).get("/api/env").set("Authorization", `Bearer ${token}`);
    expect(listed.status).toBe(200);
    expect(listed.body.reservedKeys).toEqual(expect.arrayContaining(kDeploymentOnlyEnvKeys));
    expect(listed.body.vars).toEqual([expect.objectContaining({ key: "CUSTOM_FLAG", present: true })]);
    expect(listed.body.vars[0]).not.toHaveProperty("value");
  });
});

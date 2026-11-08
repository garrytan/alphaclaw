const kModules = ["../../lib/server/deployment-only-env", "../../lib/server/gateway-env-policy"];

const loadWithDeploymentEnv = (value) => {
  for (const m of kModules) delete require.cache[require.resolve(m)];
  const saved = process.env.ALPHACLAW_GATEWAY_LOCKED_ENV;
  if (value === undefined) delete process.env.ALPHACLAW_GATEWAY_LOCKED_ENV;
  else process.env.ALPHACLAW_GATEWAY_LOCKED_ENV = value;
  try {
    return {
      deploymentOnly: require(kModules[0]),
      policy: require(kModules[1]),
    };
  } finally {
    if (saved === undefined) delete process.env.ALPHACLAW_GATEWAY_LOCKED_ENV;
    else process.env.ALPHACLAW_GATEWAY_LOCKED_ENV = saved;
    for (const m of kModules) delete require.cache[require.resolve(m)];
  }
};

const quietLogger = () => ({ log: vi.fn() });
const noHatch = { passthrough: "", unrestricted: false };

describe("ALPHACLAW_GATEWAY_LOCKED_ENV", () => {
  it("parses comma and space separated key names and drops anything else", () => {
    const { deploymentOnly } = loadWithDeploymentEnv(undefined);
    expect(
      deploymentOnly.parseGatewayLockedEnvKeys(" WM_GUARDS_DISABLE, WM_GUARDS_MODE  bad-key WM_GUARDS_MODE $(x) "),
    ).toEqual(["WM_GUARDS_DISABLE", "WM_GUARDS_MODE"]);
    expect(deploymentOnly.parseGatewayLockedEnvKeys("")).toEqual([]);
  });

  it("makes the listed keys deployment-only, so a .env line for them is ignored", () => {
    const { deploymentOnly } = loadWithDeploymentEnv("WM_GUARDS_DISABLE,WM_GUARDS_MODE");
    expect(deploymentOnly.kGatewayLockedEnvKeys).toEqual(["WM_GUARDS_DISABLE", "WM_GUARDS_MODE"]);
    expect(deploymentOnly.kDeploymentOnlyEnvKeys).toEqual(
      expect.arrayContaining(["WM_GUARDS_DISABLE", "WM_GUARDS_MODE", "ALPHACLAW_GATEWAY_LOCKED_ENV"]),
    );
    const overlay = deploymentOnly.resolveEnvFileOverlay([
      { key: "WM_GUARDS_DISABLE", value: "1" },
      { key: "WM_GUARDS_MODE", value: "v1" },
      { key: "ALPHACLAW_GATEWAY_LOCKED_ENV", value: "" },
      { key: "OTHER_PLUGIN_SETTING", value: "x" },
    ]);
    expect([...overlay.keys()]).toEqual(["OTHER_PLUGIN_SETTING"]);
  });

  it("passes a locked key's deployment value to the gateway child", () => {
    const { policy } = loadWithDeploymentEnv("WM_GUARDS_MODE");
    const child = policy.blankDeniedGatewayEnvKeys(
      policy.filterGatewayChildEnv({ WM_GUARDS_MODE: "shadow" }, { logger: quietLogger(), hatch: noHatch }),
    );
    expect(child.WM_GUARDS_MODE).toBe("shadow");
  });

  it("sends an unset locked key to the gateway child as an empty value, so OpenClaw cannot load it from .env", () => {
    const { policy } = loadWithDeploymentEnv("WM_GUARDS_DISABLE");
    const child = policy.blankDeniedGatewayEnvKeys(
      policy.filterGatewayChildEnv({ ANTHROPIC_API_KEY: "k" }, { logger: quietLogger(), hatch: noHatch }),
    );
    expect(child).toHaveProperty("WM_GUARDS_DISABLE", "");
    expect(child.ANTHROPIC_API_KEY).toBe("k");
  });

  it("never passes the list itself to the gateway child", () => {
    const { policy } = loadWithDeploymentEnv("WM_GUARDS_DISABLE");
    const child = policy.blankDeniedGatewayEnvKeys(
      policy.filterGatewayChildEnv(
        { ALPHACLAW_GATEWAY_LOCKED_ENV: "WM_GUARDS_DISABLE" },
        { logger: quietLogger(), hatch: noHatch },
      ),
    );
    expect(child.ALPHACLAW_GATEWAY_LOCKED_ENV).toBe("");
  });

  it("changes nothing when the deployment does not set it", () => {
    const { policy, deploymentOnly } = loadWithDeploymentEnv(undefined);
    expect(deploymentOnly.kGatewayLockedEnvKeys).toEqual([]);
    const child = policy.blankDeniedGatewayEnvKeys(
      policy.filterGatewayChildEnv({ WM_GUARDS_DISABLE: "1" }, { logger: quietLogger(), hatch: noHatch }),
    );
    expect(child).not.toHaveProperty("WM_GUARDS_DISABLE");
  });
});

describe("PATCH /api/env with ALPHACLAW_GATEWAY_LOCKED_ENV", () => {
  it("refuses a locked key as deployment-only and writes nothing", async () => {
    const express = require("express");
    const request = require("supertest");
    const mods = [
      "../../lib/server/deployment-only-env",
      "../../lib/server/env",
      "../../lib/server/utils/env-keys",
      "../../lib/server/routes/env",
    ];
    const clear = () => mods.forEach((m) => delete require.cache[require.resolve(m)]);
    const saved = process.env.ALPHACLAW_GATEWAY_LOCKED_ENV;
    clear();
    process.env.ALPHACLAW_GATEWAY_LOCKED_ENV = "WM_GUARDS_DISABLE";
    let registerEnvRoutes;
    try {
      ({ registerEnvRoutes } = require("../../lib/server/routes/env"));
    } finally {
      if (saved === undefined) delete process.env.ALPHACLAW_GATEWAY_LOCKED_ENV;
      else process.env.ALPHACLAW_GATEWAY_LOCKED_ENV = saved;
    }
    const writeEnvFile = vi.fn();
    const app = express();
    app.use(express.json());
    registerEnvRoutes({
      app,
      readEnvFile: vi.fn(() => []),
      writeEnvFile,
      reloadEnv: vi.fn(() => true),
      kKnownVars: [],
      kKnownKeys: new Set(),
      syncChannelConfig: vi.fn(),
      isOnboarded: vi.fn(() => true),
      restartRequiredState: { markRequired: vi.fn(), hasReason: vi.fn(() => false) },
      gatewayLaunchEnv: vi.fn(() => ({})),
      scanStaleEnvProcesses: vi.fn(() => ({ available: true, checkedKeys: 0, scannedProcesses: 0, unreadableProcesses: 0, stale: [] })),
    });
    try {
      const res = await request(app).patch("/api/env").send({ key: "WM_GUARDS_DISABLE", value: "1" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("deployment-only");
      expect(writeEnvFile).not.toHaveBeenCalled();
    } finally {
      clear();
    }
  });
});

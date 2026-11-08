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

it("strips a locked key from OPENCLAW_SERVICE_MANAGED_ENV_KEYS, so OpenClaw's .env loader cannot override the deployment value", () => {
    const { policy } = loadWithDeploymentEnv("WM_GUARDS_DISABLE");
    const child = policy.blankDeniedGatewayEnvKeys(
      policy.filterGatewayChildEnv(
        {
          WM_GUARDS_DISABLE: "0",
          OPENCLAW_SYSTEMD_UNIT: "x.service",
          OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "wm_guards_disable, OTHER_KEY",
        },
        { logger: quietLogger(), hatch: noHatch },
      ),
    );
    expect(child.WM_GUARDS_DISABLE).toBe("0");
    expect(child.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("OTHER_KEY");
  });

it("always sends a filtered managed list and blank systemd hints when keys are locked, lowercase list key included", () => {
    const { policy } = loadWithDeploymentEnv("WM_GUARDS_DISABLE");
    const child = policy.blankDeniedGatewayEnvKeys(
      policy.filterGatewayChildEnv(
        { WM_GUARDS_DISABLE: "0", OPENCLAW_SYSTEMD_UNIT: "x.service" },
        { logger: quietLogger(), hatch: noHatch },
      ),
    );
    expect(child.WM_GUARDS_DISABLE).toBe("0");
    expect(child.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("");
    expect(child.openclaw_service_managed_env_keys).toBe("");
    for (const key of ["OPENCLAW_SYSTEMD_UNIT", "INVOCATION_ID", "SYSTEMD_EXEC_PID", "JOURNAL_STREAM"]) {
      expect(child).toHaveProperty(key, "");
    }
  });

  it("passes the systemd hints and managed list through unchanged when nothing is locked", () => {
    const { policy } = loadWithDeploymentEnv(undefined);
    const source = {
      OPENCLAW_SYSTEMD_UNIT: "openclaw.service",
      INVOCATION_ID: "abc123",
      SYSTEMD_EXEC_PID: "42",
      JOURNAL_STREAM: "8:1234",
      OPENCLAW_SERVICE_MANAGED_ENV_KEYS: "WM_GUARDS_DISABLE",
    };
    const filtered = policy.filterGatewayChildEnv(source, { logger: quietLogger(), hatch: noHatch });
    const child = policy.blankDeniedGatewayEnvKeys(filtered);
    for (const key of Object.keys(source)) expect(child[key]).toBe(filtered[key]);
    expect(child.OPENCLAW_SYSTEMD_UNIT).toBe("openclaw.service");
    expect(child.OPENCLAW_SERVICE_MANAGED_ENV_KEYS).toBe("WM_GUARDS_DISABLE");
    expect(child).not.toHaveProperty("openclaw_service_managed_env_keys");
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

  it("warns once that a locked key the deployment leaves unset or blank can still come from openclaw.json env", () => {
    const { policy } = loadWithDeploymentEnv("WM_GUARDS_DISABLE,WM_GUARDS_MODE");
    policy.resetGatewayEnvPolicyForTests();
    const logger = quietLogger();
    policy.filterGatewayChildEnv({ WM_GUARDS_MODE: "  " }, { logger, hatch: noHatch });
    policy.filterGatewayChildEnv({ WM_GUARDS_MODE: "  " }, { logger, hatch: noHatch });
    const warnings = logger.log.mock.calls.map(([line]) => line).filter((line) => line.includes("openclaw.json"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("WM_GUARDS_DISABLE, WM_GUARDS_MODE");
  });

  it("does not warn when the deployment sets every locked key", () => {
    const { policy } = loadWithDeploymentEnv("WM_GUARDS_DISABLE");
    policy.resetGatewayEnvPolicyForTests();
    const logger = quietLogger();
    policy.filterGatewayChildEnv({ WM_GUARDS_DISABLE: "0" }, { logger, hatch: noHatch });
    expect(logger.log.mock.calls.some(([line]) => line.includes("openclaw.json"))).toBe(false);
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

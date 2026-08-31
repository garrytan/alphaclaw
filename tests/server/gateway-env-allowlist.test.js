const fs = require("fs");
const os = require("os");
const path = require("path");

// Isolate the module graph onto a temp root BEFORE constants load (same idiom
// as autotune-gateway-env.test.js), so gatewayEnv()'s config reads hit a clean
// dir. This is an INTEGRATION regression: the real gatewayEnv() must apply the
// allowlist filter as its last step.
const kTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gwenv-allow-test-"));
process.env.ALPHACLAW_ROOT_DIR = kTempRoot;
fs.mkdirSync(path.join(kTempRoot, ".openclaw", ".alphaclaw"), { recursive: true });

const { gatewayEnv } = require("../../lib/server/gateway");

// Save/restore any process.env key a test mutates.
const withEnv = (overrides, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k)
      ? process.env[k]
      : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

describe("gatewayEnv() applies the child-env allowlist (TODOS P1)", () => {
  it("REGRESSION: SETUP_PASSWORD and internal secrets never reach the child env", () => {
    withEnv(
      {
        SETUP_PASSWORD: "top-secret",
        GOG_KEYRING_PASSWORD: "kr-secret",
        ALPHACLAW_MANAGED_UPDATE_TOKEN: "mut",
        RAILWAY_TOKEN: "rw",
      },
      () => {
        const env = gatewayEnv();
        expect(env).not.toHaveProperty("SETUP_PASSWORD");
        expect(env).not.toHaveProperty("GOG_KEYRING_PASSWORD");
        expect(env).not.toHaveProperty("ALPHACLAW_MANAGED_UPDATE_TOKEN");
        expect(env).not.toHaveProperty("RAILWAY_TOKEN");
      },
    );
  });

  it("required OpenClaw + provider keys still pass through", () => {
    withEnv({ ANTHROPIC_API_KEY: "sk-ant-x", GITHUB_TOKEN: "ghp-x" }, () => {
      const env = gatewayEnv();
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-x");
      expect(env.GITHUB_TOKEN).toBe("ghp-x");
      // gatewayEnv's own derivations survive the filter.
      expect(env.OPENCLAW_HOME).toBe(kTempRoot);
      expect(env.HOME).toBe(kTempRoot);
      expect(env.OPENCLAW_NO_AUTO_UPDATE).toBe("1");
    });
  });

  it("a .env-supplied UNRESTRICTED hatch value is ignored (boot snapshot only)", () => {
    // The filter snapshots the hatch at module load, before .env is applied,
    // so an agent that manages to set this in process.env at RUNTIME cannot
    // self-grant the legacy full spread.
    withEnv(
      { ALPHACLAW_GATEWAY_ENV_UNRESTRICTED: "1", SETUP_PASSWORD: "s", RANDOM_LEAK: "x" },
      () => {
        const env = gatewayEnv();
        expect(env).not.toHaveProperty("SETUP_PASSWORD");
        expect(env).not.toHaveProperty("RANDOM_LEAK");
      },
    );
  });
});

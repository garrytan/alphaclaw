const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  applyGatewayAuthEnv,
  getGatewayCredential,
  resolveConfigSecret,
} = require("../../lib/server/gateway-credential");

const createTempOpenclawDir = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-gw-cred-test-"));

const writeConfig = (openclawDir, config) => {
  fs.writeFileSync(
    path.join(openclawDir, "openclaw.json"),
    JSON.stringify(config, null, 2),
  );
};

describe("server/gateway-credential", () => {
  it("resolves token mode from the env first", () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, { gateway: { auth: { token: "config-token" } } });
    expect(
      getGatewayCredential({
        openclawDir,
        env: { OPENCLAW_GATEWAY_TOKEN: "env-token" },
      }),
    ).toEqual({ mode: "token", value: "env-token" });
  });

  it("resolves a config token with env-ref substitution", () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: { auth: { token: "${MY_TOKEN_VAR}" } },
    });
    expect(
      getGatewayCredential({ openclawDir, env: { MY_TOKEN_VAR: "resolved" } }),
    ).toEqual({ mode: "token", value: "resolved" });
  });

  it("keys the config cache on the READER identity, not just mtime/size (merge resolution)", () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, { gateway: { auth: { token: "disk-token" } } });
    // Warm the cache through the real fs reader.
    expect(getGatewayCredential({ openclawDir, env: {} })).toEqual({
      mode: "token",
      value: "disk-token",
    });

    // Same path, same on-disk stat — but a swapped reader (a per-test fs
    // mock) must never be served the previous reader's parse.
    const mockFs = {
      statSync: fs.statSync,
      readFileSync: () =>
        JSON.stringify({ gateway: { auth: { token: "mock-token" } } }),
    };
    expect(
      getGatewayCredential({ fsModule: mockFs, openclawDir, env: {} }),
    ).toEqual({ mode: "token", value: "mock-token" });
    // And switching back re-reads through the real fs again.
    expect(getGatewayCredential({ openclawDir, env: {} })).toEqual({
      mode: "token",
      value: "disk-token",
    });
  });

  it("defaults to empty token mode when nothing is configured", () => {
    const openclawDir = createTempOpenclawDir();
    expect(getGatewayCredential({ openclawDir, env: {} })).toEqual({
      mode: "token",
      value: "",
    });
  });

  it("resolves password mode for trusted-proxy gateways, falling back to the token env", () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          password: "${OPENCLAW_GATEWAY_PASSWORD}",
        },
      },
    });
    expect(
      getGatewayCredential({
        openclawDir,
        env: { OPENCLAW_GATEWAY_TOKEN: "shared-secret" },
      }),
    ).toEqual({ mode: "password", value: "shared-secret" });
    expect(
      getGatewayCredential({
        openclawDir,
        env: { OPENCLAW_GATEWAY_PASSWORD: "direct-password" },
      }),
    ).toEqual({ mode: "password", value: "direct-password" });
  });

  it("resolves a literal config password", () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: { auth: { mode: "password", password: "literal-pass" } },
    });
    expect(getGatewayCredential({ openclawDir, env: {} })).toEqual({
      mode: "password",
      value: "literal-pass",
    });
  });

  describe("resolveConfigSecret", () => {
    it("resolves an object env SecretRef to the env value, not '[object Object]'", () => {
      const resolved = resolveConfigSecret(
        { source: "env", provider: "default", id: "MY_TOK" },
        { MY_TOK: "secret-value" },
      );
      expect(resolved).toBe("secret-value");
      expect(resolved).not.toBe("[object Object]");
    });

    it("returns empty string for a non-env object ref", () => {
      expect(resolveConfigSecret({ source: "file", id: "x" }, {})).toBe("");
      expect(
        resolveConfigSecret({ source: "file", id: "x" }, { x: "value" }),
      ).toBe("");
    });

    it("resolves a string env-ref via ${VAR} substitution", () => {
      expect(resolveConfigSecret("${MY_TOK}", { MY_TOK: "env-secret" })).toBe(
        "env-secret",
      );
    });

    it("passes a plain literal string through unchanged", () => {
      expect(resolveConfigSecret("literal-secret", {})).toBe("literal-secret");
    });
  });

  it("resolves an object password ref in trusted-proxy mode to the real value", () => {
    const openclawDir = createTempOpenclawDir();
    writeConfig(openclawDir, {
      gateway: {
        auth: {
          mode: "trusted-proxy",
          password: { source: "env", provider: "default", id: "MY_TOK" },
        },
      },
    });
    expect(
      getGatewayCredential({
        openclawDir,
        env: { MY_TOK: "secret-value" },
      }),
    ).toEqual({ mode: "password", value: "secret-value" });
  });

  describe("applyGatewayAuthEnv", () => {
    it("leaves the env untouched in token mode (team off compat)", () => {
      const openclawDir = createTempOpenclawDir();
      writeConfig(openclawDir, { gateway: { auth: { token: "abc" } } });
      const env = { OPENCLAW_GATEWAY_TOKEN: "abc", OTHER: "x" };
      const result = applyGatewayAuthEnv(env, { openclawDir });
      expect(result).toEqual({ OPENCLAW_GATEWAY_TOKEN: "abc", OTHER: "x" });
    });

    it("drops the token and provides the password in trusted-proxy mode", () => {
      const openclawDir = createTempOpenclawDir();
      writeConfig(openclawDir, {
        gateway: {
          auth: {
            mode: "trusted-proxy",
            password: "${OPENCLAW_GATEWAY_PASSWORD}",
          },
        },
      });
      const env = { OPENCLAW_GATEWAY_TOKEN: "shared-secret", OTHER: "x" };
      const result = applyGatewayAuthEnv(env, { openclawDir });
      expect(result.OPENCLAW_GATEWAY_TOKEN).toBeUndefined();
      expect(result.OPENCLAW_GATEWAY_PASSWORD).toBe("shared-secret");
      expect(result.OTHER).toBe("x");
    });

    it("fails open when the config is unreadable", () => {
      const openclawDir = createTempOpenclawDir();
      fs.writeFileSync(path.join(openclawDir, "openclaw.json"), "not json {");
      const env = { OPENCLAW_GATEWAY_TOKEN: "abc" };
      expect(applyGatewayAuthEnv(env, { openclawDir })).toEqual({
        OPENCLAW_GATEWAY_TOKEN: "abc",
      });
    });
  });
});

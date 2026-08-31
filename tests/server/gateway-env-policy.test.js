const {
  filterGatewayChildEnv,
  kGatewayEnvDenyKeys,
  parseGatewayEnvPassthrough,
  resetGatewayEnvPolicyForTests,
} = require("../../lib/server/gateway-env-policy");

// TODOS P1: filterGatewayChildEnv is the single allowlist gate between
// AlphaClaw's process.env and any OpenClaw child. These pin the security
// contract (deny wins absolutely; internals never leak) and the availability
// contract (everything the gateway/agent needs still passes).
describe("server/gateway-env-policy filterGatewayChildEnv", () => {
  afterEach(() => resetGatewayEnvPolicyForTests());

  const quietLogger = () => ({ log: vi.fn() });
  const noHatch = { passthrough: "", unrestricted: false };

  it("strips SETUP_PASSWORD and AlphaClaw-internal secrets (regression)", () => {
    const out = filterGatewayChildEnv(
      {
        SETUP_PASSWORD: "s3cret",
        GOG_KEYRING_PASSWORD: "kr",
        ALPHACLAW_MANAGED_UPDATE_TOKEN: "mut",
        RAILWAY_TOKEN: "rw",
        ANTHROPIC_API_KEY: "sk-ant",
      },
      { logger: quietLogger(), hatch: noHatch },
    );
    expect(out).not.toHaveProperty("SETUP_PASSWORD");
    expect(out).not.toHaveProperty("GOG_KEYRING_PASSWORD");
    expect(out).not.toHaveProperty("ALPHACLAW_MANAGED_UPDATE_TOKEN");
    expect(out).not.toHaveProperty("RAILWAY_TOKEN");
    // …but the provider key the agent needs passes.
    expect(out.ANTHROPIC_API_KEY).toBe("sk-ant");
  });

  it("passes operational integration keys the gateway resolves from openclaw.json", () => {
    // Withholding these silently breaks (and could fail OPEN, for webhooks)
    // the integrations that reference ${VAR} in openclaw.json.
    const out = filterGatewayChildEnv(
      {
        WEBHOOK_TOKEN: "wh", // hooks.token="${WEBHOOK_TOKEN}" — must pass
        REMOTE_MCP_API_TOKEN: "mcp", // _API_TOKEN, not _API_KEY
        MATTERMOST_BOT_TOKEN: "mm",
        GOOGLE_CHAT_SERVICE_ACCOUNT: "{}",
        ANTHROPIC_BASE_URL: "https://proxy",
        XAI_AUTH_TOKEN: "xai", // _AUTH_TOKEN pattern
        AWS_SECRET_ACCESS_KEY: "aws", // AWS_ prefix (Bedrock)
      },
      { logger: quietLogger(), hatch: noHatch },
    );
    for (const k of [
      "WEBHOOK_TOKEN",
      "REMOTE_MCP_API_TOKEN",
      "MATTERMOST_BOT_TOKEN",
      "GOOGLE_CHAT_SERVICE_ACCOUNT",
      "ANTHROPIC_BASE_URL",
      "XAI_AUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
    ]) {
      expect(out).toHaveProperty(k);
    }
  });

  it("denies every Claude Code launcher key by prefix (a new sibling can't leak)", () => {
    const launcherKeys = [
      "CLAUDE_CODE_ROUTINE_URL",
      "CLAUDE_CODE_ROUTINE_TOKEN",
      "CLAUDE_CODE_LOCAL_ENABLED",
      "CLAUDE_CODE_LOCAL_AUTOSTART",
      "CLAUDE_CODE_LOCAL_PERMISSION_MODE",
      "CLAUDE_CODE_LOCAL_CWD",
      "CLAUDE_CODE_LOCAL_SPAWN_ON_INCIDENT",
      "CLAUDE_CODE_LOCAL_FUTURE_KEY", // a hypothetical new sibling
    ];
    const input = Object.fromEntries(launcherKeys.map((k) => [k, "x"]));
    const out = filterGatewayChildEnv(input, { logger: quietLogger(), hatch: noHatch });
    for (const k of launcherKeys) expect(out).not.toHaveProperty(k);
    // …and even under the break-glass hatch.
    const outUnrestricted = filterGatewayChildEnv(input, {
      logger: quietLogger(),
      hatch: { passthrough: "", unrestricted: true },
    });
    for (const k of launcherKeys) expect(outUnrestricted).not.toHaveProperty(k);
  });

  it("passes required OpenClaw, provider, and agent-tooling keys", () => {
    const out = filterGatewayChildEnv(
      {
        OPENCLAW_HOME: "/data",
        OPENCLAW_GATEWAY_TOKEN: "gwt",
        XDG_CONFIG_HOME: "/data/.openclaw",
        PATH: "/usr/bin",
        HOME: "/data",
        NODE_OPTIONS: "--max-old-space-size=512",
        OPENAI_API_KEY: "sk-oai",
        GITHUB_TOKEN: "ghp",
        XI_API_KEY: "xi", // exotic provider via /_API_KEY$/
        PORT: "8080",
        ALPHACLAW_ROOT_DIR: "/data",
        npm_config_registry: "https://reg",
      },
      { logger: quietLogger(), hatch: noHatch },
    );
    for (const k of [
      "OPENCLAW_HOME",
      "OPENCLAW_GATEWAY_TOKEN",
      "XDG_CONFIG_HOME",
      "PATH",
      "HOME",
      "NODE_OPTIONS",
      "OPENAI_API_KEY",
      "GITHUB_TOKEN",
      "XI_API_KEY",
      "PORT",
      "ALPHACLAW_ROOT_DIR",
      "npm_config_registry",
    ]) {
      expect(out).toHaveProperty(k);
    }
  });

  it("drops unrecognized keys and other ALPHACLAW_* internals", () => {
    const out = filterGatewayChildEnv(
      { SOME_RANDOM_DEPLOY_VAR: "x", ALPHACLAW_SECRET_THING: "y", ALPHACLAW_ROOT_DIR: "/data" },
      { logger: quietLogger(), hatch: noHatch },
    );
    expect(out).not.toHaveProperty("SOME_RANDOM_DEPLOY_VAR");
    expect(out).not.toHaveProperty("ALPHACLAW_SECRET_THING");
    expect(out.ALPHACLAW_ROOT_DIR).toBe("/data"); // the one allowed exception
  });

  it("passthrough hatch allows extra keys and prefix globs", () => {
    const out = filterGatewayChildEnv(
      { CUSTOM_THING: "a", MYVENDOR_FOO: "b", MYVENDOR_BAR: "c", UNLISTED: "d" },
      { logger: quietLogger(), hatch: { passthrough: "CUSTOM_THING, MYVENDOR_*", unrestricted: false } },
    );
    expect(out.CUSTOM_THING).toBe("a");
    expect(out.MYVENDOR_FOO).toBe("b");
    expect(out.MYVENDOR_BAR).toBe("c");
    expect(out).not.toHaveProperty("UNLISTED");
  });

  it("deny wins even over the passthrough hatch (cannot re-grant a secret)", () => {
    const out = filterGatewayChildEnv(
      { SETUP_PASSWORD: "s" },
      { logger: quietLogger(), hatch: { passthrough: "SETUP_PASSWORD", unrestricted: false } },
    );
    expect(out).not.toHaveProperty("SETUP_PASSWORD");
  });

  it("deny wins even under the UNRESTRICTED break-glass", () => {
    const out = filterGatewayChildEnv(
      { SETUP_PASSWORD: "s", RANDOM_VAR: "keep-me", GOG_KEYRING_PASSWORD: "k" },
      { logger: quietLogger(), hatch: { passthrough: "", unrestricted: true } },
    );
    // Break-glass = legacy spread, MINUS the absolute deny set.
    expect(out.RANDOM_VAR).toBe("keep-me");
    expect(out).not.toHaveProperty("SETUP_PASSWORD");
    expect(out).not.toHaveProperty("GOG_KEYRING_PASSWORD");
  });

  it("logs the withheld keys once per distinct set, naming the hatch", () => {
    const logger = quietLogger();
    filterGatewayChildEnv({ DROP_ME: "1" }, { logger, hatch: noHatch });
    filterGatewayChildEnv({ DROP_ME: "1" }, { logger, hatch: noHatch });
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining("ALPHACLAW_GATEWAY_ENV_PASSTHROUGH"),
    );
    expect(logger.log).toHaveBeenCalledWith(expect.stringContaining("DROP_ME"));
  });

  it("never throws on odd input", () => {
    expect(() => filterGatewayChildEnv(null, { hatch: noHatch })).not.toThrow();
    expect(filterGatewayChildEnv(undefined, { hatch: noHatch })).toEqual({});
  });

  it("parseGatewayEnvPassthrough splits on commas and whitespace", () => {
    expect(parseGatewayEnvPassthrough("A, B  C\nD")).toEqual(["A", "B", "C", "D"]);
    expect(parseGatewayEnvPassthrough("")).toEqual([]);
  });

  it("SETUP_PASSWORD is in the absolute deny set", () => {
    expect(kGatewayEnvDenyKeys.has("SETUP_PASSWORD")).toBe(true);
  });
});

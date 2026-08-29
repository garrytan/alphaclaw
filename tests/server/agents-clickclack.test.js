const { createAgentsService } = require("../../lib/server/agents/service");

// Minimal fs mock: openclaw.json round-trips through an in-memory object.
const buildFsMock = (initialConfig = {}) => {
  let currentConfig = JSON.parse(JSON.stringify(initialConfig));
  return {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn((targetPath) => {
      if (String(targetPath || "").endsWith("openclaw.json")) {
        return JSON.stringify(currentConfig);
      }
      throw new Error(`ENOENT: ${targetPath}`);
    }),
    writeFileSync: vi.fn((targetPath, content) => {
      if (String(targetPath || "").endsWith("openclaw.json")) {
        currentConfig = JSON.parse(String(content || "{}"));
      }
    }),
    readConfig: () => currentConfig,
  };
};

const kBaseConfig = {
  agents: { list: [{ id: "main", name: "Main", default: true }] },
};

const buildHarness = ({ runResult, clawResult } = {}) => {
  const fsMock = buildFsMock(kBaseConfig);
  let envVars = [];
  const runCalls = [];
  const clawCalls = [];
  const runStream = {
    runStreamed: vi.fn(async (opts) => {
      runCalls.push(opts);
      return runResult || { ok: true, code: 0, tail: "", timedOut: false };
    }),
  };
  const clawCmd = vi.fn(async (cmd) => {
    clawCalls.push(cmd);
    return clawResult || { ok: true, stdout: "", stderr: "" };
  });
  const restartGateway = vi.fn(async () => {});
  const service = createAgentsService({
    fs: fsMock,
    OPENCLAW_DIR: "/tmp/openclaw",
    readEnvFile: () => envVars,
    writeEnvFile: (next) => {
      envVars = next;
    },
    reloadEnv: () => true,
    restartGateway,
    clawCmd,
    gatewayEnv: () => ({ FAKE_GATEWAY_ENV: "1" }),
    runStream,
  });
  return {
    service,
    fsMock,
    runStream,
    runCalls,
    clawCalls,
    clawCmd,
    restartGateway,
    getEnvVars: () => envVars,
  };
};

describe("server/agents clickclack channel (5.1)", () => {
  it("guided setup passes the code as an argv ELEMENT via the argv runner (C11)", async () => {
    const hostileCode = `abc"; rm -rf / #`;
    const { service, runCalls, clawCalls, restartGateway } = buildHarness();

    const result = await service.createChannelAccount({
      provider: "clickclack",
      setupValue: hostileCode,
      agentId: "main",
      name: "ClickClack",
    });

    expect(runCalls).toHaveLength(1);
    const call = runCalls[0];
    expect(call.command).toBe("openclaw");
    // The hostile value is exactly one argv element — never interpolated.
    expect(call.args).toEqual([
      "channels",
      "add",
      "--channel",
      "clickclack",
      "--name",
      "ClickClack",
      "--code",
      hostileCode,
    ]);
    expect(call.env).toEqual({ FAKE_GATEWAY_ENV: "1" });
    // Agent binding + restart mirror the manual path.
    expect(clawCalls.some((cmd) => cmd.includes("agents bind"))).toBe(true);
    expect(restartGateway).toHaveBeenCalledTimes(1);
    expect(result.channel).toBe("clickclack");
    expect(result.account.envKey).toBeNull();
  });

  it("URL-shaped values use --url (works on stable OpenClaw too)", async () => {
    const { service, runCalls } = buildHarness();
    await service.createChannelAccount({
      provider: "clickclack",
      setupValue: "https://ws.clickclack.dev/setup/abc123",
      agentId: "main",
      name: "ClickClack",
    });
    expect(runCalls[0].args).toContain("--url");
    expect(runCalls[0].args).not.toContain("--code");
  });

  it("a stable CLI rejecting --code gets the upgrade hint, never the code (E-C12)", async () => {
    const secret = "super-secret-setup-code";
    const { service } = buildHarness({
      runResult: {
        ok: false,
        code: 1,
        tail: `error: unknown option '--code' (value ${secret})`,
        timedOut: false,
      },
    });
    await expect(
      service.createChannelAccount({
        provider: "clickclack",
        setupValue: secret,
        agentId: "main",
        name: "ClickClack",
      }),
    ).rejects.toThrow(/OpenClaw 2026\.8/);
    try {
      await service.createChannelAccount({
        provider: "clickclack",
        setupValue: secret,
        agentId: "main",
        name: "ClickClack",
      });
    } catch (err) {
      expect(err.message).not.toContain(secret);
    }
  });

  it("an expired/used code gets the single-use guidance (CEO 11)", async () => {
    const { service } = buildHarness({
      runResult: {
        ok: false,
        code: 1,
        tail: "clickclack: setup code expired",
        timedOut: false,
      },
    });
    await expect(
      service.createChannelAccount({
        provider: "clickclack",
        setupValue: "expired-code",
        agentId: "main",
        name: "ClickClack",
      }),
    ).rejects.toThrow(/single-use and expire in 10 minutes/);
  });

  it("manual setup rides the generic flow: env var + \\${ENV} reference + --base-url", async () => {
    const { service, fsMock, clawCalls, getEnvVars } = buildHarness();

    await service.createChannelAccount({
      provider: "clickclack",
      token: "ccb_manual_token",
      baseUrl: "https://ws.clickclack.dev",
      agentId: "main",
      name: "ClickClack",
    });

    const addCall = clawCalls.find((cmd) => cmd.startsWith("channels add"));
    expect(addCall).toContain("--channel 'clickclack'");
    expect(addCall).toContain("--token 'ccb_manual_token'");
    expect(addCall).toContain("--base-url 'https://ws.clickclack.dev'");

    expect(getEnvVars()).toEqual(
      expect.arrayContaining([
        { key: "CLICKCLACK_BOT_TOKEN", value: "ccb_manual_token" },
      ]),
    );
    const account =
      fsMock.readConfig().channels.clickclack.accounts.default;
    expect(account.token).toBe("${CLICKCLACK_BOT_TOKEN}");
    expect(account.dmPolicy).toBe("pairing");
  });

  it("rolls the just-created account back when a post-add step fails (single-use code)", async () => {
    const clawCalls = [];
    const fsMock = buildFsMock(kBaseConfig);
    // `channels add` (argv runner) succeeds; the bind fails afterward.
    const clawCmd = vi.fn(async (cmd) => {
      clawCalls.push(cmd);
      if (cmd.includes("agents bind")) {
        return { ok: false, stdout: "", stderr: "gateway refused the bind" };
      }
      return { ok: true, stdout: "", stderr: "" };
    });
    const restartGateway = vi.fn(async () => {});
    const service = createAgentsService({
      fs: fsMock,
      OPENCLAW_DIR: "/tmp/openclaw",
      readEnvFile: () => [],
      writeEnvFile: () => {},
      reloadEnv: () => true,
      restartGateway,
      clawCmd,
      gatewayEnv: () => ({}),
      runStream: {
        runStreamed: vi.fn(async () => ({
          ok: true,
          code: 0,
          tail: "",
          timedOut: false,
        })),
      },
    });

    await expect(
      service.createChannelAccount({
        provider: "clickclack",
        setupValue: "single-use-code",
        agentId: "main",
        name: "ClickClack",
      }),
    ).rejects.toThrow(/gateway refused the bind/);

    // The account that `channels add` created is torn back down: a spent
    // single-use code must not leave an orphan account blocking retry.
    const removeCall = clawCalls.find((cmd) =>
      cmd.startsWith("channels remove"),
    );
    expect(removeCall).toBeTruthy();
    expect(removeCall).toContain("--channel clickclack");
    expect(removeCall).toContain("--delete");
    // A failed setup never claims a successful restart.
    expect(restartGateway).not.toHaveBeenCalled();
  });
});

describe("server/agents clickclack beta toggles (5.1)", () => {
  it("writes commandMenu/allowBots ONLY on an explicit choice", async () => {
    const fsMock = buildFsMock({
      agents: { list: [{ id: "main", name: "Main", default: true }] },
      channels: {
        clickclack: {
          enabled: true,
          accounts: { default: { name: "ClickClack", token: "${CLICKCLACK_BOT_TOKEN}" } },
        },
      },
    });
    const service = createAgentsService({
      fs: fsMock,
      OPENCLAW_DIR: "/tmp/openclaw",
      readEnvFile: () => [{ key: "CLICKCLACK_BOT_TOKEN", value: "ccb_x" }],
      writeEnvFile: () => {},
      reloadEnv: () => true,
      restartGateway: async () => {},
      clawCmd: async () => ({ ok: true, stdout: "", stderr: "" }),
    });

    // Default choices never write the keys.
    await service.updateChannelAccount({
      provider: "clickclack",
      accountId: "default",
      name: "ClickClack",
      agentId: "main",
    });
    expect(fsMock.readConfig().channels.clickclack.commandMenu).toBeUndefined();
    expect(fsMock.readConfig().channels.clickclack.allowBots).toBeUndefined();

    // Explicit choices write the schema-verified keys.
    await service.updateChannelAccount({
      provider: "clickclack",
      accountId: "default",
      name: "ClickClack",
      agentId: "main",
      commandMenu: "off",
      allowBots: "mentions",
    });
    expect(fsMock.readConfig().channels.clickclack.commandMenu).toBe(false);
    expect(fsMock.readConfig().channels.clickclack.allowBots).toBe("mentions");

    await service.updateChannelAccount({
      provider: "clickclack",
      accountId: "default",
      name: "ClickClack",
      agentId: "main",
      commandMenu: "on",
      allowBots: "off",
    });
    expect(fsMock.readConfig().channels.clickclack.commandMenu).toBe(true);
    expect(fsMock.readConfig().channels.clickclack.allowBots).toBe(false);
  });
});

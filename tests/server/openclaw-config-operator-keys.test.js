const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAgentsService } = require("../../lib/server/agents/service");
const { updateOpenclawConfig } = require("../../lib/server/openclaw-config");
const { normalizeBootConfig } = require("../../lib/server/boot-config-normalization");
const { ensureUsageTrackerPluginConfig } = require("../../lib/server/usage-tracker-config");
const { ensureManagedExecDefaults } = require("../../lib/server/exec-defaults-config");

// An operator adds MCP servers to openclaw.json by hand (or with their own
// tooling). No AlphaClaw writer may drop or revert them.
const kOperatorServers = {
  "ops-tools": { command: "/srv/ops/mcp-server", args: ["--stdio"] },
};

const addOperatorServers = (configPath) => {
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  cfg.mcp = { ...(cfg.mcp || {}), servers: { ...kOperatorServers } };
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
};

describe("operator-added mcp.servers survive AlphaClaw's openclaw.json writers", () => {
  let root;
  let configPath;
  const readConfig = () => JSON.parse(fs.readFileSync(configPath, "utf8"));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-operator-keys-"));
    configPath = path.join(root, "openclaw.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({ agents: { list: [{ id: "main", default: true }] } }, null, 2),
    );
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const buildService = ({ clawCmd, restartGateway = vi.fn(async () => {}), envVars = [] }) =>
    createAgentsService({
      fs,
      OPENCLAW_DIR: root,
      readEnvFile: vi.fn(() => envVars),
      writeEnvFile: vi.fn(),
      reloadEnv: vi.fn(),
      restartGateway,
      clawCmd,
    });

  const failingBind = () =>
    vi.fn(async (command) => {
      if (String(command).startsWith("channels add")) addOperatorServers(configPath);
      if (String(command).startsWith("agents bind")) {
        return { ok: false, stdout: "", stderr: "bind exploded" };
      }
      return { ok: true, stdout: "", stderr: "" };
    });

  it("a failed channel create rolls back its own keys, not an edit made while its CLI ran", async () => {
    await expect(
      buildService({ clawCmd: failingBind() }).createChannelAccount({
        provider: "telegram",
        agentId: "main",
        accountId: "default",
        token: "123:abc",
      }),
    ).rejects.toThrow("bind exploded");

    const cfg = readConfig();
    expect(cfg.mcp.servers).toEqual(kOperatorServers);
    expect(cfg.channels?.telegram).toBeUndefined();
    expect(cfg.plugins?.allow || []).not.toContain("telegram");
    expect(cfg.plugins?.entries?.telegram).toBeUndefined();
  });

  it("a WhatsApp create whose restart fails keeps an edit made during the restart", async () => {
    const restartGateway = vi.fn(async () => {
      addOperatorServers(configPath);
      throw new Error("gateway did not come back ready");
    });
    const clawCmd = vi.fn(async () => ({ ok: true, stdout: "", stderr: "" }));

    await expect(
      buildService({ clawCmd, restartGateway }).createChannelAccount({
        provider: "whatsapp",
        agentId: "main",
        accountId: "default",
        token: "+15551234567",
      }),
    ).rejects.toThrow("gateway did not come back ready");

    const cfg = readConfig();
    expect(cfg.mcp.servers).toEqual(kOperatorServers);
    expect(cfg.channels?.whatsapp).toBeUndefined();
    expect(cfg.bindings || []).toEqual([]);
    expect(cfg.plugins?.allow || []).not.toContain("whatsapp");
  });

  it("a rollback keeps channels and bindings that existed before the create", async () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        agents: { list: [{ id: "main", default: true }] },
        channels: { discord: { enabled: true, token: "${DISCORD_BOT_TOKEN}" } },
        plugins: { allow: ["discord"], entries: { discord: { enabled: true } } },
        bindings: [{ agentId: "main", match: { channel: "discord", accountId: "default" } }],
      }),
    );

    await expect(
      buildService({
        clawCmd: failingBind(),
        envVars: [{ key: "DISCORD_BOT_TOKEN", value: "discord-secret" }],
      }).createChannelAccount({
        provider: "telegram",
        agentId: "main",
        accountId: "default",
        token: "123:abc",
      }),
    ).rejects.toThrow("bind exploded");

    const cfg = readConfig();
    expect(cfg.mcp.servers).toEqual(kOperatorServers);
    expect(Object.keys(cfg.channels)).toEqual(["discord"]);
    expect(cfg.plugins.allow).toEqual(["discord"]);
    expect(Object.keys(cfg.plugins.entries)).toEqual(["discord"]);
    expect(cfg.bindings).toEqual([
      { agentId: "main", match: { channel: "discord", accountId: "default" } },
    ]);
  });

  it("boot normalization keeps them when it rewrites the file", () => {
    addOperatorServers(configPath);
    const result = normalizeBootConfig({
      hold: { isValid: () => true },
      env: {
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_STATE_DIR: root,
        TELEGRAM_BOT_TOKEN: "telegram-secret",
      },
      logger: { log: vi.fn() },
    });
    expect(result.changed).toBe(true);
    expect(readConfig().mcp.servers).toEqual(kOperatorServers);
  });

  it("roster canonicalization keeps them", () => {
    fs.writeFileSync(configPath, JSON.stringify({ agents: { entries: { main: { name: "Main" } } } }));
    addOperatorServers(configPath);
    updateOpenclawConfig({
      openclawDir: root,
      mutate: (cfg) => {
        cfg.agents.list.push({ id: "ops" });
      },
    });
    const cfg = readConfig();
    expect(cfg.mcp.servers).toEqual(kOperatorServers);
    expect(Object.keys(cfg.agents.entries || {})).toEqual(["main", "ops"]);
  });

  it("the boot plugin reconcile and the exec defaults keep them", async () => {
    addOperatorServers(configPath);
    expect(ensureUsageTrackerPluginConfig({ fsModule: fs, openclawDir: root })).toBe(true);
    await ensureManagedExecDefaults({
      fsModule: fs,
      openclawDir: root,
      logger: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    expect(readConfig().mcp.servers).toEqual(kOperatorServers);
  });

  it("the workspace sync's hook-entry reconcile keeps them", () => {
    const { syncBootstrapPromptFiles } = require("../../lib/server/onboarding/workspace");
    const { OPENCLAW_DIR } = require("../../lib/server/constants");
    const kConfigPath = path.join(OPENCLAW_DIR, "openclaw.json");
    const config = JSON.stringify({
      mcp: { servers: kOperatorServers },
      hooks: { internal: { enabled: false, entries: {} } },
    });
    const mockFs = {
      readFileSync: vi.fn((target) => {
        if (target === kConfigPath) return config;
        if (String(target).includes("core-prompts")) return "TEMPLATE";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }),
      existsSync: vi.fn(() => false),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    syncBootstrapPromptFiles({ fs: mockFs, workspaceDir: path.join(root, "workspace") });

    const configWrite = mockFs.writeFileSync.mock.calls.find(([target]) => target === kConfigPath);
    expect(configWrite).toBeTruthy();
    const written = JSON.parse(configWrite[1]);
    expect(written.hooks.internal.enabled).toBe(true);
    expect(written.mcp.servers).toEqual(kOperatorServers);
  });
});

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { normalizeBootConfig } = require("../../lib/server/boot-config-normalization");
const { kUsageTrackerPluginPath } = require("../../lib/server/usage-tracker-config");

describe("admitted boot config normalization", () => {
  let root;
  let configPath;
  let deps;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-boot-config-"));
    configPath = path.join(root, "openclaw.json");
    deps = {
      hold: { isValid: () => true },
      env: { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_STATE_DIR: root },
      logger: { log: vi.fn() },
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("preserves Telegram migration, channel setup, stale plugin pruning, and exact secret replacement", () => {
    fs.writeFileSync(configPath, JSON.stringify({
      channels: { telegram: { streamMode: "partial" } },
      agents: { entries: { main: { name: "Main" } } },
      plugins: { load: { paths: ["/previous/lib/plugin/usage-tracker", "/custom/plugin"] } },
      env: { ordinaryValue: "prefix-discord-secret-suffix" },
    }));
    deps.env.DISCORD_BOT_TOKEN = "discord-secret";
    expect(normalizeBootConfig(deps)).toEqual({ changed: true });
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(cfg.channels.telegram.streamMode).toBeUndefined();
    expect(cfg.channels.telegram.streaming).toEqual({ mode: "partial" });
    expect(cfg.channels.discord).toEqual({ enabled: true, token: "${DISCORD_BOT_TOKEN}", dmPolicy: "pairing", groupPolicy: "allowlist" });
    expect(cfg.plugins.entries.discord.enabled).toBe(true);
    expect(cfg.plugins.entries["usage-tracker"].enabled).toBe(true);
    expect(cfg.plugins.load.paths).toEqual(["/custom/plugin", kUsageTrackerPluginPath]);
    expect(cfg.agents.entries.main.name).toBe("Main");
    expect(cfg.agents.list).toBeUndefined();
    expect(cfg.env.ordinaryValue).toBe("prefix-discord-secret-suffix");
    expect(JSON.stringify(deps.logger.log.mock.calls)).not.toContain("discord-secret");
    const bytes = fs.readFileSync(configPath);
    const before = fs.statSync(configPath);
    expect(normalizeBootConfig(deps)).toEqual({ changed: false });
    expect(fs.readFileSync(configPath)).toEqual(bytes);
    expect(fs.statSync(configPath).mtimeMs).toBe(before.mtimeMs);
  });

  it("adds the missing Telegram channel without overwriting configured channels", () => {
    fs.writeFileSync(configPath, JSON.stringify({ channels: { discord: { enabled: false, token: "custom" } } }));
    deps.env.TELEGRAM_BOT_TOKEN = "telegram-secret";
    deps.env.DISCORD_BOT_TOKEN = "discord-secret";
    normalizeBootConfig(deps);
    const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(cfg.channels.telegram).toEqual({ enabled: true, botToken: "${TELEGRAM_BOT_TOKEN}", dmPolicy: "pairing", groupPolicy: "allowlist" });
    expect(cfg.channels.discord).toEqual({ enabled: false, token: "custom" });
  });

  it.each([true, false])("refuses a custom filename without modifying it or its default sibling (sibling exists: %s)", (siblingExists) => {
    const siblingBytes = '{\n  "sibling": "must not change", "agents": { "list": [] }\n}\n';
    if (siblingExists) fs.writeFileSync(configPath, siblingBytes);
    const customPath = path.join(root, "custom.json");
    const customBytes = JSON.stringify({ agents: { entries: { main: { name: "Custom main" } } } });
    fs.writeFileSync(customPath, customBytes);
    deps.env.OPENCLAW_CONFIG_PATH = customPath;
    expect(() => normalizeBootConfig(deps)).toThrow("requires the state root's openclaw.json");
    expect(fs.readFileSync(customPath, "utf8")).toBe(customBytes);
    if (siblingExists) expect(fs.readFileSync(configPath, "utf8")).toBe(siblingBytes);
    else expect(fs.existsSync(configPath)).toBe(false);
  });

  it("rejects the canonical filename when it belongs to a different state root", () => {
    const other = path.join(root, "other");
    fs.mkdirSync(other);
    fs.writeFileSync(configPath, "{}");
    deps.env.OPENCLAW_STATE_DIR = other;
    expect(() => normalizeBootConfig(deps)).toThrow("requires the state root's openclaw.json");
    expect(fs.readFileSync(configPath, "utf8")).toBe("{}");
  });

  it("accepts symlink-equivalent state roots without changing their logical environment identity or keyed agent shape", () => {
    const alias = `${root}-alias`;
    fs.symlinkSync(root, alias);
    fs.writeFileSync(configPath, JSON.stringify({ agents: { entries: { main: { name: "Main" } } } }));
    deps.env.OPENCLAW_STATE_DIR = alias;
    try {
      expect(normalizeBootConfig(deps)).toEqual({ changed: true });
      expect(deps.env.OPENCLAW_STATE_DIR).toBe(alias);
      const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(cfg.agents).toEqual({ entries: { main: { name: "Main" } } });
      expect(cfg.plugins.load.paths).toContain(kUsageTrackerPluginPath);
    } finally {
      fs.unlinkSync(alias);
    }
  });

  it("does not manufacture a config when none exists", () => {
    expect(normalizeBootConfig(deps)).toEqual({ changed: false });
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it.each([null, {}, { isValid: () => false }])("refuses normalization without current ownership: %j", (hold) => {
    fs.writeFileSync(configPath, "{\"channels\":{}}");
    expect(() => normalizeBootConfig({ ...deps, hold })).toThrow("requires the boot lease");
    expect(fs.readFileSync(configPath, "utf8")).toBe("{\"channels\":{}}");
  });

  it("fails closed on an existing unsupported config without logging its contents", () => {
    const bytes = '{ "secret": "do-not-log",';
    fs.writeFileSync(configPath, bytes);
    expect(() => normalizeBootConfig(deps)).toThrow("Boot config normalization could not complete");
    expect(fs.readFileSync(configPath, "utf8")).toBe(bytes);
    expect(deps.logger.log).not.toHaveBeenCalled();
  });

  it("removes bin's normalization writers instead of also running them before admission", () => {
    const bin = fs.readFileSync(path.resolve(__dirname, "../../bin/alphaclaw.js"), "utf8");
    expect(bin).not.toContain("migrateLegacyTelegramStreamingConfig");
    expect(bin).not.toContain("Config updated and sanitized");
    expect(bin).not.toContain("cfg.channels.telegram =");
    expect(bin).not.toContain("kUsageTrackerPluginPath");
  });
});

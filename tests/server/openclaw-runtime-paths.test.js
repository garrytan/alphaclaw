const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");
const { createCommands } = require("../../lib/server/commands");

describe("configured OpenClaw runtime paths", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-paths-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("preserves the shared state alias and cron partition key without mutating the caller", () => {
    const real = path.join(root, "repo", "agent");
    const alias = path.join(root, ".openclaw");
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, alias);
    fs.writeFileSync(path.join(real, "openclaw.json"), "{}\n");
    const input = { OPENCLAW_STATE_DIR: alias, OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json"), XDG_CONFIG_HOME: alias };
    const output = withOpenclawStartupEnv(input);
    expect(output).toMatchObject(input);
    expect(path.resolve(output.OPENCLAW_STATE_DIR, "cron/jobs.json"))
      .toBe(path.join(alias, "cron/jobs.json"));
    expect(input).toEqual({ OPENCLAW_STATE_DIR: alias, OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json"), XDG_CONFIG_HOME: alias });
  });

  it("preserves a not-yet-created config and missing state paths", () => {
    const real = path.join(root, "agent");
    const alias = path.join(root, ".openclaw");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    expect(withOpenclawStartupEnv({ OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json") }))
      .toMatchObject({ OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json") });
    const missing = path.join(root, "missing");
    expect(withOpenclawStartupEnv({ OPENCLAW_STATE_DIR: missing })).toMatchObject({ OPENCLAW_STATE_DIR: missing });
  });

  it("preserves a config-file symlink for OpenClaw's own write-safety checks", () => {
    const real = path.join(root, "agent");
    const alias = path.join(root, ".openclaw");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    const target = path.join(root, "external-config.json");
    fs.writeFileSync(target, "{}\n");
    fs.symlinkSync(target, path.join(real, "openclaw.json"));
    expect(withOpenclawStartupEnv({ OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json") }))
      .toMatchObject({ OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json") });
    expect(fs.lstatSync(path.join(real, "openclaw.json")).isSymbolicLink()).toBe(true);
  });

  it("preserves identity paths in the shell-form CLI", async () => {
    const real = path.join(root, "agent");
    const alias = path.join(root, ".openclaw");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    const input = { OPENCLAW_STATE_DIR: alias, OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json"), XDG_CONFIG_HOME: alias };
    fs.writeFileSync(path.join(root, "openclaw"), `#!${process.execPath}\nconsole.log(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(input))}.map(key => [key, process.env[key]]))))`, { mode: 0o700 });
    const commands = createCommands({ gatewayEnv: () => ({ ...input, PATH: root }) });
    const result = await commands.clawCmd("cron list --json", { quiet: true });
    expect(result.ok, result.stderr).toBe(true);
    expect(JSON.parse(result.stdout)).toEqual(input);
  });

  it("resolves only the config file's directory for a symlinked state dir (#144)", () => {
    const { resolveOpenclawChildConfigPath } = require("../../lib/server/openclaw-config-path");
    const real = path.join(root, "repo", "agent");
    const alias = path.join(root, ".openclaw");
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, alias);
    expect(resolveOpenclawChildConfigPath(alias)).toBe(path.join(fs.realpathSync(real), "openclaw.json"));
    const plain = path.join(root, "plain");
    fs.mkdirSync(plain);
    expect(resolveOpenclawChildConfigPath(plain)).toBe(path.join(plain, "openclaw.json"));
    const missing = path.join(root, "missing");
    expect(resolveOpenclawChildConfigPath(missing)).toBe(path.join(missing, "openclaw.json"));
    const target = path.join(root, "external-config.json");
    fs.writeFileSync(target, "{}\n");
    fs.symlinkSync(target, path.join(real, "openclaw.json"));
    expect(fs.lstatSync(resolveOpenclawChildConfigPath(alias)).isSymbolicLink()).toBe(true);
  });

  it("keeps the state dir lexical and resolves the config path through the actual gateway environment builder", () => {
    const real = path.join(root, "agent");
    const alias = path.join(root, ".openclaw");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    const output = execFileSync(process.execPath, ["-e", `
      const env = require(${JSON.stringify(require.resolve("../../lib/server/gateway"))}).gatewayEnv();
      console.log(JSON.stringify(Object.fromEntries(["OPENCLAW_STATE_DIR", "OPENCLAW_CONFIG_PATH", "XDG_CONFIG_HOME"].map(key => [key, env[key]]))));
    `], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: root, ALPHACLAW_ROOT_DIR: root } });
    expect(JSON.parse(output)).toEqual({ OPENCLAW_STATE_DIR: alias, OPENCLAW_CONFIG_PATH: path.join(fs.realpathSync(real), "openclaw.json"), XDG_CONFIG_HOME: alias });
  });
});

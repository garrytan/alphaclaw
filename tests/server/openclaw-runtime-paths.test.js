const fs = require("fs");
const os = require("os");
const path = require("path");
const { resolveOpenclawRuntimeEnv, withOpenclawStartupEnv } = require("../../lib/server/openclaw-runtime-env");

describe("canonical OpenClaw runtime paths", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-paths-")); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  it("resolves the shared state alias for the gateway and config CLI without mutating the caller", () => {
    const real = path.join(root, "repo", "agent");
    const alias = path.join(root, ".openclaw");
    fs.mkdirSync(real, { recursive: true });
    fs.symlinkSync(real, alias);
    fs.writeFileSync(path.join(real, "openclaw.json"), "{}\n");
    const input = { OPENCLAW_STATE_DIR: alias, OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json"), XDG_CONFIG_HOME: alias };
    for (const output of [resolveOpenclawRuntimeEnv(input), withOpenclawStartupEnv(input)]) {
      expect(output).toMatchObject({ OPENCLAW_STATE_DIR: real, OPENCLAW_CONFIG_PATH: path.join(real, "openclaw.json"), XDG_CONFIG_HOME: real });
    }
    expect(input.OPENCLAW_STATE_DIR).toBe(alias);
  });

  it("resolves the parent of a not-yet-created config without changing missing state paths", () => {
    const real = path.join(root, "agent");
    const alias = path.join(root, ".openclaw");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    expect(resolveOpenclawRuntimeEnv({ OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json") }))
      .toEqual({ OPENCLAW_CONFIG_PATH: path.join(real, "openclaw.json") });
    const missing = path.join(root, "missing");
    expect(resolveOpenclawRuntimeEnv({ OPENCLAW_STATE_DIR: missing })).toEqual({ OPENCLAW_STATE_DIR: missing });
  });

  it("preserves a config-file symlink for OpenClaw's own write-safety checks", () => {
    const real = path.join(root, "agent");
    const alias = path.join(root, ".openclaw");
    fs.mkdirSync(real);
    fs.symlinkSync(real, alias);
    const target = path.join(root, "external-config.json");
    fs.writeFileSync(target, "{}\n");
    fs.symlinkSync(target, path.join(real, "openclaw.json"));
    expect(resolveOpenclawRuntimeEnv({ OPENCLAW_CONFIG_PATH: path.join(alias, "openclaw.json") }))
      .toEqual({ OPENCLAW_CONFIG_PATH: path.join(real, "openclaw.json") });
    expect(fs.lstatSync(path.join(real, "openclaw.json")).isSymbolicLink()).toBe(true);
  });
});

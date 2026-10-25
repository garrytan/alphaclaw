// A state directory reached through a symlink (/data/.openclaw -> a folder
// inside a bigger repository) is a supported layout. AlphaClaw's own atomic
// writers resolve their temp file and rename through that symlink: the files
// land in the real directory and the symlink itself stays a symlink.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { writeFileAtomic } = require("../../lib/server/utils/safe-file");
const { updateOpenclawConfig } = require("../../lib/server/openclaw-config");
const { updateAlphaclawConfig, readAlphaclawConfig } = require("../../lib/server/alphaclaw-config");

describe("AlphaClaw's atomic writes through a symlinked state directory", () => {
  let root;
  let realDir;
  let openclawDir;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "state-dir-symlink-"));
    realDir = path.join(root, "repo", "sub");
    fs.mkdirSync(realDir, { recursive: true });
    openclawDir = path.join(root, ".openclaw");
    fs.symlinkSync(path.join("repo", "sub"), openclawDir);
    fs.writeFileSync(path.join(realDir, "openclaw.json"), JSON.stringify({ gateway: { port: 18789 } }));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const expectSymlinkKept = () => {
    expect(fs.lstatSync(openclawDir).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(openclawDir)).toBe(fs.realpathSync(realDir));
  };

  const leftovers = () => fs.readdirSync(realDir).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"));

  it("writeFileAtomic writes into the real directory and keeps the symlink", () => {
    writeFileAtomic(path.join(openclawDir, "probe.json"), "{\"ok\":true}\n");
    expectSymlinkKept();
    expect(fs.readFileSync(path.join(realDir, "probe.json"), "utf8")).toBe("{\"ok\":true}\n");
    expect(leftovers()).toEqual([]);
  });

  it("updateOpenclawConfig rewrites openclaw.json in the real directory", () => {
    updateOpenclawConfig({
      openclawDir,
      mutate: (config) => {
        config.gateway.port = 18790;
      },
    });
    expectSymlinkKept();
    expect(JSON.parse(fs.readFileSync(path.join(realDir, "openclaw.json"), "utf8")).gateway.port).toBe(18790);
    expect(leftovers()).toEqual([]);
  });

  it("updateAlphaclawConfig writes alphaclaw.json in the real directory", () => {
    updateAlphaclawConfig({
      openclawDir,
      mutate: (config) => {
        config.features.openaiCompatApi.enabled = true;
        return config;
      },
    });
    expectSymlinkKept();
    expect(fs.existsSync(path.join(realDir, "alphaclaw.json"))).toBe(true);
    expect(readAlphaclawConfig({ openclawDir }).features.openaiCompatApi.enabled).toBe(true);
    expect(leftovers()).toEqual([]);
  });
});

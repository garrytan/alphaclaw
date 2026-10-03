const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { describeExecutingBuild, resolvePackageBin } = require("../../lib/server/openclaw-build");

describe("bounded executing-build identity", () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "executing-build-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  const build = (directory, pkg = { version: "2026.9.5", bin: "openclaw.mjs" }) => {
    write(path.join(directory, "package.json"), JSON.stringify(pkg));
    write(path.join(directory, "openclaw.mjs"), "");
    return path.join(directory, "openclaw.mjs");
  };

  it("describes the pinned package installed beside AlphaClaw", () => {
    const directory = path.join(root, "node_modules/openclaw");
    const bin = build(directory);
    expect(describeExecutingBuild({ installDir: root })).toEqual({
      source: "installed", packageDir: directory, bin, version: "2026.9.5", buildId: "2026.9.5",
    });
  });

  it("preserves the logical path through a symlinked installation root", () => {
    const actual = path.join(root, "actual");
    fs.mkdirSync(actual);
    const logical = path.join(root, "logical");
    fs.symlinkSync(actual, logical);
    const directory = path.join(logical, "node_modules/openclaw");
    const bin = build(directory);
    expect(describeExecutingBuild({ installDir: logical })).toEqual({
      source: "installed", packageDir: directory, bin, version: "2026.9.5", buildId: "2026.9.5",
    });
  });

  it.each([
    ["no install dir", () => null],
    ["no package", () => root],
    ["unparseable package.json", () => { write(path.join(root, "node_modules/openclaw/package.json"), "invalid"); return root; }],
    ["blank version", () => { build(path.join(root, "node_modules/openclaw"), { version: " ", bin: "openclaw.mjs" }); return root; }],
    ["missing bin file", () => { build(path.join(root, "node_modules/openclaw")); fs.rmSync(path.join(root, "node_modules/openclaw/openclaw.mjs")); return root; }],
    ["bin escaping the package", () => { build(path.join(root, "node_modules/openclaw"), { version: "2026.9.5", bin: "../escape.mjs" }); write(path.join(root, "node_modules/escape.mjs"), ""); return root; }],
  ])("returns null for %s", (_label, arrange) => {
    expect(describeExecutingBuild({ installDir: arrange() })).toBeNull();
  });

  it("resolves the openclaw entry of an object-form bin and refuses escapes", () => {
    const directory = path.join(root, "pkg");
    write(path.join(directory, "package.json"), JSON.stringify({ bin: { other: "other.mjs", openclaw: "openclaw.mjs" } }));
    expect(resolvePackageBin(directory)).toBe(path.join(directory, "openclaw.mjs"));
    write(path.join(directory, "package.json"), JSON.stringify({ bin: { other: "other.mjs" } }));
    expect(resolvePackageBin(directory)).toBe(path.join(directory, "other.mjs"));
    write(path.join(directory, "package.json"), JSON.stringify({ bin: "../outside.mjs" }));
    expect(resolvePackageBin(directory)).toBeNull();
  });

  it("preserves filesystem injection and bounds package bytes", () => {
    const directory = path.join(root, "node_modules/openclaw");
    build(directory);
    const fsModule = { ...fs, openSync: vi.fn((...args) => fs.openSync(...args)), readFileSync: () => { throw new Error("Unbounded reader called"); } };
    expect(describeExecutingBuild({ installDir: root, fsModule })).toMatchObject({ source: "installed" });
    expect(fsModule.openSync).toHaveBeenCalledWith(path.join(directory, "package.json"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    write(path.join(directory, "package.json"), " ".repeat(1024 * 1024 + 1));
    expect(describeExecutingBuild({ installDir: root, fsModule })).toBeNull();
  });

  it("refuses a real package.json FIFO without blocking", () => {
    const directory = path.join(root, "node_modules/openclaw");
    build(directory);
    const file = path.join(directory, "package.json");
    fs.unlinkSync(file);
    execFileSync("mkfifo", [file]);
    const script = `
      const { describeExecutingBuild } = require(process.argv[1]);
      process.stdout.write(JSON.stringify(describeExecutingBuild({ installDir: process.argv[2] })));
    `;
    expect(JSON.parse(execFileSync(process.execPath, ["-e", script, require.resolve("../../lib/server/openclaw-build"), root], { encoding: "utf8", timeout: 1500 }))).toBeNull();
    expect(fs.lstatSync(file).isFIFO()).toBe(true);
  });
});

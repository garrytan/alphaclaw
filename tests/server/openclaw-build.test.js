const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { describeExecutingBuild, readCheckoutBuildId } = require("../../lib/server/openclaw-build");

describe("bounded executing-build identity", () => {
  let root;
  const sha = "a".repeat(40);
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "executing-build-")); });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, data); };
  const build = (directory) => {
    write(path.join(directory, "package.json"), JSON.stringify({ version: "2026.9.5", bin: "openclaw.mjs" }));
    write(path.join(directory, "openclaw.mjs"), "");
    write(path.join(directory, ".git/HEAD"), sha);
    return path.join(directory, "openclaw.mjs");
  };
  const store = (target, overlayStoreDir = path.join(root, "overlays")) => ({
    readBinShimTarget: () => target,
    resolvePackageBin: (directory) => fs.existsSync(path.join(directory, "openclaw.mjs")) ? path.join(directory, "openclaw.mjs") : null,
    overlayStoreDir,
  });

  it.each(["detached", "loose", "packed", "commondir", "gitfile"])("preserves %s Git identities", (mode) => {
    const checkout = path.join(root, "checkout");
    build(checkout);
    if (["loose", "packed", "commondir"].includes(mode)) write(path.join(checkout, ".git/HEAD"), "ref: refs/heads/main\n");
    if (mode === "loose") write(path.join(checkout, ".git/refs/heads/main"), sha);
    if (mode === "packed") write(path.join(checkout, ".git/packed-refs"), `# pack-refs\n${sha} refs/heads/main\n`);
    if (mode === "commondir") {
      write(path.join(checkout, ".git/commondir"), "../common");
      write(path.join(checkout, "common/refs/heads/main"), sha);
    }
    if (mode === "gitfile") {
      fs.renameSync(path.join(checkout, ".git"), path.join(root, "git-dir"));
      write(path.join(checkout, ".git"), "gitdir: ../git-dir\n");
    }
    expect(readCheckoutBuildId(checkout)).toBe(sha);
  });

  it.each(["installed", "dev", "overlay"])("preserves %s selection through a symlinked installation root", (source) => {
    const actual = path.join(root, "actual");
    fs.mkdirSync(actual);
    const logical = path.join(root, "logical");
    fs.symlinkSync(actual, logical);
    const directory = source === "installed" ? path.join(logical, "node_modules/openclaw")
      : source === "dev" ? path.join(logical, "openclaw") : path.join(logical, "overlays/version/node_modules/openclaw");
    const bin = build(directory);
    const result = describeExecutingBuild({ installDir: logical, checkoutDir: path.join(logical, "openclaw"),
      store: store(source === "installed" ? null : bin, path.join(logical, "overlays")) });
    expect(result).toEqual({ source, packageDir: directory, bin, version: "2026.9.5", buildId: source === "dev" ? sha : "2026.9.5" });
  });

  it("preserves filesystem injection and bounds package bytes", () => {
    const directory = path.join(root, "node_modules/openclaw");
    build(directory);
    const fsModule = { ...fs, openSync: vi.fn((...args) => fs.openSync(...args)), readFileSync: () => { throw new Error("Unbounded reader called"); } };
    expect(describeExecutingBuild({ installDir: root, store: store(null), fsModule })).toMatchObject({ source: "installed" });
    expect(fsModule.openSync).toHaveBeenCalledWith(path.join(directory, "package.json"), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    write(path.join(directory, "package.json"), " ".repeat(1024 * 1024 + 1));
    expect(describeExecutingBuild({ installDir: root, store: store(null), fsModule })).toBeNull();
  });

  it.each(["package", "head", "commondir", "loose", "packed", "gitfile"])("refuses a real %s FIFO without falling back to a dormant installed producer", (mode) => {
    build(path.join(root, "node_modules/openclaw"));
    const checkout = path.join(root, "openclaw");
    const bin = build(checkout);
    let file = path.join(checkout, mode === "package" ? "package.json" : ".git/HEAD");
    if (["commondir", "loose", "packed"].includes(mode)) {
      write(path.join(checkout, ".git/HEAD"), "ref: refs/heads/main\n");
      file = path.join(checkout, mode === "commondir" ? ".git/commondir" : mode === "loose" ? ".git/refs/heads/main" : ".git/packed-refs");
    }
    if (mode === "gitfile") { fs.rmSync(path.join(checkout, ".git"), { recursive: true }); file = path.join(checkout, ".git"); }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.unlinkSync(file);
    execFileSync("mkfifo", [file]);
    const script = `
      const path = require('path');
      const { describeExecutingBuild } = require(process.argv[1]);
      const root = process.argv[2];
      const bin = process.argv[3];
      process.stdout.write(JSON.stringify(describeExecutingBuild({ installDir: root, checkoutDir: path.join(root, 'openclaw'),
        store: { readBinShimTarget: () => bin, resolvePackageBin: (directory) => path.join(directory, 'openclaw.mjs') } })));
    `;
    expect(JSON.parse(execFileSync(process.execPath, ["-e", script, require.resolve("../../lib/server/openclaw-build"), root, bin], { encoding: "utf8", timeout: 1500 }))).toBeNull();
    expect(fs.lstatSync(file).isFIFO()).toBe(true);
  });

  it("does not substitute installed identity for an unreadable selected overlay", () => {
    build(path.join(root, "node_modules/openclaw"));
    const directory = path.join(root, "overlays/version/node_modules/openclaw");
    const bin = build(directory);
    write(path.join(directory, "package.json"), "invalid");
    expect(describeExecutingBuild({ installDir: root, store: store(bin) })).toBeNull();
    expect(describeExecutingBuild({ installDir: root, store: store(path.join(root, "unverified/openclaw.mjs")) })).toBeNull();
  });

  it("requests strict shim reads and never substitutes installed identity for an unreadable shim", () => {
    build(path.join(root, "node_modules/openclaw"));
    const selectedStore = store(null);
    selectedStore.readBinShimTarget = vi.fn(({ strict } = {}) => {
      if (strict) throw Object.assign(new Error("Unsafe existing shim"), { code: "REGULAR_FILE_REQUIRED" });
      return null;
    });
    expect(describeExecutingBuild({ installDir: root, store: selectedStore })).toBeNull();
    expect(selectedStore.readBinShimTarget).toHaveBeenCalledExactlyOnceWith({ strict: true });
  });
});

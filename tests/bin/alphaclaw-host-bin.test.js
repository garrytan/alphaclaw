const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, execSync } = require("child_process");

// Where `alphaclaw start` puts the binaries it provides (git auth shim,
// systemctl shim, gog): /usr/local/bin for a root install, <root>/bin first on
// PATH otherwise. The preload records (and never performs) any write under
// /usr/local/bin or /etc, fakes a missing systemctl and gog, serves a local gog
// archive in place of the download, and can pretend to be root.
describe("bin/alphaclaw host bin directory", () => {
  const binPath = path.resolve(__dirname, "../../bin/alphaclaw.js");
  let tmpDir;
  let rootDir;
  let capturePath;
  let preloadPath;
  let gogArchive;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-host-bin-"));
    rootDir = path.join(tmpDir, "root");
    fs.mkdirSync(rootDir);
    capturePath = path.join(tmpDir, "captured.json");
    const gogSrc = path.join(tmpDir, "gog-src");
    fs.mkdirSync(gogSrc);
    fs.writeFileSync(path.join(gogSrc, "gog"), "#!/bin/sh\necho fake-gog\n", { mode: 0o755 });
    gogArchive = path.join(tmpDir, "gog.tar.gz");
    execFileSync("tar", ["-czf", gogArchive, "-C", gogSrc, "gog"]);
    preloadPath = path.join(tmpDir, "host-bin-preload.js");
    fs.writeFileSync(
      preloadPath,
      `
Object.defineProperty(process.versions, "node", { value: "24.22.1" });
const fs = require("fs");
const path = require("path");
const Module = require("module");
const childProcess = require("child_process");

if (process.env.ALPHACLAW_TEST_UID) process.getuid = () => Number(process.env.ALPHACLAW_TEST_UID);
const hostWrites = [];
const isHostPath = (target) => /^\\/(usr\\/local\\/bin|etc)\\//.test(String(target || ""));
for (const op of ["writeFileSync", "copyFileSync", "chmodSync", "unlinkSync", "renameSync", "symlinkSync"]) {
  const real = fs[op];
  fs[op] = function (...args) {
    const target = op === "copyFileSync" || op === "renameSync" || op === "symlinkSync" ? args[1] : args[0];
    if (isHostPath(target)) {
      hostWrites.push(op + " " + target);
      return undefined;
    }
    return real.apply(this, args);
  };
}
childProcess.execSync = (command) => {
  const cmd = String(command || "");
  if (cmd === "command -v systemctl" || cmd === "command -v gog") throw new Error("not installed");
  return "";
};
const realExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = (file, argv = [], options) => {
  if (file === "curl") {
    const outIndex = argv.indexOf("-o");
    if (outIndex === -1) throw new Error("no checksums in this test");
    fs.copyFileSync(process.env.ALPHACLAW_TEST_GOG_ARCHIVE, argv[outIndex + 1]);
    return "";
  }
  return realExecFileSync(file, argv, options);
};
const realLoad = Module._load;
Module._load = function patchedLoad(request, parent) {
  const parentFile = String(parent && parent.filename ? parent.filename : "");
  if (String(request || "").endsWith("lib/server.js") && parentFile.endsWith(path.join("bin", "alphaclaw.js"))) {
    fs.writeFileSync(process.env.ALPHACLAW_CAPTURE_ENV_PATH, JSON.stringify({ PATH: process.env.PATH, hostWrites }));
    return {};
  }
  return realLoad.apply(this, arguments);
};
`,
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const boot = ({ uid, gitShimPath } = {}) => {
    const env = {
      ...process.env,
      SETUP_PASSWORD: "test-password",
      ALPHACLAW_ROOT_DIR: rootDir,
      HOME: rootDir,
      XDG_CONFIG_HOME: path.join(rootDir, ".config"),
      ALPHACLAW_OPENCLAW_WRAPPER_PATH: path.join(tmpDir, "wrapper-openclaw.sh"),
      ALPHACLAW_PROFILE_SNIPPET_PATH: path.join(tmpDir, "profile-openclaw.sh"),
      ALPHACLAW_SKIP_SYSTEM_CRON_INSTALL: "true",
      ALPHACLAW_CAPTURE_ENV_PATH: capturePath,
      ALPHACLAW_TEST_GOG_ARCHIVE: gogArchive,
      NODE_OPTIONS: `--require=${preloadPath}`,
    };
    delete env.ALPHACLAW_GIT_SHIM_PATH;
    delete env.PORT;
    delete env.GITHUB_WORKSPACE_REPO;
    if (uid !== undefined) env.ALPHACLAW_TEST_UID = String(uid);
    if (gitShimPath) env.ALPHACLAW_GIT_SHIM_PATH = gitShimPath;
    const output = execSync(`node "${binPath}" start`, { stdio: "pipe", encoding: "utf8", env });
    return { output, captured: JSON.parse(fs.readFileSync(capturePath, "utf8")) };
  };
  const pathEntries = (captured) => captured.PATH.split(path.delimiter);
  const kManagedPathLine = () => `export PATH='${path.join(rootDir, "bin")}':"$PATH"`;

  it("non-root: installs the git shim, systemctl shim and gog under <root>/bin, first on PATH, and touches no host path", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const { captured, output } = boot();
    const managedBin = path.join(rootDir, "bin");

    expect(captured.hostWrites).toEqual([]);
    expect(pathEntries(captured)[0]).toBe(managedBin);
    expect(fs.readFileSync(path.join(managedBin, "git"), "utf8")).toContain("# Git auth shim");
    expect(fs.readFileSync(path.join(managedBin, "systemctl"), "utf8")).toContain("systemctl shim");
    expect(fs.readFileSync(path.join(managedBin, "gog"), "utf8")).toContain("fake-gog");
    expect(fs.statSync(path.join(managedBin, "gog")).mode & 0o111).not.toBe(0);
    expect(output).toContain(`AlphaClaw's git shim, systemctl shim and gog live in ${managedBin}`);
    expect(fs.readFileSync(path.join(tmpDir, "wrapper-openclaw.sh"), "utf8")).toContain(kManagedPathLine());
    expect(fs.readFileSync(path.join(tmpDir, "profile-openclaw.sh"), "utf8")).toContain(kManagedPathLine());
  });

  it("root: keeps /usr/local/bin for all three and leaves PATH and the operator-shell env as before", () => {
    const { captured } = boot({ uid: 0 });

    expect(captured.hostWrites).toEqual(expect.arrayContaining([
      "writeFileSync /usr/local/bin/git",
      "copyFileSync /usr/local/bin/systemctl",
      "copyFileSync /usr/local/bin/gog",
    ]));
    expect(fs.existsSync(path.join(rootDir, "bin"))).toBe(false);
    expect(pathEntries(captured)).not.toContain(path.join(rootDir, "bin"));
    expect(fs.readFileSync(path.join(tmpDir, "wrapper-openclaw.sh"), "utf8")).not.toContain("export PATH=");
    expect(fs.readFileSync(path.join(tmpDir, "profile-openclaw.sh"), "utf8")).not.toContain("export PATH=");
  });

  it("override: ALPHACLAW_GIT_SHIM_PATH still decides the git shim; systemctl and gog follow the uid", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const customShim = path.join(tmpDir, "custom", "git");
    const { captured } = boot({ gitShimPath: customShim });
    const managedBin = path.join(rootDir, "bin");

    expect(captured.hostWrites).toEqual([]);
    expect(fs.readFileSync(customShim, "utf8")).toContain("# Git auth shim");
    expect(fs.existsSync(path.join(managedBin, "git"))).toBe(false);
    expect(pathEntries(captured).slice(0, 2)).toEqual([path.dirname(customShim), managedBin]);
    expect(fs.existsSync(path.join(managedBin, "systemctl"))).toBe(true);
    expect(fs.existsSync(path.join(managedBin, "gog"))).toBe(true);
  });

  it("override as root: the git shim goes to the override, systemctl and gog to /usr/local/bin", () => {
    const customShim = path.join(tmpDir, "custom", "git");
    const { captured } = boot({ uid: 0, gitShimPath: customShim });

    expect(fs.readFileSync(customShim, "utf8")).toContain("# Git auth shim");
    expect(captured.hostWrites).not.toContain("writeFileSync /usr/local/bin/git");
    expect(captured.hostWrites).toEqual(expect.arrayContaining([
      "copyFileSync /usr/local/bin/systemctl",
      "copyFileSync /usr/local/bin/gog",
    ]));
    expect(fs.existsSync(path.join(rootDir, "bin"))).toBe(false);
  });
});

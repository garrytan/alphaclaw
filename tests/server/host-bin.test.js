const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  kSystemBinDir,
  isRootProcess,
  resolveHostBinDir,
  prependPathDir,
  removeStaleSystemGitShim,
} = require("../../lib/cli/host-bin");
const { resolveGitShimPath } = require("../../lib/cli/git-runtime");

describe("lib/cli/host-bin", () => {
  it("treats uid 0, and a platform without getuid, as root", () => {
    expect(isRootProcess({ getuid: () => 0 })).toBe(true);
    expect(isRootProcess({ getuid: null })).toBe(true);
    expect(isRootProcess({ getuid: () => 1001 })).toBe(false);
  });

  it("resolves /usr/local/bin for root and <root>/bin otherwise", () => {
    expect(resolveHostBinDir({ rootDir: "/srv/claw", isRoot: true })).toBe(kSystemBinDir);
    expect(resolveHostBinDir({ rootDir: "/srv/claw", isRoot: false })).toBe("/srv/claw/bin");
  });

  it("puts the directory first on PATH exactly once", () => {
    expect(prependPathDir("/srv/claw/bin", "/usr/bin:/srv/claw/bin:/bin")).toBe("/srv/claw/bin:/usr/bin:/bin");
    expect(prependPathDir("/srv/claw/bin", "")).toBe("/srv/claw/bin");
  });

  it("derives the default git shim path from the bin directory; the override wins", () => {
    expect(resolveGitShimPath({ env: {} })).toBe("/usr/local/bin/git");
    expect(resolveGitShimPath({ env: {}, binDir: "/srv/claw/bin" })).toBe("/srv/claw/bin/git");
    expect(resolveGitShimPath({ env: { ALPHACLAW_GIT_SHIM_PATH: "/x/git" }, binDir: "/srv/claw/bin" })).toBe("/x/git");
  });

  describe("removeStaleSystemGitShim", () => {
    let dir;
    let shimPath;
    const template = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "scripts", "git"), "utf8");
    const shimFor = (repoRoot) => template.replace("@@OPENCLAW_REPO_ROOT@@", repoRoot);

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "host-bin-"));
      shimPath = path.join(dir, "git");
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it("removes this install's shim", () => {
      fs.writeFileSync(shimPath, shimFor("/srv/claw/.openclaw"), { mode: 0o755 });
      expect(removeStaleSystemGitShim({ shimPath, openclawDir: "/srv/claw/.openclaw" })).toBe(true);
      expect(fs.existsSync(shimPath)).toBe(false);
    });

    it("keeps another install's shim, a prefix-matching root, a non-shim file, a symlink and a missing path", () => {
      fs.writeFileSync(shimPath, shimFor("/srv/other/.openclaw"));
      expect(removeStaleSystemGitShim({ shimPath, openclawDir: "/srv/claw/.openclaw" })).toBe(false);
      fs.writeFileSync(shimPath, shimFor("/srv/claw/.openclaw-old"));
      expect(removeStaleSystemGitShim({ shimPath, openclawDir: "/srv/claw/.openclaw" })).toBe(false);
      fs.writeFileSync(shimPath, `#!/bin/sh\nOPENCLAW_REPO_ROOT="/srv/claw/.openclaw"\nexec /usr/bin/git "$@"\n`);
      expect(removeStaleSystemGitShim({ shimPath, openclawDir: "/srv/claw/.openclaw" })).toBe(false);
      expect(fs.existsSync(shimPath)).toBe(true);
      fs.rmSync(shimPath);
      const target = path.join(dir, "target");
      fs.writeFileSync(target, shimFor("/srv/claw/.openclaw"));
      fs.symlinkSync(target, shimPath);
      expect(removeStaleSystemGitShim({ shimPath, openclawDir: "/srv/claw/.openclaw" })).toBe(false);
      expect(fs.existsSync(target)).toBe(true);
      fs.rmSync(shimPath);
      expect(removeStaleSystemGitShim({ shimPath, openclawDir: "/srv/claw/.openclaw" })).toBe(false);
    });
  });
});

// Identity of the executable selected by AlphaClaw, independent of the
// channel selection and of the dormant npm fallback under a dev checkout.
const fs = require("fs");
const path = require("path");

const kFullGitSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const readCheckoutBuildId = (checkoutDir, { fsModule = fs } = {}) => {
  try {
    let gitDir = path.join(checkoutDir, ".git");
    if (fsModule.statSync(gitDir).isFile()) {
      const match = fsModule.readFileSync(gitDir, "utf8").trim().match(/^gitdir: (.+)$/);
      if (!match) return null;
      gitDir = path.resolve(checkoutDir, match[1]);
    }
    const head = fsModule.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
    if (kFullGitSha.test(head)) return head.toLowerCase();
    const ref = head.match(/^ref: (refs\/[A-Za-z0-9_./-]+)$/)?.[1];
    if (!ref || ref.split("/").includes("..")) return null;
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, fsModule.readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
    } catch {}
    for (const directory of new Set([gitDir, commonDir])) {
      try {
        const sha = fsModule.readFileSync(path.join(directory, ref), "utf8").trim();
        if (kFullGitSha.test(sha)) return sha.toLowerCase();
      } catch {}
      try {
        for (const line of fsModule.readFileSync(path.join(directory, "packed-refs"), "utf8").split("\n")) {
          const [sha, name] = line.trim().split(/\s+/);
          if (name === ref && kFullGitSha.test(sha)) return sha.toLowerCase();
        }
      } catch {}
    }
  } catch {}
  return null;
};

const describeExecutingBuild = ({ installDir, checkoutDir, store, fsModule = fs, readHead = readCheckoutBuildId }) => {
  const describe = (packageDir, source, buildId = null) => {
    try {
      const pkg = JSON.parse(fsModule.readFileSync(path.join(packageDir, "package.json"), "utf8"));
      const version = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
      const bin = store.resolvePackageBin(packageDir);
      if (!version || !bin || !fsModule.existsSync(bin)) return null;
      return { bin, packageDir, version, buildId: buildId || version, source };
    } catch {
      return null;
    }
  };
  const target = store.readBinShimTarget?.();
  if (target && checkoutDir) {
    const sha = readHead(checkoutDir, { fsModule });
    const dev = sha && describe(checkoutDir, "dev", sha);
    // A selection alone never establishes execution: the trusted shim must
    // name this checkout's own package entrypoint.
    if (dev && path.resolve(target) === path.resolve(dev.bin)) return dev;
  }
  if (target && store.overlayStoreDir) {
    const root = path.resolve(store.overlayStoreDir) + path.sep;
    let directory = path.dirname(path.resolve(target));
    for (let depth = 0; depth < 8 && directory.startsWith(root); depth += 1) {
      const overlay = describe(directory, "overlay");
      if (overlay && path.resolve(overlay.bin) === path.resolve(target)) return overlay;
      directory = path.dirname(directory);
    }
  }
  return installDir ? describe(path.join(installDir, "node_modules", "openclaw"), "installed") : null;
};

module.exports = { describeExecutingBuild, readCheckoutBuildId };

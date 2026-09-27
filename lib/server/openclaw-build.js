// Identity of the executable selected by AlphaClaw, independent of the
// channel selection and of the dormant npm fallback under a dev checkout.
const fs = require("fs");
const path = require("path");
const { resolveDevCheckoutForBin } = require("./openclaw-dev-candidates");
const { readRegularFileBounded } = require("./utils/bounded-file");

const kFullGitSha = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i;
const readCheckoutBuildId = (checkoutDir, { fsModule = fs } = {}) => {
  try {
    let gitDir = path.join(checkoutDir, ".git");
    if (fsModule.statSync(gitDir).isFile()) {
      const match = readRegularFileBounded(gitDir, { fsModule, maxBytes: 4096 }).trim().match(/^gitdir: (.+)$/);
      if (!match) return null;
      gitDir = path.resolve(checkoutDir, match[1]);
    }
    const head = readRegularFileBounded(path.join(gitDir, "HEAD"), { fsModule, maxBytes: 4096 }).trim();
    if (kFullGitSha.test(head)) return head.toLowerCase();
    const ref = head.match(/^ref: (refs\/[A-Za-z0-9_./-]+)$/)?.[1];
    if (!ref || ref.split("/").includes("..")) return null;
    let commonDir = gitDir;
    try {
      commonDir = path.resolve(gitDir, readRegularFileBounded(path.join(gitDir, "commondir"), { fsModule, maxBytes: 4096 }).trim());
    } catch (error) { if (error.code !== "ENOENT") return null; }
    for (const directory of new Set([gitDir, commonDir])) {
      try {
        const sha = readRegularFileBounded(path.join(directory, ref), { fsModule, maxBytes: 4096 }).trim();
        return kFullGitSha.test(sha) ? sha.toLowerCase() : null;
      } catch (error) { if (error.code !== "ENOENT") return null; }
      try {
        for (const line of readRegularFileBounded(path.join(directory, "packed-refs"), { fsModule }).split("\n")) {
          const [sha, name] = line.trim().split(/\s+/);
          if (name === ref && kFullGitSha.test(sha)) return sha.toLowerCase();
        }
      } catch (error) { if (error.code !== "ENOENT") return null; }
    }
  } catch {}
  return null;
};

const describeExecutingBuild = ({ installDir, checkoutDir, store, fsModule = fs, readHead = readCheckoutBuildId }) => {
  const describe = (packageDir, source, buildId = null) => {
    try {
      const pkg = JSON.parse(readRegularFileBounded(path.join(packageDir, "package.json"), { fsModule }));
      const version = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
      const bin = store.resolvePackageBin(packageDir);
      if (!version || !bin || !fsModule.existsSync(bin)) return null;
      return { bin, packageDir, version, buildId: buildId || version, source };
    } catch {
      return null;
    }
  };
  let target;
  try { target = store.readBinShimTarget?.({ strict: true }); }
  catch { return null; }
  if (target && checkoutDir) {
    const selected = resolveDevCheckoutForBin({ checkoutDir, targetBin: target, fsModule });
    const sha = selected && readHead(selected, { fsModule });
    const dev = sha && describe(selected, "dev", sha);
    // A selection alone never establishes execution: the trusted shim must
    // name this checkout's own package entrypoint.
    if (selected) return dev && path.resolve(target) === path.resolve(dev.bin) ? dev : null;
  }
  if (target && store.overlayStoreDir) {
    const root = path.resolve(store.overlayStoreDir) + path.sep;
    let directory = path.dirname(path.resolve(target));
    for (let depth = 0; depth < 8 && directory.startsWith(root); depth += 1) {
      const overlay = describe(directory, "overlay");
      if (overlay && path.resolve(overlay.bin) === path.resolve(target)) return overlay;
      directory = path.dirname(directory);
    }
    if (path.resolve(target).startsWith(root)) return null;
  }
  const installed = installDir ? describe(path.join(installDir, "node_modules", "openclaw"), "installed") : null;
  return installed && (!target || path.resolve(target) === path.resolve(installed.bin)) ? installed : null;
};

module.exports = { describeExecutingBuild, readCheckoutBuildId };

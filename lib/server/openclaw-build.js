// Identity of the OpenClaw build AlphaClaw executes: always the pinned
// package installed beside AlphaClaw (<installDir>/node_modules/openclaw).
const fs = require("fs");
const path = require("path");
const { readRegularFileBounded } = require("./utils/bounded-file");

const kOpenclawPackageName = "openclaw";

// The package's own bin entry, which must stay inside the package ("../"
// escapes resolve to nothing).
const resolvePackageBin = (packageDir, { fsModule = fs } = {}) => {
  try {
    const pkg = JSON.parse(readRegularFileBounded(path.join(packageDir, "package.json"), { fsModule }));
    const bin = pkg?.bin;
    const relative = typeof bin === "string"
      ? bin
      : bin && typeof bin === "object" && !Array.isArray(bin)
        ? typeof bin[kOpenclawPackageName] === "string"
          ? bin[kOpenclawPackageName]
          : Object.values(bin).find((value) => typeof value === "string") ?? null
        : null;
    if (!relative) return null;
    const resolved = path.resolve(packageDir, relative);
    return resolved.startsWith(path.resolve(packageDir) + path.sep) ? resolved : null;
  } catch {
    return null;
  }
};

// { bin, packageDir, version, buildId, source: "installed" } | null
const describeExecutingBuild = ({ installDir, fsModule = fs } = {}) => {
  if (!installDir) return null;
  const packageDir = path.join(installDir, "node_modules", kOpenclawPackageName);
  try {
    const pkg = JSON.parse(readRegularFileBounded(path.join(packageDir, "package.json"), { fsModule }));
    const version = typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : null;
    const bin = resolvePackageBin(packageDir, { fsModule });
    if (!version || !bin || !fsModule.existsSync(bin)) return null;
    return { bin, packageDir, version, buildId: version, source: "installed" };
  } catch {
    return null;
  }
};

module.exports = { describeExecutingBuild, resolvePackageBin };

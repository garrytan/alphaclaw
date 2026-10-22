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

// Every gateway launch and CLI call spawns "openclaw" through PATH. Docker
// images put /app/node_modules/.bin on PATH and npx adds the consumer's
// .bin, but "npm install -g alphaclaw" links only AlphaClaw's own bin, so the
// pinned openclaw (a nested dependency) is not on PATH at all and every
// launch fails with "spawn openclaw ENOENT". Put the pinned package's .bin
// first so the pin is what runs, whatever else is installed on the host.
const withPinnedOpenclawOnPath = ({ installDir, pathValue = "", fsModule = fs } = {}) => {
  if (!installDir) return pathValue;
  const binDir = path.join(installDir, "node_modules", ".bin");
  if (!fsModule.existsSync(path.join(binDir, kOpenclawPackageName))) return pathValue;
  const rest = String(pathValue || "").split(path.delimiter).filter((entry) => entry && entry !== binDir);
  return [binDir, ...rest].join(path.delimiter);
};

module.exports = { describeExecutingBuild, resolvePackageBin, withPinnedOpenclawOnPath };

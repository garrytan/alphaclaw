const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { describeExecutingBuild } = require("./openclaw-build");
const { resolveSelfDependency } = require("./self-dependency");

// Migrations run the same package as the gateway: the pinned install.
const resolveCodexMigrationBuild = () =>
  describeExecutingBuild({ installDir: resolveSelfDependency().installDir });

// Missing exports are an error; never borrow another build's implementation
// to fill the gap.
const loadOpenclawMigrationApi = async ({ build, prefix, functionNames }) => {
  if (!build?.packageDir) throw new Error("Executing OpenClaw build is unknown; refusing Codex migration");
  const distDir = path.join(build.packageDir, "dist");
  // Published 2026.9.3 switched ESM chunks from .js to .mjs. Both retain
  // the same function contract; source maps and other siblings are not code.
  const filenames = fs.readdirSync(distDir)
    .filter((name) => name.startsWith(`${prefix}-`) && /\.(?:mjs|js)$/.test(name));
  if (filenames.length === 0) {
    throw new Error(`OpenClaw ${build.buildId} migration module not found: ${prefix}`);
  }
  // A prefix can name dozens of chunks (2026.10.4 ships 70 `sqlite-*`).
  // Import only those whose source names a wanted function, and fall back to
  // every chunk when none does, so a renamed binding still resolves by name.
  const named = filenames.filter((filename) => {
    const source = fs.readFileSync(path.join(distDir, filename), "utf8");
    return functionNames.some((name) => source.includes(name));
  });
  const api = {};
  for (const filename of named.length > 0 ? named : filenames) {
    const url = pathToFileURL(path.join(distDir, filename));
    url.searchParams.set("build", build.buildId);
    const mod = await import(url.href);
    for (const candidate of Object.values(mod)) {
      if (typeof candidate !== "function") continue;
      if (functionNames.includes(candidate.name) && !api[candidate.name]) {
        api[candidate.name] = candidate;
      }
    }
  }
  const missing = functionNames.filter((name) => typeof api[name] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `OpenClaw ${build.buildId} migration exports not found for ${prefix}: ${missing.join(", ")}`,
    );
  }
  return api;
};

module.exports = { resolveCodexMigrationBuild, loadOpenclawMigrationApi };

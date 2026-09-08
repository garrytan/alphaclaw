const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { describeExecutingBuild } = require("./openclaw-build");
const { createOpenclawReleaseChannelStore } = require("./openclaw-release-channel");
const { resolveSelfDependency } = require("./self-dependency");

// The managed shim can select a dev checkout while require.resolve("openclaw")
// still finds the dormant npm pin. Migrations must use the same package as the
// gateway, including the normal installed fallback when that checkout is unusable.
const resolveCodexMigrationBuild = ({ configPath, env }) => {
  const openclawDir = env.OPENCLAW_STATE_DIR || path.dirname(configPath);
  const rootDir = env.ALPHACLAW_ROOT_DIR || path.dirname(openclawDir);
  return describeExecutingBuild({
    installDir: resolveSelfDependency().installDir,
    checkoutDir: env.OPENCLAW_GIT_DIR || path.join(rootDir, "openclaw"),
    store: createOpenclawReleaseChannelStore({ rootDir, openclawDir }),
  });
};

// `optionalFunctionNames` are repairs upstream retired after their inputs
// stopped surviving the SQLite migration. Missing required exports remain an
// error; never borrow another build's implementation to fill the gap.
const loadOpenclawMigrationApi = async ({
  build,
  prefix,
  functionNames,
  optionalFunctionNames = [],
}) => {
  if (!build?.packageDir) throw new Error("Executing OpenClaw build is unknown; refusing Codex migration");
  const distDir = path.join(build.packageDir, "dist");
  // Published 2026.9.3 switched ESM chunks from .js to .mjs. Both retain
  // the same function contract; source maps and other siblings are not code.
  const filenames = fs.readdirSync(distDir)
    .filter((name) => name.startsWith(`${prefix}-`) && /\.(?:mjs|js)$/.test(name));
  if (filenames.length === 0) {
    throw new Error(`OpenClaw ${build.buildId} migration module not found: ${prefix}`);
  }
  const api = {};
  const wanted = [...functionNames, ...optionalFunctionNames];
  for (const filename of filenames) {
    const url = pathToFileURL(path.join(distDir, filename));
    url.searchParams.set("build", build.buildId);
    const mod = await import(url.href);
    for (const candidate of Object.values(mod)) {
      if (typeof candidate !== "function") continue;
      if (wanted.includes(candidate.name) && !api[candidate.name]) {
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

const fs = require("fs");
const path = require("path");
const { kNpmPackageRoot } = require("./constants");

// AlphaClaw may be consumed under different dependency keys: the published npm
// scope (`@chrysb/alphaclaw`) or a plain alias used by git-based deployments
// (`alphaclaw`, e.g. `"alphaclaw": "git+https://github.com/<owner>/alphaclaw.git#main"`).
// Check the alias first so git deployments resolve correctly.
const kSelfDependencyKeys = ["alphaclaw", "@chrysb/alphaclaw"];

// A dependency spec points at a git source (rather than an npm version/range)
// when it uses a git protocol/shorthand or otherwise references a git host.
const looksLikeGitDependency = (spec) => {
  const value = String(spec || "").trim();
  if (!value) return false;
  return (
    /^(git\+|github:|gitlab:|bitbucket:|gist:|git:|git@|ssh:)/i.test(value) ||
    /\.git($|#)/i.test(value) ||
    /github\.com/i.test(value)
  );
};

const readDependencySpec = (pkg, key) =>
  pkg?.dependencies?.[key] ||
  pkg?.devDependencies?.[key] ||
  pkg?.optionalDependencies?.[key] ||
  null;

// Find the consumer app root (e.g. /app in Docker) — the nearest ancestor
// package.json that declares AlphaClaw as a dependency — and report how it is
// pinned. Falls back to the AlphaClaw package root with no dependency info.
const resolveSelfDependency = ({ fsImpl = fs, startDir = kNpmPackageRoot } = {}) => {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    const parent = path.dirname(dir);
    if (
      path.basename(parent) === "node_modules" ||
      parent.includes(`${path.sep}node_modules${path.sep}`)
    ) {
      dir = parent;
      continue;
    }
    const pkgPath = path.join(parent, "package.json");
    if (fsImpl.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fsImpl.readFileSync(pkgPath, "utf8"));
        for (const key of kSelfDependencyKeys) {
          const spec = readDependencySpec(pkg, key);
          if (spec) {
            return {
              installDir: parent,
              key,
              spec,
              isGit: looksLikeGitDependency(spec),
            };
          }
        }
      } catch {}
    }
    dir = parent;
  }
  return { installDir: kNpmPackageRoot, key: null, spec: null, isGit: false };
};

// Resolve just the install dir (consumer app root) — preserves the prior
// findInstallDir() contract used by the OpenClaw/AlphaClaw self-updaters.
const findInstallDir = (fsImpl = fs) =>
  resolveSelfDependency({ fsImpl }).installDir;

module.exports = {
  kSelfDependencyKeys,
  looksLikeGitDependency,
  resolveSelfDependency,
  findInstallDir,
};

// Matches v2026.9.3's isPersistentOpenClawAgentDatabasePath boundary without
// importing its runtime (which registers databases and may migrate schemas).
// Both the lexical imports tree and aliases into its canonical target are
// offline import artifacts. This filter applies to registry-only discovery;
// explicit configured/direct migration inputs remain independently required.
const fs = require("fs");
const path = require("path");
const within = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

const canonicalBoundary = (file, fsModule) => {
  try { return fsModule.realpathSync(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  // Resolve links before '..', including links whose targets do not exist
  // yet. Joining a dangling target first would incorrectly normalize away
  // a symlink's parent traversal. This follows the pinned registry boundary.
  let current = path.parse(file).root;
  const remaining = file.slice(current.length).split(path.sep).filter(Boolean);
  let hops = 0;
  while (remaining.length) {
    const segment = remaining.shift();
    if (!segment || segment === ".") continue;
    if (segment === "..") { current = path.dirname(current); continue; }
    const candidate = path.join(current, segment);
    let stat;
    try { stat = fsModule.lstatSync(candidate); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = fsModule.realpathSync(current);
      // Upstream intentionally stops at the known parent when a missing
      // suffix contains traversal; absence cannot establish its later path.
      return remaining.includes("..") ? parent : path.join(parent, segment, ...remaining);
    }
    if (!stat.isSymbolicLink()) { current = candidate; continue; }
    if (++hops > 64) throw Object.assign(new Error("registry path contains a symlink cycle"), { code: "ELOOP" });
    const target = fsModule.readlinkSync(candidate);
    if (path.isAbsolute(target)) {
      current = path.parse(target).root;
      remaining.unshift(...target.slice(current.length).split(path.sep));
    } else remaining.unshift(...target.split(path.sep));
  }
  return fsModule.realpathSync(current);
};

const isRegistryImportArtifact = ({ file, stateDir, fsModule = fs }) => {
  const root = path.resolve(stateDir);
  const candidate = path.resolve(file);
  if (within(candidate, path.join(root, "imports"))) return true;
  const canonicalState = canonicalBoundary(root, fsModule);
  const canonicalImports = canonicalBoundary(path.join(canonicalState, "imports"), fsModule);
  return within(canonicalBoundary(candidate, fsModule), canonicalImports);
};

module.exports = { isRegistryImportArtifact };

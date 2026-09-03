const fs = require("fs");
const path = require("path");
const { resolveContainedPath } = require("../../utils/safe-path");

const normalizeRelativePath = (inputPath) => {
  const rawPath = String(inputPath || "").trim();
  if (!rawPath) return "";
  return rawPath.replace(/\\/g, "/").replace(/^\/+/, "");
};

const normalizePolicyPath = (inputPath) =>
  String(inputPath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .trim()
    .toLowerCase();

// Symlink-safe: after the lexical check, canonicalize (realpath) and re-check
// containment on the canonical path. The returned absolutePath/relativePath
// are canonical — callers must operate on them (not the request path), so a
// symlink inside the root cannot smuggle an fs op outside it, and locked-path
// policy checks see the real target.
const resolveSafePath = (
  inputPath,
  kRootResolved,
  kRootWithSep,
  kRootDisplayName,
  { fsModule = fs } = {},
) => {
  const relativePath = normalizeRelativePath(inputPath);
  const absolutePath = path.resolve(kRootResolved, relativePath);
  const isInsideRoot =
    absolutePath === kRootResolved || absolutePath.startsWith(kRootWithSep);
  if (!isInsideRoot) {
    return { ok: false, error: `Path must stay within ${kRootDisplayName}` };
  }
  const contained = resolveContainedPath(absolutePath, kRootResolved, {
    fsModule,
  });
  if (!contained.ok) {
    return { ok: false, error: `Path must stay within ${kRootDisplayName}` };
  }
  return {
    ok: true,
    relativePath: toRelativePath(contained.absolutePath, contained.rootPath),
    absolutePath: contained.absolutePath,
  };
};

const toRelativePath = (absolutePath, kRootResolved) => {
  const relative = path.relative(kRootResolved, absolutePath);
  return relative === "" ? "" : relative.split(path.sep).join("/");
};

const matchesPolicyPath = (policyPathSet, normalizedPath) => {
  const safeNormalizedPath = String(normalizedPath || "").trim();
  if (!safeNormalizedPath) return false;
  for (const policyPath of policyPathSet) {
    if (
      safeNormalizedPath === policyPath ||
      safeNormalizedPath.endsWith(`/${policyPath}`) ||
      safeNormalizedPath.startsWith(`${policyPath}/`) ||
      safeNormalizedPath.includes(`/${policyPath}/`)
    ) {
      return true;
    }
  }
  return false;
};

module.exports = {
  normalizeRelativePath,
  normalizePolicyPath,
  resolveSafePath,
  toRelativePath,
  matchesPolicyPath,
};

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

// Ancestor-aware policy containment (fix wave F148). matchesPolicyPath only
// asks "is the target at or under a policy path?"; moving or deleting an
// ANCESTOR folder (skills, hooks/bootstrap, .alphaclaw) carried the locked or
// protected entries with it and bypassed every 403 (the .alphaclaw example
// self-revoked the agent-admin token). Two checks: lexical (a policy path
// starts with the target) and, for directories, an on-disk walk for any
// present entry that matches a policy path — bounded so a huge folder cannot
// stall the event loop (over the bound → treated as containing).
const kPolicyWalkEntryBudget = 20_000;

const containsPolicyPath = (policyPathSet, normalizedPath) => {
  const target = String(normalizedPath || "").trim();
  if (!target) return false;
  if (matchesPolicyPath(policyPathSet, target)) return true;
  for (const policyPath of policyPathSet) {
    if (policyPath === target || policyPath.startsWith(`${target}/`)) return true;
  }
  return false;
};

const directoryContainsPolicyPath = ({
  fsModule = fs,
  absoluteDir,
  rootResolved,
  policyPathSets,
}) => {
  const stack = [absoluteDir];
  let budget = kPolicyWalkEntryBudget;
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fsModule.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if ((budget -= 1) <= 0) return { contains: true, reason: "too_large_to_verify" };
      const absoluteEntry = path.join(dir, entry.name);
      const relative = normalizePolicyPath(toRelativePath(absoluteEntry, rootResolved));
      for (const policyPathSet of policyPathSets) {
        if (matchesPolicyPath(policyPathSet, relative)) {
          return { contains: true, reason: "contains_policy_path", entry: relative };
        }
      }
      if (entry.isDirectory()) stack.push(absoluteEntry);
    }
  }
  return { contains: false };
};

module.exports = {
  normalizeRelativePath,
  normalizePolicyPath,
  resolveSafePath,
  toRelativePath,
  matchesPolicyPath,
  containsPolicyPath,
  directoryContainsPolicyPath,
};

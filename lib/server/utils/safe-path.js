const fs = require("fs");
const path = require("path");

// Symlink-safe containment. A lexical check (path.resolve + startsWith) stops
// `..` but not a symlink inside the root that points out of it: the canonical
// (realpath) target is what the fs will actually touch, so containment must be
// re-checked there — and callers must operate on the RETURNED canonical path,
// or a later write would re-follow the very symlink the check cleared.
//
// Residual (accepted): a symlink swapped into the final component between this
// check and the caller's fs operation is a local-process TOCTOU; closing it
// needs O_NOFOLLOW/fd-based ops.

// lstat-existence: a dangling symlink counts as existing, so it is never
// treated as a missing tail segment (realpathSync then throws on it and the
// caller fails closed, instead of a write following it out of the root).
const existsNoFollow = (fsModule, targetPath) => {
  try {
    fsModule.lstatSync(targetPath);
    return true;
  } catch {
    return false;
  }
};

// Canonicalize a path that may not exist yet (write/move targets): realpath
// the nearest existing ancestor, then re-append the missing tail verbatim.
// Throws (like realpathSync) when the existing base cannot be resolved.
const resolveCanonicalPath = (absolutePath, { fsModule = fs } = {}) => {
  let existingBase = absolutePath;
  const missingSegments = [];
  while (!existsNoFollow(fsModule, existingBase)) {
    const parentDir = path.dirname(existingBase);
    if (parentDir === existingBase) break;
    missingSegments.push(path.basename(existingBase));
    existingBase = parentDir;
  }
  const realBase = fsModule.realpathSync(existingBase);
  return missingSegments.length
    ? path.join(realBase, ...missingSegments.reverse())
    : realBase;
};

const isPathInsideRoot = (candidatePath, rootPath) =>
  candidatePath === rootPath ||
  candidatePath.startsWith(`${rootPath}${path.sep}`);

// Canonicalize BOTH the candidate and the root (the root itself may sit behind
// a symlink, e.g. /tmp on macOS) and test containment on the canonical pair.
// Returns { ok:true, absolutePath, rootPath } — both canonical — or
// { ok:false }. Fails closed on any resolution error.
const resolveContainedPath = (absolutePath, rootDir, { fsModule = fs } = {}) => {
  try {
    const canonicalRoot = fsModule.realpathSync(path.resolve(rootDir));
    const canonicalPath = resolveCanonicalPath(absolutePath, { fsModule });
    if (!isPathInsideRoot(canonicalPath, canonicalRoot)) return { ok: false };
    return { ok: true, absolutePath: canonicalPath, rootPath: canonicalRoot };
  } catch {
    return { ok: false };
  }
};

module.exports = {
  resolveCanonicalPath,
  resolveContainedPath,
  isPathInsideRoot,
};

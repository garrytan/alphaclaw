const path = require("path");
const { resolveContainedPath } = require("../../utils/safe-path");

// Containment for imported (untrusted) relative paths — config `$include`
// values, `hooks.mappings[].transform.module`, secret file references. A
// crafted `../../../etc/...` (H2/H3) or a symlink inside the clone pointing
// out must never resolve to a read/move/write outside the import base.
//
// Lexical containment always runs (rejects `..` escapes even against an
// injected mock fs). Realpath containment additionally runs when the fs
// supports it, catching a symlink inside the clone that escapes the base.
// Returns the canonical absolute path, or "" when the entry must be skipped.
const resolveImportPathWithinBase = (baseDir, relativePath, fsModule) => {
  const relative = String(relativePath || "").trim();
  if (!relative || path.isAbsolute(relative)) return "";
  const resolvedBase = path.resolve(baseDir);
  const lexical = path.resolve(resolvedBase, relative);
  if (
    lexical !== resolvedBase &&
    !lexical.startsWith(`${resolvedBase}${path.sep}`)
  ) {
    return "";
  }
  if (
    fsModule &&
    typeof fsModule.realpathSync === "function" &&
    typeof fsModule.lstatSync === "function"
  ) {
    const contained = resolveContainedPath(lexical, resolvedBase, { fsModule });
    return contained.ok ? contained.absolutePath : "";
  }
  return lexical;
};

module.exports = { resolveImportPathWithinBase };

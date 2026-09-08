// Public package metadata is authoritative. Invalid metadata is distinct
// from absence: neither legacy chunks nor remembered declarations may repair
// a malformed declaration on behalf of the executing build.
const fs = require("fs");
const path = require("path");
const kMetadataReadBudget = 1024 * 1024;

const parseSchemaMetadata = (raw) => {
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch {
    return { status: "invalid" };
  }
  if (!pkg?.openclaw || !Object.hasOwn(pkg.openclaw, "schemaVersions")) return { status: "absent" };
  const value = pkg.openclaw.schemaVersions;
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      !["state", "agent"].every((kind) => Number.isSafeInteger(value[kind]) && value[kind] >= 0)) {
    return { status: "invalid" };
  }
  return { status: "valid", state: value.state, agent: value.agent };
};

const metadataDeclaration = (metadata) => metadata.status === "absent" ? null : ({
  state: metadata.status === "valid" ? metadata.state : null,
  agent: metadata.status === "valid" ? metadata.agent : null,
  files: ["package.json"],
  source: "declared",
  metadata: metadata.status,
  ...(metadata.status === "invalid" ? { unknownKinds: ["state", "agent"] } : {}),
});

// Refresh public authority before using a memoized legacy declaration. The
// semantic status/values form the cache key; formatting-only package edits
// do not trigger another potentially 16-MB legacy dist scan.
const readSchemaMetadata = (packageDir, { fsModule = fs } = {}) => {
  const file = path.join(packageDir, "package.json");
  let fd;
  try {
    fd = fsModule.openSync(file, "r");
    const before = fsModule.fstatSync(fd);
    if (!before.isFile() || before.size > kMetadataReadBudget) return { status: "invalid" };
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fsModule.readSync(fd, buffer, length, buffer.length - length, length);
      if (!count) break;
      length += count;
    }
    const identity = (stat) => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
    if (length !== before.size || identity(before) !== identity(fsModule.fstatSync(fd)) ||
        identity(before) !== identity(fsModule.statSync(file))) return { status: "invalid" };
    return parseSchemaMetadata(buffer.subarray(0, length).toString("utf8"));
  } catch (error) {
    return { status: fd === undefined && error.code === "ENOENT" ? "absent" : "invalid" };
  } finally {
    if (fd !== undefined) { try { fsModule.closeSync(fd); } catch {} }
  }
};

module.exports = { parseSchemaMetadata, metadataDeclaration, readSchemaMetadata };

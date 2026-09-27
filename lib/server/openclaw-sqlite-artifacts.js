const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");

const kProducerContract = Object.freeze({
  version: "2026.9.5",
  sourceCommit: "ec9c1a13db8938e5a3eaa51fca2e981cde2395a9",
  integrity: "sha512-TCO/ImVLh5HkF4tdfo7iriIa7kT6iYkIr/jR5ZOkePGFGhUx5Oe7DE716Y1DzzG2teRAVDdCjgJDu1A24Yta7w==",
  files: Object.freeze({
    "dist/manager-vector-warning-Cqtw5AdB.mjs": "2221bc901be38886e0ff43440a72cfb0cf5f9caa55229b1b6c940461a5fc1455",
    "dist/extensions/memory-core/manager-runtime.js": "1cf9dd954b0ec80192e74a025927394bf6d829c73d517f7033ea5407d8f01d05",
  }),
  families: Object.freeze(["generation-lock", "generation-writer", "reindex-lock", "memory-reindex"]),
});
const kUuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const kLease = /^(.+\.sqlite)\.(generation-lock|generation-writer|reindex-lock)\.sqlite(?:-(wal|shm|journal))?$/i;
const kShadow = new RegExp(`^(.+\\.sqlite)\\.(backup|memory-reindex|tmp)-(${kUuid})(?:-(wal|shm|journal))?$`, "i");
const matchSqliteArtifact = (file) => {
  if (typeof file !== "string" || file.includes("\0")) return null;
  const name = path.basename(file);
  const lease = name.match(kLease);
  const shadow = name.match(kShadow);
  const match = lease || shadow;
  if (!match || match[0] !== name) return null;
  const sidecar = (lease ? match[3] : match[4])?.toLowerCase() || null;
  return { family: match[2].toLowerCase(), sidecar, databaseName: sidecar ? name.slice(0, -sidecar.length - 1) : name,
    reason: "openclaw_transient_sqlite_artifact" };
};

const qualifySqliteArtifacts = ({ executingBuild, fsModule = fs } = {}) => {
  const unsupported = { qualified: false, families: [], reason: "unsupported_transient_artifact_contract" };
  if (!executingBuild || executingBuild.version !== kProducerContract.version || !["installed", "overlay"].includes(executingBuild.source) || !executingBuild.packageDir) return unsupported;
  const root = path.resolve(executingBuild.packageDir);
  const identities = [];
  try {
    const read = (relative) => {
      let current = root;
      if (!fsModule.lstatSync(root).isDirectory() || fsModule.lstatSync(root).isSymbolicLink()) throw new Error("Unsupported package root");
      for (const part of relative.split("/")) {
        current = path.join(current, part);
        if (fsModule.lstatSync(current).isSymbolicLink()) throw new Error("Symlinked producer");
      }
      const fd = fsModule.openSync(current, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const before = fsModule.fstatSync(fd);
        if (!before.isFile() || before.nlink !== 1 || before.size > 1024 * 1024) throw new Error("Unsupported producer file");
        const buffer = Buffer.alloc(before.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = fsModule.readSync(fd, buffer, length, buffer.length - length, length);
          if (!count) break;
          length += count;
        }
        const after = fsModule.fstatSync(fd);
        const named = fsModule.lstatSync(current);
        if (length !== before.size || named.ino !== before.ino || named.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("Producer changed");
        identities.push({ path: current, dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs });
        return buffer.subarray(0, length);
      } finally { fsModule.closeSync(fd); }
    };
    if (JSON.parse(read("package.json")).version !== kProducerContract.version) return unsupported;
    for (const [file, hash] of Object.entries(kProducerContract.files)) {
      if (createHash("sha256").update(read(file)).digest("hex") !== hash) return unsupported;
    }
    return { qualified: true, families: [...kProducerContract.families], reason: "verified_openclaw_2026_9_5_producer", identities };
  } catch { return unsupported; }
};

const isSqliteArtifactContractCurrent = (contract, { fsModule = fs } = {}) => {
  if (!contract?.qualified || !contract.identities?.length) return false;
  try {
    return contract.identities.every((identity) => {
      const stat = fsModule.lstatSync(identity.path);
      return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1 && ["dev", "ino", "size", "mtimeMs", "ctimeMs"].every((key) => stat[key] === identity[key]);
    });
  } catch { return false; }
};

module.exports = { matchSqliteArtifact, qualifySqliteArtifacts, isSqliteArtifactContractCurrent, kProducerContract };

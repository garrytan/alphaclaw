const kRecoveryKinds = new Set(["config_only", "database_set", "forward_only"]);
const safePath = (value) => typeof value === "string" && value.length > 0 && value.length <= 4096 &&
  !value.startsWith("/") && !value.includes("\\") && !value.includes("\0") &&
  value.split("/").every((part) => part && part !== "." && part !== "..");

const hasDatabaseRecoveryCoverage = (recovery) => {
  if (recovery?.kind !== "database_set" || recovery.checkpoint?.verified !== true ||
      typeof recovery.checkpoint.file !== "string" || !recovery.checkpoint.file ||
      recovery.databases?.complete !== true || recovery.databases.verified !== true ||
      !/^[a-f0-9]{64}$/.test(recovery.databases.inventoryDigest || "")) return false;
  const { requiredPaths, entries } = recovery.databases;
  if (!Array.isArray(requiredPaths) || !requiredPaths.length || requiredPaths.length > 512 ||
      !requiredPaths.every(safePath) || new Set(requiredPaths).size !== requiredPaths.length ||
      !Array.isArray(entries) || entries.length !== requiredPaths.length) return false;
  const observed = new Set();
  for (const entry of entries) {
    if (!entry || !safePath(entry.path) || entry.verified !== true ||
        !["state", "agent"].includes(entry.dbKind) || observed.has(entry.path)) return false;
    observed.add(entry.path);
  }
  return requiredPaths.every((file) => observed.has(file));
};

const projectRecoverySummary = (recovery) => {
  if (!recovery || !kRecoveryKinds.has(recovery.kind)) return null;
  const checkpoint = recovery.checkpoint;
  const configAvailable = checkpoint?.verified === true && typeof checkpoint.file === "string" && Boolean(checkpoint.file);
  const databaseSetAvailable = hasDatabaseRecoveryCoverage(recovery);
  return {
    kind: recovery.kind,
    checkpoint: checkpoint && typeof checkpoint === "object" ? {
      id: typeof checkpoint.id === "string" ? checkpoint.id.slice(0, 128) : null,
      file: typeof checkpoint.file === "string" ? checkpoint.file : null,
      verified: configAvailable,
      fileCount: Number.isSafeInteger(checkpoint.fileCount) && checkpoint.fileCount >= 0 ? checkpoint.fileCount : null,
      bytes: Number.isSafeInteger(checkpoint.bytes) && checkpoint.bytes >= 0 ? checkpoint.bytes : null,
    } : null,
    databases: {
      complete: databaseSetAvailable,
      verified: databaseSetAvailable,
      count: Array.isArray(recovery.databases?.entries) ? Math.min(recovery.databases.entries.length, 512) : 0,
    },
    restore: { configAvailable, databaseSetAvailable },
  };
};

const migrationRecoveryFile = (run) => {
  if (run?.recovery) return hasDatabaseRecoveryCoverage(run.recovery) ? run.recovery.checkpoint.file : null;
  const backup = run?.backup;
  if (["config_only", "forward_only", "database_set"].includes(backup?.profile)) return null;
  return backup?.verified === true && typeof backup.file === "string" && backup.file.trim() ? backup.file : null;
};

module.exports = { hasDatabaseRecoveryCoverage, projectRecoverySummary, migrationRecoveryFile };

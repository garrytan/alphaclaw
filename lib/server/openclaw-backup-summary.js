// Archive coverage crosses the ledger, inventory, manual result and rollback
// boundaries. Keep one bounded projection so none silently claims full coverage.
const projectBackupSummary = (backup) => {
  if (!backup || typeof backup !== "object") return {};
  const result = {};
  if (["full", "migration-minimal"].includes(backup.profile)) result.profile = backup.profile;
  if (typeof backup.partial === "boolean") result.partial = backup.partial;
  if (Array.isArray(backup.partialReasons)) {
    result.partialReasons = backup.partialReasons.slice(0, 64)
      .filter((reason) => typeof reason === "string")
      .map((reason) => reason.replace(/[\x00-\x1f\x7f]/g, " ").trim().slice(0, 512)).filter(Boolean);
  }
  if (backup.coverage && typeof backup.coverage === "object") {
    const coverage = {};
    for (const key of ["migration", "core", "workspace"]) {
      const value = backup.coverage[key];
      if (["complete", "partial", "omitted", "policy_excluded", "unknown"].includes(value)) coverage[key] = value;
    }
    if (Object.keys(coverage).length) result.coverage = coverage;
  }
  for (const key of ["snapshotStartedAt", "snapshotCompletedAt"]) {
    if (Number.isFinite(backup[key]) && backup[key] >= 0) result[key] = backup[key];
  }
  return result;
};

module.exports = { projectBackupSummary };

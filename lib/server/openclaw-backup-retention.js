const { kOpenclawBackupPinMaxAgeMs } = require("./constants");

// The ledger supplies newest-first runs. Keep one selector for archive
// retention, ledger retention and the rollback fence. A newer migration intent
// that failed without an archive cannot erase the last verified recovery
// record. A verified backup from a failed apply may already contain the last
// activation's migration, so preserve that activated run's recovery too. This
// is bounded to two archives and three records; ordinary successful activation
// deduplicates them. Expiring a pin does not disarm an extant fence record.
const selectMigrationBackupProtection = (
  runs,
  { nowMs = Date.now(), maxAgeMs = kOpenclawBackupPinMaxAgeMs } = {},
) => {
  const migrations = (Array.isArray(runs) ? runs : []).filter(
    (entry) => entry?.dbPreflight?.migrationRequired === true,
  );
  const run = migrations[0] || null;
  const withinPinWindow = (entry) => Boolean(
    entry && Number.isFinite(entry.startedAt) && Number.isFinite(nowMs) &&
      Number.isFinite(maxAgeMs) && maxAgeMs >= 0 &&
      nowMs - entry.startedAt <= maxAgeMs,
  );
  const verifiedFile = (entry) => entry?.backup?.verified === true &&
    typeof entry.backup.file === "string" && entry.backup.file.trim()
    ? entry.backup.file : null;
  const recoveryRun = migrations.find((entry) => verifiedFile(entry)) || null;
  const activatedRecoveryRun = migrations.find((entry) => entry.state === "activated" && verifiedFile(entry)) || null;
  const pinnedOperationId = withinPinWindow(run) ? run.operationId : null;
  const recoveryPinned = withinPinWindow(recoveryRun);
  const recoveryPins = [recoveryRun, activatedRecoveryRun].filter(withinPinWindow);
  return {
    run,
    pinnedOperationId,
    pinnedOperationIds: [...new Set([pinnedOperationId,
      ...recoveryPins.map((entry) => entry.operationId)].filter(Boolean))],
    pinnedArchiveFile: recoveryPinned ? verifiedFile(recoveryRun) : null,
    pinnedArchiveFiles: [...new Set(recoveryPins.map(verifiedFile))],
  };
};

module.exports = { selectMigrationBackupProtection };

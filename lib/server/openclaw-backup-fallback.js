// Broad attempts -> unwind -> minimal (once) -> final reuse/consent decision.
// Scheduling reserves never authorize abandoning cleanup or a SQLite worker.
const minimalBackupBudgets = (budget) => ({
  copyMs: budget.offlineCopyBudgetMs,
  leaseMs: budget.offlineCopyBudgetMs + budget.quiesceLeaseReserveMs,
  phaseMs: budget.quiesceLockTimeoutMs + budget.offlineCopyBudgetMs +
    budget.quiesceLeaseReserveMs + budget.reuseVerifyTimeoutMs,
  unwindMs: Math.max(0, budget.quiesceLeaseReserveMs - budget.quiesceStopTimeoutMs -
    7_000 - budget.reuseVerifyTimeoutMs),
  publicationMs: budget.reuseVerifyTimeoutMs,
});

const backupSafetyFailure = (error) => {
  if (error?.orphanedBackup === true) return "orphaned_sqlite_backup";
  const codes = [error?.code, error?.cause?.code];
  const message = String(error?.message || error?.error || "");
  if (codes.includes("ENOSPC") || /\bENOSPC\b|no space left on device/i.test(message)) return "disk_full";
  if (codes.some((code) => /SQLITE_CORRUPT|SQLITE_NOTADB/.test(String(code))) ||
      /database disk image is malformed|file is not a database/i.test(message) ||
      error?.sourceCorrupt === true) return "source_corrupt";
  return null;
};

const backupFailureAttempt = (kind, message, hint = "Fix the cause and retry the backup.") => ({
  classified: { kind, message, hint, stepError: message },
  result: null,
  outputFile: null,
});

module.exports = { minimalBackupBudgets, backupSafetyFailure, backupFailureAttempt };

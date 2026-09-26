import { formatLocaleDateTime } from "../../lib/format.js";

export const isMigrationOnlyBackup = (archive) => archive?.profile === "migration-minimal";
export const kMigrationOnlyBackupCaption =
  "Migration-only backup: database recovery is covered; workspace and other state are omitted.";
export const kMigrationOnlyRestoreCaption =
  "Restore only the captured assets using the migration-only runbook; preserve omitted workspace and other data.";

export const buildBackupResultMessage = (result, { toast = false } = {}) => {
  if (result?.recovery) return buildRecoveryCaption(result.recovery);
  const archive = result?.archive;
  if (!archive?.file) return result?.noBackup
    ? "Nothing to back up yet — this OpenClaw has no state a backup could lose."
    : toast ? "Backup completed" : "Backup finished.";
  const name = String(archive.file).split("/").pop();
  if (isMigrationOnlyBackup(archive)) return `Migration-only backup written: ${name} — workspace and other state omitted.`;
  return `${toast ? "Backup" : "Archive"} written: ${name}${!toast && archive.verified === true ? " — verified" : ""}`;
};

export const buildRecoveryCaption = (recovery) => {
  const config = recovery?.restore?.configAvailable === true
    ? "Configuration checkpoint available"
    : "Configuration recovery unavailable";
  if (recovery?.restore?.databaseSetAvailable === true &&
      recovery?.databases?.complete === true && recovery?.databases?.verified === true) {
    return `${config}; verified database snapshot available`;
  }
  return `${config}; database data not backed up`;
};

export const buildBackupSnapshotCaption = (archive) => {
  if (!Number.isFinite(archive?.snapshotStartedAt) || !Number.isFinite(archive?.snapshotCompletedAt)) return null;
  return `Data captured ${formatLocaleDateTime(archive.snapshotStartedAt)} – ${formatLocaleDateTime(archive.snapshotCompletedAt)}`;
};

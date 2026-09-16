const { selectMigrationBackupProtection } = require("../../lib/server/openclaw-backup-retention");
const { kOpenclawBackupPinMaxAgeMs } = require("../../lib/server/constants");

describe("migration backup protection", () => {
  const migration = {
    operationId: "11111111-aaaa-4bbb-8ccc-111111111111",
    startedAt: 1_000,
    state: "activated",
    dbPreflight: { migrationRequired: true },
    backup: { verified: true, file: "/backups/openclaw-backup-1.alphaclaw.tar.gz",
      profile: "migration-minimal", partial: true,
      coverage: { migration: "complete", core: "partial", workspace: "omitted" } },
  };

  it("protects the migration record and partial archive behind newer ordinary runs", () => {
    const result = selectMigrationBackupProtection([
      { operationId: "33333333", target: { kind: "backup" }, startedAt: 3_000 },
      { operationId: "22222222", dbPreflight: { migrationRequired: false }, startedAt: 2_000 },
      migration,
    ], { nowMs: 4_000 });
    expect(result).toEqual({ run: migration, pinnedOperationId: migration.operationId,
      pinnedOperationIds: [migration.operationId],
      pinnedArchiveFiles: [migration.backup.file],
      pinnedArchiveFile: migration.backup.file });
  });

  it("expires retention without hiding an extant migration record from the rollback fence", () => {
    expect(selectMigrationBackupProtection([migration], {
      nowMs: migration.startedAt + kOpenclawBackupPinMaxAgeMs,
    }).pinnedArchiveFile).toBe(migration.backup.file);
    expect(selectMigrationBackupProtection([migration], {
      nowMs: migration.startedAt + kOpenclawBackupPinMaxAgeMs + 1,
    })).toEqual({ run: migration, pinnedOperationId: null, pinnedOperationIds: [], pinnedArchiveFile: null, pinnedArchiveFiles: [] });
  });

  it("keeps a migration's record even when it has no verified archive", () => {
    const unverified = { ...migration, backup: { ...migration.backup, verified: false } };
    expect(selectMigrationBackupProtection([unverified], { nowMs: 4_000 })).toEqual({
      run: unverified, pinnedOperationId: migration.operationId, pinnedArchiveFile: null,
      pinnedOperationIds: [migration.operationId],
      pinnedArchiveFiles: [],
    });
  });

  it("keeps both the newest fence record and the last verified recovery when a later attempt has no archive", () => {
    const latest = { ...migration, operationId: "22222222", startedAt: 2_000, state: "failed", backup: null };
    expect(selectMigrationBackupProtection([latest, migration], { nowMs: 4_000 })).toEqual({
      run: latest, pinnedOperationId: latest.operationId,
      pinnedOperationIds: [latest.operationId, migration.operationId], pinnedArchiveFile: migration.backup.file,
      pinnedArchiveFiles: [migration.backup.file],
    });
    expect(selectMigrationBackupProtection(null)).toEqual({
      run: null, pinnedOperationId: null, pinnedOperationIds: [], pinnedArchiveFile: null, pinnedArchiveFiles: [],
    });
  });

  it("expires recovery against its own age, independently of a newer fence record", () => {
    const latest = { ...migration, operationId: "22222222", startedAt: 2_000, backup: null };
    expect(selectMigrationBackupProtection([latest, migration], {
      nowMs: migration.startedAt + kOpenclawBackupPinMaxAgeMs + 1,
    })).toEqual({ run: latest, pinnedOperationId: latest.operationId,
      pinnedOperationIds: [latest.operationId], pinnedArchiveFile: null, pinnedArchiveFiles: [] });
  });

  it("also retains the activated migration's recovery when a failed retry has a newer verified snapshot", () => {
    const verifiedRetry = { ...migration, operationId: "22222222", startedAt: 2_000, state: "failed",
      backup: { ...migration.backup, file: "/backups/openclaw-backup-2.alphaclaw.tar.gz" } };
    const latest = { ...verifiedRetry, operationId: "33333333", startedAt: 3_000, backup: null };
    const older = { ...migration, operationId: "00000000", startedAt: 500,
      backup: { ...migration.backup, file: "/backups/openclaw-backup-0.alphaclaw.tar.gz" } };
    expect(selectMigrationBackupProtection([latest, verifiedRetry, migration, older], { nowMs: 4_000 })).toEqual({
      run: latest, pinnedOperationId: latest.operationId,
      pinnedOperationIds: [latest.operationId, verifiedRetry.operationId, migration.operationId],
      pinnedArchiveFile: verifiedRetry.backup.file,
      pinnedArchiveFiles: [verifiedRetry.backup.file, migration.backup.file],
    });
    // The activated recovery's own age expires independently; a retry
    // cannot extend its lease, and the older activated row is never pinned.
    expect(selectMigrationBackupProtection([latest, verifiedRetry, migration, older], {
      nowMs: migration.startedAt + kOpenclawBackupPinMaxAgeMs + 1,
    }).pinnedArchiveFiles).toEqual([verifiedRetry.backup.file]);
  });
});

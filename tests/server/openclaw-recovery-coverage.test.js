const { hasDatabaseRecoveryCoverage, projectRecoverySummary, migrationRecoveryFile } = require("../../lib/server/openclaw-recovery-coverage");
const { selectMigrationBackupProtection } = require("../../lib/server/openclaw-backup-retention");

const complete = () => ({
  kind: "database_set",
  checkpoint: { id: "operation", file: "/private/recovery/operation", verified: true, fileCount: 1, bytes: 300 },
  databases: {
    complete: true,
    verified: true,
    inventoryDigest: "a".repeat(64),
    requiredPaths: ["state/openclaw.sqlite", "agents/main/agent/openclaw-agent.sqlite"],
    entries: [
      { path: "state/openclaw.sqlite", dbKind: "state", verified: true },
      { path: "agents/main/agent/openclaw-agent.sqlite", dbKind: "agent", verified: true },
    ],
  },
});

describe("database recovery coverage", () => {
  it("requires exactly the independently inventoried verified database set", () => {
    expect(hasDatabaseRecoveryCoverage(complete())).toBe(true);
    for (const mutate of [
      (value) => { value.kind = "config_only"; },
      (value) => { value.kind = "forward_only"; },
      (value) => { value.checkpoint.verified = false; },
      (value) => { value.databases.complete = false; },
      (value) => { value.databases.verified = false; },
      (value) => { value.databases.inventoryDigest = ""; },
      (value) => { value.databases.requiredPaths.pop(); },
      (value) => { value.databases.requiredPaths[1] = value.databases.requiredPaths[0]; },
      (value) => { value.databases.entries.pop(); },
      (value) => { value.databases.entries[1] = value.databases.entries[0]; },
      (value) => { value.databases.entries[1].verified = false; },
      (value) => { value.databases.entries[1].dbKind = "workspace"; },
      (value) => { value.databases.entries[1].path = "../outside.sqlite"; },
      (value) => { value.databases.entries[1].path = "state/other.sqlite"; },
    ]) {
      const recovery = complete();
      mutate(recovery);
      expect(hasDatabaseRecoveryCoverage(recovery)).toBe(false);
    }
  });

  it("does not claim an empty or missing database set protects a migration", () => {
    expect(hasDatabaseRecoveryCoverage(null)).toBe(false);
    const recovery = complete();
    recovery.databases.requiredPaths = [];
    recovery.databases.entries = [];
    expect(hasDatabaseRecoveryCoverage(recovery)).toBe(false);
  });

  it("projects config coverage independently from database recovery", () => {
    const recovery = complete();
    recovery.kind = "config_only";
    recovery.checkpoint.secret = "private payload must not escape";
    const summary = projectRecoverySummary(recovery);
    expect(summary.restore).toEqual({ configAvailable: true, databaseSetAvailable: false });
    expect(summary.databases).toMatchObject({ complete: false, verified: false });
    expect(JSON.stringify(summary)).not.toContain("private payload");
    expect(summary.databases).not.toHaveProperty("entries");
  });

  it("retains legacy archives but never treats a config checkpoint as an archive", () => {
    expect(migrationRecoveryFile({ backup: { verified: true, file: "/old.tar.gz", profile: "migration-minimal" } })).toBe("/old.tar.gz");
    const recovery = complete();
    expect(migrationRecoveryFile({ recovery })).toBe(recovery.checkpoint.file);
    recovery.kind = "config_only";
    expect(migrationRecoveryFile({ recovery, backup: { verified: true, file: "/misleading.tar.gz" } })).toBeNull();
    expect(migrationRecoveryFile({ backup: { verified: true, profile: "config_only", file: "/checkpoint" } })).toBeNull();
  });

  it("never evicts an activated migration's database recovery for a newer config-only run", () => {
    const recovery = complete();
    recovery.kind = "forward_only";
    const runs = [
      { operationId: "new", startedAt: 1000, state: "activated", dbPreflight: { migrationRequired: true }, recovery },
      { operationId: "old", startedAt: 900, state: "activated", dbPreflight: { migrationRequired: true }, backup: { verified: true, file: "/old.tar.gz" } },
    ];
    const result = selectMigrationBackupProtection(runs, { nowMs: 1100, maxAgeMs: 10000 });
    expect(result.run.operationId).toBe("new");
    expect(result.pinnedArchiveFiles).toEqual(["/old.tar.gz"]);
    expect(result.pinnedOperationIds).toEqual(["new", "old"]);
  });
});

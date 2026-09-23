import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { minimalBackupBudgets, backupSafetyFailure } = require("../../lib/server/openclaw-backup-fallback");
const { kDefaultBackupBudget } = require("../../lib/server/openclaw-backup-ladder");
const { projectBackupSummary } = require("../../lib/server/openclaw-backup-summary");

describe("migration fallback scheduling and cumulative safety", () => {
  it("reserves a separate 25m37s phase, an eight-minute producer and publication after unwind", () => {
    const budget = minimalBackupBudgets(kDefaultBackupBudget);
    expect(budget).toMatchObject({ copyMs: 8 * 60_000, phaseMs: 25 * 60_000 + 37_000, publicationMs: 5 * 60_000 });
    expect(budget.leaseMs).toBe(kDefaultBackupBudget.offlineCopyBudgetMs + kDefaultBackupBudget.quiesceLeaseReserveMs);
    expect(budget.phaseMs).toBe(kDefaultBackupBudget.quiesceLockTimeoutMs + budget.leaseMs + budget.publicationMs);
  });

  it.each([
    [{ orphanedBackup: true }, "orphaned_sqlite_backup"],
    [{ cause: { code: "ENOSPC" } }, "disk_full"],
    [{ message: "tar: no space left on device" }, "disk_full"],
    [{ code: "SQLITE_CORRUPT" }, "source_corrupt"],
    [{ sourceCorrupt: true, stage: "integrity_check" }, "source_corrupt"],
    [{ stage: "integrity_check", message: "worker could not start" }, null],
    [{ stage: "disk_check", message: "predicted full copy exceeds available space" }, null],
  ])("preserves proven blockers and permits a smaller producer after predicted insufficiency: %j", (error, expected) => {
    expect(backupSafetyFailure(error)).toBe(expected);
  });

  it("projects bounded honest coverage without copying private inventory paths", () => {
    expect(projectBackupSummary({ profile: "full", coverage: { migration: "unknown", core: "complete", other: "secret" },
      partialReasons: ["scratch\u0000 omitted"], snapshotStartedAt: 1, snapshotCompletedAt: NaN,
      requiredAssets: [{ sourcePath: "/private" }] })).toEqual({
      profile: "full", coverage: { migration: "unknown", core: "complete" },
      partialReasons: ["scratch  omitted"], snapshotStartedAt: 1,
    });
  });
});

import { describe, expect, it } from "vitest";
import { buildBackupInventoryRows, buildLastManualBackupLine, buildFailureCtaModel,
  buildRollbackDataRiskLine, buildBackupReuseConsentModel, buildBackupReuseOfferModel } from "../../lib/public/js/components/upgrade-tab/helpers.js";
import { buildBackupResultMessage } from "../../lib/public/js/components/upgrade-tab/backup-presentation.js";
import { UpgradeProgressCard } from "../../lib/public/js/components/upgrade-tab/progress-card.js";

const at = Date.parse("2026-09-16T12:00:00Z");
const minimal = { file: "/backups/one.alphaclaw.tar.gz", at, verified: true,
  profile: "migration-minimal", partial: true, producer: "alphaclaw-offline-copy",
  coverage: { migration: "complete", core: "partial", workspace: "omitted" },
  partialReasons: ["workspace and other state omitted"], sha256: "a".repeat(64) };
const text = (node) => {
  if (node == null) return "";
  if (Array.isArray(node)) return node.map(text).join(" ");
  if (typeof node !== "object") return String(node);
  return text(node.props?.children);
};

describe("migration-only backup presentation", () => {
  it("labels quick and streamed manual results, inventory, and last manual backup honestly", () => {
    expect(buildBackupResultMessage({ archive: minimal }, { toast: true })).toContain("Migration-only backup");
    expect(buildBackupResultMessage({ archive: minimal })).toContain("workspace and other state omitted");
    const [row] = buildBackupInventoryRows({ entries: [{ ...minimal, exists: true, eligible: false,
      ineligibleReason: "partial", snapshotStartedAt: at + 1000, snapshotCompletedAt: at + 2500 }] }, at + 3000);
    expect(row.badges.find((badge) => badge.id === "partial").label).toContain("not reusable by a later update");
    expect(row.captureLabel).toContain("Data captured");
    const run = { operationId: "manual", target: { kind: "backup" }, state: "completed", startedAt: at,
      finishedAt: at + 3000, result: { ok: true, archive: minimal } };
    expect(buildLastManualBackupLine([run], at + 4000)).toMatchObject({ tone: "warning", text: expect.stringContaining("migration-only") });
    const tree = UpgradeProgressCard({ operation: { ...run, phase: "completed", steps: [] }, nowMs: at + 4000 });
    expect(text(tree)).toContain("Migration-only backup completed");
    expect(text(tree)).toContain("preserve omitted workspace and other data");
  });
  it("explains that retrying the update needs a fresh backup", () => {
    const model = buildFailureCtaModel({ phase: "completed", target: { kind: "backup" }, result: { archive: minimal },
      retryUpdate: { payload: { channel: "stable", version: "2026.9.3" }, label: "2026.9.3" } });
    expect(model.retryUpdate.label).toBe("2026.9.3");
    expect(model.hint).toContain("run a fresh backup");
    expect(model.hint).toContain("not reusable");
  });
  it("offers Retry backup even when the installed dev build also supports repair", () => {
    const tree = UpgradeProgressCard({ repairAvailable: true, operation: { phase: "failed", target: { channel: "stable", version: "2026.9.4" },
      startedAt: at, finishedAt: at + 1, steps: [], error: { code: "backup_failed", message: "Backup failed" } } });
    const labels = [];
    const visit = (node) => {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!node || typeof node !== "object") return;
      if (node.props?.idleLabel) labels.push(node.props.idleLabel);
      visit(node.props?.children);
    };
    visit(tree);
    expect(labels).toContain("Retry backup");
    expect(labels).toContain("Run repair");
    expect(labels.indexOf("Retry backup")).toBeLessThan(labels.indexOf("Run repair"));
  });
  it("never offers minimal archives for reuse, including an inconsistent legacy projection", () => {
    const invalid = { ...minimal, partial: false, eligible: true, exists: true };
    const model = buildBackupReuseConsentModel({ inventory: { readable: true, entries: [invalid], reuseWindowStartMs: 0,
      reuseMaxAgeMs: 86_400_000 }, nowMs: at + 1000 });
    expect(model).toMatchObject({ available: false, entry: null, sha256: null });
    expect(buildBackupReuseOfferModel({ error: { code: "backup_failed", reusableBackup: invalid } })).toBeNull();
  });
  it("carries partial recovery instructions through both rollback archive choices", () => {
    const present = buildRollbackDataRiskLine({ backupFile: minimal.file, backupFileExists: true,
      backupProfile: minimal.profile, backupPartial: true }, at);
    expect(present).toContain("migration-only backup");
    expect(present).toContain("Restore only the captured assets");
    for (const backupFileCaveat of ["missing", "digest_mismatch"]) {
      const survivor = buildRollbackDataRiskLine({ backupFile: "/backups/missing.tar.gz", backupFileExists: false,
        backupFileCaveat, newestSurvivingBackup: minimal }, at);
      expect(survivor).toContain("It is migration-only");
      expect(survivor).toContain("preserve omitted workspace");
    }
  });
  it("preserves existing full and legacy partial archive wording", () => {
    expect(buildBackupResultMessage({ archive: { file: "/backups/full.tar.gz", verified: true } })).toBe("Archive written: full.tar.gz — verified");
    expect(buildRollbackDataRiskLine({ backupFile: "/backups/legacy.tar.gz", backupPartial: true })).toContain("workspace files were excluded");
  });
});

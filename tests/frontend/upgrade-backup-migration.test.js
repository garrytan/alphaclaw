import { describe, expect, it } from "vitest";
import { buildBackupInventoryRows, buildLastManualBackupLine, buildFailureCtaModel,
  buildRollbackDataRiskLine, buildBackupReuseConsentModel, buildBackupReuseOfferModel } from "../../lib/public/js/components/upgrade-tab/helpers.js";
import { buildBackupResultMessage } from "../../lib/public/js/components/upgrade-tab/backup-presentation.js";
import { UpgradeProgressCard } from "../../lib/public/js/components/upgrade-tab/progress-card.js";
import { buildRecoveryChoice, resolveRecoveryRequest } from "../../lib/public/js/components/upgrade-tab/recovery-choice.js";

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
  it("guides verified database-directory rollback through matching-build offline restore rather than tar extraction", () => {
    const file = "/backups/recovery-op";
    const recovery = { kind: "database_set", checkpoint: { file, verified: true }, databases: { complete: true, verified: true, count: 2 }, restore: { configAvailable: true, databaseSetAvailable: true } };
    const model = { backupFile: file, backupFileExists: true, recovery };
    const line = buildRollbackDataRiskLine(model);
    for (const phrase of ["database recovery directory", "not a tar archive", "verify the manifest and database integrity", "complete captured database set", "matching source build", "preserve omitted files", "does not restore database data automatically"]) expect(line).toContain(phrase);
    expect(line).not.toContain("gzip");
    for (const invalid of [
      { ...model, backupFileExists: undefined },
      { ...model, recovery: { ...recovery, restore: { databaseSetAvailable: false } } },
      { ...model, recovery: { ...recovery, databases: { complete: false, verified: true } } },
      { ...model, recovery: { ...recovery, checkpoint: { file, verified: false } } },
      { ...model, backupFile: "/backups/different-op" },
    ]) expect(buildRollbackDataRiskLine(invalid)).toContain("do not restore it");
    const missing = buildRollbackDataRiskLine({ ...model, backupFileExists: false, backupFileCaveat: "missing" });
    expect(missing).toContain("database recovery directory");
    expect(missing).toContain("no longer on disk");
    const tampered = buildRollbackDataRiskLine({ ...model, backupFileExists: false, backupFileCaveat: "content_changed", newestSurvivingBackup: minimal });
    expect(tampered).toContain("do not restore it");
    expect(tampered).toContain("It is migration-only");
    expect(tampered).not.toContain("complete captured database set with its matching source build");
  });
  it("never treats configuration-only or forward-only recovery as database rollback protection", () => {
    for (const kind of ["config_only", "forward_only"]) {
      const recovery = { kind, checkpoint: { file: "/backups/config-op", verified: true }, restore: { configAvailable: true, databaseSetAvailable: false } };
      const line = buildRollbackDataRiskLine({ backupFile: null, recovery });
      expect(line).toContain("configuration checkpoint is available");
      expect(line).toContain("cannot restore database data or make database rollback safe");
      expect(line).toContain("No database snapshot");
      expect(line).toContain("does not restore database data automatically");
      if (kind === "forward_only") expect(line).toContain("approved as forward-only");
      const unverifiable = buildRollbackDataRiskLine({ backupFile: null, recovery: { ...recovery, restore: { configAvailable: false, databaseSetAvailable: false } } });
      expect(unverifiable).toContain("No verified configuration checkpoint");
      expect(unverifiable).not.toContain("checkpoint is available");
    }
  });
  it("binds a prepared dev HEAD choice to its immutable commit without changing other requests", () => {
    const sha = "a".repeat(40);
    const request = { payload: { channel: "dev", devHead: true }, label: "latest dev" };
    expect(resolveRecoveryRequest({ target: { channel: "dev", sha } }, request)).toMatchObject({ payload: { channel: "dev", sha }, label: "dev aaaaaaaa" });
    expect(resolveRecoveryRequest({ target: { channel: "dev", sha: "short" } }, request)).toBe(request);
    const fixed = { payload: { channel: "dev", sha: "b".repeat(40) } };
    expect(resolveRecoveryRequest({ target: { channel: "dev", sha } }, fixed)).toBe(fixed);
  });
  it("derives migration size/count from the server preflight when top-level estimates are absent", () => {
    const request = { payload: { channel: "stable", version: "2026.9.6" } };
    const error = { code: "recovery_choice_required", operationId: "choice", preflight: { dbSizesBytes: { "/state.db": 2 * 1024 ** 3, "/agent.db": 6 * 1024 ** 3 } } };
    expect(buildRecoveryChoice(error, request)).toMatchObject({ databaseBytes: 8 * 1024 ** 3, databaseCount: 2 });
    expect(buildRecoveryChoice({ ...error, preflight: { dbSizesBytes: { "/state.db": null } } }, request).databaseBytes).toBeNull();
  });
  it("distinguishes verified configuration recovery from verified database-set recovery", () => {
    const recovery = { kind: "config_only", checkpoint: { verified: true, bytes: 2048 }, databases: { complete: false, verified: false, entries: [] }, restore: { configAvailable: true, databaseSetAvailable: false } };
    expect(buildBackupResultMessage({ recovery })).toBe("Configuration checkpoint available; database data not backed up");
    const [row] = buildBackupInventoryRows({ entries: [{ file: "/backups/checkpoint", profile: "config_only", verified: true, recovery, eligible: false }] });
    expect(row.badges.map((badge) => badge.label).join(" ")).toContain("database data not backed up");
    expect(row.badges.some((badge) => badge.id === "verified")).toBe(false);
    const databaseSet = { ...recovery, kind: "database_set", databases: { complete: true, verified: true, entries: [{ file: "state.db" }] }, restore: { configAvailable: true, databaseSetAvailable: true } };
    expect(buildBackupResultMessage({ recovery: databaseSet })).toContain("verified database snapshot available");
    expect(buildBackupResultMessage({ recovery: { ...databaseSet, databases: { complete: false, verified: true } } })).not.toContain("verified database snapshot available");
    const run = { operationId: "checkpoint", target: { kind: "backup" }, state: "completed", finishedAt: at, result: { ok: true, recovery } };
    expect(buildLastManualBackupLine([run], at + 1).text).toContain("database data not backed up");
    expect(text(UpgradeProgressCard({ operation: { ...run, phase: "completed", steps: [] } }))).toContain("Configuration checkpoint completed");
  });
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

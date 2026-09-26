import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenclawBackupPolicy, updateOpenclawBackupPolicy, rollbackOpenclaw } from "../../lib/public/js/lib/api.js";

afterEach(() => vi.unstubAllGlobals());
describe("backup policy and coverage API contracts", () => {
  it("carries the server's on-disk rollback recovery verdict without promoting recorded verification", async () => {
    const recovery = { kind: "database_set", checkpoint: { file: "/backups/recovery-op", verified: true }, databases: { complete: true, verified: true }, restore: { configAvailable: false, databaseSetAvailable: false } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, code: "rollback_requires_confirmation", message: "Restore first", backupFile: recovery.checkpoint.file, backupFileExists: false, backupFileCaveat: "content_changed", recovery }), { status: 409 })));
    await expect(rollbackOpenclaw()).rejects.toMatchObject({ recovery, backupFileExists: false, backupFileCaveat: "content_changed" });
  });
  it("GET returns canonical policy/defaults and PUT sends both explicit lists", async () => {
    const policy = { excludes: [], rootExcludes: ["state/security-planning/stronghold-*"] };
    const response = { ok: true, policy, defaults: { excludes: ["node_modules"], rootExcludes: [] }, refusedExcludes: [] };
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchOpenclawBackupPolicy()).toEqual(response);
    expect(await updateOpenclawBackupPolicy(policy)).toEqual(response);
    expect(fetch).toHaveBeenLastCalledWith("/api/openclaw/backup-policy", expect.objectContaining({ method: "PUT", body: JSON.stringify(policy) }));
  });
  it("retains bounded public rule errors and the shared corrupt-file recovery hint", async () => {
    const refusal = { scope: "root", pattern: "state", reason: "protected" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false,
      code: "invalid_backup_policy", message: "Unsafe rule", refusedExcludes: [refusal], confirmNoBackupToken: "private" }), { status: 400 })));
    const error = await updateOpenclawBackupPolicy({ excludes: [], rootExcludes: ["state"] }).catch((err) => err);
    expect(error).toMatchObject({ status: 400, code: "invalid_backup_policy", refusedExcludes: [refusal] });
    expect(error.confirmNoBackupToken).toBeUndefined();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false,
      code: "config_unreadable", error: "Cannot parse alphaclaw.json", hint: "Restore the settings file" }), { status: 503 })));
    await expect(updateOpenclawBackupPolicy({ excludes: [], rootExcludes: [] })).rejects.toMatchObject({
      status: 503, code: "config_unreadable", message: "Cannot parse alphaclaw.json", hint: "Restore the settings file",
    });
  });
  it("preserves migration coverage on a recorded and surviving rollback archive", async () => {
    const coverage = { migration: "complete", core: "partial", workspace: "omitted" };
    const newestSurvivingBackup = { file: "/backups/second.tar.gz", profile: "migration-minimal", coverage, partial: true };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false,
      code: "rollback_requires_confirmation", message: "Restore first", backupFile: "/backups/first.tar.gz",
      backupProfile: "migration-minimal", backupCoverage: coverage, backupPartialReasons: ["workspace omitted"],
      newestSurvivingBackup }), { status: 409 })));
    await expect(rollbackOpenclaw()).rejects.toMatchObject({ backupProfile: "migration-minimal", backupCoverage: coverage,
      backupPartialReasons: ["workspace omitted"], newestSurvivingBackup });
  });
});

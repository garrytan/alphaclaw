import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenclawRun, resolveManagedUpdateAttempt, updateAlphaclaw, applyOpenclawVersion, createOpenclawBackup, cancelOpenclawRecoveryReview } from "../../lib/public/js/lib/api.js";

describe("operation identity API wrappers", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("cancels only the named held review and requires the server to confirm its exact identity", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, operationId: "review-one", resumed: true })));
    vi.stubGlobal("fetch", fetch);
    expect(await cancelOpenclawRecoveryReview("review-one")).toMatchObject({ ok: true, resumed: true });
    expect(fetch).toHaveBeenCalledWith("/api/openclaw/recovery/cancel", expect.objectContaining({ method: "POST", body: JSON.stringify({ operationId: "review-one" }) }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, operationId: "other-review" })));
    await expect(cancelOpenclawRecoveryReview("review-one")).rejects.toThrow("did not confirm cancellation");
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, code: "recovery_review_stale", message: "Still held", hint: "Refresh recovery state" }), { status: 409 }));
    await expect(cancelOpenclawRecoveryReview("review-one")).rejects.toMatchObject({ code: "recovery_review_stale", hint: "Refresh recovery state" });
  });
  it("manual recovery defaults to configuration and only requests databases explicitly", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ok: true, recovery: { kind: "config_only" } })));
    vi.stubGlobal("fetch", fetch);
    expect(await createOpenclawBackup()).toMatchObject({ recovery: { kind: "config_only" } });
    expect(fetch).toHaveBeenLastCalledWith("/api/openclaw/backup", expect.objectContaining({ method: "POST", body: JSON.stringify({ recoveryMode: "config_only" }) }));
    await createOpenclawBackup({ recoveryMode: "database_set" });
    expect(fetch).toHaveBeenLastCalledWith("/api/openclaw/backup", expect.objectContaining({ body: JSON.stringify({ recoveryMode: "database_set" }) }));
  });
  it("retains public migration-choice details without retaining arbitrary error fields", async () => {
    const body = { ok: false, code: "recovery_choice_required", message: "Choose recovery", operationId: "choice-one", backupRiskEligible: true, databaseBytes: 5 * 1024 ** 3, databaseCount: 4, preflight: { migrationRequired: true }, confirmNoBackupToken: "private" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 409 })));
    const error = await applyOpenclawVersion({ channel: "stable", version: "2026.9.6", intent: "update", recoveryMode: "config_only" }).catch((err) => err);
    expect(error).toMatchObject({ status: 409, code: body.code, operationId: body.operationId, backupRiskEligible: true, databaseBytes: body.databaseBytes, databaseCount: 4, preflight: body.preflight });
    expect(error.confirmNoBackupToken).toBeUndefined();
  });
  it("reads exactly the selected run with an explicit signal", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, run: { operationId: "run-one" } })));
    vi.stubGlobal("fetch", fetch);
    const signal = new AbortController().signal;
    expect((await fetchOpenclawRun("run-one", { signal })).run.operationId).toBe("run-one");
    expect(fetch).toHaveBeenCalledWith("/api/openclaw/runs/run-one", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });
  it("resolution sends only the explicit provider confirmation and selected outcome", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, managedUpdateAttempt: { id: "deploy-one", state: "resolved" } })));
    vi.stubGlobal("fetch", fetch);
    await resolveManagedUpdateAttempt("deploy-one", "not_deployed");
    expect(fetch).toHaveBeenCalledWith("/api/alphaclaw/update/deploy-one/resolve", expect.objectContaining({
      method: "POST", body: JSON.stringify({ confirmProviderChecked: true, outcome: "not_deployed" }),
    }));
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("update HTTP failures preserve the actionable code rather than returning a success payload", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, code: "managed_update_pending", message: "Check the provider" }), { status: 409 })));
    await expect(updateAlphaclaw()).rejects.toMatchObject({ status: 409, code: "managed_update_pending", message: "Check the provider" });
  });
});

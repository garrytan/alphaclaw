import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReadHost, deferred } from "./mounted-read-helpers.js";
import { clearApiCache } from "../../lib/public/js/lib/api-cache.js";
import { useManagedUpdateAttempt } from "../../lib/public/js/hooks/use-managed-update-attempt.js";
import * as api from "../../lib/public/js/lib/api.js";

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchAlphaclawVersion: vi.fn(), updateAlphaclaw: vi.fn(), resolveManagedUpdateAttempt: vi.fn(),
}));

const attempt = (state = "accepted", id = "attempt-1") => ({
  id, state, requestedAt: "2026-09-15T12:00:00Z", updatedAt: "2026-09-15T12:00:00Z",
  target: { repo: "owner/template", ref: "main", alphaclawVersion: "1.1", openclawVersion: "2026.9.3" },
});
const version = (managedUpdateAttempt = null) => ({ currentVersion: "1.0", latestVersion: "1.1", hasUpdate: true, managedUpdateAttempt });

describe("mounted managed deployment attempts", () => {
  let host;
  const mount = async (identityRole = "admin") => {
    await host.render([{ id: "update", useRead: useManagedUpdateAttempt, args: [{ identityRole }] }]);
    await host.settle();
  };
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); clearApiCache();
    host = createReadHost(); vi.stubGlobal("document", host.document);
    api.fetchAlphaclawVersion.mockResolvedValue(version());
  });
  afterEach(async () => { await host.unmount(); clearApiCache(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each(["submitting", "accepted", "unknown"])("restores %s and blocks resubmission after a reload and version change", async (state) => {
    api.fetchAlphaclawVersion.mockResolvedValue({ ...version(attempt(state)), currentVersion: "1.1", hasUpdate: false });
    await mount();
    expect(host.result("update").blocked).toBe(true);
    await host.settle(() => host.result("update").submit());
    expect(api.updateAlphaclaw).not.toHaveBeenCalled();
  });

  it("records a queued provider acknowledgement without self-restart state", async () => {
    api.updateAlphaclaw.mockResolvedValue({ ok: true, managedUpdate: true, restarting: false, phase: "queued", managedUpdateAttempt: attempt() });
    await mount();
    await host.settle(() => host.result("update").submit());
    expect(host.result("update")).toMatchObject({ blocked: true, submitting: false, attempt: { state: "accepted" } });
    await host.settle(() => host.result("update").submit());
    expect(api.updateAlphaclaw).toHaveBeenCalledOnce();
  });

  it.each(["deployed", "not_deployed"])("resolves %s only through the explicit action and never submits another update", async (outcome) => {
    api.fetchAlphaclawVersion.mockResolvedValue(version(attempt("unknown")));
    await mount();
    expect(api.resolveManagedUpdateAttempt).not.toHaveBeenCalled();
    const resolved = { ...attempt("resolved"), resolution: { outcome, source: "operator" } };
    api.resolveManagedUpdateAttempt.mockResolvedValue({ ok: true, managedUpdateAttempt: resolved });
    api.fetchAlphaclawVersion.mockResolvedValue(version(resolved));
    await host.settle(() => host.result("update").resolve("attempt-1", outcome));
    expect(api.resolveManagedUpdateAttempt).toHaveBeenCalledWith("attempt-1", outcome);
    expect(host.result("update").blocked).toBe(false);
    expect(api.updateAlphaclaw).not.toHaveBeenCalled();
  });

  it("refuses non-admin resolution and a confirmation bound to an older attempt", async () => {
    api.fetchAlphaclawVersion.mockResolvedValue(version(attempt()));
    await mount("member");
    await host.settle(() => host.result("update").resolve("attempt-1", "deployed"));
    expect(api.resolveManagedUpdateAttempt).not.toHaveBeenCalled();
    await mount("admin");
    await host.settle(() => host.result("update").resolve("attempt-old", "deployed"));
    expect(api.resolveManagedUpdateAttempt).not.toHaveBeenCalled();
  });

  it("keeps last-known version and attempt visible on a failed GET, disables update, and recovers with Retry", async () => {
    api.fetchAlphaclawVersion.mockResolvedValue(version(attempt()));
    await mount();
    api.fetchAlphaclawVersion.mockRejectedValue(Object.assign(new Error("Cannot read the saved attempt"), { code: "config_unreadable" }));
    await host.settle(() => host.result("update").retry());
    expect(host.result("update")).toMatchObject({ disabled: true, version: { currentVersion: "1.0" }, attempt: { id: "attempt-1" }, error: { code: "config_unreadable" } });
    api.fetchAlphaclawVersion.mockResolvedValue(version());
    await host.settle(() => host.result("update").retry());
    expect(host.result("update").error).toBeNull();
    expect(host.result("update").disabled).toBe(false);
  });

  it("re-reads the persisted unknown attempt after a dropped POST response", async () => {
    await mount();
    api.updateAlphaclaw.mockRejectedValue(new Error("connection lost"));
    api.fetchAlphaclawVersion.mockResolvedValue(version(attempt("unknown")));
    await host.settle(() => host.result("update").submit());
    expect(host.result("update").blocked).toBe(true);
    expect(host.result("update").attempt.state).toBe("unknown");
  });

  it("serializes same-tick submissions while the request is in flight", async () => {
    const pending = deferred(); api.updateAlphaclaw.mockReturnValue(pending.promise);
    await mount();
    let first;
    await host.settle(() => { first = host.result("update").submit(); host.result("update").submit(); });
    expect(api.updateAlphaclaw).toHaveBeenCalledOnce();
    await host.settle(() => pending.resolve({ ok: true, managedUpdateAttempt: attempt() }));
    await first;
  });
});

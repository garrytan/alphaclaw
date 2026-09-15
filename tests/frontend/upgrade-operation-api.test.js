import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchOpenclawRun, resolveManagedUpdateAttempt, updateAlphaclaw } from "../../lib/public/js/lib/api.js";

describe("operation identity API wrappers", () => {
  afterEach(() => vi.unstubAllGlobals());
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

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "preact/hooks";
import { createReadHost, deferred } from "./mounted-read-helpers.js";
import { clearApiCache } from "../../lib/public/js/lib/api-cache.js";
import { operationRunPhase, resumeLedgerOperation, useOperationMonitor } from "../../lib/public/js/components/upgrade-tab/use-operation-monitor.js";
import { useUpgradeTab } from "../../lib/public/js/components/upgrade-tab/use-upgrade-tab.js";
import * as api from "../../lib/public/js/lib/api.js";

vi.mock("../../lib/public/js/lib/api.js", async (original) => ({
  ...await original(),
  fetchOpenclawRun: vi.fn(), fetchOpenclawRuns: vi.fn(), fetchStatus: vi.fn(),
  fetchOpenclawChannel: vi.fn(), fetchOpenclawCatalog: vi.fn(), fetchOpenclawBackups: vi.fn(),
  runOpenclawRepair: vi.fn(), subscribeOpenclawApplyEvents: vi.fn(),
}));
vi.mock("../../lib/public/js/components/toast.js", () => ({ showToast: vi.fn() }));

const op = (id = "repair-1", target = { repair: true }) => ({
  operationId: id, target, resumed: true, phase: "running", startedAt: 100,
  steps: [], output: "", label: "repair",
});
const run = (id = "repair-1", overrides = {}) => ({
  operationId: id, target: { repair: true }, state: "running", startedAt: 100,
  finishedAt: null, steps: [], ...overrides,
});

describe("mounted Upgrade operation recovery", () => {
  let host;
  const terminal = vi.fn();
  const restarted = vi.fn();
  const useProbe = (initial) => {
    const [operation, setOperation] = useState(initial);
    const monitor = useOperationMonitor({ operation, setOperation, expectedRef: { current: null }, onTerminal: terminal, onRestartFinished: restarted });
    return { operation, setOperation, ...monitor };
  };
  const mount = async (initial = op()) => {
    await host.render([{ id: "probe", useRead: useProbe, args: [initial] }]);
    await host.settle();
  };
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); clearApiCache();
    host = createReadHost(); vi.stubGlobal("document", host.document);
    api.fetchOpenclawRun.mockResolvedValue({ ok: true, run: run() });
    api.fetchOpenclawRuns.mockResolvedValue({ ok: true, runs: [] });
    api.fetchOpenclawChannel.mockResolvedValue({ releaseChannel: "dev", lastUpdateRun: { operationId: "old-apply", ok: true, finishedAt: 99 } });
    api.fetchOpenclawCatalog.mockResolvedValue({ ok: true, catalog: {} });
    api.fetchOpenclawBackups.mockResolvedValue({ ok: true, backups: [] });
    api.subscribeOpenclawApplyEvents.mockReturnValue(vi.fn());
  });
  afterEach(async () => { await host.unmount(); clearApiCache(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  it.each(["completed", "activated"])("finishes a repair in place from %s and never probes restart health", async (state) => {
    api.fetchOpenclawRun.mockResolvedValue({ ok: true, run: run("repair-1", { state, ok: true, finishedAt: 200 }) });
    await mount();
    expect(host.result("probe").operation.phase).toBe("completed");
    expect(api.fetchStatus).not.toHaveBeenCalled();
    expect(restarted).not.toHaveBeenCalled();
    expect(terminal).toHaveBeenCalledOnce();
  });

  it("keeps the selected repair running when an unrelated run is returned", async () => {
    api.fetchOpenclawRun.mockResolvedValue({ ok: true, run: run("old-apply", { state: "failed", ok: false }) });
    await mount();
    expect(host.result("probe").operation.phase).toBe("running");
    expect(host.result("probe").error.message).toMatch(/did not match/);
    expect(terminal).not.toHaveBeenCalled();
  });

  it("fences a late response when a newer operation replaces it", async () => {
    const first = deferred();
    api.fetchOpenclawRun.mockImplementation((id) => id === "repair-1" ? first.promise : Promise.resolve({ run: run(id) }));
    await mount();
    await host.settle(() => host.result("probe").setOperation(op("repair-2")));
    await host.settle(() => first.resolve({ run: run("repair-1", { state: "failed", ok: false, result: { message: "old failure" } }) }));
    expect(host.result("probe").operation.operationId).toBe("repair-2");
    expect(host.result("probe").operation.phase).toBe("running");
    expect(terminal).not.toHaveBeenCalled();
  });

  it("waits for its ledger activation even when the old process reports the expected version", async () => {
    const target = { channel: "stable", version: "1.0" };
    api.fetchOpenclawRun.mockResolvedValue({ run: run("apply-1", { target, state: "restart_expected", ok: true }) });
    api.fetchStatus.mockResolvedValue({ openclawChannel: { installedVersion: "1.0" } });
    await mount(op("apply-1", target));
    expect(restarted).not.toHaveBeenCalled();
    api.fetchOpenclawRun.mockResolvedValue({ run: run("apply-1", { target, state: "activated", ok: true }) });
    await host.settle(() => vi.advanceTimersByTimeAsync(3000));
    expect(restarted).toHaveBeenCalledOnce();
  });

  it("surfaces a failed read, preserves progress, and allows a status retry", async () => {
    api.fetchOpenclawRun.mockRejectedValue(new Error("HTTP 503"));
    await mount({ ...op(), steps: [{ name: "repair", status: "running" }] });
    expect(host.result("probe").error.message).toBe("HTTP 503");
    expect(host.result("probe").operation.steps).toHaveLength(1);
    api.fetchOpenclawRun.mockResolvedValue({ run: run("repair-1", { state: "completed", ok: true }) });
    await host.settle(() => host.result("probe").retry());
    expect(host.result("probe").operation.phase).toBe("completed");
  });

  it("discovers a repair on reload despite a prior successful apply", async () => {
    api.fetchOpenclawRuns.mockResolvedValue({ runs: [run()] });
    await host.render([{ id: "page", useRead: useUpgradeTab, args: [{}] }]);
    await host.settle();
    expect(host.result("page").operation).toMatchObject({ operationId: "repair-1", target: { repair: true } });
    expect(api.fetchOpenclawRun).toHaveBeenCalledWith("repair-1", expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it.each([true, false])("recovers lost repair SSE without adopting the old apply outcome (%s)", async (oldOk) => {
    api.fetchOpenclawChannel.mockResolvedValue({ releaseChannel: "dev", lastUpdateRun: { operationId: "old-apply", ok: oldOk, finishedAt: 99 } });
    api.runOpenclawRepair.mockResolvedValue({ ok: true, operationId: "repair-1", events: "/events" });
    await host.render([{ id: "page", useRead: useUpgradeTab, args: [{}] }]); await host.settle();
    await host.settle(() => host.result("page").onRunRepair());
    const first = api.subscribeOpenclawApplyEvents.mock.calls[0][0];
    await host.settle(() => first.onError());
    expect(host.result("page").operation.phase).toBe("running");
    api.fetchOpenclawRun.mockResolvedValue({ run: run("repair-1", { state: "completed", ok: true, finishedAt: 200 }) });
    await host.settle(() => vi.advanceTimersByTimeAsync(3000));
    expect(host.result("page").operation.phase).toBe("completed");
    await host.settle(() => first.onMessage({ event: "error", data: { error: "late old stream" } }));
    expect(host.result("page").operation.phase).toBe("completed");
  });

  it("discovers only active ledger records and maps interrupted repair as failed", () => {
    expect(resumeLedgerOperation([run("old", { state: "activated" }), run("live")]).operationId).toBe("live");
    expect(operationRunPhase(run("repair", { state: "interrupted" }))).toBe("failed");
  });
});

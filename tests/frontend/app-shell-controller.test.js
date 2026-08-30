import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deps-aware hook harness (same pattern as use-polling.test.js): the
// controller's fixes under test are effect-driven (stream-latch clearing on
// poll data, reachability poller wiring), so effects must re-run when their
// dependency arrays change, with cleanups firing first.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, pendingEffects: [] };

  const depsChanged = (previousDeps, nextDeps) => {
    if (!previousDeps || !nextDeps) return true;
    if (previousDeps.length !== nextDeps.length) return true;
    return nextDeps.some((dep, index) => !Object.is(dep, previousDeps[index]));
  };

  harness.beginRender = () => {
    harness.cursor = 0;
  };

  harness.flushEffects = () => {
    const pending = harness.pendingEffects;
    harness.pendingEffects = [];
    for (const run of pending) run();
  };

  harness.unmount = () => {
    harness.pendingEffects = [];
    for (const slot of [...harness.slots].reverse()) {
      if (slot?.kind === "effect" && typeof slot.cleanup === "function") {
        slot.cleanup();
        slot.cleanup = null;
      }
    }
  };

  harness.reset = () => {
    harness.unmount();
    harness.slots = [];
    harness.cursor = 0;
    harness.pendingEffects = [];
  };

  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = {
        kind: "state",
        value: typeof initialValue === "function" ? initialValue() : initialValue,
      };
    }
    const slot = harness.slots[index];
    const setState = (next) => {
      slot.value = typeof next === "function" ? next(slot.value) : next;
    };
    return [slot.value, setState];
  };

  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { kind: "ref", current: initialValue };
    }
    return harness.slots[index];
  };

  const useCallback = (fn, deps) => {
    const index = harness.cursor++;
    let slot = harness.slots[index];
    if (!slot) {
      slot = harness.slots[index] = {
        kind: "callback",
        fn: null,
        deps: undefined,
        initialized: false,
      };
    }
    if (!slot.initialized || depsChanged(slot.deps, deps)) {
      slot.fn = fn;
      slot.deps = deps;
      slot.initialized = true;
    }
    return slot.fn;
  };

  const useEffect = (effect, deps) => {
    const index = harness.cursor++;
    let slot = harness.slots[index];
    if (!slot) {
      slot = harness.slots[index] = {
        kind: "effect",
        deps: undefined,
        cleanup: null,
        initialized: false,
      };
    }
    const changed = !slot.initialized || depsChanged(slot.deps, deps);
    slot.deps = deps;
    slot.initialized = true;
    if (!changed) return;
    harness.pendingEffects.push(() => {
      if (typeof slot.cleanup === "function") slot.cleanup();
      const cleanup = effect();
      slot.cleanup = typeof cleanup === "function" ? cleanup : null;
    });
  };

  const useMemo = (factory) => factory();

  return { useState, useRef, useCallback, useEffect, useMemo, __harness: harness };
});

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchStatus: vi.fn(),
  fetchOnboardStatus: vi.fn(),
  fetchAuthStatus: vi.fn(),
  // Role-aware nav (team mode): the controller resolves the caller's identity
  // on mount to filter admin-only nav items for members.
  fetchAuthIdentity: vi.fn(() => Promise.resolve({ identity: null })),
  fetchAlphaclawVersion: vi.fn(),
  updateAlphaclaw: vi.fn(),
  fetchRestartStatus: vi.fn(),
  dismissRestartStatus: vi.fn(),
  restartGatewayAsync: vi.fn(),
  subscribeGatewayRestartEvents: vi.fn(() => () => {}),
  resumeWatchdogChannels: vi.fn(),
  rollbackOpenclaw: vi.fn(),
  fetchWatchdogStatus: vi.fn(),
  fetchDoctorStatus: vi.fn(),
  subscribeStatusEvents: vi.fn(() => () => {}),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { invalidateCache } from "../../lib/public/js/lib/api-cache.js";
import { gatewayShellStore } from "../../lib/public/js/components/restart-progress-card.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { useAppShellController } from "../../lib/public/js/hooks/use-app-shell-controller.js";

const harness = preactHooks.__harness;

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

const renderController = (props = {}) => {
  harness.beginRender();
  const result = useAppShellController(props);
  harness.flushEffects();
  return result;
};

// Renders + flushes effects/microtasks until cascaded state settles.
const settle = async (props = {}) => {
  let result;
  for (let i = 0; i < 6; i += 1) {
    result = renderController(props);
    await flushMicrotasks();
  }
  return result;
};

describe("frontend/app-shell controller (shared status feed)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.reset();
    gatewayShellStore.reset();
    invalidateCache("/api/status");
    invalidateCache("/api/watchdog/status");
    invalidateCache("/api/doctor/status");
    globalThis.window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      location: { reload: vi.fn() },
    };
    api.fetchOnboardStatus.mockResolvedValue({ onboarded: true });
    api.fetchAuthStatus.mockResolvedValue({ authEnabled: false });
    api.fetchAlphaclawVersion.mockResolvedValue({
      currentVersion: "0.9.34",
      hasUpdate: false,
    });
    api.fetchRestartStatus.mockResolvedValue({
      restartRequired: false,
      restartInProgress: false,
      reasons: [],
    });
    api.fetchStatus.mockResolvedValue({ gateway: "running" });
    api.fetchWatchdogStatus.mockResolvedValue({ status: { health: "healthy" } });
    api.fetchDoctorStatus.mockResolvedValue({ status: null });
    api.subscribeStatusEvents.mockImplementation(() => () => {});
  });

  afterEach(() => {
    harness.reset();
    gatewayShellStore.reset();
    vi.useRealTimers();
    delete globalThis.window;
  });

  it("fresh polling-fallback data replaces a latched stream frame (stale SSE must not shadow polls)", async () => {
    // The exact scenario the 15s SSE-staleness fallback exists for: the
    // stream delivered one frame, then hangs while plain HTTP keeps working
    // and reports a DIFFERENT gateway state.
    let streamHandlers = null;
    api.subscribeStatusEvents.mockImplementation((handlers) => {
      streamHandlers = handlers;
      return () => {};
    });
    api.fetchStatus.mockResolvedValue({
      gateway: "stopped",
      state: { state: "down", label: "Gateway is down" },
    });

    let state = await settle();
    expect(state.state.onboarded).toBe(true);
    expect(streamHandlers).toBeTruthy();

    // One stream frame arrives, then the stream goes silent.
    streamHandlers.onOpen();
    streamHandlers.onMessage({
      status: { gateway: "running", state: { state: "running", label: "Running" } },
    });
    state = await settle();
    expect(state.state.sharedStatus.gateway).toBe("running");

    // Past the 5s polling grace and the 15s staleness budget: the staleness
    // check flips the stream to disconnected and the polls re-enable.
    await vi.advanceTimersByTimeAsync(21000);
    state = await settle();
    await vi.advanceTimersByTimeAsync(100);
    state = await settle();

    // The fallback polls fetched fresh data — the UI must render it instead
    // of the frozen stream frame.
    expect(state.state.sharedStatus.gateway).toBe("stopped");
    expect(gatewayShellStore.get().statusState?.state).toBe("down");
  });

  it("a new stream frame re-takes precedence after the polling fallback", async () => {
    let streamHandlers = null;
    api.subscribeStatusEvents.mockImplementation((handlers) => {
      streamHandlers = handlers;
      return () => {};
    });
    api.fetchStatus.mockResolvedValue({ gateway: "stopped" });

    let state = await settle();
    streamHandlers.onOpen();
    streamHandlers.onMessage({ status: { gateway: "running" } });
    state = await settle();

    await vi.advanceTimersByTimeAsync(21000);
    state = await settle();
    await vi.advanceTimersByTimeAsync(100);
    state = await settle();
    expect(state.state.sharedStatus.gateway).toBe("stopped");

    // The reopened stream recovers and delivers a frame: stream data wins
    // again.
    streamHandlers.onOpen();
    streamHandlers.onMessage({ status: { gateway: "running" } });
    state = await settle();
    expect(state.state.sharedStatus.gateway).toBe("running");
  });

  it("managed update: never reloads against the OLD process — only once the polled process reports the new version", async () => {
    api.updateAlphaclaw.mockResolvedValue({
      ok: true,
      managedUpdate: true,
      previousVersion: "0.9.34",
    });
    // The old process keeps serving /api/status during the external deploy.
    api.fetchStatus.mockResolvedValue({
      gateway: "running",
      alphaclawVersion: "0.9.34",
    });

    const state = await settle();
    await state.actions.handleAcUpdate();
    await flushMicrotasks();

    // First poll at the +8s grace succeeds against the still-running old
    // process: NO reload (pre-fix this reloaded deterministically here).
    await vi.advanceTimersByTimeAsync(8000);
    expect(globalThis.window.location.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(globalThis.window.location.reload).not.toHaveBeenCalled();

    // The platform swaps the deploy in: the next poll reports the new
    // version and the reload fires exactly once.
    api.fetchStatus.mockResolvedValue({
      gateway: "running",
      alphaclawVersion: "0.9.35",
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(globalThis.window.location.reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(globalThis.window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("non-managed self-update keeps reload-on-first-successful-poll", async () => {
    api.updateAlphaclaw.mockResolvedValue({ ok: true, managedUpdate: false });
    api.fetchStatus.mockResolvedValue({ gateway: "running" });

    const state = await settle();
    await state.actions.handleAcUpdate();
    await flushMicrotasks();

    await vi.advanceTimersByTimeAsync(5000);
    expect(globalThis.window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("publishes an openSetup action that reopens the onboarding surface (server 'setup' action)", async () => {
    let state = await settle();
    expect(state.state.onboarded).toBe(true);

    const { openSetup } = gatewayShellStore.get().actions;
    expect(typeof openSetup).toBe("function");

    // Dispatching the server's not_onboarded "Set up" action drops the user
    // into the Welcome wizard (the app's existing setup surface).
    openSetup();
    state = renderController({});
    expect(state.state.onboarded).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Restart operation pipeline (M3): optimistic start, SSE step stream,
  // honest terminal outcomes, restart-safe rehydration.
  // -----------------------------------------------------------------------

  it("restart click: optimistic __requesting frame → SSE attach → real steps replace the placeholder → done lands the success outcome", async () => {
    let restartHandlers = null;
    api.subscribeGatewayRestartEvents.mockImplementation((options) => {
      restartHandlers = options;
      return vi.fn();
    });
    let resolveRestart = null;
    api.restartGatewayAsync.mockImplementation(
      () => new Promise((resolve) => (resolveRestart = resolve)),
    );

    let state = await settle();
    expect(api.subscribeGatewayRestartEvents).not.toHaveBeenCalled();

    // The optimistic frame renders BEFORE the 202 lands (no await).
    state.actions.handleGatewayRestart();
    state = renderController({});
    expect(state.state.restartOperation.phase).toBe("running");
    expect(state.state.restartOperation.steps).toEqual([
      expect.objectContaining({ name: "__requesting", status: "running" }),
    ]);
    expect(api.subscribeGatewayRestartEvents).not.toHaveBeenCalled();

    // 202 {operationId} → the SSE subscription attaches to that operation,
    // keeping the placeholder until the first real step lands.
    resolveRestart({ ok: true, operationId: "op-1" });
    await flushMicrotasks();
    expect(api.subscribeGatewayRestartEvents).toHaveBeenCalledTimes(1);
    expect(api.subscribeGatewayRestartEvents).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "op-1" }),
    );
    state = renderController({});
    expect(state.state.restartOperation.operationId).toBe("op-1");
    expect(state.state.restartOperation.steps).toEqual([
      expect.objectContaining({ name: "__requesting" }),
    ]);

    // First real step REPLACES the optimistic placeholder.
    restartHandlers.onMessage({
      event: "step",
      data: { name: "stopping", label: "Stopping gateway", status: "running" },
    });
    state = renderController({});
    expect(state.state.restartOperation.steps).toEqual([
      { name: "stopping", label: "Stopping gateway", status: "running" },
    ]);
    restartHandlers.onMessage({
      event: "step",
      data: { name: "launching", label: "Starting gateway", status: "running" },
    });

    // Terminal `done` with the measured downtime → success outcome.
    restartHandlers.onMessage({
      event: "done",
      data: { ok: true, durationMs: 4200, downtimeMs: 1800 },
    });
    state = await settle();
    expect(state.state.restartOperation.phase).toBe("succeeded");
    expect(state.state.restartOperation.downtimeMs).toBe(1800);
    expect(gatewayShellStore.get().restartOperation.phase).toBe("succeeded");
    // Off the Gateway surfaces (location "") the outcome also toasts.
    expect(showToast).toHaveBeenCalledWith(
      "Gateway restarted — ready in 2s",
      "success",
    );

    // The success outcome auto-collapses after the grace window.
    await vi.advanceTimersByTimeAsync(8000);
    state = renderController({});
    expect(state.state.restartOperation).toBeNull();
  });

  it("apply_in_progress rejection clears the operation (no permanently spinning card) and toasts", async () => {
    api.restartGatewayAsync.mockRejectedValue(
      Object.assign(new Error("A channel update is in progress"), {
        code: "apply_in_progress",
        status: 409,
      }),
    );

    let state = await settle();
    await state.actions.handleGatewayRestart();
    state = renderController({});

    expect(state.state.restartOperation).toBeNull();
    expect(gatewayShellStore.get().restartOperation).toBeNull();
    expect(api.subscribeGatewayRestartEvents).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      "A channel update is in progress",
      "error",
    );
  });

  it("version skew: a 200 without operationId is treated as a synchronous success — no SSE attach", async () => {
    api.restartGatewayAsync.mockResolvedValue({ ok: true });

    let state = await settle();
    await state.actions.handleGatewayRestart();
    await flushMicrotasks();
    state = renderController({});

    expect(api.subscribeGatewayRestartEvents).not.toHaveBeenCalled();
    expect(state.state.restartOperation.phase).toBe("succeeded");
    expect(state.state.restartOperation.durationMs).toBeNull();
    expect(showToast).toHaveBeenCalledWith("Gateway restarted", "success");
  });

  it("SSE drop mid-operation resolves from the server: still-running re-attaches, a terminal record lands the outcome", async () => {
    let restartHandlers = null;
    api.subscribeGatewayRestartEvents.mockImplementation((options) => {
      restartHandlers = options;
      return vi.fn();
    });
    api.restartGatewayAsync.mockResolvedValue({ ok: true, operationId: "op-2" });

    let state = await settle();
    await state.actions.handleGatewayRestart();
    await flushMicrotasks();
    state = await settle();
    expect(api.subscribeGatewayRestartEvents).toHaveBeenCalledTimes(1);

    // Drop #1: the persisted record says the operation is STILL running →
    // a re-attach is scheduled (SSE replay restores the step list).
    api.fetchRestartStatus.mockResolvedValue({
      restartRequired: false,
      restartInProgress: true,
      reasons: [],
      activeOperation: { operationId: "op-2", status: "running" },
    });
    restartHandlers.onError();
    await flushMicrotasks();
    expect(api.subscribeGatewayRestartEvents).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.subscribeGatewayRestartEvents).toHaveBeenCalledTimes(2);
    expect(api.subscribeGatewayRestartEvents).toHaveBeenLastCalledWith(
      expect.objectContaining({ operationId: "op-2" }),
    );
    state = renderController({});
    expect(state.state.restartOperation.phase).toBe("running");

    // Drop #2: the record reached a terminal state while the stream was
    // down → the outcome resolves from the record, never spins forever.
    api.fetchRestartStatus.mockResolvedValue({
      restartRequired: false,
      restartInProgress: false,
      reasons: [],
      lastOperation: {
        operationId: "op-2",
        status: "succeeded",
        durationMs: 5000,
        downtimeMs: 2500,
      },
    });
    restartHandlers.onError();
    await flushMicrotasks();
    state = renderController({});
    expect(state.state.restartOperation.phase).toBe("succeeded");
    expect(state.state.restartOperation.downtimeMs).toBe(2500);
  });

  it("reload mid-restart: mount sees the persisted activeOperation and attaches to it", async () => {
    api.subscribeGatewayRestartEvents.mockImplementation(() => vi.fn());
    api.fetchRestartStatus.mockResolvedValue({
      restartRequired: false,
      restartInProgress: true,
      reasons: [],
      activeOperation: { operationId: "op-9", status: "running" },
    });

    const state = await settle();

    expect(api.subscribeGatewayRestartEvents).toHaveBeenCalledTimes(1);
    expect(api.subscribeGatewayRestartEvents).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "op-9" }),
    );
    expect(state.state.restartOperation).toEqual(
      expect.objectContaining({
        operationId: "op-9",
        phase: "running",
        resumed: true,
      }),
    );
  });

  it("an unacknowledged failed lastOperation survives the reload; dismissing acknowledges it for good", async () => {
    api.fetchRestartStatus.mockResolvedValue({
      restartRequired: false,
      restartInProgress: false,
      reasons: [],
      lastOperation: {
        operationId: "op-8",
        status: "failed",
        errorSummary: "gateway exited with code 1",
        startedAt: 1000,
        durationMs: 9000,
      },
    });

    let state = await settle();
    expect(state.state.restartOperation.phase).toBe("failed");
    expect(state.state.restartOperation.error.message).toBe(
      "gateway exited with code 1",
    );

    // Dismiss acknowledges op-8; the next server refresh reports the SAME
    // lastOperation but it must not resurface.
    state.actions.dismissRestartOutcome();
    state = renderController({});
    expect(state.state.restartOperation).toBeNull();
    await state.actions.dismissRestartBanner();
    state = await settle();
    expect(state.state.restartOperation).toBeNull();
  });

  it("rollback: a rejected rollback only toasts; a successful one begins the reconnect with its grace window", async () => {
    let state = await settle();
    const rollBack = gatewayShellStore.get().actions.rollBack;

    api.rollbackOpenclaw.mockRejectedValue(new Error("no known-good build"));
    await rollBack();
    state = renderController({});
    expect(showToast).toHaveBeenCalledWith("no known-good build", "error");
    expect(state.state.connectivityMode).toBe("online");
    expect(globalThis.window.location.reload).not.toHaveBeenCalled();

    api.rollbackOpenclaw.mockResolvedValue({ ok: true });
    await rollBack();
    state = renderController({});
    expect(state.state.connectivityMode).toBe("alphaclaw_restarting");

    // Grace window: no probe (and no reload) before the 3s grace elapses;
    // the first successful poll after it reloads exactly once.
    await vi.advanceTimersByTimeAsync(2999);
    expect(globalThis.window.location.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(globalThis.window.location.reload).toHaveBeenCalledTimes(1);
  });

  it("rollback fence (#20): the 409 raises the data-risk confirm on the shell store; confirm re-sends with consent, cancel clears", async () => {
    let state = await settle();
    const rollBack = gatewayShellStore.get().actions.rollBack;

    api.rollbackOpenclaw.mockRejectedValue(
      Object.assign(
        new Error(
          "This update migrated your state databases — the rollback target may not be able to read them.",
        ),
        {
          code: "rollback_requires_confirmation",
          status: 409,
          backupFile: "backup-2026-08-29.tar.gz",
        },
      ),
    );
    await rollBack();
    state = renderController({});
    // A consent gate, not a failure: no toast, no reconnect handoff — the
    // Gateway card renders the second-stage confirm off this slice.
    expect(showToast).not.toHaveBeenCalled();
    expect(state.state.connectivityMode).toBe("online");
    expect(gatewayShellStore.get().rollbackDataRisk).toEqual({
      message:
        "This update migrated your state databases — the rollback target may not be able to read them.",
      backupFile: "backup-2026-08-29.tar.gz",
    });

    // Cancel clears the slice without another API call.
    gatewayShellStore.get().actions.cancelRollbackDataRisk();
    state = renderController({});
    expect(gatewayShellStore.get().rollbackDataRisk).toBeNull();
    expect(api.rollbackOpenclaw).toHaveBeenCalledTimes(1);
    expect(api.rollbackOpenclaw).toHaveBeenLastCalledWith({});

    // Re-raise the fence, then confirm: the rollback re-sends WITH consent
    // and the success path (toast + reconnect) runs as usual.
    await rollBack();
    state = renderController({});
    expect(gatewayShellStore.get().rollbackDataRisk).not.toBeNull();
    api.rollbackOpenclaw.mockResolvedValue({ ok: true });
    await gatewayShellStore.get().actions.confirmRollbackDataRisk();
    state = renderController({});
    expect(api.rollbackOpenclaw).toHaveBeenLastCalledWith({
      confirmDataRisk: true,
    });
    expect(gatewayShellStore.get().rollbackDataRisk).toBeNull();
    expect(showToast).toHaveBeenCalledWith(
      "Rolling back to the last known-good build — AlphaClaw is restarting",
      "info",
    );
    expect(state.state.connectivityMode).toBe("alphaclaw_restarting");
  });

  it("Retry after a managed update reuses the SAME isReady discriminator — never reloads against the old process", async () => {
    api.updateAlphaclaw.mockResolvedValue({
      ok: true,
      managedUpdate: true,
      previousVersion: "0.9.34",
    });
    api.fetchStatus.mockResolvedValue({
      gateway: "running",
      alphaclawVersion: "0.9.34",
    });

    let state = await settle();
    await state.actions.handleAcUpdate();
    await flushMicrotasks();
    state = renderController({});
    expect(state.state.connectivityMode).toBe("alphaclaw_restarting");

    // Manual Retry while the deploy is still swapping: the remembered poller
    // options (minus the grace) restart the poll.
    state.actions.handleRetryConnect();

    // The old process keeps answering with the OLD version: reachable but
    // NOT ready — the retry must not reload against it.
    await vi.advanceTimersByTimeAsync(3000);
    expect(globalThis.window.location.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(globalThis.window.location.reload).not.toHaveBeenCalled();

    // The platform swaps the deploy in: the next poll reports the new
    // version and the reload fires exactly once.
    api.fetchStatus.mockResolvedValue({
      gateway: "running",
      alphaclawVersion: "0.9.35",
    });
    await vi.advanceTimersByTimeAsync(3000);
    expect(globalThis.window.location.reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30000);
    expect(globalThis.window.location.reload).toHaveBeenCalledTimes(1);
  });
});

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
});

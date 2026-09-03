import { beforeEach, describe, expect, it, vi } from "vitest";

// Slot harness (cron-tab.test.js pattern) with dep tracking: useEffect records
// deps per slot and an effect is queued only when its deps changed.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, pendingEffects: [] };
  harness.beginRender = () => {
    harness.cursor = 0;
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.pendingEffects = [];
  };
  const depsChanged = (previousDeps, nextDeps) =>
    !previousDeps ||
    !nextDeps ||
    previousDeps.length !== nextDeps.length ||
    nextDeps.some((dep, index) => !Object.is(dep, previousDeps[index]));
  harness.flushEffects = () => {
    const pending = harness.pendingEffects.splice(0);
    for (const { slot, effect } of pending) {
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = effect() || null;
    }
    return pending.length;
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = {
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
      harness.slots[index] = { ref: { current: initialValue } };
    }
    return harness.slots[index].ref;
  };
  const useMemo = (factory, deps) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { computed: false };
    const slot = harness.slots[index];
    if (!slot.computed || depsChanged(slot.deps, deps)) {
      slot.value = factory();
      slot.deps = deps;
      slot.computed = true;
    }
    return slot.value;
  };
  const useCallback = (fn) => fn;
  const useEffect = (effect, deps) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { ran: false, cleanup: null };
    }
    const slot = harness.slots[index];
    const changed = !slot.ran || depsChanged(slot.deps, deps);
    slot.deps = deps;
    slot.ran = true;
    if (changed) harness.pendingEffects.push({ slot, effect });
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

// usePolling stand-in: refresh is a recorder; the real hook's own mount fetch
// is out of scope here (covered by its own suite).
vi.mock("../../lib/public/js/hooks/usePolling.js", () => {
  const registry = { slots: [], cursor: 0 };
  registry.beginRender = () => {
    registry.cursor = 0;
  };
  registry.ensureSlot = (index) => {
    if (!registry.slots[index]) {
      registry.slots[index] = {
        data: null,
        error: null,
        isPolling: false,
        refresh: vi.fn(async () => null),
      };
    }
    return registry.slots[index];
  };
  registry.reset = () => {
    registry.slots = [];
    registry.cursor = 0;
  };
  const usePolling = (fetcher, interval, options = {}) => {
    const slot = registry.ensureSlot(registry.cursor++);
    slot.fetcher = fetcher;
    slot.options = options;
    return {
      data: slot.data,
      error: slot.error,
      refresh: slot.refresh,
      isPolling: slot.isPolling,
    };
  };
  return { usePolling, __pollRegistry: registry };
});

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchWebhookRequest: vi.fn(),
  fetchWebhookRequests: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import { __pollRegistry } from "../../lib/public/js/hooks/usePolling.js";
import { useRequestHistory } from "../../lib/public/js/components/webhooks/request-history/use-request-history.js";

const harness = preactHooks.__harness;

const renderHook = (props = {}) => {
  harness.beginRender();
  __pollRegistry.beginRender();
  return useRequestHistory({ selectedHookName: "hook-1", ...props });
};

beforeEach(() => {
  harness.reset();
  __pollRegistry.reset();
  vi.clearAllMocks();
});

describe("frontend/use-request-history refresh nonce", () => {
  it("does not fire an extra refresh on mount — usePolling already fetches", () => {
    renderHook({ refreshNonce: 0 });
    harness.flushEffects();
    expect(__pollRegistry.ensureSlot(0).refresh).not.toHaveBeenCalled();

    // Unrelated re-render with the same nonce: still no extra fetch.
    renderHook({ refreshNonce: 0 });
    harness.flushEffects();
    expect(__pollRegistry.ensureSlot(0).refresh).not.toHaveBeenCalled();
  });

  it("refreshes when the nonce actually changes", () => {
    renderHook({ refreshNonce: 0 });
    harness.flushEffects();

    renderHook({ refreshNonce: 1 });
    harness.flushEffects();
    expect(__pollRegistry.ensureSlot(0).refresh).toHaveBeenCalledTimes(1);
  });
});

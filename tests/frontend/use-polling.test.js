import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deps-aware hook harness: unlike the collect-only harness in the upgrade-tab
// tests, usePolling's visibility fix depends on effects re-running when their
// dependency arrays change (and cleanups firing first), so this harness tracks
// deps per slot and flushes scheduled effects after each render.
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

import * as preactHooks from "preact/hooks";
import { usePolling } from "../../lib/public/js/hooks/usePolling.js";
import { setCached, invalidateCache } from "../../lib/public/js/lib/api-cache.js";

const harness = preactHooks.__harness;

const kIntervalMs = 3000;

const flushMicrotasks = async () => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

describe("frontend/use-polling visibility", () => {
  let fetcher;
  let visibilityListeners;
  let hookResult;

  const setDocumentHidden = (hidden) => {
    Object.defineProperty(globalThis.document, "hidden", {
      configurable: true,
      value: hidden,
    });
  };

  const dispatchVisibilityChange = () => {
    for (const listener of [...visibilityListeners]) listener();
  };

  const renderPolling = (options = {}) => {
    harness.beginRender();
    hookResult = usePolling(fetcher, kIntervalMs, options);
    harness.flushEffects();
    return hookResult;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    harness.reset();
    fetcher = vi.fn(async () => ({ ok: true }));
    visibilityListeners = [];
    globalThis.document = {
      addEventListener: (type, listener) => {
        if (type === "visibilitychange") visibilityListeners.push(listener);
      },
      removeEventListener: (type, listener) => {
        visibilityListeners = visibilityListeners.filter(
          (entry) => entry !== listener,
        );
      },
    };
    setDocumentHidden(false);
  });

  afterEach(() => {
    harness.reset();
    vi.useRealTimers();
    delete globalThis.document;
  });

  it("mounted hidden: never fetches until the tab becomes visible, then polls", async () => {
    setDocumentHidden(true);
    renderPolling({ pauseWhenHidden: true });

    // The regression: mounting while hidden must not fetch — and must not
    // stay dead forever either.
    await vi.advanceTimersByTimeAsync(kIntervalMs * 4);
    expect(fetcher).not.toHaveBeenCalled();

    setDocumentHidden(false);
    dispatchVisibilityChange();
    renderPolling({ pauseWhenHidden: true });
    await flushMicrotasks();

    // Becoming visible starts the interval effect: immediate refresh...
    expect(fetcher).toHaveBeenCalledTimes(1);

    // ...and a real recurring interval (the pre-fix behavior only did a
    // one-shot refresh from the visibility listener).
    await vi.advanceTimersByTimeAsync(kIntervalMs);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(kIntervalMs);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("mounted visible: fetches immediately and keeps polling on the interval", async () => {
    renderPolling({ pauseWhenHidden: true });
    await flushMicrotasks();

    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(kIntervalMs);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("stops the interval when the tab goes hidden and resumes when visible", async () => {
    renderPolling({ pauseWhenHidden: true });
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(1);

    setDocumentHidden(true);
    dispatchVisibilityChange();
    renderPolling({ pauseWhenHidden: true });

    await vi.advanceTimersByTimeAsync(kIntervalMs * 3);
    expect(fetcher).toHaveBeenCalledTimes(1);

    setDocumentHidden(false);
    dispatchVisibilityChange();
    renderPolling({ pauseWhenHidden: true });
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("ignores visibility entirely when pauseWhenHidden is false", async () => {
    setDocumentHidden(true);
    renderPolling({ pauseWhenHidden: false });
    await flushMicrotasks();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(visibilityListeners).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(kIntervalMs);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not fetch while disabled, even when visible", async () => {
    renderPolling({ enabled: false, pauseWhenHidden: true });
    await vi.advanceTimersByTimeAsync(kIntervalMs * 3);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("seeds initial data from the cache when a cacheKey is provided (warm paint)", async () => {
    const cacheKey = "use-polling-test-warm-paint";
    setCached(cacheKey, { events: ["cached"] });
    try {
      const result = renderPolling({ pauseWhenHidden: true, cacheKey });
      expect(result.data).toEqual({ events: ["cached"] });
    } finally {
      invalidateCache(cacheKey);
    }
  });

  it("cleans up its interval and visibility listener on unmount", async () => {
    renderPolling({ pauseWhenHidden: true });
    await flushMicrotasks();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(visibilityListeners).toHaveLength(1);

    harness.unmount();
    expect(visibilityListeners).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(kIntervalMs * 3);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

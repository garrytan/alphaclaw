import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deps-aware hook harness (use-polling.test.js pattern): effects re-run when
// their deps change, cleanups fire first, refs/state live in call-index slots.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, pendingEffects: [] };
  const depsChanged = (previousDeps, nextDeps) =>
    !previousDeps ||
    !nextDeps ||
    previousDeps.length !== nextDeps.length ||
    nextDeps.some((dep, index) => !Object.is(dep, previousDeps[index]));
  harness.beginRender = () => {
    harness.cursor = 0;
  };
  harness.flushEffects = () => {
    const pending = harness.pendingEffects.splice(0);
    for (const { slot, effect } of pending) {
      if (typeof slot.cleanup === "function") slot.cleanup();
      slot.cleanup = effect() || null;
    }
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
    if (!(index in harness.slots)) harness.slots[index] = { kind: "ref", current: initialValue };
    return harness.slots[index];
  };
  const useCallback = (fn) => fn;
  const useMemo = (factory) => factory();
  const useEffect = (effect, deps) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { kind: "effect", ran: false, cleanup: null };
    const slot = harness.slots[index];
    const changed = !slot.ran || depsChanged(slot.deps, deps);
    slot.deps = deps;
    slot.ran = true;
    if (changed) harness.pendingEffects.push({ slot, effect });
  };
  return { useState, useRef, useCallback, useMemo, useEffect, __harness: harness };
});

import * as preactHooks from "preact/hooks";
import { useVisibleInterval } from "../../lib/public/js/hooks/use-visible-interval.js";

const harness = preactHooks.__harness;

// A document double with a settable `hidden` flag and a captured
// visibilitychange listener list.
const makeDocument = ({ hidden = false } = {}) => {
  const listeners = new Set();
  return {
    hidden,
    addEventListener: vi.fn((type, handler) => {
      if (type === "visibilitychange") listeners.add(handler);
    }),
    removeEventListener: vi.fn((type, handler) => {
      if (type === "visibilitychange") listeners.delete(handler);
    }),
    fire() {
      for (const handler of [...listeners]) handler();
    },
    listenerCount: () => listeners.size,
  };
};

const render = (callback, intervalMs, options) => {
  harness.beginRender();
  useVisibleInterval(callback, intervalMs, options);
  harness.flushEffects();
};

describe("frontend/hooks useVisibleInterval (fix wave PR 11 polling primitive)", () => {
  let doc;

  beforeEach(() => {
    harness.reset();
    vi.useFakeTimers();
    doc = makeDocument();
    vi.stubGlobal("document", doc);
    // No `window` in this test: the hook falls back to the bare timer globals.
    vi.stubGlobal("window", undefined);
  });

  afterEach(() => {
    harness.unmount();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("ticks on the interval, not before, and stops on cleanup", () => {
    const tick = vi.fn();
    render(tick, 1000);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(tick).toHaveBeenCalledTimes(4);
    harness.unmount();
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(4);
    expect(doc.listenerCount()).toBe(0);
  });

  it("`immediate` runs the callback once when the interval starts", () => {
    const tick = vi.fn();
    render(tick, 1000, { immediate: true });
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("does not tick while hidden and runs ONCE immediately when the tab comes back", () => {
    const tick = vi.fn();
    doc.hidden = true;
    render(tick, 1000);
    vi.advanceTimersByTime(10_000);
    expect(tick).not.toHaveBeenCalled();
    // No interval was even scheduled while hidden (no wasted timers).
    expect(vi.getTimerCount()).toBe(0);

    doc.hidden = false;
    doc.fire();
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);

    doc.hidden = true;
    doc.fire();
    vi.advanceTimersByTime(10_000);
    expect(tick).toHaveBeenCalledTimes(2);
    // A second visibility event while already visible must not double-start.
    doc.hidden = false;
    doc.fire();
    doc.fire();
    expect(tick).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(4);
  });

  it("`pauseWhenHidden: false` keeps ticking while hidden and registers no visibility listener", () => {
    const tick = vi.fn();
    doc.hidden = true;
    render(tick, 500, { pauseWhenHidden: false });
    vi.advanceTimersByTime(1500);
    expect(tick).toHaveBeenCalledTimes(3);
    expect(doc.addEventListener).not.toHaveBeenCalled();
  });

  it("`enabled: false` (or a non-positive interval) schedules nothing", () => {
    const tick = vi.fn();
    render(tick, 1000, { enabled: false });
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    harness.reset();
    render(tick, 0);
    vi.advanceTimersByTime(5000);
    expect(tick).not.toHaveBeenCalled();
  });

  it("always fires the LATEST callback (ref-backed) without restarting the interval", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(first, 1000);
    vi.advanceTimersByTime(1000);
    expect(first).toHaveBeenCalledTimes(1);
    // Re-render with a new closure: same deps, so the effect (and timer) is kept.
    render(second, 1000);
    vi.advanceTimersByTime(1000);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("a throwing tick neither kills the interval nor escapes", () => {
    let calls = 0;
    const tick = vi.fn(() => {
      calls += 1;
      if (calls === 1) throw new Error("boom");
    });
    render(tick, 1000);
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
  });

  it("returns the callback's result from a tick so an async poll can be awaited through a captured interval callback", async () => {
    const captured = [];
    vi.stubGlobal("window", {
      setInterval: (callback) => {
        captured.push(callback);
        return captured.length;
      },
      clearInterval: vi.fn(),
    });
    let settled = false;
    render(() => Promise.resolve().then(() => {
      settled = true;
    }), 1000);
    expect(captured).toHaveLength(1);
    await captured[0]();
    expect(settled).toBe(true);
  });
});

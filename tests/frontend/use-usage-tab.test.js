import { beforeEach, describe, expect, it, vi } from "vitest";

// Slot harness (cron-tab.test.js pattern) with dep tracking. useCallback is
// also dep-aware here: the [loadSummary] effect must refire only when `days`
// changes, exactly like preact — that scheduling is the race under test.
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
  const useCallback = (fn, deps) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { computed: false };
    const slot = harness.slots[index];
    if (!slot.computed || depsChanged(slot.deps, deps)) {
      slot.value = fn;
      slot.deps = deps;
      slot.computed = true;
    }
    return slot.value;
  };
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

vi.mock("chart.js/auto", () => ({
  default: class ChartStub {
    destroy() {}
  },
}));

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchUsageSessionDetail: vi.fn(),
  fetchUsageSessions: vi.fn(async () => ({ sessions: [] })),
  fetchUsageSummary: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/ui-settings.js", () => ({
  readUiSettings: vi.fn(() => ({})),
  writeUiSettings: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import {
  fetchUsageSessionDetail,
  fetchUsageSummary,
} from "../../lib/public/js/lib/api.js";
import { useUsageTab } from "../../lib/public/js/components/usage-tab/use-usage-tab.js";

const harness = preactHooks.__harness;

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const flushAsync = async () => {
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
};

const renderHook = (props = {}) => {
  harness.beginRender();
  return useUsageTab({ sessionId: "", ...props });
};

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  fetchUsageSummary.mockResolvedValue({ summary: null });
});

describe("frontend/use-usage-tab summary range race", () => {
  it("a slow response for the previous range cannot overwrite the new range's summary", async () => {
    const slow30 = deferred();
    fetchUsageSummary.mockReturnValueOnce(slow30.promise);
    const hook = renderHook();
    harness.flushEffects(); // mount: loadSummary(days=30) in flight

    const fast7 = deferred();
    fetchUsageSummary.mockReturnValueOnce(fast7.promise);
    hook.actions.setDays(7);
    renderHook();
    harness.flushEffects(); // days changed: loadSummary(days=7) dispatched

    fast7.resolve({ summary: { daily: [], totals: { totalTokens: 7 } } });
    await flushAsync();
    slow30.resolve({ summary: { daily: [], totals: { totalTokens: 30 } } });
    await flushAsync();

    const result = renderHook();
    expect(result.state.summary.totals.totalTokens).toBe(7);
    expect(result.state.loadingSummary).toBe(false);
  });
});

describe("frontend/use-usage-tab deep-link session detail", () => {
  it("records a terminal error sentinel and does not refire the deep-link fetch after failure", async () => {
    fetchUsageSessionDetail.mockRejectedValue(new Error("detail down"));
    renderHook({ sessionId: "s1" });
    harness.flushEffects();
    await flushAsync();

    // Re-renders keep flowing (polls, parent updates): the failed attempt
    // must not be retried automatically.
    renderHook({ sessionId: "s1" });
    harness.flushEffects();
    await flushAsync();
    renderHook({ sessionId: "s1" });
    harness.flushEffects();
    await flushAsync();

    expect(fetchUsageSessionDetail).toHaveBeenCalledTimes(1);
    const result = renderHook({ sessionId: "s1" });
    expect(result.state.sessionDetailById.s1).toEqual({
      status: "error",
      message: "detail down",
    });
  });

  it("still loads the detail once on deep link", async () => {
    fetchUsageSessionDetail.mockResolvedValue({ detail: { sessionKey: "k1" } });
    renderHook({ sessionId: "s1" });
    harness.flushEffects();
    await flushAsync();
    renderHook({ sessionId: "s1" });
    harness.flushEffects();
    await flushAsync();

    expect(fetchUsageSessionDetail).toHaveBeenCalledTimes(1);
    const result = renderHook({ sessionId: "s1" });
    expect(result.state.sessionDetailById.s1).toEqual({ sessionKey: "k1" });
    expect(result.state.expandedSessionIds).toContain("s1");
  });
});

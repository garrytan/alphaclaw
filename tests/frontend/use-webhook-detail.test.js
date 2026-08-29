import { beforeEach, describe, expect, it, vi } from "vitest";

// Slot harness (cron-tab.test.js pattern) with dep tracking: useEffect/useMemo
// record deps per slot and an effect is queued only when its deps changed, so
// tests can model background refetches (new object, same values) faithfully.
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

vi.mock("../../lib/public/js/lib/api.js", () => ({
  deleteWebhook: vi.fn(),
  fetchAgents: vi.fn(),
  fetchWebhookDetail: vi.fn(),
  rotateWebhookOauthCallback: vi.fn(),
  updateWebhookDestination: vi.fn(),
}));

// use-cached-fetch stand-in: per-call-index slots the tests drive directly.
vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => {
  const registry = { slots: [], cursor: 0 };
  registry.beginRender = () => {
    registry.cursor = 0;
  };
  registry.ensureSlot = (index) => {
    if (!registry.slots[index]) {
      registry.slots[index] = {
        data: null,
        loading: false,
        error: null,
        refresh: vi.fn(async () => null),
      };
    }
    return registry.slots[index];
  };
  registry.reset = () => {
    registry.slots = [];
    registry.cursor = 0;
  };
  const useCachedFetch = () => {
    const slot = registry.ensureSlot(registry.cursor++);
    return {
      data: slot.data,
      loading: slot.loading,
      error: slot.error,
      refresh: slot.refresh,
    };
  };
  return { useCachedFetch, __cachedFetchRegistry: registry };
});

vi.mock(
  "../../lib/public/js/hooks/use-destination-session-selection.js",
  () => {
    const destination = {
      sessions: [],
      loading: false,
      error: "",
      destinationSessionKey: "",
      selectedDestination: null,
      setCalls: [],
    };
    // Stable setter identity: it sits in the sync effect's dep array.
    const setDestinationSessionKey = (key) => destination.setCalls.push(key);
    destination.reset = () => {
      destination.sessions = [];
      destination.loading = false;
      destination.error = "";
      destination.destinationSessionKey = "";
      destination.selectedDestination = null;
      destination.setCalls = [];
    };
    const useDestinationSessionSelection = () => ({
      sessions: destination.sessions,
      loading: destination.loading,
      error: destination.error,
      destinationSessionKey: destination.destinationSessionKey,
      setDestinationSessionKey,
      selectedDestination: destination.selectedDestination,
    });
    return {
      useDestinationSessionSelection,
      kNoDestinationSessionValue: "__none__",
      __destinationState: destination,
    };
  },
);

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import { __cachedFetchRegistry } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { __destinationState } from "../../lib/public/js/hooks/use-destination-session-selection.js";
import { deleteWebhook } from "../../lib/public/js/lib/api.js";
import { getCached, setCached } from "../../lib/public/js/lib/api-cache.js";
import { useWebhookDetail } from "../../lib/public/js/components/webhooks/webhook-detail/use-webhook-detail.js";

const harness = preactHooks.__harness;

const flushAsync = async () => {
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
};

const kSessionOne = {
  key: "agent:main:telegram:direct:111",
  replyChannel: "telegram",
  replyTo: "111",
};
const kSessionTwo = {
  key: "agent:main:telegram:direct:222",
  replyChannel: "telegram",
  replyTo: "222",
};

const makeWebhook = (overrides = {}) => ({
  name: "hook-1",
  managed: false,
  agentId: "main",
  channel: "telegram",
  to: "111",
  ...overrides,
});

const renderHook = (props = {}) => {
  harness.beginRender();
  __cachedFetchRegistry.beginRender();
  return useWebhookDetail({ selectedHookName: "hook-1", ...props });
};

// Slot 0 = webhook detail fetch, slot 1 = agents fetch.
const detailSlot = () => __cachedFetchRegistry.ensureSlot(0);
const agentsSlot = () => __cachedFetchRegistry.ensureSlot(1);

beforeEach(() => {
  harness.reset();
  __cachedFetchRegistry.reset();
  __destinationState.reset();
  vi.clearAllMocks();
});

describe("frontend/use-webhook-detail destination sync", () => {
  it("applies the stored destination once sessions and webhook are loaded", () => {
    detailSlot().data = makeWebhook();
    __destinationState.sessions = [kSessionOne, kSessionTwo];
    renderHook();
    harness.flushEffects();
    expect(__destinationState.setCalls).toEqual([kSessionOne.key]);
  });

  it("does not reset the select when a background refetch returns an identical destination (new object identity)", () => {
    detailSlot().data = makeWebhook();
    __destinationState.sessions = [kSessionOne, kSessionTwo];
    renderHook();
    harness.flushEffects();

    // User picks a different session (unsaved manual selection).
    const hook = renderHook();
    harness.flushEffects();
    hook.actions.setDestinationSessionKey(kSessionTwo.key);
    expect(__destinationState.setCalls).toEqual([
      kSessionOne.key,
      kSessionTwo.key,
    ]);

    // 15s poll refetch: same values, new object. Pre-fix this re-ran the sync
    // effect (object-identity dep) and clobbered the user's selection.
    detailSlot().data = makeWebhook();
    renderHook();
    harness.flushEffects();
    expect(__destinationState.setCalls).toEqual([
      kSessionOne.key,
      kSessionTwo.key,
    ]);
  });

  it("re-syncs when the stored destination value actually changes", () => {
    detailSlot().data = makeWebhook();
    __destinationState.sessions = [kSessionOne, kSessionTwo];
    const hook = renderHook();
    harness.flushEffects();
    hook.actions.setDestinationSessionKey(kSessionTwo.key);

    detailSlot().data = makeWebhook({ to: "222" });
    renderHook();
    harness.flushEffects();
    expect(__destinationState.setCalls.at(-1)).toBe(kSessionTwo.key);
    expect(__destinationState.setCalls.length).toBe(3);
  });
});

describe("frontend/use-webhook-detail delete", () => {
  it("invalidates the cached detail and swallows refresh rejections", async () => {
    const detailCacheKey = "/api/webhooks/hook-1";
    setCached(detailCacheKey, makeWebhook());
    detailSlot().data = makeWebhook();
    deleteWebhook.mockResolvedValue({});
    agentsSlot().refresh.mockRejectedValue(new Error("agents refresh boom"));

    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const hook = renderHook();
      await hook.actions.handleDeleteConfirmed();
      await flushAsync();
      expect(getCached(detailCacheKey)).toBe(null);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("refreshDetail never surfaces an unhandled rejection", async () => {
    detailSlot().data = makeWebhook();
    detailSlot().refresh.mockRejectedValue(new Error("detail boom"));
    agentsSlot().refresh.mockRejectedValue(new Error("agents boom"));

    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const hook = renderHook();
      hook.actions.refreshDetail();
      await flushAsync();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

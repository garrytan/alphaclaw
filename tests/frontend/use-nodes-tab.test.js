import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as use-saved-setting.test.js): hook
// state lives in per-call-index slots so the hook can be invoked directly
// without a DOM renderer. Effects are collected, not run.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, effects: [] };
  harness.beginRender = () => {
    harness.cursor = 0;
    harness.effects = [];
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.effects = [];
  };
  const useState = (initialValue) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] =
        typeof initialValue === "function" ? initialValue() : initialValue;
    }
    const setState = (next) => {
      harness.slots[index] =
        typeof next === "function" ? next(harness.slots[index]) : next;
    };
    return [harness.slots[index], setState];
  };
  const useRef = (initialValue = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) {
      harness.slots[index] = { current: initialValue };
    }
    return harness.slots[index];
  };
  const useMemo = (factory) => factory();
  const useCallback = (fn) => fn;
  const useEffect = (effect) => {
    harness.effects.push(effect);
  };
  return { useState, useRef, useMemo, useCallback, useEffect, __harness: harness };
});

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchNodeConnectInfo: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: vi.fn(),
}));

vi.mock(
  "../../lib/public/js/components/nodes-tab/connected-nodes/user-connected-nodes.js",
  () => ({
    useConnectedNodes: vi.fn(),
  }),
);

import * as preactHooks from "preact/hooks";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { useConnectedNodes } from "../../lib/public/js/components/nodes-tab/connected-nodes/user-connected-nodes.js";
import { useNodesTab } from "../../lib/public/js/components/nodes-tab/use-nodes-tab.js";

const harness = preactHooks.__harness;

const renderTab = () => {
  harness.beginRender();
  return useNodesTab();
};

describe("frontend/use-nodes-tab", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    useCachedFetch.mockReturnValue({
      data: null,
      error: null,
      loading: false,
      refresh: vi.fn(),
    });
  });

  it("forces node refreshes past any in-flight poll after mutations", async () => {
    const refresh = vi.fn(async () => {});
    useConnectedNodes.mockReturnValue({
      nodes: [],
      pending: [],
      loading: false,
      error: "",
      refresh,
    });
    const tab = renderTab();

    await tab.actions.refreshNodes();
    // force:true skips the dedupe-onto-stale-in-flight path so a refresh
    // dispatched after a mutation can never resolve to pre-mutation data.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith({ force: true });
  });
});

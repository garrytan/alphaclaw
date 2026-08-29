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
  fetchNodeBrowserStatusForNode: vi.fn(),
  removeNode: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/clipboard.js", () => ({
  copyTextToClipboard: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/ui-settings.js", () => ({
  readUiSettings: vi.fn(() => ({})),
  updateUiSettings: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { useConnectedNodesCard } from "../../lib/public/js/components/nodes-tab/connected-nodes/use-connected-nodes-card.js";

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

const renderCard = (options = {}) => {
  harness.beginRender();
  return useConnectedNodesCard({ nodes: [], ...options });
};

describe("frontend/use-connected-nodes-card", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  it("runs checks on different nodes concurrently instead of dropping the click", async () => {
    const gateA = deferred();
    const gateB = deferred();
    api.fetchNodeBrowserStatusForNode.mockImplementation((nodeId) =>
      nodeId === "node-a" ? gateA.promise : gateB.promise,
    );
    let state = renderCard();

    const checkA = state.handleCheckNodeBrowser("node-a");
    const checkB = state.handleCheckNodeBrowser("node-b");
    expect(api.fetchNodeBrowserStatusForNode).toHaveBeenCalledTimes(2);

    state = renderCard();
    expect(state.checkingBrowserNodeIds.has("node-a")).toBe(true);
    expect(state.checkingBrowserNodeIds.has("node-b")).toBe(true);

    gateA.resolve({ status: { running: true } });
    await checkA;
    state = renderCard();
    // node-a settles independently; node-b keeps its own busy affordance.
    expect(state.checkingBrowserNodeIds.has("node-a")).toBe(false);
    expect(state.checkingBrowserNodeIds.has("node-b")).toBe(true);
    expect(state.browserStatusByNodeId["node-a"]).toEqual({ running: true });

    gateB.reject(new Error("b failed"));
    await checkB;
    state = renderCard();
    expect(state.checkingBrowserNodeIds.size).toBe(0);
    expect(state.browserErrorByNodeId["node-b"]).toBe("b failed");
  });

  it("keeps per-node single-flight: a re-click on a busy node is a no-op", async () => {
    const gate = deferred();
    api.fetchNodeBrowserStatusForNode.mockReturnValue(gate.promise);
    const state = renderCard();

    const first = state.handleCheckNodeBrowser("node-a");
    await state.handleCheckNodeBrowser("node-a");
    expect(api.fetchNodeBrowserStatusForNode).toHaveBeenCalledTimes(1);

    gate.resolve({ status: { running: false } });
    await first;
    // The lock releases once the check settles — a new check dispatches.
    const second = state.handleCheckNodeBrowser("node-a");
    expect(api.fetchNodeBrowserStatusForNode).toHaveBeenCalledTimes(2);
    await second;
  });
});

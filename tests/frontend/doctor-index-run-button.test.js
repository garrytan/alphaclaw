import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slot harness (cron-tab.test.js pattern) with dep tracking; the component's
// vnode output is walked directly (saved-toggle-component.test.js pattern).
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

// usePolling stand-in driven directly by the tests.
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
  fetchDoctorCards: vi.fn(),
  fetchDoctorStatus: vi.fn(),
  fetchDoctorRuns: vi.fn(),
  startDoctorRun: vi.fn(),
  updateDoctorCardStatus: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));

// Children with their own suites/heavy deps: keep the walk scoped to the
// header/button behavior under test.
vi.mock("../../lib/public/js/components/doctor/summary-cards.js", () => ({
  DoctorSummaryCards: () => null,
}));
vi.mock("../../lib/public/js/components/doctor/findings-list.js", () => ({
  DoctorFindingsList: () => null,
}));
vi.mock("../../lib/public/js/components/doctor/fix-card-modal.js", () => ({
  DoctorFixCardModal: () => null,
}));

import * as preactHooks from "preact/hooks";
import { __pollRegistry } from "../../lib/public/js/hooks/usePolling.js";
import { startDoctorRun } from "../../lib/public/js/lib/api.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { DoctorTab } from "../../lib/public/js/components/doctor/index.js";

const harness = preactHooks.__harness;

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function") {
    try {
      out.rendered = expandTree(node.type(node.props || {}));
    } catch {
      out.rendered = null;
    }
  }
  if (out.props.children !== undefined) {
    out.props = { ...out.props, children: expandTree(out.props.children) };
  }
  return out;
};

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) {
    collectNodes(node.props.children, out);
    // PageHeader receives its button through the `actions` prop.
    collectNodes(node.props.actions, out);
  }
  if (node.rendered) collectNodes(node.rendered, out);
  return out;
};

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

// Slot 0 = status poll, slot 1 = runs poll, slot 2 = cards poll.
const statusSlot = () => __pollRegistry.ensureSlot(0);
const runsSlot = () => __pollRegistry.ensureSlot(1);
const cardsSlot = () => __pollRegistry.ensureSlot(2);

const renderTab = () => {
  harness.beginRender();
  __pollRegistry.beginRender();
  return expandTree(DoctorTab({ isActive: true }));
};

const runDoctorButton = (tree) =>
  collectNodes(tree).find(
    (vnode) =>
      vnode.type === ActionButton &&
      vnode.props.idleLabel === "Run Drift Doctor",
  );

const seedLoadedState = ({ runInProgress = false } = {}) => {
  statusSlot().data = {
    status: {
      lastRunAt: "2026-08-20T00:00:00Z",
      runInProgress,
      activeRunId: runInProgress ? "1" : "",
      changeSummary: { changedFilesCount: 2, changedPaths: [] },
    },
  };
  runsSlot().data = {
    runs: [
      {
        id: 1,
        status: "completed",
        summary: "ok",
        priorityCounts: { P0: 0, P1: 0, P2: 0 },
        statusCounts: { open: 0, working: 0, dismissed: 0, fixed: 0 },
      },
    ],
  };
  cardsSlot().data = { cards: [] };
};

beforeEach(() => {
  harness.reset();
  __pollRegistry.reset();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.clearAllTimers?.();
});

describe("frontend/doctor-tab run button", () => {
  it("renders the header button immediately with a scoped Loading state (no hostage frame)", () => {
    const tree = renderTab(); // polls have no data yet
    const button = runDoctorButton(tree);
    expect(button).toBeTruthy();
    expect(button.props.loading).toBe(true);
    expect(button.props.loadingLabel).toBe("Loading...");
  });

  it("shows Starting... from click until the status refresh lands, then Running...", async () => {
    seedLoadedState();
    let tree = renderTab();
    harness.flushEffects();
    tree = renderTab();
    expect(runDoctorButton(tree).props.loading).toBe(false);

    const startGate = deferred();
    startDoctorRun.mockReturnValue(startGate.promise);
    const clickPromise = runDoctorButton(tree).props.onClick();

    tree = renderTab();
    expect(runDoctorButton(tree).props.loading).toBe(true);
    expect(runDoctorButton(tree).props.loadingLabel).toBe("Starting...");

    startGate.resolve({ runId: 5 });
    await clickPromise;
    await flushAsync();

    seedLoadedState({ runInProgress: true });
    tree = renderTab();
    expect(runDoctorButton(tree).props.loading).toBe(true);
    expect(runDoctorButton(tree).props.loadingLabel).toBe("Running...");
  });

  it("skips the initial filter refresh and refreshes only on filter changes", () => {
    seedLoadedState();
    renderTab();
    harness.flushEffects();
    expect(cardsSlot().refresh).not.toHaveBeenCalled();
    expect(statusSlot().refresh).not.toHaveBeenCalled();
    expect(runsSlot().refresh).not.toHaveBeenCalled();

    // Select the Run #1 tab: the filter change triggers one refresh.
    const tree = renderTab();
    const runTab = collectNodes(tree).find(
      (vnode) =>
        vnode.type === "button" &&
        JSON.stringify(vnode.props.children || "").includes("Run #"),
    );
    runTab.props.onClick();
    renderTab();
    harness.flushEffects();
    expect(cardsSlot().refresh).toHaveBeenCalledTimes(1);
  });
});

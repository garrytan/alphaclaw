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

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchBrowseGitSummary: vi.fn(),
  syncBrowseChanges: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import { fetchBrowseGitSummary } from "../../lib/public/js/lib/api.js";
import { SidebarGitPanel } from "../../lib/public/js/components/sidebar-git-panel.js";

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

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (node.props) collectText(node.props.children, out);
    if (node.rendered) collectText(node.rendered, out);
  }
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

const makeSummary = (overrides = {}) => ({
  isRepo: true,
  repoSlug: "acme/repo",
  branch: "main",
  changedFiles: [],
  commits: [],
  ...overrides,
});

let intervalCallbacks;
let originalWindow;

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  intervalCallbacks = [];
  originalWindow = globalThis.window;
  globalThis.window = {
    setInterval: (callback) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    clearInterval: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  };
});

afterEach(() => {
  globalThis.window = originalWindow;
});

const renderPanel = () => {
  harness.beginRender();
  return SidebarGitPanel({ isActive: true });
};

const renderText = () => collectText(expandTree(renderPanel())).join(" ");

describe("frontend/sidebar-git-panel summary poll", () => {
  it("latest request wins: an older poll response landing late cannot clobber the newer summary", async () => {
    const slowFirst = deferred();
    fetchBrowseGitSummary.mockReturnValueOnce(slowFirst.promise);
    renderPanel();
    harness.flushEffects(); // mount fetch in flight (slow)

    const fastSecond = deferred();
    fetchBrowseGitSummary.mockReturnValueOnce(fastSecond.promise);
    intervalCallbacks.at(-1)(); // poll tick dispatches a second request

    fastSecond.resolve(makeSummary({ branch: "branch-new" }));
    await flushAsync();
    slowFirst.resolve(makeSummary({ branch: "branch-stale" }));
    await flushAsync();

    const text = renderText();
    expect(text).toContain("branch-new");
    expect(text).not.toContain("branch-stale");
  });

  it("keeps the panel with an inline warning when a refresh fails after data loaded", async () => {
    fetchBrowseGitSummary.mockResolvedValueOnce(makeSummary());
    renderPanel();
    harness.flushEffects();
    await flushAsync();

    fetchBrowseGitSummary.mockRejectedValueOnce(new Error("git offline"));
    await intervalCallbacks.at(-1)();
    await flushAsync();

    const text = renderText();
    expect(text).toContain("acme/repo"); // panel still shows data
    expect(text).toContain("Refresh failed - showing last known state");
  });

  it("renders the error-only panel when the initial load fails with no data", async () => {
    fetchBrowseGitSummary.mockRejectedValueOnce(new Error("git offline"));
    renderPanel();
    harness.flushEffects();
    await flushAsync();

    const text = renderText();
    expect(text).toContain("git offline");
    expect(text).not.toContain("acme/repo");
  });
});

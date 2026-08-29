import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slot harness (cron-tab.test.js pattern) with dep tracking: useEffect records
// deps per slot and an effect is queued only when its deps changed, so the
// disk-poll effect re-subscribes exactly when isDirty/path flip — the race
// under test.
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
  fetchBrowseSqliteTable: vi.fn(),
  fetchFileContent: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/browse-draft-state.js", () => ({
  clearStoredFileDraft: vi.fn(),
  readStoredFileDraft: vi.fn(() => ""),
  updateDraftIndex: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import { fetchFileContent } from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { useFileLoader } from "../../lib/public/js/components/file-viewer/use-file-loader.js";

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

const makeSetters = () => ({
  setContent: vi.fn(),
  setInitialContent: vi.fn(),
  setFileKind: vi.fn(),
  setImageDataUrl: vi.fn(),
  setAudioDataUrl: vi.fn(),
  setSqliteSummary: vi.fn(),
  setSqliteSelectedTable: vi.fn(),
  setSqliteTableOffset: vi.fn(),
  setSqliteTableLoading: vi.fn(),
  setSqliteTableError: vi.fn(),
  setSqliteTableData: vi.fn(),
  setError: vi.fn(),
  setIsFolderPath: vi.fn(),
  setExternalChangeNoticeShown: vi.fn(),
  setLoading: vi.fn(),
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
    dispatchEvent: vi.fn(),
  };
  if (typeof globalThis.CustomEvent !== "function") {
    globalThis.CustomEvent = class CustomEvent {
      constructor(type) {
        this.type = type;
      }
    };
  }
});

afterEach(() => {
  globalThis.window = originalWindow;
});

const renderLoader = (setters, overrides = {}) => {
  harness.beginRender();
  return useFileLoader({
    hasSelectedPath: true,
    normalizedPath: "/notes.md",
    isDiffView: false,
    isSqliteFile: false,
    sqliteSelectedTable: "",
    sqliteTableOffset: 0,
    canEditFile: true,
    isFolderPath: false,
    loading: false,
    saving: false,
    initialContent: "old",
    isDirty: false,
    externalChangeNoticeShown: false,
    viewScrollRatioRef: { current: 0 },
    ...setters,
    ...overrides,
  });
};

const mountLoader = async (setters) => {
  fetchFileContent.mockResolvedValueOnce({ kind: "text", content: "old" });
  renderLoader(setters);
  harness.flushEffects();
  await flushAsync();
  Object.values(setters).forEach((setter) => setter.mockClear());
};

describe("frontend/use-file-loader disk poll", () => {
  it("applies disk content while the editor is clean", async () => {
    const setters = makeSetters();
    await mountLoader(setters);

    fetchFileContent.mockResolvedValueOnce({ content: "disk-new" });
    await intervalCallbacks.at(-1)();
    expect(setters.setContent).toHaveBeenCalledWith("disk-new");
    expect(setters.setInitialContent).toHaveBeenCalledWith("disk-new");
  });

  it("drops a poll response dispatched while clean that lands after the user starts typing", async () => {
    const setters = makeSetters();
    await mountLoader(setters);

    const pollGate = deferred();
    fetchFileContent.mockReturnValueOnce(pollGate.promise);
    const pollPromise = intervalCallbacks.at(-1)(); // dispatched with isDirty=false

    // User types before the response lands: isDirty flips, the effect
    // re-subscribes, and the superseded closure must go inert.
    renderLoader(setters, { isDirty: true });
    harness.flushEffects();

    pollGate.resolve({ content: "disk-new" });
    await pollPromise;
    await flushAsync();
    expect(setters.setContent).not.toHaveBeenCalled();
    expect(setters.setInitialContent).not.toHaveBeenCalled();
  });

  it("warns instead of overwriting when the editor is dirty", async () => {
    const setters = makeSetters();
    fetchFileContent.mockResolvedValueOnce({ kind: "text", content: "old" });
    renderLoader(setters, { isDirty: true });
    harness.flushEffects();
    await flushAsync();
    Object.values(setters).forEach((setter) => setter.mockClear());

    fetchFileContent.mockResolvedValueOnce({ content: "disk-new" });
    await intervalCallbacks.at(-1)();
    expect(setters.setContent).not.toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      "This file changed on disk. Save to overwrite or reload by re-opening.",
      "error",
    );
  });
});

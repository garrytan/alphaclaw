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

vi.mock("../../lib/public/js/lib/ui-settings.js", () => ({
  readUiSettings: () => ({}),
  writeUiSettings: () => {},
}));

import * as preactHooks from "preact/hooks";
import { useAppShellUi } from "../../lib/public/js/hooks/use-app-shell-ui.js";

const harness = preactHooks.__harness;

const makeDocument = () => {
  const listeners = new Map();
  return {
    body: { style: {} },
    openLayer: null,
    querySelector: vi.fn(function querySelector() {
      return this.openLayer;
    }),
    addEventListener: vi.fn((type, handler) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    }),
    removeEventListener: vi.fn((type, handler) => {
      listeners.get(type)?.delete(handler);
    }),
    key(key, init = {}) {
      const event = { key, defaultPrevented: false, isComposing: false, ...init };
      for (const handler of [...(listeners.get("keydown") || [])]) handler(event);
    },
  };
};

let shell;
const render = (location, query = "") => {
  harness.beginRender();
  shell = useAppShellUi({ location, query });
  harness.flushEffects();
  return shell;
};
const isOpen = (location, query = "") => {
  render(location, query);
  return render(location, query).state.mobileSidebarOpen;
};

describe("frontend/hooks useAppShellUi phone drawer", () => {
  let doc;

  beforeEach(() => {
    harness.reset();
    doc = makeDocument();
    vi.stubGlobal("document", doc);
  });

  afterEach(() => {
    harness.unmount();
    vi.unstubAllGlobals();
  });

  it("closes the drawer on every navigation", () => {
    render("/home");
    shell.actions.setMobileSidebarOpen(true);
    expect(isOpen("/home")).toBe(true);
    expect(isOpen("/health")).toBe(false);
    shell.actions.setMobileSidebarOpen(true);
    expect(isOpen("/health")).toBe(true);
    expect(isOpen("/agents/main")).toBe(false);
  });

  it("closes the drawer when only the query changes", () => {
    render("/browse/notes.md");
    shell.actions.setMobileSidebarOpen(true);
    expect(isOpen("/browse/notes.md")).toBe(true);
    expect(isOpen("/browse/notes.md", "view=diff")).toBe(false);
  });

  it("keeps the drawer open for the navigation a drawer tab switch makes, and only that one", () => {
    render("/home");
    shell.actions.setMobileSidebarOpen(true);
    render("/home");
    shell.actions.keepMobileSidebarOnNextLocation();
    expect(isOpen("/browse")).toBe(true);
    expect(isOpen("/browse")).toBe(true);
    expect(isOpen("/browse/notes.md")).toBe(false);
  });

  it("closes on Escape and returns focus to the menu button", () => {
    render("/home");
    const focus = vi.fn();
    shell.refs.mobileMenuButtonRef.current = { focus };
    shell.actions.setMobileSidebarOpen(true);
    render("/home");
    doc.key("Escape");
    expect(isOpen("/home")).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("leaves Escape alone when something else handled it, during composition, or while closed", () => {
    render("/home");
    const focus = vi.fn();
    shell.refs.mobileMenuButtonRef.current = { focus };
    doc.key("Escape");
    expect(focus).not.toHaveBeenCalled();
    shell.actions.setMobileSidebarOpen(true);
    render("/home");
    doc.key("Escape", { defaultPrevented: true });
    doc.key("Escape", { isComposing: true });
    doc.key("Enter");
    expect(isOpen("/home")).toBe(true);
    expect(focus).not.toHaveBeenCalled();
  });

  it("keeps the drawer open for a tab switch from a page whose hash has a query", () => {
    const win = { location: { hash: "#/health?incident=5" } };
    vi.stubGlobal("window", win);
    render("/health", "incident=5");
    shell.actions.setMobileSidebarOpen(true);
    render("/health", "incident=5");
    shell.actions.keepMobileSidebarOnNextLocation();
    win.location.hash = "#/browse";
    expect(isOpen("/browse", "incident=5")).toBe(true);
    expect(isOpen("/browse", "")).toBe(true);
    win.location.hash = "#/browse?view=diff";
    expect(isOpen("/browse", "view=diff")).toBe(false);
  });

  it("closes the account menu with the drawer on navigation and on Escape", () => {
    render("/home");
    shell.actions.setMobileSidebarOpen(true);
    shell.actions.setMenuOpen(true);
    render("/health");
    expect(render("/health").state.menuOpen).toBe(false);
    shell.actions.setMobileSidebarOpen(true);
    shell.actions.setMenuOpen(true);
    render("/health");
    doc.key("Escape");
    expect(render("/health").state.menuOpen).toBe(false);
  });

  it("leaves Escape to an open dialog or file menu above the drawer", () => {
    render("/home");
    const focus = vi.fn();
    shell.refs.mobileMenuButtonRef.current = { focus };
    shell.actions.setMobileSidebarOpen(true);
    render("/home");
    doc.openLayer = {};
    doc.key("Escape");
    expect(isOpen("/home")).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    expect(doc.querySelector).toHaveBeenCalledWith('[aria-modal="true"], .tree-context-menu');
    doc.openLayer = null;
    doc.key("Escape");
    expect(isOpen("/home")).toBe(false);
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it("removes its Escape listener once the drawer closes", () => {
    render("/home");
    shell.actions.setMobileSidebarOpen(true);
    render("/home");
    shell.actions.closeMobileSidebar();
    render("/home");
    const removed = doc.removeEventListener.mock.calls.filter(([type]) => type === "keydown");
    expect(removed).toHaveLength(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slot harness with dep tracking (team-tab-presence.test.js pattern).
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

vi.mock("../../lib/public/js/components/watchdog-tab/helpers.js", () => ({
  ensureXtermStylesheet: vi.fn(),
  fitTerminalWhenVisible: vi.fn(),
  kWatchdogTerminalWsPath: "/api/watchdog/terminal",
  loadXtermModules: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, closeWatchdogTerminalSession: vi.fn() };
});

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import { loadXtermModules } from "../../lib/public/js/components/watchdog-tab/helpers.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { useWatchdogTerminal } from "../../lib/public/js/components/watchdog-tab/terminal/use-terminal.js";

const harness = preactHooks.__harness;

const flushAsync = async () => {
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
};

const renderHook = () => {
  harness.beginRender();
  return useWatchdogTerminal({
    active: true,
    panelRef: { current: {} },
    hostRef: { current: {} },
  });
};

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("frontend/watchdog terminal initialization failure", () => {
  it("names the cause in the status text — never a bare 'Terminal failed to load'", async () => {
    loadXtermModules.mockRejectedValue(new Error("xterm bundle 404"));

    renderHook();
    harness.flushEffects();
    await flushAsync();

    const hook = renderHook();
    expect(hook.terminalStatusText).toBe(
      "Terminal failed to load — xterm bundle 404",
    );
    expect(hook.terminalConnected).toBe(false);
    expect(hook.connectingTerminal).toBe(false);
    expect(showToast).toHaveBeenCalledWith("Could not initialize terminal", "error");
  });

  it("falls back to 'unknown error' when the failure carries no message", async () => {
    loadXtermModules.mockRejectedValue({});

    renderHook();
    harness.flushEffects();
    await flushAsync();

    expect(renderHook().terminalStatusText).toBe(
      "Terminal failed to load — unknown error",
    );
  });
});

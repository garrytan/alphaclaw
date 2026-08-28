import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Deps-aware hook harness (same pattern as use-polling.test.js): the console
// hook's poll effect must re-run (with cleanup first) when the active tab
// changes — that's exactly the pause/resume behavior under test.
vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, pendingEffects: [] };

  const depsChanged = (previousDeps, nextDeps) => {
    if (!previousDeps || !nextDeps) return true;
    if (previousDeps.length !== nextDeps.length) return true;
    return nextDeps.some((dep, index) => !Object.is(dep, previousDeps[index]));
  };

  harness.beginRender = () => {
    harness.cursor = 0;
  };

  harness.flushEffects = () => {
    const pending = harness.pendingEffects;
    harness.pendingEffects = [];
    for (const run of pending) run();
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
    if (!(index in harness.slots)) {
      harness.slots[index] = { kind: "ref", current: initialValue };
    }
    return harness.slots[index];
  };

  const useCallback = (fn, deps) => {
    const index = harness.cursor++;
    let slot = harness.slots[index];
    if (!slot) {
      slot = harness.slots[index] = {
        kind: "callback",
        fn: null,
        deps: undefined,
        initialized: false,
      };
    }
    if (!slot.initialized || depsChanged(slot.deps, deps)) {
      slot.fn = fn;
      slot.deps = deps;
      slot.initialized = true;
    }
    return slot.fn;
  };

  const useEffect = (effect, deps) => {
    const index = harness.cursor++;
    let slot = harness.slots[index];
    if (!slot) {
      slot = harness.slots[index] = {
        kind: "effect",
        deps: undefined,
        cleanup: null,
        initialized: false,
      };
    }
    const changed = !slot.initialized || depsChanged(slot.deps, deps);
    slot.deps = deps;
    slot.initialized = true;
    if (!changed) return;
    harness.pendingEffects.push(() => {
      if (typeof slot.cleanup === "function") slot.cleanup();
      const cleanup = effect();
      slot.cleanup = typeof cleanup === "function" ? cleanup : null;
    });
  };

  const useMemo = (factory) => factory();

  return { useState, useRef, useCallback, useEffect, useMemo, __harness: harness };
});

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchWatchdogLogs: vi.fn(),
  fetchWatchdogLogsDelta: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/clipboard.js", () => ({
  copyTextToClipboard: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/ui-settings.js", () => ({
  readUiSettings: vi.fn(() => ({})),
  writeUiSettings: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

vi.mock(
  "../../lib/public/js/components/watchdog-tab/terminal/use-terminal.js",
  () => ({ useWatchdogTerminal: vi.fn() }),
);

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { readUiSettings } from "../../lib/public/js/lib/ui-settings.js";
import { useWatchdogTerminal } from "../../lib/public/js/components/watchdog-tab/terminal/use-terminal.js";
import {
  capWatchdogLogsText,
  useWatchdogConsole,
} from "../../lib/public/js/components/watchdog-tab/console/use-console.js";

const harness = preactHooks.__harness;

// Mirrors kWatchdogLogsMaxTextChars in use-console.js (intentionally
// unexported — the cap itself is an implementation detail; the trimming
// CONTRACT is what these tests pin).
const kCapChars = 262144;

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

describe("frontend/watchdog console — capWatchdogLogsText", () => {
  it("passes under-cap text through, trims over-cap text on a line boundary, and falls back to a raw slice without newlines", () => {
    // Under the cap: identity.
    const small = "line1\nline2\n";
    expect(capWatchdogLogsText(small)).toBe(small);
    expect(capWatchdogLogsText("x".repeat(kCapChars))).toHaveLength(kCapChars);

    // Over the cap: the trim lands exactly after a "\n" so the oldest
    // visible line is whole. 3000 lines of 100 chars: the raw slice starts
    // 44 chars into a line, so 44 chars are dropped to reach the boundary.
    const line = `${"a".repeat(99)}\n`;
    const big = line.repeat(3000); // 300000 chars
    const capped = capWatchdogLogsText(big);
    expect(capped.length).toBe(kCapChars - 44);
    expect(big.endsWith(capped)).toBe(true);
    // The char immediately before the kept text in the original is a "\n".
    expect(big[big.length - capped.length - 1]).toBe("\n");
    expect(capped.startsWith(line)).toBe(true);

    // No newline anywhere: keep the raw slice rather than dropping the pane.
    const noNewline = "z".repeat(kCapChars + 10);
    const fallback = capWatchdogLogsText(noNewline);
    expect(fallback.length).toBe(kCapChars);
    expect(fallback).toBe("z".repeat(kCapChars));
  });
});

describe("frontend/watchdog console hook (delta polling)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    harness.reset();
    readUiSettings.mockReturnValue({});
    useWatchdogTerminal.mockReturnValue({
      prepareForActivate: vi.fn(),
      clearSettling: vi.fn(),
      restartSession: vi.fn(),
      fitNow: vi.fn(),
    });
  });

  afterEach(() => {
    harness.reset();
    vi.useRealTimers();
  });

  const renderConsole = () => {
    harness.beginRender();
    const result = useWatchdogConsole({});
    harness.flushEffects();
    return result;
  };

  it("reset replaces, deltas append, and the cursor survives a Terminal-tab switch (poll paused) then resumes", async () => {
    api.fetchWatchdogLogs.mockResolvedValue("line1\nline2\n");
    api.fetchWatchdogLogsDelta.mockResolvedValueOnce({
      ok: true,
      reset: false,
      data: "line3\n",
      gen: 2,
      offset: 64,
    });

    // Mount on the Logs tab: the first fetch is the full tail.
    let result = renderConsole();
    expect(result.activeConsoleTab).toBe("logs");
    await flushMicrotasks();
    result = renderConsole();
    expect(result.logs).toBe("line1\nline2\n");
    expect(result.loadingLogs).toBe(false);
    expect(api.fetchWatchdogLogs).toHaveBeenCalledTimes(1);

    // First delta poll: no cursor yet, and the delta APPENDS.
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.fetchWatchdogLogsDelta).toHaveBeenCalledTimes(1);
    expect(api.fetchWatchdogLogsDelta).toHaveBeenNthCalledWith(1, {});
    result = renderConsole();
    expect(result.logs).toBe("line1\nline2\nline3\n");

    // Terminal tab: the logs poll pauses entirely.
    result.handleSelectConsoleTab("terminal");
    result = renderConsole();
    expect(result.activeConsoleTab).toBe("terminal");
    await vi.advanceTimersByTimeAsync(9000);
    expect(api.fetchWatchdogLogsDelta).toHaveBeenCalledTimes(1);

    // Back to Logs: an IMMEDIATE catch-up poll resumes from the persisted
    // {gen, offset} cursor — never a second full-tail fetch.
    api.fetchWatchdogLogsDelta.mockResolvedValueOnce({
      ok: true,
      reset: true,
      data: "rotated tail\n",
      gen: 3,
      offset: 13,
    });
    result.handleSelectConsoleTab("logs");
    result = renderConsole();
    await flushMicrotasks();
    expect(api.fetchWatchdogLogsDelta).toHaveBeenCalledTimes(2);
    expect(api.fetchWatchdogLogsDelta).toHaveBeenNthCalledWith(2, {
      gen: 2,
      offset: 64,
    });
    expect(api.fetchWatchdogLogs).toHaveBeenCalledTimes(1);

    // reset:true (log rotation) REPLACES the pane text instead of appending.
    result = renderConsole();
    expect(result.logs).toBe("rotated tail\n");
  });
});

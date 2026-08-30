import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as agents-tab-use-agents) so
// ToastContainer can run without a DOM renderer; effects are collected and
// run manually, and createPortal is identity.
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

vi.mock("preact/compat", () => ({
  createPortal: (children) => children,
}));

import * as preactHooks from "preact/hooks";
import { showToast, ToastContainer } from "../../lib/public/js/components/toast.js";

const harness = preactHooks.__harness;

const mountContainer = () => {
  harness.beginRender();
  ToastContainer({});
  // Run the collected mount effect so the module-level addToastFn is wired.
  for (const effect of harness.effects) effect();
};

beforeEach(() => {
  harness.reset();
  vi.useFakeTimers();
  global.document = { body: {} };
});

describe("showToast durations", () => {
  it("auto-dismisses after the 4000ms default", () => {
    mountContainer();
    showToast("hello", "info");
    expect(harness.slots[0]).toHaveLength(1);
    vi.advanceTimersByTime(3999);
    expect(harness.slots[0]).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(harness.slots[0]).toHaveLength(0);
  });

  it("honors an explicit durationMs (critical launcher copy needs >4s)", () => {
    mountContainer();
    showToast("session started — open claude.ai/code to find it", "warning", {
      durationMs: 10_000,
    });
    vi.advanceTimersByTime(9_999);
    expect(harness.slots[0]).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(harness.slots[0]).toHaveLength(0);
  });

  it("stays backwards compatible with two-arg calls", () => {
    mountContainer();
    showToast("plain", "success");
    expect(harness.slots[0][0]).toEqual(
      expect.objectContaining({ type: "success", durationMs: 4000 }),
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as team-tab-component.test.js): hook
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
  fetchGmailConfig: vi.fn(),
  renewGmailWatch: vi.fn(),
  saveGmailConfig: vi.fn(),
  startGmailWatch: vi.fn(),
  stopGmailWatch: vi.fn(),
}));

vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { useGmailWatch } from "../../lib/public/js/components/google/use-gmail-watch.js";

const harness = preactHooks.__harness;

describe("frontend/use-gmail-watch", () => {
  let cachedState;

  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    cachedState = {
      data: null,
      loading: false,
      error: null,
      refresh: vi.fn(async () => {}),
    };
    useCachedFetch.mockImplementation(() => cachedState);
  });

  const render = (accounts) => {
    harness.beginRender();
    return useGmailWatch({ gatewayStatus: "running", accounts });
  };

  const runEffects = () => {
    for (const effect of [...harness.effects]) effect?.();
  };

  it("does not force a second fetch on mount — useCachedFetch already fetched", () => {
    render([{ id: "a1" }]);
    runEffects();
    expect(cachedState.refresh).not.toHaveBeenCalled();
  });

  it("force-refreshes only when the account set actually changes", () => {
    render([{ id: "a1" }]);
    runEffects();

    render([{ id: "a1" }, { id: "a2" }]);
    runEffects();
    expect(cachedState.refresh).toHaveBeenCalledTimes(1);
    expect(cachedState.refresh).toHaveBeenCalledWith({ force: true });

    // Same signature again (e.g. an unrelated re-render): no extra fetch.
    render([{ id: "a2" }, { id: "a1" }]);
    runEffects();
    expect(cachedState.refresh).toHaveBeenCalledTimes(1);
  });

  it("exposes the config load error so rows can render an unknown state", () => {
    cachedState.error = new Error("config boom");
    const hook = render([{ id: "a1" }]);
    expect(hook.error).toBe(cachedState.error);
  });
});

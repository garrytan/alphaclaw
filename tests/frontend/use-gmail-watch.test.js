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
vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({ usePolling: vi.fn() }));

import * as preactHooks from "preact/hooks";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { useGmailWatch } from "../../lib/public/js/components/google/use-gmail-watch.js";
import { startGmailWatch, stopGmailWatch } from "../../lib/public/js/lib/api.js";
import { usePolling } from "../../lib/public/js/hooks/usePolling.js";

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

  it("loads and reconciles account changes while the gateway is stopped", () => {
    harness.beginRender();
    useGmailWatch({ gatewayStatus: "stopped", accounts: [{ id: "a1" }] });
    runEffects();
    expect(useCachedFetch.mock.calls.at(-1)[2].enabled).toBe(true);
    harness.beginRender();
    useGmailWatch({ gatewayStatus: "stopped", accounts: [{ id: "a1" }, { id: "a2" }] });
    runEffects();
    expect(cachedState.refresh).toHaveBeenCalledWith({ force: true });
  });

  it("refreshes persisted disabled state when a remote stop fails", async () => {
    stopGmailWatch.mockRejectedValue(new Error("remote stop failed"));
    const hook = render([{ id: "a1" }]);
    await expect(hook.stopWatchForAccount("a1")).rejects.toThrow("remote stop failed");
    expect(cachedState.refresh).toHaveBeenCalledWith({ force: true });
    expect(render([{ id: "a1" }]).busyByAccountId.a1).toBeUndefined();
  });

  it("keeps the row busy until overlapping requests settle", async () => {
    let finishFirst;
    let finishSecond;
    startGmailWatch.mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishSecond = resolve; }));
    const hook = render([{ id: "a1" }]);
    const first = hook.startWatchForAccount("a1");
    const second = hook.startWatchForAccount("a1");
    finishFirst({ ok: true });
    await first;
    expect(render([{ id: "a1" }]).busyByAccountId.a1).toBe(true);
    finishSecond({ ok: true });
    await second;
    expect(render([{ id: "a1" }]).busyByAccountId.a1).toBeUndefined();
  });

  it("polls pending remote work after reload with the canonical cache key", () => {
    cachedState.data = { accounts: [{ accountId: "a1", enabled: false, remoteOperation: { kind: "stop", status: "pending" } }] };
    render([{ id: "a1" }]);
    expect(usePolling).toHaveBeenCalledWith(expect.any(Function), 5000, { enabled: true, cacheKey: "/api/gmail/config" });
  });
});

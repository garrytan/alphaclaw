import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as use-claude-code-launcher tests):
// hook state lives in per-call-index slots so the hook can be invoked
// directly without a DOM renderer. Effects are collected, not run — the
// poll-cadence tests run them explicitly under fake timers.
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
  cancelClaudeCodeLocalLogin: vi.fn(),
  createClaudeCodeLocalSession: vi.fn(),
  fetchClaudeCodeLocalTail: vi.fn(),
  fetchClaudeCodeStatusDirect: vi.fn(),
  logoutClaudeCodeLocal: vi.fn(),
  startClaudeCodeLocalLogin: vi.fn(),
  stopClaudeCodeLocalSession: vi.fn(),
  submitClaudeCodeLocalLoginCode: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/api-cache.js", () => ({
  invalidateCache: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import {
  cancelClaudeCodeLocalLogin,
  createClaudeCodeLocalSession,
  fetchClaudeCodeLocalTail,
  fetchClaudeCodeStatusDirect,
  logoutClaudeCodeLocal,
  startClaudeCodeLocalLogin,
  stopClaudeCodeLocalSession,
  submitClaudeCodeLocalLoginCode,
} from "../../lib/public/js/lib/api.js";
import { invalidateCache } from "../../lib/public/js/lib/api-cache.js";
import { useClaudeCodeLocal } from "../../lib/public/js/hooks/use-claude-code-local.js";

const harness = preactHooks.__harness;

const statusWith = (local) => ({ ok: true, availability: { available: true }, local });

const renderHook = (props = {}) => {
  harness.beginRender();
  return useClaudeCodeLocal({ enabled: true, ...props });
};

const runEffects = () => {
  const cleanups = [];
  for (const effect of harness.effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") cleanups.push(cleanup);
  }
  return () => cleanups.forEach((cleanup) => cleanup());
};

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  fetchClaudeCodeStatusDirect.mockResolvedValue(
    statusWith({ enabled: true, state: "ready" }),
  );
});

describe("useClaudeCodeLocal status", () => {
  it("exposes the local block from a direct status fetch", async () => {
    const hook = renderHook();
    expect(hook.local).toBe(null);
    await hook.refresh();
    expect(renderHook().local).toEqual({ enabled: true, state: "ready" });
    expect(fetchClaudeCodeStatusDirect).toHaveBeenCalledTimes(1);
  });

  it("keeps the last snapshot and records the error on a failed poll", async () => {
    const hook = renderHook();
    await hook.refresh();
    fetchClaudeCodeStatusDirect.mockRejectedValueOnce(new Error("offline"));
    await renderHook().refresh();
    const rendered = renderHook();
    expect(rendered.local).toEqual({ enabled: true, state: "ready" });
    expect(rendered.statusError?.message).toBe("offline");
  });
});

describe("useClaudeCodeLocal poll cadence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls every 5s in steady state", async () => {
    renderHook();
    const cleanup = runEffects();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchClaudeCodeStatusDirect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchClaudeCodeStatusDirect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchClaudeCodeStatusDirect).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("polls every 1s while a login is in progress or a spawn is starting", async () => {
    for (const state of ["login_in_progress", "starting"]) {
      harness.reset();
      vi.clearAllMocks();
      fetchClaudeCodeStatusDirect.mockResolvedValue(
        statusWith({ enabled: true, state }),
      );
      const hook = renderHook();
      await hook.refresh();
      renderHook(); // re-render sees the active state → 1s interval effect
      const cleanup = runEffects();
      await vi.advanceTimersByTimeAsync(0);
      const callsAfterMount = fetchClaudeCodeStatusDirect.mock.calls.length;
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchClaudeCodeStatusDirect).toHaveBeenCalledTimes(callsAfterMount + 1);
      cleanup();
    }
  });
});

describe("useClaudeCodeLocal visibility pause", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    global.document = {
      hidden: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });
  afterEach(() => {
    vi.useRealTimers();
    delete global.document;
  });

  it("mounts hidden without polling, then refreshes immediately on visibility return", async () => {
    global.document.hidden = true;
    renderHook();
    let cleanup = runEffects();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchClaudeCodeStatusDirect).not.toHaveBeenCalled();

    // The shared useVisibleInterval primitive resumes on visibilitychange and
    // polls immediately — no re-render or effect re-run needed (PR 11).
    const handler = global.document.addEventListener.mock.calls.find(
      (call) => call[0] === "visibilitychange",
    )[1];
    global.document.hidden = false;
    handler();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchClaudeCodeStatusDirect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchClaudeCodeStatusDirect).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it("stops the interval while the document is hidden", async () => {
    renderHook();
    let cleanup = runEffects();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchClaudeCodeStatusDirect).toHaveBeenCalledTimes(1);

    const handler = global.document.addEventListener.mock.calls.find(
      (call) => call[0] === "visibilitychange",
    )[1];
    global.document.hidden = true;
    handler();
    cleanup();
    renderHook();
    cleanup = runEffects();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchClaudeCodeStatusDirect).toHaveBeenCalledTimes(1);
    cleanup();
  });
});

describe("useClaudeCodeLocal mutations", () => {
  const kStatusCacheKey = "/api/claude-code/status";

  it("start posts the consent flag + permissionMode, invalidates the status cache, and refreshes", async () => {
    createClaudeCodeLocalSession.mockResolvedValue({ ok: true, status: "starting" });
    const hook = renderHook();
    const result = await hook.start({
      confirmed: true,
      permissionMode: "acceptEdits",
    });
    expect(createClaudeCodeLocalSession).toHaveBeenCalledWith({
      confirmed: true,
      permissionMode: "acceptEdits",
    });
    expect(result).toEqual({ ok: true, status: "starting" });
    expect(invalidateCache).toHaveBeenCalledWith(kStatusCacheKey);
    expect(fetchClaudeCodeStatusDirect).toHaveBeenCalled();
  });

  it("start defaults permissionMode to null (no consent-scope assertion)", async () => {
    createClaudeCodeLocalSession.mockResolvedValue({ ok: true, status: "starting" });
    const hook = renderHook();
    await hook.start({ confirmed: false });
    expect(createClaudeCodeLocalSession).toHaveBeenCalledWith({
      confirmed: false,
      permissionMode: null,
    });
  });

  it("every mutating action invalidates the shared cache key — even when refused", async () => {
    stopClaudeCodeLocalSession.mockRejectedValue(
      Object.assign(new Error("busy"), { code: "busy" }),
    );
    startClaudeCodeLocalLogin.mockResolvedValue({ ok: true, status: "starting" });
    submitClaudeCodeLocalLoginCode.mockResolvedValue({ ok: true, status: "verifying" });
    cancelClaudeCodeLocalLogin.mockResolvedValue({ ok: true });
    logoutClaudeCodeLocal.mockResolvedValue({ ok: true });

    const hook = renderHook();
    await expect(hook.stop()).rejects.toThrow("busy");
    await hook.login.begin();
    await hook.login.submitCode("ABC-123");
    expect(submitClaudeCodeLocalLoginCode).toHaveBeenCalledWith({ code: "ABC-123" });
    await hook.login.cancel();
    await hook.logout();

    expect(invalidateCache).toHaveBeenCalledTimes(5);
    for (const call of invalidateCache.mock.calls) {
      expect(call[0]).toBe(kStatusCacheKey);
    }
  });

  it("fetchTail is a read: no cache invalidation", async () => {
    fetchClaudeCodeLocalTail.mockResolvedValue({ ok: true, source: "login", tail: "out" });
    const hook = renderHook();
    const result = await hook.fetchTail({ source: "login" });
    expect(fetchClaudeCodeLocalTail).toHaveBeenCalledWith({ source: "login" });
    expect(result.tail).toBe("out");
    expect(invalidateCache).not.toHaveBeenCalled();
  });
});

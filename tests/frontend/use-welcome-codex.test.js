import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (use-saved-setting.test.js pattern): hook state lives
// in per-call-index slots; effects are collected, not run — tests invoke them
// to model mount.
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
  disconnectCodex: vi.fn(),
  exchangeCodexOAuth: vi.fn(),
  fetchCodexStatus: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/codex-oauth-window.js", () => ({
  isCodexAuthCallbackMessage: vi.fn(() => false),
  openCodexAuthWindow: vi.fn(() => ({ closed: true })),
}));

import * as preactHooks from "preact/hooks";
import {
  disconnectCodex,
  exchangeCodexOAuth,
  fetchCodexStatus,
} from "../../lib/public/js/lib/api.js";
import { openCodexAuthWindow } from "../../lib/public/js/lib/codex-oauth-window.js";
import {
  kCodexDeferredSaveNotFoundReason,
  kCodexDeferredSaveRecheckMs,
} from "../../lib/public/js/lib/codex-status.js";
import { useWelcomeCodex } from "../../lib/public/js/components/onboarding/use-welcome-codex.js";

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

let setFormError;
let originalWindow;

const renderHook = () => {
  harness.beginRender();
  return useWelcomeCodex({ setFormError });
};

// Mount with a connected Codex status.
const mountConnected = async () => {
  fetchCodexStatus.mockResolvedValue({ connected: true });
  let hook = renderHook();
  harness.effects[0]();
  await flushAsync();
  hook = renderHook();
  expect(hook.codexStatus.connected).toBe(true);
  return hook;
};

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  setFormError = vi.fn();
  originalWindow = globalThis.window;
  globalThis.window = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
});

afterEach(() => {
  globalThis.window = originalWindow;
});

describe("frontend/use-welcome-codex reconnect", () => {
  it("Reconnect runs the OAuth flow even while connected (no silent no-op)", async () => {
    const hook = await mountConnected();
    hook.startCodexAuth();
    expect(openCodexAuthWindow).toHaveBeenCalledTimes(1);
    const next = renderHook();
    expect(next.codexAuthStarted).toBe(true);
  });
});

describe("frontend/use-welcome-codex status check semantics", () => {
  // CRITICAL regression: a failed status CHECK must never fabricate
  // { connected: false } over a live auth — it keeps the last-known status.
  it("a failed check keeps the last-known connected status (never connected:false)", async () => {
    await mountConnected();

    fetchCodexStatus.mockRejectedValue(new Error("status endpoint down"));
    let hook = renderHook();
    harness.effects[0]();
    await flushAsync();

    hook = renderHook();
    expect(hook.codexStatus.connected).toBe(true);
    expect(hook.codexStatusError).toBe("status endpoint down");
    // A prior checked status exists, so the step is not in the unknown state.
    expect(hook.codexStatusUnknown).toBe(false);
  });

  it("a quiet-period read (unavailable: true) keeps the last-known connection under the marker; a deferred exchange flags the pending save", async () => {
    await mountConnected();

    fetchCodexStatus.mockResolvedValue({
      connected: false,
      unavailable: true,
      reason: "backup_in_progress",
    });
    let hook = renderHook();
    harness.effects[0]();
    await flushAsync();
    hook = renderHook();
    expect(hook.codexStatus).toEqual({
      connected: true,
      unavailable: true,
      reason: "backup_in_progress",
    });
    expect(hook.codexStatusKnown).toBe(true);
    expect(hook.codexStatusUnknown).toBe(false);
    expect(hook.codexStatusError).toBe("");
    expect(hook.codexDeferredSavePending).toBe(false);

    // Manual exchange answered 202 deferred: connected, save pending.
    exchangeCodexOAuth.mockResolvedValue({ ok: true, deferred: true, reason: "backup_in_progress" });
    hook.setCodexManualInput("http://localhost:1455/auth/callback?code=abc&state=def");
    hook = renderHook();
    await hook.completeCodexAuth();
    hook = renderHook();
    expect(hook.codexDeferredSavePending).toBe(true);
    expect(setFormError).not.toHaveBeenCalledWith(expect.stringContaining("failed"));

    // The store confirms the saved connection → pending clears.
    fetchCodexStatus.mockResolvedValue({ connected: true });
    hook = renderHook();
    harness.effects[0]();
    await flushAsync();
    hook = renderHook();
    expect(hook.codexDeferredSavePending).toBe(false);
    expect(hook.codexStatus).toEqual({ connected: true });
  });

  it("a FIRST read that is unavailable is not a checked status (known stays false, no error, loading cleared); the first readable read is", async () => {
    fetchCodexStatus.mockResolvedValue({
      connected: false,
      unavailable: true,
      reason: "backup_in_progress",
    });
    let hook = renderHook();
    harness.effects[0]();
    await flushAsync();
    hook = renderHook();
    expect(hook.codexLoading).toBe(false);
    expect(hook.codexStatus).toEqual({
      connected: false,
      unavailable: true,
      reason: "backup_in_progress",
    });
    // connected:false here is a placeholder — nothing was learned.
    expect(hook.codexStatusKnown).toBe(false);
    // ...but it is not a FAILED check either: no error, not the error-unknown state.
    expect(hook.codexStatusError).toBe("");
    expect(hook.codexStatusUnknown).toBe(false);
    expect(hook.codexDeferredSavePending).toBe(false);

    // The barrier lifts: the first readable status is the checked truth.
    fetchCodexStatus.mockResolvedValue({ connected: false });
    hook = renderHook();
    harness.effects[0]();
    await flushAsync();
    hook = renderHook();
    expect(hook.codexStatus).toEqual({ connected: false });
    expect(hook.codexStatusKnown).toBe(true);
  });

  // Deferred manual exchange while the status read answers `firstRead`.
  // `beforeComplete` runs right before the exchange (fake timers must not
  // start before the mount flush's setTimeout(0), or it never resolves).
  const completeDeferredExchange = async (firstRead, beforeComplete = () => {}) => {
    fetchCodexStatus.mockResolvedValue({ connected: false });
    let hook = renderHook();
    harness.effects[0]();
    await flushAsync();
    hook = renderHook();
    exchangeCodexOAuth.mockResolvedValue({ ok: true, deferred: true, reason: "backup_in_progress" });
    fetchCodexStatus.mockResolvedValue(firstRead);
    hook.setCodexManualInput("http://localhost:1455/auth/callback?code=abc&state=def");
    hook = renderHook();
    beforeComplete();
    await hook.completeCodexAuth();
    return renderHook();
  };

  it("X7: the server's deferredWrite:failed verdict ends the pending claim with the reason; a later connected read retires it", async () => {
    let hook = await completeDeferredExchange({
      connected: false,
      unavailable: true,
      reason: "backup_in_progress",
    });
    expect(hook.codexDeferredSavePending).toBe(true);
    expect(hook.codexDeferredSaveFailedReason).toBeNull();

    fetchCodexStatus.mockResolvedValue({
      connected: false,
      deferredWrite: { state: "failed", reason: "store closed for a second backup" },
    });
    harness.effects[0]();
    await flushAsync();
    hook = renderHook();
    expect(hook.codexDeferredSavePending).toBe(false);
    expect(hook.codexDeferredSaveFailedReason).toBe("store closed for a second backup");
    expect(hook.codexStatus.connected).toBe(false);

    // Reconnected (direct save this time): the failure line goes away.
    exchangeCodexOAuth.mockResolvedValue({ ok: true });
    fetchCodexStatus.mockResolvedValue({ connected: true });
    hook.setCodexManualInput("http://localhost:1455/auth/callback?code=abc&state=def");
    hook = renderHook();
    await hook.completeCodexAuth();
    hook = renderHook();
    expect(hook.codexDeferredSaveFailedReason).toBeNull();
    expect(hook.codexDeferredSavePending).toBe(false);
    expect(hook.codexStatus).toEqual({ connected: true });
  });

  it("X7: without a server verdict, one readable connected:false read keeps the claim and arms a recheck; the second ends it", async () => {
    try {
      // The read right after the exchange is readable and still disconnected.
      let hook = await completeDeferredExchange({ connected: false }, () => vi.useFakeTimers());
      expect(hook.codexDeferredSavePending).toBe(true);
      expect(hook.codexDeferredSaveFailedReason).toBeNull();
      const readsBefore = fetchCodexStatus.mock.calls.length;

      await vi.advanceTimersByTimeAsync(kCodexDeferredSaveRecheckMs);
      expect(fetchCodexStatus.mock.calls.length).toBe(readsBefore + 1);
      hook = renderHook();
      expect(hook.codexDeferredSavePending).toBe(false);
      expect(hook.codexDeferredSaveFailedReason).toBe(kCodexDeferredSaveNotFoundReason);
      await vi.advanceTimersByTimeAsync(kCodexDeferredSaveRecheckMs * 3);
      expect(fetchCodexStatus.mock.calls.length).toBe(readsBefore + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a resolved {ok:false} envelope is a failed check too (last-known kept)", async () => {
    await mountConnected();

    fetchCodexStatus.mockResolvedValue({ ok: false, error: "boom" });
    let hook = renderHook();
    harness.effects[0]();
    await flushAsync();

    hook = renderHook();
    expect(hook.codexStatus.connected).toBe(true);
    expect(hook.codexStatusError).toBe("boom");
    expect(hook.codexStatusUnknown).toBe(false);
  });

  it("a failed FIRST check reports the status as unknown, never 'Not connected' as fact", async () => {
    fetchCodexStatus.mockRejectedValue(new Error("cold boot failure"));
    let hook = renderHook();
    harness.effects[0]();
    await flushAsync();

    hook = renderHook();
    expect(hook.codexLoading).toBe(false);
    expect(hook.codexStatusError).toBe("cold boot failure");
    expect(hook.codexStatusUnknown).toBe(true);
  });

  it("a later successful check clears the error and leaves the unknown state", async () => {
    fetchCodexStatus.mockRejectedValue(new Error("cold boot failure"));
    let hook = renderHook();
    harness.effects[0]();
    await flushAsync();
    expect(renderHook().codexStatusUnknown).toBe(true);

    fetchCodexStatus.mockResolvedValue({ connected: false });
    hook = renderHook();
    harness.effects[0]();
    await flushAsync();

    hook = renderHook();
    expect(hook.codexStatus.connected).toBe(false);
    expect(hook.codexStatusError).toBe("");
    expect(hook.codexStatusUnknown).toBe(false);
  });
});

describe("frontend/use-welcome-codex disconnect", () => {
  it("exposes a pending state while the disconnect is in flight", async () => {
    const hook = await mountConnected();
    const disconnectGate = deferred();
    disconnectCodex.mockReturnValue(disconnectGate.promise);

    const pending = hook.handleCodexDisconnect();
    expect(renderHook().codexDisconnecting).toBe(true);

    fetchCodexStatus.mockResolvedValue({ connected: false });
    disconnectGate.resolve({ ok: true });
    await pending;
    expect(renderHook().codexDisconnecting).toBe(false);
    expect(setFormError).not.toHaveBeenCalledWith(expect.any(String));
  });

  it("surfaces a thrown disconnect as a form error instead of an unhandled rejection", async () => {
    const hook = await mountConnected();
    disconnectCodex.mockRejectedValue(new Error("net down"));

    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      await hook.handleCodexDisconnect();
      await flushAsync();
      expect(setFormError).toHaveBeenCalledWith("net down");
      expect(renderHook().codexDisconnecting).toBe(false);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("reports an unsuccessful disconnect result as a form error", async () => {
    const hook = await mountConnected();
    disconnectCodex.mockResolvedValue({ ok: false, error: "still busy" });
    await hook.handleCodexDisconnect();
    expect(setFormError).toHaveBeenCalledWith("still busy");
    expect(renderHook().codexDisconnecting).toBe(false);
  });
});

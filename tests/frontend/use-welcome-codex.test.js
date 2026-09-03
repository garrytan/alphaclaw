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
  fetchCodexStatus,
} from "../../lib/public/js/lib/api.js";
import { openCodexAuthWindow } from "../../lib/public/js/lib/codex-oauth-window.js";
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

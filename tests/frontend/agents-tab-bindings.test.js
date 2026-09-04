import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as team-tab-component): hook state lives
// in per-call-index slots so hooks can be invoked directly without a DOM
// renderer. Effects are collected, not run.
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
  deleteChannelAccount: vi.fn(),
  fetchChannelAccounts: vi.fn(),
  fetchStatus: vi.fn(),
  updateChannelAccount: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/channel-create-operation.js", () => ({
  createChannelAccountWithProgress: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { useAgentBindings } from "../../lib/public/js/components/agents-tab/agent-bindings-section/use-agent-bindings.js";

const harness = preactHooks.__harness;

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const makeDeferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const kAgent = { id: "a1", default: false };

const renderHook = () => {
  harness.beginRender();
  return useAgentBindings({ agent: kAgent, agents: [kAgent] });
};

const channelsPayload = (name) => ({
  channels: [{ channel: "telegram", accounts: [{ id: "default", name }] }],
});

describe("frontend/agents-tab bindings hook", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    global.window = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    };
    api.fetchStatus.mockResolvedValue({ channels: {} });
    api.fetchChannelAccounts.mockResolvedValue(channelsPayload("First"));
  });

  it("ignores a stale response that resolves after a newer load (latest-request-wins)", async () => {
    const older = makeDeferred();
    const newer = makeDeferred();
    api.fetchChannelAccounts
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    let hook = renderHook();
    const firstLoad = hook.retryLoad();
    const secondLoad = hook.retryLoad();

    newer.resolve(channelsPayload("Newest"));
    await flushAsync();
    older.resolve(channelsPayload("Stale"));
    await Promise.all([firstLoad, secondLoad]);

    hook = renderHook();
    expect(hook.channels[0].accounts[0].name).toBe("Newest");
    expect(hook.loading).toBe(false);
  });

  it("keeps the list rendered on refetch: initial load vs refreshing split", async () => {
    let hook = renderHook();
    expect(hook.loading).toBe(true);

    await hook.retryLoad();
    hook = renderHook();
    expect(hook.loading).toBe(false);
    expect(hook.channels).toHaveLength(1);

    const deferred = makeDeferred();
    api.fetchChannelAccounts.mockReturnValueOnce(deferred.promise);
    const refresh = hook.retryLoad();
    hook = renderHook();
    // Refetch must not flip back to `loading` and unmount the list.
    expect(hook.loading).toBe(false);
    expect(hook.refreshing).toBe(true);
    expect(hook.channels).toHaveLength(1);

    deferred.resolve(channelsPayload("First"));
    await refresh;
    hook = renderHook();
    expect(hook.refreshing).toBe(false);
  });

  it("surfaces a fetch error as loadError with last-known-good data intact", async () => {
    let hook = renderHook();
    await hook.retryLoad();

    api.fetchChannelAccounts.mockRejectedValueOnce(new Error("network down"));
    hook = renderHook();
    await hook.retryLoad();

    hook = renderHook();
    expect(hook.loadError).toBeTruthy();
    expect(hook.loadError.message).toBe("network down");
    // Error must not masquerade as an empty list.
    expect(hook.channels).toHaveLength(1);
    expect(hook.loading).toBe(false);

    await hook.retryLoad();
    hook = renderHook();
    expect(hook.loadError).toBe(null);
  });

  it("sets loadError on a failed initial load instead of a confident empty state", async () => {
    api.fetchChannelAccounts.mockRejectedValueOnce(new Error("boom"));
    let hook = renderHook();
    await hook.retryLoad();

    hook = renderHook();
    expect(hook.loading).toBe(false);
    expect(hook.loadError).toBeTruthy();
    expect(hook.channels).toHaveLength(0);
  });

  it("marks the clicked account as pending while a quick bind is in flight", async () => {
    const deferred = makeDeferred();
    api.updateChannelAccount.mockReturnValueOnce(deferred.promise);

    let hook = renderHook();
    await hook.retryLoad();
    hook = renderHook();

    const bind = hook.handleQuickBind({
      provider: "telegram",
      id: "default",
      name: "First",
    });
    hook = renderHook();
    expect(hook.pendingBindKey).toBe("telegram:default");
    expect(hook.saving).toBe(true);

    deferred.resolve({ ok: true });
    await bind;
    hook = renderHook();
    expect(hook.pendingBindKey).toBe("");
    expect(hook.saving).toBe(false);
  });

  // D3/D5/D7: the bindings section is the second delete caller — it reads the
  // same additive outcome flags (AGENTS.md: a failed pairing-row clear is
  // reported, never a clean delete) and raises the restart banner itself.
  const deleteFromBindings = async (result) => {
    api.deleteChannelAccount.mockResolvedValue(result);
    let hook = renderHook();
    await hook.retryLoad();
    hook = renderHook();
    hook.setDeletingAccount({ id: "default", provider: "telegram" });
    hook = renderHook();
    await hook.handleDeleteChannel();
    return renderHook();
  };

  it("a delete whose pairing-row clear FAILED toasts an error with the reason and remedy — never 'Channel deleted' success", async () => {
    const hook = await deleteFromBindings({
      ok: true,
      pairingRowsCleanupFailed: true,
      pairingRowsCleanupError: "disk I/O error",
    });
    expect(api.deleteChannelAccount).toHaveBeenCalledWith({
      provider: "telegram",
      accountId: "default",
    });
    const [message, level] = showToast.mock.calls.at(-1);
    expect(level).toBe("error");
    expect(message).toContain("STILL authorized");
    expect(message).toContain("disk I/O error");
    expect(message).toContain("clear the rows by hand");
    expect(showToast).not.toHaveBeenCalledWith("Channel deleted", "success");
    // The delete itself succeeded: the dialog closes and bindings re-announce.
    expect(hook.deletingAccount).toBeNull();
    expect(
      global.window.dispatchEvent.mock.calls.map((call) => call[0].type),
    ).toContain("alphaclaw:agent-bindings-changed");
    expect(
      global.window.dispatchEvent.mock.calls.map((call) => call[0].type),
    ).not.toContain("alphaclaw:restart-required");
  });

  it("a DEFERRED pairing-row clear toasts a warning; gatewayRestartFailed raises the restart banner", async () => {
    await deleteFromBindings({ ok: true, pairingRowsCleanupDeferred: true });
    let [message, level] = showToast.mock.calls.at(-1);
    expect(level).toBe("warning");
    expect(message).toContain("stay authorized until the running backup finishes");
    expect(
      global.window.dispatchEvent.mock.calls.map((call) => call[0].type),
    ).not.toContain("alphaclaw:restart-required");

    harness.reset();
    global.window.dispatchEvent.mockClear();
    await deleteFromBindings({ ok: true, gatewayRestartFailed: true });
    [message, level] = showToast.mock.calls.at(-1);
    expect(level).toBe("warning");
    expect(message).toContain("gateway restart also failed");
    expect(
      global.window.dispatchEvent.mock.calls.map((call) => call[0].type),
    ).toContain("alphaclaw:restart-required");

    // A clean delete stays a clean success.
    harness.reset();
    global.window.dispatchEvent.mockClear();
    await deleteFromBindings({ ok: true });
    expect(showToast).toHaveBeenLastCalledWith("Channel deleted", "success");
    expect(
      global.window.dispatchEvent.mock.calls.map((call) => call[0].type),
    ).not.toContain("alphaclaw:restart-required");
  });

});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Slot harness (cron-tab.test.js pattern) with dep tracking: useEffect/useMemo
// record deps per slot and an effect is queued only when its deps changed, so
// tests can model background refetches (new object, same values) faithfully.
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

vi.mock("../../lib/public/js/lib/api.js", () => ({
  deleteWebhook: vi.fn(),
  fetchAgents: vi.fn(),
  fetchWebhookDetail: vi.fn(),
  rotateWebhookOauthCallback: vi.fn(),
  updateWebhookDestination: vi.fn(),
  sendWebhookRequest: vi.fn(),
}));

// use-cached-fetch stand-in: per-call-index slots the tests drive directly.
vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => {
  const registry = { slots: [], cursor: 0 };
  registry.beginRender = () => {
    registry.cursor = 0;
  };
  registry.ensureSlot = (index) => {
    if (!registry.slots[index]) {
      registry.slots[index] = {
        data: null,
        loading: false,
        error: null,
        refresh: vi.fn(async () => null),
      };
    }
    return registry.slots[index];
  };
  registry.reset = () => {
    registry.slots = [];
    registry.cursor = 0;
  };
  const useCachedFetch = () => {
    const slot = registry.ensureSlot(registry.cursor++);
    return {
      data: slot.data,
      loading: slot.loading,
      error: slot.error,
      refresh: slot.refresh,
    };
  };
  return { useCachedFetch, __cachedFetchRegistry: registry };
});

vi.mock(
  "../../lib/public/js/hooks/use-destination-session-selection.js",
  () => {
    const destination = {
      sessions: [],
      loading: false,
      error: "",
      destinationSessionKey: "",
      selectedDestination: null,
      setCalls: [],
    };
    // Stable setter identity: it sits in the sync effect's dep array.
    const setDestinationSessionKey = (key) => destination.setCalls.push(key);
    destination.reset = () => {
      destination.sessions = [];
      destination.loading = false;
      destination.error = "";
      destination.destinationSessionKey = "";
      destination.selectedDestination = null;
      destination.setCalls = [];
    };
    const useDestinationSessionSelection = () => ({
      sessions: destination.sessions,
      loading: destination.loading,
      error: destination.error,
      destinationSessionKey: destination.destinationSessionKey,
      setDestinationSessionKey,
      selectedDestination: destination.selectedDestination,
    });
    return {
      useDestinationSessionSelection,
      kNoDestinationSessionValue: "__none__",
      __destinationState: destination,
    };
  },
);

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import { __cachedFetchRegistry } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { __destinationState } from "../../lib/public/js/hooks/use-destination-session-selection.js";
import { deleteWebhook, sendWebhookRequest } from "../../lib/public/js/lib/api.js";
import { getCached, setCached } from "../../lib/public/js/lib/api-cache.js";
import { useWebhookDetail } from "../../lib/public/js/components/webhooks/webhook-detail/use-webhook-detail.js";
import {
  kHookTokenPlaceholder,
  kSendTestNeedsOwnTokenReason,
  kSendTestSignedReason,
} from "../../lib/public/js/components/webhooks/own-token.js";

const harness = preactHooks.__harness;

const flushAsync = async () => {
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
};

const kSessionOne = {
  key: "agent:main:telegram:direct:111",
  replyChannel: "telegram",
  replyTo: "111",
};
const kSessionTwo = {
  key: "agent:main:telegram:direct:222",
  replyChannel: "telegram",
  replyTo: "222",
};

const makeWebhook = (overrides = {}) => ({
  name: "hook-1",
  managed: false,
  agentId: "main",
  channel: "telegram",
  to: "111",
  ...overrides,
});

const renderHook = (props = {}) => {
  harness.beginRender();
  __cachedFetchRegistry.beginRender();
  return useWebhookDetail({ selectedHookName: "hook-1", ...props });
};

// Slot 0 = webhook detail fetch, slot 1 = agents fetch.
const detailSlot = () => __cachedFetchRegistry.ensureSlot(0);
const agentsSlot = () => __cachedFetchRegistry.ensureSlot(1);

beforeEach(() => {
  harness.reset();
  __cachedFetchRegistry.reset();
  __destinationState.reset();
  vi.clearAllMocks();
});

describe("frontend/use-webhook-detail destination sync", () => {
  it("applies the stored destination once sessions and webhook are loaded", () => {
    detailSlot().data = makeWebhook();
    __destinationState.sessions = [kSessionOne, kSessionTwo];
    renderHook();
    harness.flushEffects();
    expect(__destinationState.setCalls).toEqual([kSessionOne.key]);
  });

  it("does not reset the select when a background refetch returns an identical destination (new object identity)", () => {
    detailSlot().data = makeWebhook();
    __destinationState.sessions = [kSessionOne, kSessionTwo];
    renderHook();
    harness.flushEffects();

    // User picks a different session (unsaved manual selection).
    const hook = renderHook();
    harness.flushEffects();
    hook.actions.setDestinationSessionKey(kSessionTwo.key);
    expect(__destinationState.setCalls).toEqual([
      kSessionOne.key,
      kSessionTwo.key,
    ]);

    // 15s poll refetch: same values, new object. Pre-fix this re-ran the sync
    // effect (object-identity dep) and clobbered the user's selection.
    detailSlot().data = makeWebhook();
    renderHook();
    harness.flushEffects();
    expect(__destinationState.setCalls).toEqual([
      kSessionOne.key,
      kSessionTwo.key,
    ]);
  });

  it("re-syncs when the stored destination value actually changes", () => {
    detailSlot().data = makeWebhook();
    __destinationState.sessions = [kSessionOne, kSessionTwo];
    const hook = renderHook();
    harness.flushEffects();
    hook.actions.setDestinationSessionKey(kSessionTwo.key);

    detailSlot().data = makeWebhook({ to: "222" });
    renderHook();
    harness.flushEffects();
    expect(__destinationState.setCalls.at(-1)).toBe(kSessionTwo.key);
    expect(__destinationState.setCalls.length).toBe(3);
  });
});

describe("frontend/use-webhook-detail delete", () => {
  it("invalidates the cached detail and swallows refresh rejections", async () => {
    const detailCacheKey = "/api/webhooks/hook-1";
    setCached(detailCacheKey, makeWebhook());
    detailSlot().data = makeWebhook();
    deleteWebhook.mockResolvedValue({});
    agentsSlot().refresh.mockRejectedValue(new Error("agents refresh boom"));

    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const hook = renderHook();
      await hook.actions.handleDeleteConfirmed();
      await flushAsync();
      expect(getCached(detailCacheKey)).toBe(null);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("refreshDetail never surfaces an unhandled rejection", async () => {
    detailSlot().data = makeWebhook();
    detailSlot().refresh.mockRejectedValue(new Error("detail boom"));
    agentsSlot().refresh.mockRejectedValue(new Error("agents boom"));

    const unhandled = [];
    const onUnhandled = (err) => unhandled.push(err);
    process.on("unhandledRejection", onUnhandled);
    try {
      const hook = renderHook();
      hook.actions.refreshDetail();
      await flushAsync();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("frontend/use-webhook-detail test send", () => {
  it.each([
    ["the hook accepts", () => sendWebhookRequest.mockResolvedValue("")],
    ["the hook rejects", () => sendWebhookRequest.mockResolvedValue("bad token")],
    ["reading the answer fails", () => sendWebhookRequest.mockRejectedValue(new Error("connection reset"))],
  ])("refreshes the request history once when %s", async (_label, arrange) => {
    detailSlot().data = makeWebhook();
    arrange();
    const onTestWebhookSent = vi.fn();
    const hook = renderHook({ onTestWebhookSent });
    await hook.actions.handleSendTestWebhook();
    expect(sendWebhookRequest).toHaveBeenCalled();
    expect(onTestWebhookSent).toHaveBeenCalledTimes(1);
  });
});

describe("frontend/use-webhook-detail own token", () => {
  const kOwnToken = ["own", "token", "x9+y8"].join("-");
  const kAuthScheme = ["Authorization:", "Bearer"].join(" ");
  const kHookUrl = "https://box.example.com/hooks/hook-1";
  const makeOwnTokenHook = (overrides = {}) =>
    makeWebhook({
      fullUrl: kHookUrl,
      queryStringUrl: `${kHookUrl}?token=${kHookTokenPlaceholder}`,
      authHeaderValue: [kAuthScheme, kHookTokenPlaceholder].join(" "),
      hasHookToken: true,
      ingress: { preset: "per_hook_token" },
      ...overrides,
    });

  it("uses the in-memory token in the URLs, the curl example and Send test", async () => {
    detailSlot().data = makeOwnTokenHook();
    sendWebhookRequest.mockResolvedValue("");
    const hook = renderHook({ ownToken: kOwnToken });
    expect(hook.state.authHeaderValue).toBe([kAuthScheme, kOwnToken].join(" "));
    expect(hook.state.webhookUrlWithQueryToken).toBe(`${kHookUrl}?token=${encodeURIComponent(kOwnToken)}`);
    expect(hook.state.activeCurlCommand).toContain(kOwnToken);
    expect(hook.state.activeCurlCommand).not.toContain(kHookTokenPlaceholder);
    expect(hook.state.sendTestDisabledReason).toBe("");
    await hook.actions.handleSendTestWebhook();
    const [url, options] = sendWebhookRequest.mock.calls[0];
    expect(url).toBe(kHookUrl);
    expect(options.headers.Authorization).toBe(["Bearer", kOwnToken].join(" "));
    expect(JSON.stringify(getCached("/api/webhooks/hook-1") ?? null)).not.toContain(kOwnToken);
  });

  it("keeps the placeholder and disables Send test without the token", async () => {
    detailSlot().data = makeOwnTokenHook();
    const onTestWebhookSent = vi.fn();
    const hook = renderHook({ onTestWebhookSent });
    expect(hook.state.authHeaderValue).toContain(kHookTokenPlaceholder);
    expect(hook.state.activeCurlCommand).toContain(kHookTokenPlaceholder);
    expect(hook.state.sendTestDisabledReason).toBe(kSendTestNeedsOwnTokenReason);
    await hook.actions.handleSendTestWebhook();
    expect(sendWebhookRequest).not.toHaveBeenCalled();
    expect(onTestWebhookSent).not.toHaveBeenCalled();
  });

  it("disables Send test on a signed hook and keeps the OAuth GET test", () => {
    detailSlot().data = makeOwnTokenHook({ ingress: { preset: "circleback" } });
    expect(renderHook({ ownToken: kOwnToken }).state.sendTestDisabledReason).toBe(kSendTestSignedReason);
    detailSlot().data = makeOwnTokenHook({ oauthCallbackUrl: "https://box.example.com/oauth/cb-1" });
    expect(renderHook().state.sendTestDisabledReason).toBe("");
  });

  it("forgets the kept token once a new secret is issued, and refetches the detail", () => {
    detailSlot().data = makeOwnTokenHook();
    const onForgetOwnToken = vi.fn();
    const hook = renderHook({ ownToken: kOwnToken, onForgetOwnToken });
    hook.actions.handleIngressChanged({ ok: true, ingress: { preset: "per_hook_token" } });
    expect(onForgetOwnToken).not.toHaveBeenCalled();
    expect(detailSlot().refresh).toHaveBeenCalledTimes(1);
    hook.actions.handleIngressChanged({ ok: true, secret: ["new", "secret"].join("-"), ingress: { preset: "per_hook_token" } });
    expect(onForgetOwnToken).toHaveBeenCalledTimes(1);
    expect(detailSlot().refresh).toHaveBeenCalledTimes(2);
  });
});

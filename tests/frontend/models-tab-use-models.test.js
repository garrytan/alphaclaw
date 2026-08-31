import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as use-saved-setting.test.js): hook
// state lives in per-call-index slots so the hook can be invoked directly
// without a DOM renderer. Effects are collected, not run — tests invoke them
// to model mount/dep-change.
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
  fetchModels: vi.fn(),
  fetchModelsConfig: vi.fn(),
  saveModelsConfig: vi.fn(),
  fetchCodexStatus: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

vi.mock("../../lib/public/js/lib/api-cache.js", () => ({
  getCached: vi.fn(() => null),
  setCached: vi.fn(),
  invalidateCache: vi.fn(),
  cachedFetch: vi.fn(),
}));

// Controllable per-key fetch states: the hook's refreshes route through
// these, so tests can defer/reject individual endpoints.
vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => {
  const registry = new Map();
  const useCachedFetch = (key) => {
    if (!registry.has(key)) {
      registry.set(key, {
        data: null,
        error: null,
        loading: false,
        refresh: vi.fn(),
      });
    }
    return registry.get(key);
  };
  return { useCachedFetch, __cachedFetchRegistry: registry };
});

vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: () => ({ data: null, error: null, isPolling: false, refresh: vi.fn() }),
}));

import * as preactHooks from "preact/hooks";
import { __cachedFetchRegistry } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { invalidateCache } from "../../lib/public/js/lib/api-cache.js";
import {
  useModels,
  kCodexStatusCacheKey,
} from "../../lib/public/js/components/models-tab/use-models.js";
import { kModelCatalogCacheKey } from "../../lib/public/js/lib/model-catalog.js";

const harness = preactHooks.__harness;

const kAgentId = "agent-1";
const kConfigKey = `/api/models/config?agentId=${encodeURIComponent(kAgentId)}`;
const kCatalog = {
  models: [
    { key: "anthropic/claude-opus-4-8", label: "Opus 4.8" },
    { key: "openai/gpt-5.6-sol", label: "GPT-5.6 Sol" },
  ],
};

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

// Scoped (agentId) usage bypasses the module-level tab cache, keeping tests
// independent of each other.
const renderHook = (agentId = kAgentId) => {
  let latest;
  const render = (nextAgentId = agentId) => {
    agentId = nextAgentId;
    harness.beginRender();
    latest = useModels(agentId);
    return latest;
  };
  render();
  return {
    result: () => latest,
    render,
    // Drive a refresh via the hook's own action: the mount effect now
    // first-sighting-skips (useCachedFetch's mount fetches cover the initial
    // load; the forced refresh double-hit all three endpoints on every mount).
    runRefreshEffect: () => latest.refresh(),
  };
};

const fetchStates = () => ({
  catalog: __cachedFetchRegistry.get(kModelCatalogCacheKey),
  config: __cachedFetchRegistry.get(kConfigKey),
  codex: __cachedFetchRegistry.get(kCodexStatusCacheKey),
});

const configPayload = (overrides = {}) => ({
  primary: "anthropic/claude-opus-4-8",
  configuredModels: { "anthropic/claude-opus-4-8": {} },
  authProfiles: [
    {
      id: "anthropic:default",
      type: "api_key",
      provider: "anthropic",
      key: "server-key",
    },
    {
      id: "anthropic:manual",
      type: "token",
      provider: "anthropic",
      token: "server-token",
    },
  ],
  authOrder: { anthropic: ["anthropic:default", "anthropic:manual"] },
  ...overrides,
});

beforeEach(() => {
  harness.reset();
  __cachedFetchRegistry.clear();
  vi.clearAllMocks();
});

describe("frontend/models-tab use-models", () => {
  it("refresh does not clobber profile/order edits made while it was in flight; edits the server now reflects are cleared", async () => {
    const hook = renderHook();
    const { catalog, config, codex } = fetchStates();
    catalog.refresh.mockResolvedValue(kCatalog);
    codex.refresh.mockResolvedValue({ connected: false });
    const configGate = deferred();
    config.refresh.mockReturnValue(configGate.promise);

    hook.runRefreshEffect();
    hook.render();

    // Mid-flight edits: one draft diverges from the server, one matches what
    // the server is about to report, plus a diverging order edit.
    hook.result().editProfile("anthropic:manual", {
      type: "token",
      provider: "anthropic",
      token: "draft-token",
    });
    hook.render();
    hook.result().editProfile("anthropic:default", {
      type: "api_key",
      provider: "anthropic",
      key: "server-key",
    });
    hook.render();
    hook.result().editAuthOrder("anthropic", [
      "anthropic:manual",
      "anthropic:default",
    ]);
    hook.render();

    configGate.resolve(configPayload());
    await flushAsync();
    hook.render();

    // The diverging draft survives; the matching one is cleared to server
    // truth (no phantom dirty state).
    expect(hook.result().getProfileValue("anthropic:manual").token).toBe(
      "draft-token",
    );
    expect(hook.result().getProfileValue("anthropic:default").key).toBe(
      "server-key",
    );
    expect(hook.result().getEffectiveOrder("anthropic")).toEqual([
      "anthropic:manual",
      "anthropic:default",
    ]);
    expect(hook.result().authProfiles).toEqual(configPayload().authProfiles);
    expect(hook.result().isDirty).toBe(true);
    expect(hook.result().ready).toBe(true);
  });

  it("refresh keeps an in-flight primary/configured-models draft while moving the saved baseline", async () => {
    const hook = renderHook();
    const { catalog, config, codex } = fetchStates();
    catalog.refresh.mockResolvedValue(kCatalog);
    codex.refresh.mockResolvedValue({ connected: false });
    const configGate = deferred();
    config.refresh.mockReturnValue(configGate.promise);

    hook.runRefreshEffect();
    hook.render();

    hook.result().addModel("openai/gpt-5.6-sol");
    hook.render();
    hook.result().setPrimaryModel("openai/gpt-5.6-sol");
    hook.render();

    configGate.resolve(configPayload());
    await flushAsync();
    hook.render();

    expect(hook.result().primary).toBe("openai/gpt-5.6-sol");
    expect(Object.keys(hook.result().configuredModels)).toContain(
      "openai/gpt-5.6-sol",
    );
    // Baseline moved to server truth, so the draft still reads as dirty.
    expect(hook.result().isDirty).toBe(true);
  });

  it("a superseded refresh never applies its results (latest wins)", async () => {
    const hook = renderHook();
    const { catalog, config, codex } = fetchStates();
    catalog.refresh.mockResolvedValue(kCatalog);
    codex.refresh.mockResolvedValue({ connected: false });
    const gateA = deferred();
    const gateB = deferred();
    config.refresh
      .mockReturnValueOnce(gateA.promise)
      .mockReturnValueOnce(gateB.promise);

    hook.runRefreshEffect(); // refresh A
    hook.render();
    hook.result().refresh(); // refresh B supersedes A
    hook.render();

    gateB.resolve(configPayload({ primary: "openai/gpt-5.6-sol" }));
    await flushAsync();
    gateA.resolve(configPayload({ primary: "anthropic/claude-opus-4-8" }));
    await flushAsync();
    hook.render();

    expect(hook.result().primary).toBe("openai/gpt-5.6-sol");
    expect(hook.result().isDirty).toBe(false);
  });

  it("a refresh from the previous agent is discarded after an agent switch", async () => {
    const hook = renderHook("agent-1");
    const { catalog, config, codex } = fetchStates();
    catalog.refresh.mockResolvedValue(kCatalog);
    codex.refresh.mockResolvedValue({ connected: false });
    const gateA = deferred();
    config.refresh.mockReturnValue(gateA.promise);

    hook.runRefreshEffect();
    hook.render("agent-2"); // switch before the old refresh lands

    gateA.resolve(configPayload({ primary: "agent-1-model" }));
    await flushAsync();
    hook.render("agent-2");

    expect(hook.result().primary).toBe("");
  });

  it("refreshCodexStatus keeps the last-known status on failure and flags the check (no fabricated 'not connected')", async () => {
    const hook = renderHook();
    const { catalog, config, codex } = fetchStates();
    catalog.refresh.mockResolvedValue(kCatalog);
    codex.refresh.mockResolvedValue({ connected: true });
    config.refresh.mockResolvedValue(configPayload());

    hook.runRefreshEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().codexStatus.connected).toBe(true);

    codex.refresh.mockRejectedValueOnce(new Error("status endpoint down"));
    await hook.result().refreshCodexStatus();
    hook.render();

    expect(hook.result().codexStatus.connected).toBe(true);
    expect(hook.result().codexStatusError).toBe("status endpoint down");
    // A prior successful check exists, so render sites may say "last known".
    expect(hook.result().codexStatusKnown).toBe(true);
    // Failure path must not touch the model catalog either.
    expect(invalidateCache).not.toHaveBeenCalledWith(kModelCatalogCacheKey);
  });

  it("refreshCodexStatus routes through the cached fetch state (force) and clears the failure flag on success", async () => {
    const hook = renderHook();
    const { catalog, config, codex } = fetchStates();
    catalog.refresh.mockResolvedValue(kCatalog);
    codex.refresh.mockResolvedValue({ connected: true });
    config.refresh.mockResolvedValue(configPayload());

    hook.runRefreshEffect();
    await flushAsync();
    hook.render();

    codex.refresh.mockRejectedValueOnce(new Error("down"));
    await hook.result().refreshCodexStatus();
    hook.render();
    expect(hook.result().codexStatusError).toBe("down");

    codex.refresh.mockResolvedValueOnce({ connected: false });
    await hook.result().refreshCodexStatus();
    hook.render();

    expect(hook.result().codexStatus.connected).toBe(false);
    expect(hook.result().codexStatusError).toBe("");
    expect(codex.refresh).toHaveBeenCalledWith({ force: true });
    // Successful status change invalidates + re-fetches the catalog.
    expect(invalidateCache).toHaveBeenCalledWith(kModelCatalogCacheKey);
  });

  it("a resolved {ok:false} error envelope is an error, never adopted as empty config", async () => {
    const hook = renderHook();
    const { catalog, config, codex } = fetchStates();
    catalog.refresh.mockResolvedValue(kCatalog);
    codex.refresh.mockResolvedValue({ connected: true });
    config.refresh.mockResolvedValue(configPayload());

    hook.runRefreshEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().primary).toBe("anthropic/claude-opus-4-8");

    // The fetchers resolve HTTP 500s as {ok:false} envelopes. Adopting one
    // would clear models/profiles/order and advance the saved baselines.
    config.refresh.mockResolvedValueOnce({ ok: false, error: "boom" });
    await hook.result().refresh();
    hook.render();

    expect(hook.result().error).not.toBe("");
    expect(hook.result().primary).toBe("anthropic/claude-opus-4-8"); // kept
    expect(hook.result().authProfiles.length).toBeGreaterThan(0); // not cleared
    // Baseline did not advance: the kept primary still reads as clean.
    expect(hook.result().isDirty).toBe(false);
  });

  it("a resolved {ok:false} codex envelope keeps the last-known status (refreshCodexStatus)", async () => {
    const hook = renderHook();
    const { catalog, config, codex } = fetchStates();
    catalog.refresh.mockResolvedValue(kCatalog);
    codex.refresh.mockResolvedValue({ connected: true });
    config.refresh.mockResolvedValue(configPayload());

    hook.runRefreshEffect();
    await flushAsync();
    hook.render();

    codex.refresh.mockResolvedValueOnce({ ok: false, error: "boom" });
    await hook.result().refreshCodexStatus();
    hook.render();

    expect(hook.result().codexStatus.connected).toBe(true); // last-known kept
    expect(hook.result().codexStatusError).toBe("boom");
  });

  it("a failed FIRST check reports no last-known status (codexStatusKnown stays false)", async () => {
    const hook = renderHook();
    const { codex } = fetchStates();
    codex.refresh.mockRejectedValue(new Error("cold boot failure"));

    await hook.result().refreshCodexStatus();
    hook.render();

    // No successful check has ever happened — render sites must say
    // "status unknown", never claim last-known data that doesn't exist.
    expect(hook.result().codexStatusKnown).toBe(false);
    expect(hook.result().codexStatusError).toBe("cold boot failure");
  });
});

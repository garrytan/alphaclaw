import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as watchdog-notifications-settings):
// hook state lives in per-call-index slots so hook functions can be invoked
// directly without a DOM renderer. Effects are collected, not run.
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
  fetchOpenclawFeatures: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import {
  __resetForTests,
  useOpenclawFeatures,
} from "../../lib/public/js/hooks/use-openclaw-features.js";

const harness = preactHooks.__harness;

const flushAsync = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

// Renders N consumers of the hook in one pass (slots stay index-aligned as
// long as the same count is used across re-renders of a test).
const renderConsumers = (count = 1, options = undefined) => {
  harness.beginRender();
  const results = [];
  for (let i = 0; i < count; i += 1) {
    results.push(useOpenclawFeatures(options));
  }
  return results;
};

const runEffects = async () => {
  const effects = [...harness.effects];
  for (const effect of effects) effect?.();
  await flushAsync();
};

describe("frontend/use-openclaw-features hook", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    __resetForTests();
    api.fetchOpenclawFeatures.mockResolvedValue({
      version: "2026.8.1-beta.1",
      features: { sessionDashboards: true },
    });
  });

  it("fetches once even with two concurrent consumers", async () => {
    let consumers = renderConsumers(2);
    expect(consumers[0].loading).toBe(true);
    expect(consumers[1].loading).toBe(true);

    await runEffects();
    consumers = renderConsumers(2);

    expect(api.fetchOpenclawFeatures).toHaveBeenCalledTimes(1);
    for (const consumer of consumers) {
      expect(consumer.loading).toBe(false);
      expect(consumer.version).toBe("2026.8.1-beta.1");
      expect(consumer.features).toEqual({ sessionDashboards: true });
    }

    // A later consumer render reuses the module cache: still one fetch.
    await runEffects();
    renderConsumers(2);
    expect(api.fetchOpenclawFeatures).toHaveBeenCalledTimes(1);
  });

  it("fails closed to an empty feature map when the fetch rejects", async () => {
    api.fetchOpenclawFeatures.mockRejectedValue(new Error("gateway down"));

    renderConsumers(1);
    await runEffects();
    const [consumer] = renderConsumers(1);

    expect(consumer.loading).toBe(false);
    expect(consumer.features).toEqual({});
    expect(consumer.version).toBe(null);
  });

  it("does not fetch at all when disabled", async () => {
    const [consumer] = renderConsumers(1, { enabled: false });
    await runEffects();

    expect(api.fetchOpenclawFeatures).not.toHaveBeenCalled();
    expect(consumer.features).toEqual({});
    expect(consumer.version).toBe(null);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Hook harness (team-tab-component.test.js pattern) — see that file for the
// slot mechanics. Effects are collected, not run.
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

import * as preactHooks from "preact/hooks";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { invalidateCache } from "../../lib/public/js/lib/api-cache.js";

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

const renderHook = (key, fetcher, options) => {
  let currentFetcher = fetcher;
  let latest;
  const render = (nextFetcher = currentFetcher) => {
    currentFetcher = nextFetcher;
    harness.beginRender();
    latest = useCachedFetch(key, currentFetcher, options);
    return latest;
  };
  render();
  return { result: () => latest, render };
};

beforeEach(() => {
  harness.reset();
});

describe("frontend/use-cached-fetch", () => {
  it("refresh always calls the LATEST fetcher (ref), not the render-time closure", async () => {
    const first = vi.fn(async () => "first");
    const second = vi.fn(async () => "second");
    const hook = renderHook("ucf-fetcher-ref-key", first);
    hook.render(second); // fetcher identity churns between renders
    const value = await hook.result().refresh({ force: true });
    expect(value).toBe("second");
    expect(second).toHaveBeenCalledTimes(1);
    expect(first).not.toHaveBeenCalled();
    invalidateCache("ucf-fetcher-ref-key");
  });

  it("latest-request-wins for local state: an older refresh resolving late cannot overwrite newer data", async () => {
    const slow = deferred();
    let call = 0;
    const fetcher = vi.fn(() => {
      call += 1;
      return call === 1 ? slow.promise : Promise.resolve("newer");
    });
    const hook = renderHook("ucf-latest-wins-key", fetcher);

    const oldRefresh = hook.result().refresh({ force: true }); // dispatch 1 (slow)
    const newRefresh = hook.result().refresh({ force: true }); // dispatch 2 (fast)
    await newRefresh;
    hook.render();
    expect(hook.result().data).toBe("newer");

    slow.resolve("older");
    await oldRefresh;
    hook.render();
    // The stale refresh may not overwrite the newer hook-local data.
    expect(hook.result().data).toBe("newer");
    invalidateCache("ucf-latest-wins-key");
  });

  it("a stale refresh error cannot overwrite newer success state", async () => {
    const slow = deferred();
    let call = 0;
    const fetcher = vi.fn(() => {
      call += 1;
      return call === 1 ? slow.promise : Promise.resolve("ok");
    });
    const hook = renderHook("ucf-stale-error-key", fetcher);

    const failing = hook.result().refresh({ force: true }).catch(() => {});
    await hook.result().refresh({ force: true });
    hook.render();
    expect(hook.result().error).toBe(null);

    slow.reject(new Error("late failure"));
    await failing;
    hook.render();
    expect(hook.result().error).toBe(null); // stale error suppressed
    expect(hook.result().data).toBe("ok");
    invalidateCache("ucf-stale-error-key");
  });
});

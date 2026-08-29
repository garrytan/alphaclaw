import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as team-tab-component.test.js): hook
// state lives in per-call-index slots so the hook can be invoked directly
// without a DOM renderer. Effects are collected, not run — tests invoke them
// to model mount/dep-change and capture cleanups to model unmount.
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
import { useSavedSetting } from "../../lib/public/js/hooks/use-saved-setting.js";
import { invalidateCache, setCached } from "../../lib/public/js/lib/api-cache.js";

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

// Renders the hook; returns { result(), render(opts), runLoadEffect() }.
// runLoadEffect models the framework running the [key, loadNonce] effect and
// returns its cleanup (call it to model unmount / effect supersession).
const renderHook = (initialOptions) => {
  let options = initialOptions;
  let latest;
  const render = (nextOptions = options) => {
    options = nextOptions;
    harness.beginRender();
    latest = useSavedSetting(options);
    return latest;
  };
  render();
  return {
    result: () => latest,
    render,
    runLoadEffect: () => {
      const cleanup = harness.effects[0]();
      return cleanup;
    },
  };
};

beforeEach(() => {
  harness.reset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("frontend/use-saved-setting", () => {
  it("hydrates from load() and exposes value + payload", async () => {
    const load = vi.fn(async () => ({ enabled: true, availability: "ok" }));
    const hook = renderHook({ load, select: (d) => d?.enabled === true, save: vi.fn() });
    expect(hook.result().hydrated).toBe(false);
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().hydrated).toBe(true);
    expect(hook.result().value).toBe(true);
    expect(hook.result().payload).toEqual({ enabled: true, availability: "ok" });
    expect(hook.result().loadError).toBe(null);
  });

  it("commits optimistically: the value flips before the save resolves", async () => {
    const saveGate = deferred();
    const save = vi.fn(() => saveGate.promise);
    const hook = renderHook({ load: async () => ({ enabled: false }), select: (d) => d.enabled, save });
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().value).toBe(false);

    const outcomePromise = hook.result().commit(true);
    hook.render();
    expect(hook.result().value).toBe(true); // instant — no waiting on the PUT
    expect(hook.result().saving).toBe(true);

    saveGate.resolve({ ok: true });
    const outcome = await outcomePromise;
    hook.render();
    expect(outcome.ok).toBe(true);
    expect(outcome.value).toBe(true);
    expect(hook.result().saving).toBe(false);
    expect(hook.result().saveError).toBe(null);
  });

  it("reverts loudly on save failure and reconciles with a fresh load", async () => {
    const error = Object.assign(new Error("disk full"), { hint: "Check disk space." });
    const loads = [{ enabled: false }, { enabled: false }];
    const load = vi.fn(async () => loads.shift());
    const hook = renderHook({ load, select: (d) => d.enabled, save: vi.fn(async () => { throw error; }) });
    hook.runLoadEffect();
    await flushAsync();
    hook.render();

    const outcome = await hook.result().commit(true);
    hook.render();
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toBe(error);
    expect(hook.result().value).toBe(false); // reverted
    expect(hook.result().saveError).toEqual({ attempted: true, error, context: null });

    // Reconcile: the failure bumped loadNonce — running the (re-collected)
    // effect converges the UI to server truth.
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(load).toHaveBeenCalledTimes(2);
    expect(hook.result().value).toBe(false);
  });

  it("ignores a stale GET that lands after a user commit (dispatched before it)", async () => {
    const loadGate = deferred();
    const hook = renderHook({
      load: () => loadGate.promise,
      select: (d) => d.enabled,
      save: vi.fn(async () => ({})),
    });
    hook.runLoadEffect(); // GET in flight with pre-commit generation

    await hook.result().commit(true); // fast PUT wins
    hook.render();
    expect(hook.result().value).toBe(true);

    loadGate.resolve({ enabled: false, availability: "ok" }); // pre-write snapshot lands late
    await flushAsync();
    hook.render();
    expect(hook.result().value).toBe(true); // user action supersedes the stale GET
    expect(hook.result().payload).toEqual({ enabled: false, availability: "ok" }); // non-mutable payload still applied
    expect(hook.result().hydrated).toBe(true);
  });

  it("drops load results entirely after unmount (active flag)", async () => {
    const loadGate = deferred();
    const hook = renderHook({ load: () => loadGate.promise, select: (d) => d.enabled, save: vi.fn() });
    const cleanup = hook.runLoadEffect();
    cleanup(); // unmount
    loadGate.resolve({ enabled: true });
    await flushAsync();
    hook.render();
    expect(hook.result().hydrated).toBe(false);
    expect(hook.result().value).toBe(undefined);
  });

  it("exposes loadError with retryLoad instead of presenting the default as fact", async () => {
    const error = new Error("boom");
    const loads = [Promise.reject(error), Promise.resolve({ enabled: true })];
    const load = vi.fn(() => loads.shift());
    const hook = renderHook({ load, select: (d) => d.enabled, save: vi.fn() });
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().loadError).toBe(error);
    expect(hook.result().hydrated).toBe(true);
    expect(hook.result().value).toBe(undefined); // never a fabricated default

    hook.result().retryLoad();
    hook.render();
    expect(hook.result().loadError).toBe(null);
    expect(hook.result().hydrated).toBe(false);
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().value).toBe(true);
    expect(hook.result().hydrated).toBe(true);
  });

  it("treats a select() throw as a loadError", async () => {
    const hook = renderHook({
      load: async () => ({ shape: "changed" }),
      select: () => {
        throw new Error("bad shape");
      },
      save: vi.fn(),
    });
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().loadError).toBeInstanceOf(Error);
    expect(hook.result().hydrated).toBe(true);
    expect(hook.result().value).toBe(undefined);
  });

  it("does not revert a successful save when onSaved throws (isolation)", async () => {
    const onSaved = vi.fn(async () => {
      throw new Error("invalidation blew up");
    });
    const hook = renderHook({
      load: async () => ({ enabled: false }),
      select: (d) => d.enabled,
      save: vi.fn(async () => ({})),
      onSaved,
    });
    hook.runLoadEffect();
    await flushAsync();
    hook.render();

    const outcome = await hook.result().commit(true);
    hook.render();
    expect(onSaved).toHaveBeenCalled();
    expect(outcome.ok).toBe(true); // the PUT succeeded — invalidation failure is not a save failure
    expect(hook.result().value).toBe(true);
    expect(hook.result().saveError).toBe(null);
  });

  it("passes next value and response to onSaved", async () => {
    const onSaved = vi.fn();
    const hook = renderHook({
      load: async () => ({ enabled: false }),
      select: (d) => d.enabled,
      save: vi.fn(async () => ({ echoed: true })),
      onSaved,
    });
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    await hook.result().commit(true);
    expect(onSaved).toHaveBeenCalledWith(true, { echoed: true });
  });

  it("locks concurrent commits synchronously (savingRef, not state)", async () => {
    const saveGate = deferred();
    const save = vi.fn(() => saveGate.promise);
    const hook = renderHook({ load: async () => ({ enabled: false }), select: (d) => d.enabled, save });
    hook.runLoadEffect();
    await flushAsync();
    hook.render();

    // Two commits in the same tick — before any re-render could update
    // `saving` state. The ref must reject the second.
    const first = hook.result().commit(true);
    const second = await hook.result().commit(false);
    expect(second.busy).toBe(true);
    expect(save).toHaveBeenCalledTimes(1);
    saveGate.resolve({});
    await first;
  });

  it("resets and refetches when key changes; no frame shows the old entity interactive", async () => {
    const loadsByKey = { a: { enabled: true }, b: { enabled: false } };
    let currentKey = "a";
    const load = vi.fn(async () => loadsByKey[currentKey]);
    const options = (key) => ({ key, load, select: (d) => d.enabled, save: vi.fn() });
    const hook = renderHook(options("a"));
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().value).toBe(true);

    currentKey = "b";
    hook.render(options("b")); // render-phase reset fires
    hook.render(options("b")); // settle the render-phase setState pass
    expect(hook.result().hydrated).toBe(false); // gated — not interactive with a's value
    expect(hook.result().value).toBe(undefined);
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().value).toBe(false);
    expect(hook.result().hydrated).toBe(true);
  });

  it("a stale save from a previous key cannot write state or release the new key's lock", async () => {
    const saveGate = deferred();
    const save = vi.fn(() => saveGate.promise);
    const load = vi.fn(async () => ({ enabled: false }));
    const options = (key) => ({ key, load, select: (d) => d.enabled, save });
    const hook = renderHook(options("a"));
    hook.runLoadEffect();
    await flushAsync();
    hook.render();

    const stale = hook.result().commit(true); // key a save in flight
    hook.render(options("b")); // switch entities mid-save (render-phase reset)
    hook.render(options("b"));
    expect(hook.result().saving).toBe(false); // new key is not saving

    saveGate.reject(new Error("a failed late"));
    await stale;
    hook.render();
    // The stale operation may not set errors or values on key b.
    expect(hook.result().saveError).toBe(null);
    expect(hook.result().value).toBe(undefined);
    // And key b's lock is free: a new commit is accepted.
    const next = await hook.result().commit(true);
    expect(next.busy).toBeFalsy();
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("supports functional commits merging from a synchronous snapshot", async () => {
    const save = vi.fn(async () => ({}));
    const hook = renderHook({
      load: async () => ({ autoRepair: true, notify: false }),
      select: (d) => d,
      save,
    });
    hook.runLoadEffect();
    await flushAsync();
    hook.render();

    await hook.result().commit((current) => ({ ...current, notify: true }), { context: "notify" });
    hook.render();
    expect(save).toHaveBeenCalledWith({ autoRepair: true, notify: true });
    expect(hook.result().value).toEqual({ autoRepair: true, notify: true });
  });

  it("scopes saving and saveError by context for document-level hooks", async () => {
    const saveGate = deferred();
    const hook = renderHook({
      load: async () => ({ autoRepair: true, notify: false }),
      select: (d) => d,
      save: () => saveGate.promise,
    });
    hook.runLoadEffect();
    await flushAsync();
    hook.render();

    const pending = hook.result().commit((c) => ({ ...c, notify: true }), { context: "notify" });
    hook.render();
    expect(hook.result().saving).toBe(true);
    expect(hook.result().savingContext).toBe("notify");

    saveGate.reject(new Error("nope"));
    await pending;
    hook.render();
    expect(hook.result().saveError.context).toBe("notify");
    expect(hook.result().savingContext).toBe(null);
  });

  it("adopts the canonical value via selectSaved only", async () => {
    const hook = renderHook({
      load: async () => ({ enabled: false }),
      select: (d) => d.enabled,
      selectSaved: (response) => response.enabled,
      save: vi.fn(async () => ({ ok: true, enabled: false })), // server normalized the value
    });
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    await hook.result().commit(true);
    hook.render();
    expect(hook.result().value).toBe(false); // server truth adopted
  });

  it("seeds interactively from cacheKey and lets a click during revalidation win", async () => {
    setCached("saved-setting-seed-key", { enabled: true });
    const loadGate = deferred();
    const hook = renderHook({
      cacheKey: "saved-setting-seed-key",
      load: () => loadGate.promise,
      select: (d) => d.enabled,
      save: vi.fn(async () => ({})),
    });
    // Seeded: interactive immediately — no "Loading..." hostage.
    expect(hook.result().hydrated).toBe(true);
    expect(hook.result().value).toBe(true);

    hook.runLoadEffect(); // foreground revalidate in flight
    await hook.result().commit(false); // user clicks during revalidation
    hook.render();
    loadGate.resolve({ enabled: true }); // revalidate lands late with pre-click truth
    await flushAsync();
    hook.render();
    expect(hook.result().value).toBe(false); // the click wins
    invalidateCache("saved-setting-seed-key");
  });

  it("corrects a stale seed visibly when the revalidate differs and no click happened", async () => {
    setCached("saved-setting-seed-key-2", { enabled: true });
    const hook = renderHook({
      cacheKey: "saved-setting-seed-key-2",
      load: async () => ({ enabled: false }),
      select: (d) => d.enabled,
      save: vi.fn(),
    });
    expect(hook.result().value).toBe(true); // seeded
    hook.runLoadEffect();
    await flushAsync();
    hook.render();
    expect(hook.result().value).toBe(false); // server corrected
    invalidateCache("saved-setting-seed-key-2");
  });
});

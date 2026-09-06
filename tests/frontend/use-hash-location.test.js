import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Collect-only hook harness (use-general-tab.test.js pattern).
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
  const useCallback = (fn) => fn;
  const useEffect = (effect) => {
    harness.effects.push(effect);
  };
  return { useState, useCallback, useEffect, __harness: harness };
});

import * as preactHooks from "preact/hooks";
import { kDefaultUiTab } from "../../lib/public/js/lib/app-navigation.js";
import {
  getHashRouterPath,
  getHashRouterQuery,
  useHashLocation,
  useHashQuery,
} from "../../lib/public/js/hooks/use-hash-location.js";

const harness = preactHooks.__harness;

// Browsers normalize `location.hash = "/x"` to "#/x"; the double does too.
const makeLocation = (initialHash) => {
  let hash = initialHash;
  const location = {
    get hash() {
      return hash;
    },
    set hash(next) {
      const value = String(next);
      hash = !value ? "" : value.startsWith("#") ? value : `#${value}`;
    },
  };
  location.replace = vi.fn((next) => {
    location.hash = next;
  });
  return location;
};

const makeWindow = (hash) => {
  const listeners = new Set();
  const win = {
    location: makeLocation(hash),
    addEventListener: vi.fn((type, handler) => {
      if (type === "hashchange") listeners.add(handler);
    }),
    removeEventListener: vi.fn((type, handler) => {
      if (type === "hashchange") listeners.delete(handler);
    }),
    fireHashChange() {
      for (const handler of [...listeners]) handler();
    },
  };
  return win;
};

describe("frontend/hooks use-hash-location (fix wave F138/F140)", () => {
  let win;

  beforeEach(() => {
    harness.reset();
    win = makeWindow("#/browse/skills/x.md?view=diff&line=12");
    vi.stubGlobal("window", win);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("routes on the PATH only but keeps the query reachable through useHashQuery", () => {
    expect(getHashRouterPath()).toBe("/browse/skills/x.md");
    expect(getHashRouterQuery()).toBe("view=diff&line=12");

    harness.beginRender();
    const [location] = useHashLocation();
    const query = useHashQuery();
    expect(location).toBe("/browse/skills/x.md");
    expect(query).toBe("view=diff&line=12");
  });

  it("defaults to the default tab for an empty hash and prefixes a bare hash with a slash", () => {
    win.location.hash = "";
    expect(getHashRouterPath()).toBe(`/${kDefaultUiTab}`);
    expect(getHashRouterQuery()).toBe("");
    win.location.hash = "#watchdog?incident=5";
    expect(getHashRouterPath()).toBe("/watchdog");
    expect(getHashRouterQuery()).toBe("incident=5");
  });

  it("both hooks follow hashchange (path and query independently)", () => {
    harness.beginRender();
    useHashLocation();
    useHashQuery();
    for (const effect of harness.effects) effect();
    win.location.hash = "#/doctor?focus=context";
    win.fireHashChange();
    harness.beginRender();
    const [location] = useHashLocation();
    const query = useHashQuery();
    expect(location).toBe("/doctor");
    expect(query).toBe("focus=context");
  });

  it("setLocation pushes by default (history entry) and REPLACES on { replace: true } — redirects never build a Back-button trap", () => {
    harness.beginRender();
    const [, setLocation] = useHashLocation();

    setLocation("/upgrade");
    expect(win.location.hash).toBe("#/upgrade");
    expect(win.location.replace).not.toHaveBeenCalled();

    setLocation("/agents/alpha", { replace: true });
    expect(win.location.replace).toHaveBeenCalledWith("#/agents/alpha");
    // replace() does not fire hashchange everywhere: the router state is mirrored.
    harness.beginRender();
    const [location] = useHashLocation();
    expect(location).toBe("/agents/alpha");

    // A bare target is normalized to a leading slash on both paths.
    setLocation("cron");
    expect(win.location.hash).toBe("#/cron");
    setLocation("team", { replace: true });
    expect(win.location.replace).toHaveBeenLastCalledWith("#/team");
  });

  it("setLocation to the current hash is a no-op on the URL (no duplicate history entry)", () => {
    win.location.hash = "#/cron";
    harness.reset();
    harness.beginRender();
    const [, setLocation] = useHashLocation();
    const before = win.location.hash;
    setLocation("/cron");
    expect(win.location.hash).toBe(before);
    expect(win.location.replace).not.toHaveBeenCalled();
  });
});

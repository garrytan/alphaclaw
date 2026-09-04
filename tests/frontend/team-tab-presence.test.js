import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Slot harness with dep tracking (sidebar-git-panel.test.js pattern).
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

vi.mock("../../lib/public/js/lib/api.js", async (importOriginal) => {
  const actual = await importOriginal();
  return Object.fromEntries(Object.keys(actual).map((key) => [key, vi.fn()]));
});

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import {
  fetchDevicePairings,
  fetchTeam,
  fetchTeamPresence,
} from "../../lib/public/js/lib/api.js";
import { useTeamTab } from "../../lib/public/js/components/team-tab/use-team-tab.js";
import { PresenceCard } from "../../lib/public/js/components/team-tab/index.js";

const harness = preactHooks.__harness;

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  return out;
};

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object" && node.props) {
    collectText(node.props.children, out);
  }
  return out;
};

const nodeText = (node) => collectText(node).join(" ").replace(/\s+/g, " ");

const flushAsync = async () => {
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, 0));
};

const makeTeam = (overrides = {}) => ({
  enabled: true,
  me: { role: "member" },
  members: [],
  invites: [],
  presence: [{ email: "sam@acme.dev", displayName: "Sam", lastSeenAt: null }],
  ...overrides,
});

describe("frontend/team-tab presence refresh failures", () => {
  let intervalCallbacks;

  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
    intervalCallbacks = [];
    vi.stubGlobal("setInterval", (callback) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    });
    vi.stubGlobal("clearInterval", vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const renderHook = () => {
    harness.beginRender();
    return useTeamTab();
  };

  it("stores the caught message string (never a boolean) and clears it on recovery", async () => {
    fetchTeam.mockResolvedValue(makeTeam());

    let hook = renderHook();
    expect(hook.presenceUnavailable).toBe(null);
    harness.flushEffects();
    await flushAsync();

    hook = renderHook();
    harness.flushEffects(); // registers the presence poll interval
    await flushAsync();
    expect(intervalCallbacks.length).toBeGreaterThan(0);

    fetchTeamPresence.mockRejectedValueOnce(new Error("presence socket down"));
    await intervalCallbacks.at(-1)();
    hook = renderHook();
    expect(hook.presenceUnavailable).toBe("presence socket down");

    fetchTeamPresence.mockResolvedValueOnce({ presence: [] });
    await intervalCallbacks.at(-1)();
    hook = renderHook();
    expect(hook.presenceUnavailable).toBe(null);
  });

  it("falls back to 'unknown error' when the rejection carries no message", async () => {
    fetchTeam.mockResolvedValue(makeTeam());

    renderHook();
    harness.flushEffects();
    await flushAsync();
    renderHook();
    harness.flushEffects();
    await flushAsync();

    fetchTeamPresence.mockRejectedValueOnce(undefined);
    await intervalCallbacks.at(-1)();
    const hook = renderHook();
    expect(hook.presenceUnavailable).toBe("unknown error");
  });

  it("a failed device-queue poll is devicesError, never an empty queue; it clears on recovery (F170)", async () => {
    fetchTeam.mockResolvedValue(makeTeam({ me: { role: "admin" } }));
    fetchDevicePairings.mockRejectedValueOnce(new Error("pairings offline"));

    renderHook();
    harness.flushEffects();
    await flushAsync();
    renderHook();
    // Registers the presence poll AND the device poll; the device poll runs
    // immediately (immediate: true) — and fails.
    harness.flushEffects();
    await flushAsync();
    let hook = renderHook();
    expect(hook.devicesError).toBe("pairings offline");
    expect(hook.devicePending).toEqual([]);
    expect(intervalCallbacks.length).toBe(2);

    fetchDevicePairings.mockResolvedValueOnce({ pending: [{ id: "req-1" }] });
    await intervalCallbacks.at(-1)(); // the device poll registered last
    hook = renderHook();
    expect(hook.devicesError).toBe(null);
    expect(hook.devicePending).toEqual([{ id: "req-1" }]);
  });
});

describe("frontend/team-tab PresenceCard failure model", () => {
  const presence = [
    { email: "sam@acme.dev", displayName: "Sam", lastSeenAt: null },
  ];

  it("renders two lines — a static headline plus the message on its own muted line — above the last known roster", () => {
    const tree = PresenceCard({
      presence,
      presenceUnavailable: "socket closed",
    });
    const paragraphs = collectNodes(tree).filter((node) => node.type === "p");

    const headline = paragraphs.find((node) =>
      nodeText(node).includes("Presence refresh failed"),
    );
    expect(headline).toBeTruthy();
    expect(nodeText(headline)).toContain(
      "Presence refresh failed — showing last known presence. Retrying automatically.",
    );
    // The raw error never rides mid-sentence in the headline.
    expect(nodeText(headline)).not.toContain("socket closed");

    const detail = paragraphs.find((node) =>
      nodeText(node).includes("socket closed"),
    );
    expect(detail).toBeTruthy();
    expect(String(detail.props.class)).toContain("text-xs");
    expect(String(detail.props.class)).toContain("text-fg-muted");

    // "Showing last known presence" stays true: the roster remains rendered.
    expect(nodeText(tree)).toContain("Sam");
  });

  it("renders no failure lines while presence is healthy", () => {
    const tree = PresenceCard({ presence, presenceUnavailable: null });
    expect(nodeText(tree)).not.toContain("Presence refresh failed");
    expect(nodeText(tree)).toContain("Sam");
  });
});

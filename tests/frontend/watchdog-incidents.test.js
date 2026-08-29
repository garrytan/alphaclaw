import { beforeEach, describe, expect, it, vi } from "vitest";

// Hook harness (use-saved-setting.test.js pattern): state in per-call-index
// slots; effects collected, not run — the poll interval never starts, so
// refresh() is driven explicitly.
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
  fetchWatchdogEvents: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { invalidateCache } from "../../lib/public/js/lib/api-cache.js";
import { useWatchdogIncidents } from "../../lib/public/js/components/watchdog-tab/incidents/use-incidents.js";
import { WatchdogIncidentsCard } from "../../lib/public/js/components/watchdog-tab/incidents/index.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";

const harness = preactHooks.__harness;

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function") {
    try {
      out.rendered = expandTree(node.type(node.props || {}));
    } catch {
      out.rendered = null;
    }
  }
  if (out.props.children !== undefined) {
    out.props = { ...out.props, children: expandTree(out.props.children) };
  }
  return out;
};

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  if (node.rendered) collectNodes(node.rendered, out);
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
  if (node && typeof node === "object") {
    if (node.props) collectText(node.props.children, out);
    if (node.rendered) collectText(node.rendered, out);
  }
  return out;
};

const treeText = (tree) => collectText(tree).join(" ");

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

beforeEach(() => {
  harness.reset();
  vi.clearAllMocks();
  // The events poll seeds from the shared api-cache (cacheKey) — drop the
  // module-level entry so a prior test's data can't leak across cases.
  invalidateCache("/api/watchdog/events?limit=20");
});

describe("frontend/watchdog incidents hook", () => {
  const renderHook = () => {
    harness.beginRender();
    return useWatchdogIncidents();
  };

  it("starts in the loading shape: not loaded, no error, empty list", () => {
    const state = renderHook();
    expect(state.events).toEqual([]);
    expect(state.eventsLoaded).toBe(false);
    expect(state.eventsError).toBe(null);
  });

  it("maps a successful poll to events + loaded", async () => {
    api.fetchWatchdogEvents.mockResolvedValue({
      events: [{ eventType: "crash", status: "open" }],
    });
    let state = renderHook();
    await state.refreshEvents();
    state = renderHook();
    expect(state.eventsLoaded).toBe(true);
    expect(state.events).toEqual([{ eventType: "crash", status: "open" }]);
    expect(state.eventsError).toBe(null);
    expect(state.refreshingEvents).toBe(false);
  });

  it("surfaces a failed poll as eventsError — never a confident empty list", async () => {
    const error = new Error("watchdog down");
    api.fetchWatchdogEvents.mockRejectedValue(error);
    let state = renderHook();
    await state.refreshEvents();
    state = renderHook();
    expect(state.eventsError).toBe(error);
    expect(state.eventsLoaded).toBe(false);
    expect(state.events).toEqual([]);
  });

  it("keeps the last-known-good list when a later refresh fails", async () => {
    api.fetchWatchdogEvents.mockResolvedValue({
      events: [{ eventType: "crash" }],
    });
    let state = renderHook();
    await state.refreshEvents();
    api.fetchWatchdogEvents.mockRejectedValue(new Error("flaky"));
    state = renderHook();
    await state.refreshEvents();
    state = renderHook();
    expect(state.events).toEqual([{ eventType: "crash" }]); // stale but shown
    expect(state.eventsLoaded).toBe(true);
    expect(state.eventsError).toBeInstanceOf(Error);
  });
});

describe("frontend/watchdog incidents card", () => {
  const renderCard = (props = {}) =>
    expandTree(WatchdogIncidentsCard(props));

  it("shows a loading line before the first poll settles — not the empty state", () => {
    const tree = renderCard({ events: [], hasLoaded: false, error: null });
    const text = treeText(tree);
    expect(text).toContain("Loading incidents...");
    expect(text).not.toContain("No incidents recorded.");
  });

  it("renders the error chip with Retry when the first load fails", () => {
    const onRefresh = () => {};
    const tree = renderCard({
      events: [],
      hasLoaded: false,
      error: new Error("boom"),
      onRefresh,
    });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.onRetry).toBe(onRefresh);
    const text = treeText(tree);
    expect(text).toContain("Couldn't load incidents.");
    expect(text).not.toContain("No incidents recorded.");
  });

  it("keeps the stale list visible with a refresh-failed note", () => {
    const tree = renderCard({
      events: [{ eventType: "crash", status: "open", createdAt: "2026-08-28" }],
      hasLoaded: true,
      error: new Error("flaky"),
    });
    const text = treeText(tree);
    expect(text).toContain("Couldn't refresh incidents — showing the last loaded list.");
    expect(text).toContain("crash"); // list still rendered
    expect(findAllByType(tree, InlineErrorChip).length).toBe(1);
  });

  it("renders the genuine empty state only after a successful load", () => {
    const tree = renderCard({ events: [], hasLoaded: true, error: null });
    expect(treeText(tree)).toContain("No incidents recorded.");
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
  });

  it("Refresh shows a pending affordance while polling", () => {
    const idle = renderCard({ events: [], hasLoaded: true, isRefreshing: false });
    expect(findAllByType(idle, ActionButton)[0].props.loading).toBe(false);
    expect(treeText(idle)).toContain("Refresh");

    const busy = renderCard({ events: [], hasLoaded: true, isRefreshing: true });
    const buttons = findAllByType(busy, "button");
    const refreshButton = buttons.find((vnode) =>
      collectText(vnode).join(" ").includes("Refreshing..."),
    );
    expect(refreshButton).toBeTruthy();
    expect(refreshButton.props.disabled).toBe(true);
  });
});

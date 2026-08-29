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
  fetchWatchdogIncidents: vi.fn(),
  fetchWatchdogIncidentDetail: vi.fn(),
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { invalidateCache } from "../../lib/public/js/lib/api-cache.js";
import { useWatchdogIncidents } from "../../lib/public/js/components/watchdog-tab/incidents/use-incidents.js";
import { WatchdogIncidentsCard } from "../../lib/public/js/components/watchdog-tab/incidents/index.js";
import { buildIncidentTimeTooltip } from "../../lib/public/js/components/watchdog-tab/incidents/helpers.js";
import { formatLocaleDateTimeWithTodayTime } from "../../lib/public/js/lib/format.js";
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
  // Both polls seed from the shared api-cache (cacheKey) — drop the
  // module-level entries so a prior test's data can't leak across cases.
  invalidateCache("/api/watchdog/events?limit=20&includeRoutine=0");
  invalidateCache("/api/watchdog/incidents?limit=10");
  // refreshEvents refreshes BOTH feeds; give the incidents side a quiet
  // default so events-focused cases don't reject on the sibling fetch.
  api.fetchWatchdogIncidents.mockResolvedValue({
    ok: true,
    incidents: [],
    hasMore: false,
  });
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
  const renderCard = (props = {}) => expandTree(WatchdogIncidentsCard(props));

  const kIncident = {
    id: 3,
    incidentKey: "gateway_crash",
    status: "resolved",
    openedAt: "2026-08-28T10:00:00Z",
    summary: {
      trigger: "gateway_crash",
      severity: "warning",
      outcome: "recovered",
      durationMs: 60_000,
    },
  };

  it("shows a loading line before the first poll settles — not the empty state", () => {
    const tree = renderCard({
      incidents: [],
      incidentsLoaded: false,
      incidentsError: null,
    });
    const text = treeText(tree);
    expect(text).toContain("Loading incidents...");
    expect(text).not.toContain("No incidents recorded");
  });

  it("renders the error chip with Retry when the first load fails", () => {
    const onRefresh = () => {};
    const tree = renderCard({
      incidents: [],
      incidentsLoaded: false,
      incidentsError: new Error("boom"),
      onRefresh,
    });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.onRetry).toBe(onRefresh);
    const text = treeText(tree);
    expect(text).toContain("Couldn't load incidents.");
    expect(text).not.toContain("No incidents recorded");
  });

  it("keeps the stale list visible with a refresh-failed note", () => {
    const tree = renderCard({
      incidents: [kIncident],
      incidentsLoaded: true,
      incidentsError: new Error("flaky"),
    });
    const text = treeText(tree);
    expect(text).toContain(
      "Couldn't refresh incidents — showing the last loaded list.",
    );
    expect(text).toContain("Gateway crash"); // list still rendered
    expect(findAllByType(tree, InlineErrorChip).length).toBe(1);
  });

  it("renders the genuine empty state only after a successful load", () => {
    const tree = renderCard({
      incidents: [],
      incidentsLoaded: true,
      incidentsError: null,
    });
    expect(treeText(tree)).toContain(
      "No incidents recorded — the watchdog is quiet.",
    );
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
  });

  it("applies the same loading/error/empty honesty to the All-events tab", () => {
    const base = { activeTab: "events", events: [] };
    expect(
      treeText(renderCard({ ...base, eventsLoaded: false, eventsError: null })),
    ).toContain("Loading events...");
    const failed = renderCard({
      ...base,
      eventsLoaded: false,
      eventsError: new Error("boom"),
    });
    expect(treeText(failed)).toContain("Couldn't load events.");
    expect(findAllByType(failed, InlineErrorChip).length).toBe(1);
    expect(
      treeText(renderCard({ ...base, eventsLoaded: true, eventsError: null })),
    ).toContain("No events recorded.");
  });

  it("uses dual-register tooltips (local+offset · raw ISO) instead of bare raw ISO", () => {
    const eventCreatedAt = "2026-08-27T09:15:02.114Z";
    const tree = renderCard({
      incidents: [kIncident],
      incidentsLoaded: true,
      expandedIds: { [kIncident.id]: true },
      detailById: {
        [kIncident.id]: {
          loading: false,
          error: null,
          events: [
            {
              id: 1,
              eventType: "crash",
              status: "failed",
              createdAt: eventCreatedAt,
              details: { code: 1 },
            },
          ],
        },
      },
    });
    const spans = findAllByType(tree, "span");
    const openedTooltip = buildIncidentTimeTooltip(kIncident.openedAt);
    expect(openedTooltip).toContain(` · ${kIncident.openedAt}`);
    expect(spans.some((span) => span.props.title === openedTooltip)).toBe(true);
    const eventTooltip = buildIncidentTimeTooltip(eventCreatedAt);
    expect(spans.some((span) => span.props.title === eventTooltip)).toBe(true);
    // No tooltip carries the bare raw ISO anymore.
    expect(spans.some((span) => span.props.title === kIncident.openedAt)).toBe(
      false,
    );
    expect(spans.some((span) => span.props.title === eventCreatedAt)).toBe(
      false,
    );

    // The All-events tab rows use the same dual-register tooltip.
    const eventsTree = renderCard({
      activeTab: "events",
      eventsLoaded: true,
      events: [
        { id: 2, eventType: "restart", status: "ok", createdAt: eventCreatedAt },
      ],
    });
    const eventSpans = findAllByType(eventsTree, "span");
    expect(eventSpans.some((span) => span.props.title === eventTooltip)).toBe(
      true,
    );
  });

  it("renders timeline event times with seconds (sub-minute causality)", () => {
    const eventCreatedAt = "2026-08-27T09:15:02.114Z";
    const tree = renderCard({
      incidents: [kIncident],
      incidentsLoaded: true,
      expandedIds: { [kIncident.id]: true },
      detailById: {
        [kIncident.id]: {
          loading: false,
          error: null,
          events: [
            {
              id: 1,
              eventType: "crash",
              status: "failed",
              createdAt: eventCreatedAt,
              details: { code: 1 },
            },
          ],
        },
      },
    });
    expect(treeText(tree)).toContain(
      formatLocaleDateTimeWithTodayTime(eventCreatedAt, { withSeconds: true }),
    );
  });

  it("Refresh shows a pending affordance while polling", () => {
    const idle = renderCard({
      incidents: [],
      incidentsLoaded: true,
      isRefreshing: false,
    });
    expect(findAllByType(idle, ActionButton)[0].props.loading).toBe(false);
    expect(treeText(idle)).toContain("Refresh");

    const busy = renderCard({
      incidents: [],
      incidentsLoaded: true,
      isRefreshing: true,
    });
    const buttons = findAllByType(busy, "button");
    const refreshButton = buttons.find((vnode) =>
      collectText(vnode).join(" ").includes("Refreshing..."),
    );
    expect(refreshButton).toBeTruthy();
    expect(refreshButton.props.disabled).toBe(true);
  });
});

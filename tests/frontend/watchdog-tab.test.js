import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as gateway-card.test.js): hook state
// lives in per-call-index slots so component functions can be invoked
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

// The page hook drives polling/terminal/api plumbing this test does not
// exercise — stub it so the layout seams under test render in isolation.
vi.mock(
  "../../lib/public/js/components/watchdog-tab/use-watchdog-tab.js",
  () => ({ useWatchdogTab: vi.fn() }),
);

import * as preactHooks from "preact/hooks";
import { WatchdogTab } from "../../lib/public/js/components/watchdog-tab/index.js";
import { useWatchdogTab } from "../../lib/public/js/components/watchdog-tab/use-watchdog-tab.js";
import { WatchdogSafeModeBanner } from "../../lib/public/js/components/watchdog-tab/safe-mode-banner.js";
import { WatchdogSqliteBackupCard } from "../../lib/public/js/components/watchdog-tab/backup-card.js";
import { WatchdogOverseerCard } from "../../lib/public/js/components/watchdog-tab/overseer-card.js";
import { WatchdogIncidentsCard } from "../../lib/public/js/components/watchdog-tab/incidents/index.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { Gateway } from "../../lib/public/js/components/gateway.js";
import { gatewayShellStore } from "../../lib/public/js/components/restart-progress-card.js";

const harness = preactHooks.__harness;

// Deep walk: function children are invoked so the assertions can reach the
// buttons the two cards render from the shared overseer slice.
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

const collectDeep = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectDeep(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectDeep(node.props.children, out);
  if (node.rendered) collectDeep(node.rendered, out);
  return out;
};

// Shallow walk: child components stay as vnodes (never invoked), so the
// assertions are about WHAT the tab composes, not the children's internals.
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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

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

const renderTab = (props = {}) => {
  harness.beginRender();
  return WatchdogTab(props);
};

const kSafeModeWatchdog = {
  gatewayPid: 1234,
  lifecycle: "running",
  health: "healthy",
  safeMode: true,
  suppressedChannels: ["telegram"],
};

describe("frontend/watchdog tab (safe-mode ownership + upstream-merge seams)", () => {
  beforeEach(() => {
    harness.reset();
    gatewayShellStore.reset();
    useWatchdogTab.mockImplementation(({ watchdogStatus }) => ({
      currentWatchdogStatus: watchdogStatus || {},
      onResumeChannels: vi.fn(),
      resumingChannels: false,
    }));
  });

  it("with the unified server state present, the Gateway card owns safe mode: NO standalone banner, and the sqlite backup card renders", () => {
    gatewayShellStore.publish({
      hasStatus: true,
      statusState: { state: "safe_mode", label: "Channels paused" },
    });

    const tree = renderTab({ watchdogStatus: kSafeModeWatchdog });

    // Even with safeMode true, the standalone banner must NOT render — the
    // server-driven Gateway card presents safe_mode itself.
    expect(findAllByType(tree, WatchdogSafeModeBanner)).toHaveLength(0);
    expect(findAllByType(tree, Gateway)).toHaveLength(1);
    // The upstream-merge seam: the sqlite backup card stays mounted on the
    // page regardless of which card owns safe-mode presentation.
    expect(findAllByType(tree, WatchdogSqliteBackupCard)).toHaveLength(1);
  });

  it("version skew (no statusState): the standalone banner survives and renders the safe-mode copy", () => {
    // Store still at defaults: statusState null (old server).
    const tree = renderTab({ watchdogStatus: kSafeModeWatchdog });

    const banners = findAllByType(tree, WatchdogSafeModeBanner);
    expect(banners).toHaveLength(1);
    expect(banners[0].props.watchdogStatus).toEqual(kSafeModeWatchdog);

    // The banner itself renders real content for a safe-mode status...
    const rendered = WatchdogSafeModeBanner(banners[0].props);
    const text = collectText(rendered).join(" ");
    expect(text).toContain("Gateway is in safe mode");
    expect(text).toContain("telegram");

    // ...and collapses to nothing once safe mode clears (never a stale box).
    expect(
      WatchdogSafeModeBanner({
        watchdogStatus: { ...kSafeModeWatchdog, safeMode: false },
      }),
    ).toBeNull();
  });
});

describe("frontend/watchdog tab (lifted overseer state feeds both cards)", () => {
  const kNow = Date.parse("2026-08-29T12:00:00Z");
  const kIncidents = [
    {
      id: 5,
      status: "resolved",
      openedAt: new Date(kNow - 3_600_000).toISOString(),
      resolvedAt: new Date(kNow - 3_000_000).toISOString(),
      eventCount: 4,
      summary: { severity: "warning", outcome: "recovered", durationMs: 600_000 },
      overseer: null,
    },
  ];
  const overseerSlice = (overrides = {}) => ({
    enabled: true,
    availability: { available: true, reason: null, message: "ok" },
    settingsLoaded: true,
    saving: false,
    onToggle: vi.fn(),
    situation: { ok: true, current: null, lastVerdict: null, nextManualAt: 0, inFlight: false },
    situationError: null,
    reviewInFlight: null,
    ephemeral: null,
    reviewStatus: null,
    incidentReviewError: null,
    primaryKind: "auto",
    onSelectPrimaryKind: vi.fn(),
    onReviewSituation: vi.fn(),
    onReviewIncident: vi.fn(),
    ...overrides,
  });

  const stubTab = (overseer) => {
    useWatchdogTab.mockImplementation(({ watchdogStatus }) => ({
      currentWatchdogStatus: watchdogStatus || {},
      onResumeChannels: vi.fn(),
      resumingChannels: false,
      incidents: kIncidents,
      incidentsLoaded: true,
      incidentsError: null,
      incidentDetailById: { 5: { loaded: true, events: [], truncated: false, omittedCount: 0 } },
      expandedIncidentIds: { 5: true },
      refreshEvents: vi.fn(),
      overseer,
    }));
  };

  beforeEach(() => {
    harness.reset();
    gatewayShellStore.reset();
  });

  it("threads the overseer slice to the overseer card and the incidents card", () => {
    const overseer = overseerSlice({ reviewInFlight: "situation" });
    stubTab(overseer);
    const tree = renderTab({ watchdogStatus: { health: "degraded" } });

    const card = findAllByType(tree, WatchdogOverseerCard)[0];
    expect(card.props).toMatchObject({
      enabled: true,
      settingsLoaded: true,
      reviewInFlight: "situation",
      primaryKind: "auto",
      watchdogStatus: { health: "degraded" },
    });
    expect(card.props.availability).toBe(overseer.availability);
    expect(card.props.situation).toBe(overseer.situation);
    expect(card.props.onReviewSituation).toBe(overseer.onReviewSituation);
    expect(card.props.onSelectPrimaryKind).toBe(overseer.onSelectPrimaryKind);
    expect(card.props.onToggle).toBe(overseer.onToggle);

    const incidentsCard = findAllByType(tree, WatchdogIncidentsCard)[0];
    expect(incidentsCard.props).toMatchObject({
      overseerEnabled: true,
      reviewInFlight: "situation",
      incidentReviewError: null,
    });
    expect(incidentsCard.props.overseerAvailability).toBe(overseer.availability);
    expect(incidentsCard.props.onReviewIncident).toBe(overseer.onReviewIncident);
  });

  it("row action: a click posts the row id, a row error renders as an inline chip, and a disabled reason is visible text", () => {
    const onReviewIncident = vi.fn();
    stubTab(overseerSlice({ onReviewIncident }));
    const tree = expandTree(renderTab({ watchdogStatus: { health: "healthy" } }));
    const row = collectDeep(tree).find(
      (node) => node.type === ActionButton && node.props.idleLabel === "Review this incident",
    );
    row.props.onClick();
    expect(onReviewIncident).toHaveBeenCalledWith(5);

    const err = {
      incidentId: 5,
      error: new Error("No incident with that id."),
      message: "No incident with that id.",
    };
    stubTab(overseerSlice({ incidentReviewError: err }));
    const withError = expandTree(renderTab({ watchdogStatus: { health: "healthy" } }));
    expect(
      collectDeep(withError).some(
        (node) => node.type === InlineErrorChip && node.props.headline === err.message,
      ),
    ).toBe(true);

    // Keyboard and screen-reader users cannot hover a disabled button's title.
    stubTab(overseerSlice({ reviewInFlight: "situation" }));
    const busy = expandTree(renderTab({ watchdogStatus: { health: "healthy" } }));
    expect(
      collectDeep(busy).some(
        (node) =>
          node.type === "span" &&
          node.props.role === "status" &&
          String(node.props.children).includes("A review is already running"),
      ),
    ).toBe(true);
  });

  it("one reviewInFlight drives both buttons: the situation button loads while the row action disables", () => {
    stubTab(overseerSlice({ reviewInFlight: "situation" }));
    const tree = expandTree(renderTab({ watchdogStatus: { health: "degraded" } }));
    const buttons = collectDeep(tree).filter((node) => node.type === ActionButton);
    const situationButton = buttons.find(
      (node) => node.props.idleLabel === "Review current situation",
    );
    const rowButton = buttons.find((node) => node.props.idleLabel === "Review this incident");
    expect(situationButton.props.loading).toBe(true);
    expect(rowButton.props).toMatchObject({
      loading: false,
      disabled: true,
      title: "A review is already running",
    });
  });

  it("…and the other way round: an incident review in flight loads the row and disables the situation button's twin", () => {
    stubTab(overseerSlice({ reviewInFlight: 5 }));
    const tree = expandTree(renderTab({ watchdogStatus: { health: "degraded" } }));
    const buttons = collectDeep(tree).filter((node) => node.type === ActionButton);
    const situationButton = buttons.find(
      (node) => node.props.idleLabel === "Review current situation",
    );
    const rowButton = buttons.find((node) => node.props.idleLabel === "Review this incident");
    expect(rowButton.props.loading).toBe(true);
    // The situation button is not "loading" for an incident review; the hook's
    // ref guard makes a click a no-op, and the row's title explains the wait.
    expect(situationButton.props.loading).toBe(false);
  });

  it("the row action disappears when the toggle is off; the situation button too", () => {
    stubTab(overseerSlice({ enabled: false }));
    const tree = expandTree(renderTab({ watchdogStatus: { health: "healthy" } }));
    const labels = collectDeep(tree)
      .filter((node) => node.type === ActionButton)
      .map((node) => node.props.idleLabel);
    expect(labels).not.toContain("Review this incident");
    expect(labels).not.toContain("Review current situation");
  });

  it("tolerates a hook without the overseer slice (older stubs) — the tab still renders", () => {
    useWatchdogTab.mockImplementation(({ watchdogStatus }) => ({
      currentWatchdogStatus: watchdogStatus || {},
      onResumeChannels: vi.fn(),
      resumingChannels: false,
    }));
    const tree = renderTab({ watchdogStatus: kSafeModeWatchdog });
    expect(findAllByType(tree, WatchdogOverseerCard)).toHaveLength(1);
    expect(findAllByType(tree, WatchdogIncidentsCard)).toHaveLength(1);
  });
});

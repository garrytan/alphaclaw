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
import { WatchdogOverseerCard } from "../../lib/public/js/components/watchdog-tab/overseer/index.js";
import { WatchdogIncidentsCard } from "../../lib/public/js/components/watchdog-tab/incidents/index.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { GatewayStateLabel } from "../../lib/public/js/components/gateway.js";
import { WatchdogRestartEvidence } from "../../lib/public/js/components/watchdog-tab/restart-evidence.js";
import { gatewayShellStore } from "../../lib/public/js/components/restart-progress-card.js";
import { RoutePageHeader } from "../../lib/public/js/components/page-header.js";
import {
  GatewayDetails,
  GatewayRepairControl,
  GatewayRestartControl,
} from "../../lib/public/js/components/gateway.js";
import { WatchdogResourcesCard } from "../../lib/public/js/components/watchdog-tab/resources/index.js";
import { WatchdogConsoleCard } from "../../lib/public/js/components/watchdog-tab/console/index.js";
import { WatchdogBoxCard } from "../../lib/public/js/components/watchdog-tab/box/index.js";
import { WatchdogSettingsCard } from "../../lib/public/js/components/watchdog-tab/settings/index.js";
import { WatchdogAutotuneCard } from "../../lib/public/js/components/watchdog-tab/autotune/index.js";
import { WatchdogRescueSessionCard } from "../../lib/public/js/components/watchdog-tab/rescue-session-card.js";
import { WatchdogStatusDetails } from "../../lib/public/js/components/watchdog-tab/status-details.js";
import { WatchdogNarrativeCard } from "../../lib/public/js/components/watchdog-tab/narrative-card.js";
import { WatchdogDegradedCard } from "../../lib/public/js/components/watchdog-tab/degraded-card.js";

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

  it("with the unified server state present, the Gateway card owns safe mode: NO standalone banner", () => {
    gatewayShellStore.publish({
      hasStatus: true,
      statusState: { state: "safe_mode", label: "Channels paused" },
    });

    const tree = renderTab({ watchdogStatus: kSafeModeWatchdog });

    // Even with safeMode true, the standalone banner must NOT render — the
    // server-driven Gateway card presents safe_mode itself.
    expect(findAllByType(tree, WatchdogSafeModeBanner)).toHaveLength(0);
    expect(findAllByType(tree, GatewayStateLabel)).toHaveLength(1);
  });

  it("a failed restart gets a 'Restart evidence' disclosure that loads the redacted tail on open — nothing while running or idle", async () => {
    const loadEvidence = vi.fn(async () => "stderr line 1\nstderr line 2");
    gatewayShellStore.publish({
      hasStatus: true,
      statusState: { state: "down", label: "Down" },
      restartOperation: { operationId: "op-1", phase: "failed", startedAt: 1, steps: [], error: { message: "boom", code: "launch_failed" } },
      actions: { loadEvidence },
    });
    let tree = renderTab({ watchdogStatus: kSafeModeWatchdog });
    const evidence = findAllByType(tree, WatchdogRestartEvidence)[0];
    expect(evidence).toBeTruthy();
    expect(evidence.props.operation.operationId).toBe("op-1");
    expect(evidence.props.onLoadEvidence).toBe(loadEvidence);

    // Rendered on its own: a <details> whose toggle loads the evidence once.
    harness.reset();
    harness.beginRender();
    let detailsTree = expandTree(WatchdogRestartEvidence(evidence.props));
    const details = collectDeep(detailsTree).find((vnode) => vnode.type === "details");
    expect(collectText(details).join(" ")).toContain("Restart evidence");
    expect(loadEvidence).not.toHaveBeenCalled();
    details.props.ontoggle({ currentTarget: { open: true } });
    expect(loadEvidence).toHaveBeenCalledWith("op-1");
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
    harness.beginRender();
    detailsTree = expandTree(WatchdogRestartEvidence(evidence.props));
    const pre = collectDeep(detailsTree).find((vnode) => vnode.type === "pre");
    expect(collectText(pre).join("")).toContain("stderr line 2");
    // Re-opening never refetches.
    collectDeep(detailsTree).find((vnode) => vnode.type === "details").props.ontoggle({ currentTarget: { open: true } });
    expect(loadEvidence).toHaveBeenCalledTimes(1);

    harness.reset();
    harness.beginRender();
    expect(WatchdogRestartEvidence({ operation: { operationId: "op-2", phase: "running", steps: [] }, onLoadEvidence: loadEvidence })).toBeNull();
    harness.beginRender();
    expect(WatchdogRestartEvidence({ operation: null, onLoadEvidence: loadEvidence })).toBeNull();
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

describe("frontend/health briefing (ALPH-69 slot map)", () => {
  const handlers = () => ({
    refreshResources: vi.fn(),
    setMemoryExpanded: vi.fn(),
    onSelectIncidentsTab: vi.fn(),
    onToggleIncident: vi.fn(),
    onLoadMoreIncidents: vi.fn(),
    onSetIncludeRoutine: vi.fn(),
    refreshEvents: vi.fn(),
    setStickToBottom: vi.fn(),
    handleSelectConsoleTab: vi.fn(),
    onRestartTerminalSession: vi.fn(),
    onCopyAll: vi.fn(),
    setBoxExpanded: vi.fn(),
    refreshBox: vi.fn(),
    onRetryLoadSettings: vi.fn(),
    onToggleAutoRepair: vi.fn(),
    onToggleNotifications: vi.fn(),
    onToggleNotificationsVerbose: vi.fn(),
    onRepair: vi.fn(),
    onViewLogs: vi.fn(),
    onResumeChannels: vi.fn(),
  });

  let state;
  beforeEach(() => {
    harness.reset();
    gatewayShellStore.reset();
    state = { currentWatchdogStatus: { phase: "healthy" }, incidents: [], incidentsLoaded: true, ...handlers() };
    useWatchdogTab.mockImplementation(() => state);
  });

  it("puts the health header above the page body", () => {
    const tree = renderTab({ watchdogStatus: {} });
    const children = [tree.props.children].flat(Infinity).filter((child) => child && typeof child === "object");
    expect(children[0].type).toBe(RoutePageHeader);
    expect(children[0].props.routeId).toBe("health");
  });

  it("renders every slot and hands each one the hook's own handlers", () => {
    const onRestartGateway = vi.fn();
    const tree = renderTab({ watchdogStatus: {}, onRestartGateway });
    const one = (type) => {
      const found = findAllByType(tree, type);
      expect(found).toHaveLength(1);
      return found[0].props;
    };
    const resources = one(WatchdogResourcesCard);
    expect(resources.onRetry).toBe(state.refreshResources);
    expect(resources.onSetMemoryExpanded).toBe(state.setMemoryExpanded);
    const incidents = one(WatchdogIncidentsCard);
    expect(incidents.onSelectTab).toBe(state.onSelectIncidentsTab);
    expect(incidents.onToggleIncident).toBe(state.onToggleIncident);
    expect(incidents.onLoadMore).toBe(state.onLoadMoreIncidents);
    expect(incidents.onSetIncludeRoutine).toBe(state.onSetIncludeRoutine);
    expect(incidents.onRefresh).toBe(state.refreshEvents);
    const console = one(WatchdogConsoleCard);
    expect(console.onSetStickToBottom).toBe(state.setStickToBottom);
    expect(console.onSelectConsoleTab).toBe(state.handleSelectConsoleTab);
    expect(console.onRestartTerminalSession).toBe(state.onRestartTerminalSession);
    expect(console.onCopyAll).toBe(state.onCopyAll);
    const box = one(WatchdogBoxCard);
    expect(box.onSetExpanded).toBe(state.setBoxExpanded);
    expect(box.onRetry).toBe(state.refreshBox);
    const settings = one(WatchdogSettingsCard);
    expect(settings.onRetryLoadSettings).toBe(state.onRetryLoadSettings);
    expect(settings.onToggleAutoRepair).toBe(state.onToggleAutoRepair);
    expect(settings.onToggleNotifications).toBe(state.onToggleNotifications);
    expect(settings.onToggleNotificationsVerbose).toBe(state.onToggleNotificationsVerbose);
    const overseer = one(WatchdogOverseerCard);
    expect(overseer.onRepair).toBe(state.onRepair);
    expect(overseer.onRestartGateway).toBe(onRestartGateway);
    expect(overseer.onResumeChannels).toBe(state.onResumeChannels);
    expect(one(WatchdogAutotuneCard).onRestartGateway).toBe(onRestartGateway);
    one(WatchdogRescueSessionCard);
    one(WatchdogRestartEvidence);
    one(WatchdogStatusDetails);
    one(WatchdogNarrativeCard);
    one(WatchdogDegradedCard);
    one(GatewayDetails);
    const actions = findAllByType(tree, RoutePageHeader)[0].props.actions;
    expect(findAllByType(actions, GatewayRestartControl)).toHaveLength(1);
    expect(findAllByType(actions, GatewayRepairControl)).toHaveLength(1);
    const viewLogs = findAllByType(actions, ActionButton).find((button) => button.props.idleLabel === "View logs");
    viewLogs.props.onClick();
    expect(state.onViewLogs).toHaveBeenCalledTimes(1);
  });

  it("keeps Recent boots and Watchdog settings in closed disclosures, settings last", () => {
    const tree = renderTab({ watchdogStatus: {} });
    const disclosures = findAllByType(tree, "details");
    expect(disclosures.map((node) => node.props["data-disclosure"])).toEqual(["boots", "settings"]);
    for (const node of disclosures) expect(node.props.open).toBeUndefined();
    expect(findAllByType(disclosures[0], WatchdogBoxCard)).toHaveLength(1);
    expect(findAllByType(disclosures[1], WatchdogSettingsCard)).toHaveLength(1);
    expect(findAllByType(disclosures[1], WatchdogAutotuneCard)).toHaveLength(1);
  });

  it("says Repairing the gateway while a Repair from the header runs", () => {
    let tree = renderTab({ watchdogStatus: {} });
    const repair = findAllByType(findAllByType(tree, RoutePageHeader)[0].props.actions, GatewayRepairControl)[0];
    repair.props.onBusyChange(true);
    tree = renderTab({ watchdogStatus: {} });
    let headline = collectNodes(tree).find((node) => node.props?.class === "briefing-headline");
    expect(collectText(headline).join("")).toBe("Repairing the gateway.");
    repair.props.onBusyChange(false);
    tree = renderTab({ watchdogStatus: {} });
    headline = collectNodes(tree).find((node) => node.props?.class === "briefing-headline");
    expect(collectText(headline).join("")).toBe("Healthy. No incidents today.");
  });

  it("does not report a live state when the snapshot is stale or AlphaClaw is offline", () => {
    gatewayShellStore.publish({ hasStatus: true, statusFreshness: { mode: "stale" } });
    let tree = renderTab({ watchdogStatus: {} });
    let headline = collectNodes(tree).find((node) => node.props?.class === "briefing-headline");
    expect(collectText(headline).join("")).toBe("Gateway status is out of date. Showing the last known status.");
    harness.reset();
    gatewayShellStore.publish({ hasStatus: true, connectivityMode: "offline", statusFreshness: { mode: "fresh" } });
    tree = renderTab({ watchdogStatus: {} });
    headline = collectNodes(tree).find((node) => node.props?.class === "briefing-headline");
    expect(collectText(headline).join("")).toBe("AlphaClaw is not answering. Showing the last known status.");
  });

  it("keeps the phone's More menu open for a click in Repair's confirm dialog, so a failure stays visible", () => {
    const actionsOf = (tree) => findAllByType(tree, RoutePageHeader)[0].props.actions;
    const moreOf = (tree) => collectNodes(actionsOf(tree)).find((node) => node.props?.class === "health-more");
    const toggleOf = (tree) =>
      collectNodes(actionsOf(tree)).find((node) => node.props?.class === "health-more-toggle");
    let tree = renderTab({ watchdogStatus: {} });
    toggleOf(tree).props.onclick();
    tree = renderTab({ watchdogStatus: {} });
    expect(moreOf(tree).props["data-open"]).toBe("true");
    const listeners = {};
    const previousWindow = globalThis.window;
    globalThis.window = {
      addEventListener: (type, fn) => {
        listeners[type] = fn;
      },
      removeEventListener: () => {},
    };
    try {
      for (const effect of harness.effects) {
        try {
          effect();
        } catch {}
      }
    } finally {
      globalThis.window = previousWindow;
    }
    const inDialog = { closest: (selector) => (selector.includes("role=dialog") ? {} : null) };
    listeners.click({ target: inDialog });
    tree = renderTab({ watchdogStatus: {} });
    expect(moreOf(tree).props["data-open"]).toBe("true");
    listeners.click({ target: { closest: () => null } });
    tree = renderTab({ watchdogStatus: {} });
    expect(moreOf(tree).props["data-open"]).toBe("false");
  });

  it("shows Repair's result under the header, outside the phone menu, and View logs closes the menu", () => {
    const actionsOf = (tree) => findAllByType(tree, RoutePageHeader)[0].props.actions;
    const moreOf = (tree) => collectNodes(actionsOf(tree)).find((node) => node.props?.class === "health-more");
    let tree = renderTab({ watchdogStatus: {} });
    collectNodes(actionsOf(tree)).find((node) => node.props?.class === "health-more-toggle").props.onclick();
    tree = renderTab({ watchdogStatus: {} });
    expect(moreOf(tree).props["data-open"]).toBe("true");

    findAllByType(actionsOf(tree), GatewayRepairControl)[0].props.onOutcomeChange("Not started: gateway busy");
    tree = renderTab({ watchdogStatus: {} });
    const alert = collectNodes(tree).find((node) => String(node.props?.class || "").includes("health-repair-outcome"));
    expect(alert.props.role).toBe("alert");
    expect(collectText(alert).join("").trim()).toBe("Not started: gateway busy");
    expect(collectNodes(actionsOf(tree)).some((node) => node === alert)).toBe(false);

    findAllByType(actionsOf(tree), ActionButton).find((button) => button.props.idleLabel === "View logs").props.onClick();
    tree = renderTab({ watchdogStatus: {} });
    expect(moreOf(tree).props["data-open"]).toBe("false");
    expect(state.onViewLogs).toHaveBeenCalledTimes(1);
  });

  it("leads with the headline sentence", () => {
    const tree = renderTab({ watchdogStatus: {} });
    const headline = collectNodes(tree).find((node) => node.props?.class === "briefing-headline");
    expect(collectText(headline).join("")).toBe("Healthy. No incidents today.");
  });
});


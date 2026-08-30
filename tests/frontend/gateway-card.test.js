import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

// Minimal hook harness (same pattern as upgrade-tab tests): hook state lives
// in per-call-index slots so component functions can be invoked directly
// without a DOM renderer. Effects are collected, not run.
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
import { Gateway, buildReasonsSummary, dotClassFor } from "../../lib/public/js/components/gateway.js";
import { gatewayShellStore } from "../../lib/public/js/components/restart-progress-card.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { ConfirmDialog } from "../../lib/public/js/components/confirm-dialog.js";
import { Tooltip } from "../../lib/public/js/components/tooltip.js";
import { InfoTooltip } from "../../lib/public/js/components/info-tooltip.js";

// The card renders the SERVER's state verbatim, so the fixtures come from the
// server's own reducer — the test matrix can never drift from the contract.
const require = createRequire(import.meta.url);
const { reduceGatewayState, kGatewayStateCatalog } = require("../../lib/server/gateway-state.js");

const harness = preactHooks.__harness;

const kNow = Date.parse("2026-08-27T12:00:00.000Z");

const kSkipExpand = new Set([Tooltip, InfoTooltip]);

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function" && !kSkipExpand.has(node.type)) {
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
  if (node && typeof node === "object") {
    if (node.props) collectText(node.props.children, out);
    if (node.rendered) collectText(node.rendered, out);
  }
  return out;
};

const treeText = (tree) => collectText(tree).join(" ");

const findDotSpan = (tree) =>
  findAllByType(tree, "span").find((vnode) =>
    String(vnode.props.class || "").includes("ac-gateway-dot"),
  );

const renderGateway = (props = {}) => {
  harness.beginRender();
  return expandTree(Gateway(props));
};

const kFreshUp = { running: true, observedAt: kNow - 1000 };
const kFreshDown = { running: false, observedAt: kNow - 1000 };

const kHealthyWatchdog = {
  gatewayPid: 1234,
  lifecycle: "running",
  health: "healthy",
  crashCountInWindow: 0,
  crashLoopWindowMs: 300000,
  safeMode: false,
  suppressedChannels: [],
};

const makeServerState = (overrides = {}) => ({
  ...reduceGatewayState({
    configExists: true,
    tcp: kFreshUp,
    watchdog: kHealthyWatchdog,
    operation: null,
    bootPhase: { phase: "ready", error: null },
    inStabilizationWindow: false,
    now: kNow,
    ...overrides,
  }),
  since: kNow - 60000,
});

// Every server state in the matrix, produced by the real reducer.
const kStateFixtures = [
  {
    name: "not_onboarded",
    state: makeServerState({ configExists: false }),
    dot: { color: "gray", motion: "steady" },
  },
  {
    name: "booting",
    state: makeServerState({ bootPhase: { phase: "starting_gateway", error: null } }),
    dot: { color: "cyan", motion: "pulse" },
  },
  {
    name: "boot_failed",
    state: makeServerState({ bootPhase: { phase: "failed", error: "channel sync exploded" } }),
    dot: { color: "red", motion: "steady" },
  },
  {
    name: "unknown",
    state: makeServerState({ tcp: { running: null, observedAt: 0 } }),
    dot: { color: "gray", motion: "hollow" },
  },
  {
    name: "config_error",
    state: makeServerState({
      watchdog: { ...kHealthyWatchdog, lifecycle: "configuration_error" },
    }),
    dot: { color: "red", motion: "steady" },
  },
  {
    name: "down",
    // lifecycle "crashed" now reduces to "starting" (the watchdog's own
    // crash relaunch IS a launch in progress) — "stopped" is the honest
    // no-recovery-in-flight down state.
    state: makeServerState({
      tcp: kFreshDown,
      watchdog: { ...kHealthyWatchdog, lifecycle: "stopped", health: "unhealthy" },
    }),
    dot: { color: "red", motion: "steady" },
  },
  {
    name: "starting",
    state: makeServerState({
      tcp: kFreshDown,
      operation: { kind: "restart", label: "Restarting gateway", startedAt: kNow },
    }),
    dot: { color: "cyan", motion: "pulse" },
  },
  {
    name: "flapping",
    state: makeServerState({
      watchdog: { ...kHealthyWatchdog, crashCountInWindow: 2 },
    }),
    dot: { color: "red", motion: "steady" },
  },
  {
    name: "degraded",
    state: makeServerState({
      watchdog: { ...kHealthyWatchdog, health: "degraded" },
    }),
    dot: { color: "yellow", motion: "steady" },
  },
  {
    name: "safe_mode",
    state: makeServerState({
      watchdog: { ...kHealthyWatchdog, safeMode: true, suppressedChannels: ["telegram"] },
    }),
    dot: { color: "yellow", motion: "steady" },
  },
  {
    name: "running",
    state: makeServerState({}),
    dot: { color: "green", motion: "steady" },
  },
];

const publishShell = (partial = {}) => {
  gatewayShellStore.reset();
  gatewayShellStore.publish({
    hasStatus: true,
    connectivityMode: "online",
    actions: {
      restart: vi.fn(),
      refresh: vi.fn(),
      resumeChannels: vi.fn(),
      rollBack: vi.fn(),
      dismissOutcome: vi.fn(),
      loadEvidence: vi.fn(),
      retryConnect: vi.fn(),
    },
    ...partial,
  });
};

describe("frontend/gateway card (server-state matrix)", () => {
  beforeEach(() => {
    harness.reset();
    gatewayShellStore.reset();
  });

  it.each(kStateFixtures)(
    "renders $name verbatim: label, dot, reason, actions",
    ({ name, state, dot }) => {
      publishShell({ statusState: state });
      const tree = renderGateway({});
      const text = treeText(tree);

      // Reducer sanity: the fixture really is the state under test.
      expect(state.state).toBe(name);

      // Server label and reason render verbatim.
      expect(text).toContain(state.label);
      if (state.reason) expect(text).toContain(state.reason);
      if (state.detail) expect(text).toContain(state.detail);

      // Dot class matches the server-sent { color, motion } exactly.
      const dotSpan = findDotSpan(tree);
      expect(dotSpan).toBeTruthy();
      const dotClass = String(dotSpan.props.class || "");
      expect(state.dot).toEqual(dot);
      expect(dotClass).toContain(`ac-gateway-dot--${dot.color}`);
      if (dot.motion === "pulse") {
        expect(dotClass).toContain("ac-gateway-dot--pulse");
      } else {
        expect(dotClass).not.toContain("ac-gateway-dot--pulse");
      }
      if (dot.motion === "hollow") {
        expect(dotClass).toContain("ac-gateway-dot--hollow");
      } else {
        expect(dotClass).not.toContain("ac-gateway-dot--hollow");
      }

      // Every server-sent action renders as a button with its exact label,
      // and at most one is primary.
      const buttons = findAllByType(tree, ActionButton);
      for (const action of state.actions) {
        const button = buttons.find((vnode) => vnode.props.idleLabel === action.label);
        expect(button, `action "${action.label}" missing in ${name}`).toBeTruthy();
        expect(button.props.tone).toBe(
          { primary: "primary", secondary: "secondary", danger: "danger" }[action.kind],
        );
        if (action.disabledReason) {
          expect(button.props.disabled).toBe(true);
          expect(button.props.title).toBe(action.disabledReason);
        }
      }
      const primaryCount = state.actions.filter(
        (action) => action.kind === "primary",
      ).length;
      expect(primaryCount).toBeLessThanOrEqual(1);
      const renderedPrimaries = buttons.filter(
        (vnode) => vnode.props.tone === "primary" && !vnode.props.disabled,
      );
      expect(renderedPrimaries.length).toBe(primaryCount);

      // Glossary affordance + aria-live headline.
      const glossaryTip = findAllByType(tree, InfoTooltip).find(
        (vnode) => vnode.props.text === state.glossary,
      );
      expect(glossaryTip).toBeTruthy();
      const liveRegion = findAllByType(tree, "span").find(
        (vnode) => vnode.props["aria-live"] === "polite",
      );
      expect(liveRegion).toBeTruthy();
      expect(collectText(liveRegion).join(" ")).toContain(state.label);
    },
  );

  it("renders the operation badge from the server operation field", () => {
    const state = makeServerState({
      operation: { kind: "repair", label: "Repairing", startedAt: kNow },
    });
    publishShell({ statusState: state });
    const tree = renderGateway({});
    expect(treeText(tree)).toContain("Repairing");
    // Restart action is proactively disabled with the server's reason.
    const restartButton = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Restart",
    );
    expect(restartButton.props.disabled).toBe(true);
    expect(restartButton.props.title).toBe("Another operation is in progress");
  });

  it("restart action dispatches to the shell restart pipeline", () => {
    const restart = vi.fn();
    publishShell({ statusState: makeServerState({}) });
    gatewayShellStore.publish({
      actions: { ...gatewayShellStore.get().actions, restart },
    });
    const tree = renderGateway({});
    const restartButton = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Restart",
    );
    restartButton.props.onClick();
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("not_onboarded's Set up action dispatches to the shell onboarding surface (never a silent no-op)", () => {
    const openSetup = vi.fn();
    // Reachable in-app: the client's onboarded flag reads the onboarding
    // marker while the reducer checks openclaw.json — with the marker present
    // but the config missing, the card renders 'Not set up yet' whose only
    // action is 'Set up'.
    publishShell({ statusState: makeServerState({ configExists: false }) });
    gatewayShellStore.publish({
      actions: { ...gatewayShellStore.get().actions, openSetup },
    });
    const tree = renderGateway({});
    const setupButton = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Set up",
    );
    expect(setupButton).toBeTruthy();
    setupButton.props.onClick();
    expect(openSetup).toHaveBeenCalledTimes(1);
  });

  it("shows the reasons banner capped at two labels plus a count", () => {
    expect(
      buildReasonsSummary([
        { code: "a", label: "Channel token updated" },
        { code: "b", label: "Environment variables changed" },
        { code: "c", label: "Webhook mappings changed" },
        { code: "d", label: "Gmail watch updated" },
      ]),
    ).toBe("Channel token updated, Environment variables changed and 2 more");

    publishShell({
      statusState: makeServerState({}),
      restartRequired: true,
      restartReasons: [
        { code: "a", label: "Channel token updated" },
        { code: "b", label: "Environment variables changed" },
        { code: "c", label: "Webhook mappings changed" },
      ],
    });
    const tree = renderGateway({});
    const text = treeText(tree);
    expect(text).toContain(
      "Channel token updated, Environment variables changed and 1 more",
    );
    expect(text).not.toContain("Webhook mappings changed");
  });

  it("replaces the card body with the progress card during an operation", () => {
    publishShell({
      statusState: makeServerState({}),
      restartOperation: {
        operationId: "op-1",
        startedAt: kNow - 5000,
        phase: "running",
        steps: [
          { name: "stopping", label: "Stopping gateway", status: "done" },
          { name: "launching", label: "Starting gateway", status: "running" },
        ],
        error: null,
      },
    });
    const tree = renderGateway({});
    const text = treeText(tree);
    expect(text).toContain("Restarting gateway");
    expect(text).toContain("Stopping gateway");
    expect(text).toContain("Starting gateway");
    // Steady-state actions are replaced by the operation region.
    const restartButton = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Restart",
    );
    expect(restartButton).toBeUndefined();
  });

  it("freezes with an 'as of Xs ago' stamp when connectivity is lost", () => {
    publishShell({
      statusState: makeServerState({}),
      connectivityMode: "reconnecting",
      lastFrameAtMs: Date.now() - 12000,
    });
    const tree = renderGateway({});
    expect(treeText(tree)).toMatch(/as of\s+\d+s ago/);
  });

  it("renders no freeze stamp before the first frame (lastFrameAtMs 0 is not epoch 1970)", () => {
    // lastFrameAtMs starts at 0 (no frame yet) — 0 must stay "no stamp",
    // never a relative time computed against the 1970 epoch.
    publishShell({
      statusState: makeServerState({}),
      connectivityMode: "reconnecting",
    });
    const tree = renderGateway({});
    expect(treeText(tree)).not.toMatch(/as of/);
  });

  it("pre-first-frame renders the client-owned connecting card with Restart disabled", () => {
    // Store still at defaults: no status frame has arrived.
    const tree = renderGateway({ status: null });
    const text = treeText(tree);
    expect(text).toContain("Connecting to AlphaClaw…");
    const restartButton = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Restart",
    );
    expect(restartButton.props.disabled).toBe(true);
    const dotSpan = findDotSpan(tree);
    expect(String(dotSpan.props.class || "")).toContain("ac-gateway-dot--gray");
  });

  it("version skew (no status.state) renders the legacy presentation", () => {
    publishShell({ statusState: null });
    const tree = renderGateway({
      status: "running",
      watchdogStatus: { health: "healthy", lifecycle: "running" },
      onRestart: () => {},
    });
    const text = treeText(tree);
    expect(text).toContain("Gateway:");
    expect(text).toContain("running");
    expect(text).toContain("Watchdog:");
    expect(text).toContain("healthy");
    // The unified card never renders in skew mode.
    expect(text).not.toContain("OpenClaw Gateway");
  });

  it("dotClassFor never renders undefined for malformed dots", () => {
    expect(dotClassFor(null)).toContain("ac-gateway-dot--gray");
    expect(dotClassFor({})).toContain("ac-gateway-dot--gray");
  });

  it("flapping in the stabilization window: Roll back is a danger action behind a confirm — confirm dispatches, cancel does not", () => {
    const state = makeServerState({
      watchdog: { ...kHealthyWatchdog, crashCountInWindow: 2 },
      inStabilizationWindow: true,
    });
    expect(state.state).toBe("flapping");
    const rollBackAction = state.actions.find((action) => action.id === "roll_back");
    expect(rollBackAction).toMatchObject({ kind: "danger", needsConfirm: true });

    publishShell({ statusState: state });
    const rollBack = gatewayShellStore.get().actions.rollBack;

    let tree = renderGateway({});
    const button = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Roll back",
    );
    expect(button).toBeTruthy();
    expect(button.props.tone).toBe("danger");
    let dialog = findAllByType(tree, ConfirmDialog)[0];
    expect(dialog.props.visible).toBe(false);

    // needsConfirm: the click opens the dialog and dispatches NOTHING yet.
    button.props.onClick();
    expect(rollBack).not.toHaveBeenCalled();
    tree = renderGateway({});
    dialog = findAllByType(tree, ConfirmDialog)[0];
    expect(dialog.props.visible).toBe(true);
    expect(dialog.props.title).toBe("Roll back?");
    expect(dialog.props.message).toBe(rollBackAction.description);
    expect(dialog.props.confirmTone).toBe("warning");

    // Confirming dispatches the shell rollBack action and closes the dialog.
    dialog.props.onConfirm();
    expect(rollBack).toHaveBeenCalledTimes(1);
    tree = renderGateway({});
    expect(findAllByType(tree, ConfirmDialog)[0].props.visible).toBe(false);

    // Canceling a fresh confirm never dispatches.
    findAllByType(tree, ActionButton)
      .find((vnode) => vnode.props.idleLabel === "Roll back")
      .props.onClick();
    tree = renderGateway({});
    dialog = findAllByType(tree, ConfirmDialog)[0];
    expect(dialog.props.visible).toBe(true);
    dialog.props.onCancel();
    tree = renderGateway({});
    expect(findAllByType(tree, ConfirmDialog)[0].props.visible).toBe(false);
    expect(rollBack).toHaveBeenCalledTimes(1);
  });

  it("rollback fence (#20): the shell's rollbackDataRisk slice renders the second-stage danger confirm naming the backup", () => {
    const confirmRollbackDataRisk = vi.fn();
    const cancelRollbackDataRisk = vi.fn();
    publishShell({
      statusState: makeServerState({}),
      rollbackDataRisk: {
        message:
          "This update migrated your state databases — the rollback target may not be able to read them.",
        backupFile: "backup-2026-08-29.tar.gz",
      },
    });
    gatewayShellStore.publish({
      actions: {
        ...gatewayShellStore.get().actions,
        confirmRollbackDataRisk,
        cancelRollbackDataRisk,
      },
    });

    const tree = renderGateway({});
    // Two ConfirmDialogs render: [0] is the action confirm (hidden), the
    // data-risk confirm is the visible one carrying the server's message.
    const dialog = findAllByType(tree, ConfirmDialog).find(
      (vnode) => vnode.props.title === "Roll back despite migrated data?",
    );
    expect(dialog).toBeTruthy();
    expect(dialog.props.visible).toBe(true);
    expect(dialog.props.confirmTone).toBe("danger");
    expect(dialog.props.message).toBe(
      "This update migrated your state databases — the rollback target may not be able to read them.",
    );
    expect(collectText(dialog).join(" ")).toContain(
      "Restore the verified pre-update backup first (backup-2026-08-29.tar.gz), or roll back anyway — data written by the newer version may be unreadable.",
    );

    dialog.props.onConfirm();
    expect(confirmRollbackDataRisk).toHaveBeenCalledTimes(1);
    dialog.props.onCancel();
    expect(cancelRollbackDataRisk).toHaveBeenCalledTimes(1);
  });

  it("no rollbackDataRisk slice: the data-risk confirm does not render", () => {
    publishShell({ statusState: makeServerState({}) });
    const tree = renderGateway({});
    expect(
      findAllByType(tree, ConfirmDialog).find(
        (vnode) => vnode.props.title === "Roll back despite migrated data?",
      ),
    ).toBeUndefined();
  });

  it("the fixture matrix covers every state in the server catalog (a new state cannot ship unrendered)", () => {
    const fixtureNames = new Set(kStateFixtures.map((fixture) => fixture.name));
    const catalogStates = Object.keys(kGatewayStateCatalog);
    expect(catalogStates.length).toBeGreaterThan(0);
    for (const stateName of catalogStates) {
      expect(
        fixtureNames.has(stateName),
        `server state "${stateName}" has no rendering fixture in kStateFixtures`,
      ).toBe(true);
    }
  });
});

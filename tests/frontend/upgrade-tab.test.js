import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as models-tab-model-picker-component):
// hook state lives in per-call-index slots so component/hook functions can be
// invoked directly without a DOM renderer. Effects are collected, not run.
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
  applyOpenclawVersion: vi.fn(),
  clearOpenclawBlocklist: vi.fn(),
  fetchOpenclawCatalog: vi.fn(),
  fetchOpenclawChannel: vi.fn(),
  fetchStatus: vi.fn(),
  markOpenclawGood: vi.fn(),
  rollbackOpenclaw: vi.fn(),
  subscribeOpenclawApplyEvents: vi.fn(() => () => {}),
  updateOpenclawReleaseChannel: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { UpgradeTabView } from "../../lib/public/js/components/upgrade-tab/index.js";
import { useUpgradeTab } from "../../lib/public/js/components/upgrade-tab/use-upgrade-tab.js";
import { buildChannelSwitchModel } from "../../lib/public/js/components/upgrade-tab/helpers.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { SegmentedControl } from "../../lib/public/js/components/segmented-control.js";
import { Tooltip } from "../../lib/public/js/components/tooltip.js";
import { InfoTooltip } from "../../lib/public/js/components/info-tooltip.js";

const harness = preactHooks.__harness;

const kNow = Date.parse("2026-08-25T12:00:00.000Z");

// Components whose render bodies need a real DOM (portals) — keep as vnodes.
const kSkipExpand = new Set([Tooltip, InfoTooltip]);

// Recursively invokes function components so the whole page renders to a
// walkable tree. The original vnode (type + props) is preserved so tests can
// still find components by identity.
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

const findButtonByText = (tree, text) =>
  findAllByType(tree, "button").find((vnode) =>
    collectText(vnode).join(" ").includes(text),
  );

const findActionButtonByLabel = (tree, label) =>
  findAllByType(tree, ActionButton).find(
    (vnode) => vnode.props.idleLabel === label,
  );

const renderView = (stateOverrides = {}) => {
  harness.beginRender();
  return expandTree(UpgradeTabView({ state: { nowMs: kNow, ...stateOverrides } }));
};

const makeChannelInfo = (overrides = {}) => ({
  ok: true,
  releaseChannel: "stable",
  installedVersion: "2026.7.1-2",
  pinVersion: "2026.7.1-2",
  applied: null,
  appliedId: null,
  isPin: true,
  acceptedAt: null,
  inStabilizationWindow: false,
  lastKnownGood: { package: "2026.7.1-2", dev: null },
  blocklist: [],
  lastUpdateRun: null,
  lastBoot: null,
  ...overrides,
});

const makeStableRow = (overrides = {}) => ({
  version: "2026.7.2",
  publishedAt: "2026-08-20T00:00:00.000Z",
  prerelease: false,
  isDistTagLatest: true,
  engines: null,
  notes: "release notes body",
  notesUnavailable: false,
  applyPayload: { channel: "stable", version: "2026.7.2" },
  current: false,
  lastKnownGood: false,
  blocklisted: null,
  ...overrides,
});

const makeCatalog = (overrides = {}) => ({
  staleAsOf: kNow - 5 * 60_000,
  degraded: { github: false, npm: false },
  distTags: { latest: "2026.7.2" },
  stable: [
    makeStableRow(),
    makeStableRow({
      version: "2026.7.1-2",
      isDistTagLatest: false,
      current: true,
      lastKnownGood: true,
      applyPayload: { channel: "stable", version: "2026.7.1-2" },
    }),
  ],
  beta: [
    makeStableRow({
      version: "2026.7.3-beta.1",
      prerelease: true,
      isDistTagLatest: false,
      applyPayload: { channel: "beta", version: "2026.7.3-beta.1" },
    }),
  ],
  dev: {
    commits: [
      {
        sha: "abc1234def5678abc1234def5678abc1234def56",
        shortSha: "abc1234",
        subject: "fix: gateway reconnect",
        date: "2026-08-24T00:00:00.000Z",
        applyPayload: {
          channel: "dev",
          sha: "abc1234def5678abc1234def5678abc1234def56",
        },
        current: false,
        lastKnownGood: false,
        blocklisted: null,
      },
    ],
    truncated: true,
    baseTag: "v2026.7.2",
    source: "github",
  },
  ...overrides,
});

describe("frontend/upgrade-tab view", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("renders the page title and the LOADING state", () => {
    const tree = renderView({ loadingChannel: true, loadingCatalog: true });

    const text = treeText(tree);
    expect(text).toContain("OpenClaw — Versions & Channels");
    expect(text).toContain("Loading version info...");
    expect(text).toContain("Loading version catalog...");
  });

  it("renders the EMPTY-OFFLINE state for a degraded catalog", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog({
        degraded: { github: true, npm: true },
        staleAsOf: kNow - 3 * 3_600_000,
      }),
    });

    const text = treeText(tree);
    expect(text).toContain("Catalog sources are degraded");
    expect(text).toContain("github, npm");
    expect(text).toContain("Catalog as of 3 hours ago");
  });

  it("renders catalog_unavailable envelopes with message and hint", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: null,
      catalogError: {
        message: "Could not load the OpenClaw release catalog from GitHub or npm.",
        hint: "Check the server's network access (and GITHUB_TOKEN if configured), then refresh the catalog.",
        code: "catalog_unavailable",
      },
    });

    const text = treeText(tree);
    expect(text).toContain(
      "Could not load the OpenClaw release catalog from GitHub or npm.",
    );
    expect(text).toContain("Check the server's network access");
  });

  it("renders apply error envelopes verbatim — message with hint underneath (U12)", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      applyError: {
        message: "Node 22.12+ is required to build OpenClaw from source",
        hint: "Install Node 22 via apt: sudo apt install nodejs",
        code: "preflight_failed",
      },
    });

    const text = treeText(tree);
    expect(text).toContain("Node 22.12+ is required to build OpenClaw from source");
    expect(text).toContain("Install Node 22 via apt: sudo apt install nodejs");
  });

  it("disables every action button while an apply operation streams (U5)", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      actionsDisabled: true,
      operation: {
        operationId: "op-1",
        target: { channel: "stable", version: "2026.7.2" },
        label: "2026.7.2",
        startedAt: kNow - 83_000,
        steps: [
          { name: "preflight", status: "completed", at: kNow - 80_000 },
          { name: "backup", status: "completed", at: kNow - 60_000 },
          { name: "download", status: "running", at: kNow - 30_000 },
        ],
        output: "npm install openclaw@2026.7.2\n",
        lastOutputAt: kNow - 5_000,
        phase: "running",
        error: null,
      },
    });

    const text = treeText(tree);
    expect(text).toContain("Updating to 2026.7.2");
    expect(text).toContain("elapsed");
    expect(text).toContain("1m 23s");
    expect(text).toContain("last output 5s ago");
    expect(text).toContain("Preflight checks");
    expect(text).toContain("Download");
    expect(text).toContain("Show raw log");

    const actionButtons = findAllByType(tree, ActionButton);
    expect(actionButtons.length).toBeGreaterThan(0);
    for (const button of actionButtons) {
      expect(Boolean(button.props.disabled) || Boolean(button.props.loading)).toBe(
        true,
      );
    }
  });

  it("expands the raw-log pane when open", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      logOpen: true,
      operation: {
        label: "2026.7.2",
        startedAt: kNow,
        steps: [],
        output: "unpacked 1234 files",
        lastOutputAt: kNow,
        phase: "running",
      },
    });

    expect(treeText(tree)).toContain("unpacked 1234 files");
  });

  it("renders the RESTARTING handoff state (U4)", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      actionsDisabled: true,
      operation: {
        label: "2026.7.2",
        startedAt: kNow - 130_000,
        steps: [
          { name: "record", status: "completed", at: kNow - 10_000 },
          { name: "restarting", status: "running", at: kNow - 5_000 },
        ],
        output: "",
        lastOutputAt: null,
        phase: "restarting",
      },
    });

    expect(treeText(tree)).toContain(
      "AlphaClaw is restarting — this page will reconnect automatically (up to ~2 min)",
    );
  });

  it("renders the verdict banner after reconnect", () => {
    const onDismissVerdict = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      verdict: {
        ok: true,
        message: "Now on OpenClaw 2026.7.2 — activation verified",
      },
      onDismissVerdict,
    });

    expect(treeText(tree)).toContain(
      "Now on OpenClaw 2026.7.2 — activation verified",
    );
    findButtonByText(tree, "Dismiss").props.onclick();
    expect(onDismissVerdict).toHaveBeenCalledTimes(1);
  });

  it("shows the STABILIZING badge with the Mark-as-good button and caption (U7)", () => {
    const onMarkGood = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo({
        releaseChannel: "beta",
        installedVersion: "2026.7.3-beta.1",
        applied: { channel: "beta", version: "2026.7.3-beta.1" },
        appliedId: "2026.7.3-beta.1",
        isPin: false,
        inStabilizationWindow: true,
        acceptedAt: null,
        lastKnownGood: { package: "2026.7.2", dev: null },
      }),
      activeChannel: "beta",
      catalog: makeCatalog(),
      onMarkGood,
    });

    const text = treeText(tree);
    expect(text).toContain("STABILIZING");
    expect(text).toContain("auto-rollback armed → last known good: 2026.7.2");
    expect(text).toContain("first 24h");
    expect(text).toContain(
      "Channel-applied versions add ~10-30s to restarts (the built-in version boots fastest).",
    );

    const markGood = findActionButtonByLabel(tree, "Mark as good now");
    expect(markGood).toBeTruthy();
    markGood.props.onClick();
    expect(onMarkGood).toHaveBeenCalledTimes(1);
  });

  it("offers Roll back now in the stabilization block, secondary to Mark as good now", () => {
    const onRequestRollback = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo({
        releaseChannel: "beta",
        installedVersion: "2026.7.3-beta.1",
        applied: { channel: "beta", version: "2026.7.3-beta.1" },
        appliedId: "2026.7.3-beta.1",
        isPin: false,
        inStabilizationWindow: true,
        acceptedAt: null,
        lastKnownGood: { package: "2026.7.2", dev: null },
      }),
      activeChannel: "beta",
      catalog: makeCatalog(),
      onRequestRollback,
    });

    const rollback = findActionButtonByLabel(tree, "Roll back now");
    expect(rollback).toBeTruthy();
    expect(rollback.props.tone).toBe("warning");
    rollback.props.onClick();
    expect(onRequestRollback).toHaveBeenCalledTimes(1);
  });

  it("shows the auto-accepted 24h note when acceptedAt is set inside the window", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo({
        releaseChannel: "beta",
        installedVersion: "2026.7.3-beta.1",
        applied: {
          channel: "beta",
          version: "2026.7.3-beta.1",
          acceptedSource: "acceptance",
        },
        appliedId: "2026.7.3-beta.1",
        isPin: false,
        inStabilizationWindow: true,
        acceptedAt: kNow - 3_600_000,
      }),
      activeChannel: "beta",
      catalog: makeCatalog(),
    });

    const text = treeText(tree);
    expect(text).not.toContain("STABILIZING");
    expect(text).toContain(
      "Auto-rollback stays armed for 24h after activation — 'Mark as good now' disarms it.",
    );
  });

  it("renders the incident card for an auto-rollback and wires the Clear CTA (U6)", () => {
    const onClearBlocklist = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo({
        lastUpdateRun: {
          target: { channel: "stable", version: "2026.7.2" },
          startedAt: kNow - 7_200_000,
          finishedAt: kNow - 7_100_000,
          ok: true,
          steps: [],
          result: { ok: true },
        },
        blocklist: [
          { id: "2026.7.2", reason: "crash_loop", exitCode: 1, at: kNow - 60_000 },
        ],
      }),
      catalog: makeCatalog(),
      onClearBlocklist,
    });

    const text = treeText(tree);
    expect(text).toContain("2026.7.2 rolled back at");
    expect(text).toContain("Trigger: crash_loop, exit code 1");

    const clearButton = findActionButtonByLabel(tree, "Clear blocklist entry");
    clearButton.props.onClick();
    expect(onClearBlocklist).toHaveBeenCalledWith("2026.7.2");
  });

  it("renders a Roll back control in the incident card next to the Clear CTA", () => {
    const onRequestRollback = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo({
        lastUpdateRun: {
          target: { channel: "stable", version: "2026.7.2" },
          startedAt: kNow - 7_200_000,
          finishedAt: kNow - 7_100_000,
          ok: true,
          steps: [],
          result: { ok: true },
        },
        blocklist: [
          { id: "2026.7.2", reason: "crash_loop", exitCode: 1, at: kNow - 60_000 },
        ],
      }),
      catalog: makeCatalog(),
      onRequestRollback,
    });

    expect(findActionButtonByLabel(tree, "Clear blocklist entry")).toBeTruthy();
    const rollback = findActionButtonByLabel(tree, "Roll back");
    expect(rollback).toBeTruthy();
    expect(rollback.props.tone).toBe("warning");
    rollback.props.onClick();
    expect(onRequestRollback).toHaveBeenCalledTimes(1);
  });

  it("confirms a rollback through a dialog that states the target and side effect", () => {
    const onRollback = vi.fn();
    const onCancelRollback = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      rollbackPrompt: true,
      onRollback,
      onCancelRollback,
    });

    expect(treeText(tree)).toContain(
      "Roll back to the last known good version now? The current version will be blocklisted.",
    );

    // The dialog's confirm — the only "Roll back" ActionButton in this render.
    const confirmButton = findActionButtonByLabel(tree, "Roll back");
    expect(confirmButton).toBeTruthy();
    confirmButton.props.onClick();
    expect(onRollback).toHaveBeenCalledTimes(1);

    findActionButtonByLabel(tree, "Cancel").props.onClick();
    expect(onCancelRollback).toHaveBeenCalledTimes(1);
  });

  it("routes segment changes through the guided flow — the dialog offers Apply now vs browse (U1)", () => {
    const onSelectChannel = vi.fn();
    const onConfirmSwitchApply = vi.fn();
    const onConfirmSwitchBrowse = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      onSelectChannel,
      onConfirmSwitchApply,
      onConfirmSwitchBrowse,
      channelSwitchPrompt: {
        nextChannel: "beta",
        latestLabel: "2026.7.3-beta.1",
        model: buildChannelSwitchModel({
          nextChannel: "beta",
          latestLabel: "2026.7.3-beta.1",
        }),
      },
    });

    const segmented = findAllByType(tree, SegmentedControl)[0];
    segmented.props.onChange("beta");
    expect(onSelectChannel).toHaveBeenCalledWith("beta");

    const text = treeText(tree);
    expect(text).toContain("Switch to latest beta?");
    expect(text).toContain("~2 min, backup included");
    expect(text).toContain("Just browse the catalog");
    expect(text).toContain("installs nothing until you press Apply");

    findButtonByText(tree, "Apply now").props.onclick();
    expect(onConfirmSwitchApply).toHaveBeenCalledTimes(1);
    findButtonByText(tree, "Just browse the catalog").props.onclick();
    expect(onConfirmSwitchBrowse).toHaveBeenCalledTimes(1);
  });

  it("keeps the dev commit list collapsed behind Advanced with requirements shown first (U13/U3)", () => {
    const onToggleDevAdvanced = vi.fn();
    const collapsed = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      devAdvancedOpen: false,
      onToggleDevAdvanced,
    });

    const collapsedText = treeText(collapsed);
    expect(collapsedText).toContain(
      "≈5 GB free on the data volume · 8 GB RAM recommended · first build takes 20-35 minutes",
    );
    expect(collapsedText).toContain("Latest dev (main HEAD)");
    expect(collapsedText).toContain("Advanced: pin a specific commit");
    expect(collapsedText).not.toContain("abc1234");

    findButtonByText(collapsed, "Advanced: pin a specific commit").props.onclick();
    expect(onToggleDevAdvanced).toHaveBeenCalledTimes(1);

    const open = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      devAdvancedOpen: true,
    });
    const openText = treeText(open);
    expect(openText).toContain("abc1234");
    expect(openText).toContain("untested snapshot");
    expect(openText).toContain("List truncated");
  });

  it("requests a dev-head apply from the primary dev action", () => {
    const onRequestApply = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      onRequestApply,
    });

    findActionButtonByLabel(tree, "Latest dev (main HEAD)").props.onClick();
    expect(onRequestApply).toHaveBeenCalledWith({
      payload: { channel: "dev", devHead: true },
      label: "latest dev (main HEAD)",
      isDowngrade: false,
    });
  });

  it("shows blocklisted rows with reason, exit code, time, and a Clear affordance (U14)", () => {
    const onClearBlocklist = vi.fn();
    const catalog = makeCatalog();
    catalog.stable[0] = makeStableRow({
      blocklisted: { reason: "crash_loop", exitCode: 1, at: kNow - 60_000 },
    });
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog,
      onClearBlocklist,
    });

    const text = treeText(tree);
    expect(text).toContain("blocklisted");
    expect(text).toContain("trigger: crash_loop");
    expect(text).toContain("exit code 1");

    const clearButton = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Clear",
    );
    clearButton.props.onClick();
    expect(onClearBlocklist).toHaveBeenCalledWith("2026.7.2");
  });

  it("relabels a just-cleared row's action to Try again (U14)", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      lastClearedId: "2026.7.2",
    });

    expect(findActionButtonByLabel(tree, "Try again")).toBeTruthy();
  });

  it("renders the staleness stamp and wires the Check now action (U15)", () => {
    const onCheckNow = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      onCheckNow,
    });

    expect(treeText(tree)).toContain("Catalog as of 5 minutes ago");
    findActionButtonByLabel(tree, "Check now").props.onClick();
    expect(onCheckNow).toHaveBeenCalledTimes(1);
  });

  it("cross-links to the AlphaClaw update dialog as plain guidance (U16)", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
    });

    const text = treeText(tree);
    expect(text).toContain(
      "Looking for AlphaClaw updates? Use the update dialog in the sidebar.",
    );
    expect(text).not.toContain("→ use the update dialog");
  });

  it("disables the channel segmented control during an operation", () => {
    const onSelectChannel = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      actionsDisabled: true,
      onSelectChannel,
      operation: {
        label: "2026.7.2",
        startedAt: kNow,
        steps: [],
        output: "",
        lastOutputAt: null,
        phase: "running",
      },
    });

    const segmented = findAllByType(tree, SegmentedControl)[0];
    expect(segmented.props.disabled).toBe(true);

    const segmentButtons = findAllByType(segmented, "button");
    expect(segmentButtons.length).toBe(3);
    for (const button of segmentButtons) {
      expect(button.props.disabled).toBe(true);
    }
    segmentButtons[0].props.onclick();
    expect(onSelectChannel).not.toHaveBeenCalled();
  });

  it("keeps the segmented control enabled when idle", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
    });

    const segmented = findAllByType(tree, SegmentedControl)[0];
    expect(segmented.props.disabled).toBe(false);
  });

  it("Escape closes the channel-switch dialog, guarded while saving", () => {
    const onCancelSwitch = vi.fn();
    const listeners = [];
    const priorWindow = globalThis.window;
    globalThis.window = {
      addEventListener: (type, handler) => listeners.push([type, handler]),
      removeEventListener: () => {},
    };
    try {
      const prompt = {
        nextChannel: "beta",
        latestLabel: "2026.7.3-beta.1",
        model: buildChannelSwitchModel({
          nextChannel: "beta",
          latestLabel: "2026.7.3-beta.1",
        }),
      };
      renderView({
        channelInfo: makeChannelInfo(),
        catalog: makeCatalog(),
        channelSwitchPrompt: prompt,
        onCancelSwitch,
      });
      for (const effect of harness.effects) effect?.();
      const keydownHandlers = listeners
        .filter(([type]) => type === "keydown")
        .map(([, handler]) => handler);
      expect(keydownHandlers.length).toBe(1);

      keydownHandlers[0]({ key: "Enter" });
      expect(onCancelSwitch).not.toHaveBeenCalled();
      keydownHandlers[0]({ key: "Escape" });
      expect(onCancelSwitch).toHaveBeenCalledTimes(1);

      // While saving, Escape must not dismiss the dialog mid-request.
      listeners.length = 0;
      renderView({
        channelInfo: makeChannelInfo(),
        catalog: makeCatalog(),
        channelSwitchPrompt: prompt,
        savingChannel: true,
        onCancelSwitch,
      });
      for (const effect of harness.effects) effect?.();
      const savingHandlers = listeners
        .filter(([type]) => type === "keydown")
        .map(([, handler]) => handler);
      savingHandlers[0]({ key: "Escape" });
      expect(onCancelSwitch).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.window = priorWindow;
    }
  });

  it("keeps last loaded data visible with an amber notice when a refresh fails", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      channelError: {
        message: "Could not read channel state",
        hint: null,
        code: "channel_state_unavailable",
      },
    });

    const text = treeText(tree);
    expect(text).toContain("Could not refresh status — showing last loaded data.");
    // The full-page error block stays reserved for the no-data case.
    expect(text).not.toContain("Could not read channel state");
    expect(text).toContain("Release channel");
  });

  it("renders the streamed failure hint under the message (U12)", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      operation: {
        label: "latest dev (main HEAD)",
        startedAt: kNow - 60_000,
        steps: [{ name: "build", status: "failed", at: kNow - 5_000 }],
        output: "",
        lastOutputAt: null,
        phase: "failed",
        error: {
          message: "build failed: tsc exited 2",
          hint: "Check the raw log for the first TypeScript error.",
          code: "build_failed",
          docsUrl: null,
        },
      },
    });

    const text = treeText(tree);
    expect(text).toContain("build failed: tsc exited 2");
    expect(text).toContain("Check the raw log for the first TypeScript error.");
  });
});

describe("frontend/upgrade-tab hook", () => {
  const flushAsync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const renderHook = (props = {}) => {
    harness.beginRender();
    return useUpgradeTab(props);
  };

  const hydrate = async (props = {}) => {
    let state = renderHook(props);
    // Run only the mount data-load effect (effect #0); the others start
    // timers/streams that the harness should not leak.
    harness.effects[0]();
    await flushAsync();
    state = renderHook(props);
    return state;
  };

  beforeEach(() => {
    harness.reset();
    api.fetchOpenclawChannel.mockResolvedValue(makeChannelInfo());
    api.fetchOpenclawCatalog.mockResolvedValue({
      ok: true,
      catalog: makeCatalog(),
      channel: { releaseChannel: "stable" },
    });
    api.updateOpenclawReleaseChannel.mockResolvedValue({
      ok: true,
      changed: true,
      config: {},
      restartRequired: false,
    });
    api.subscribeOpenclawApplyEvents.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("a segment change opens the guided prompt and never PUTs silently (U1)", async () => {
    let state = await hydrate();

    state.onSelectChannel("beta");

    expect(api.updateOpenclawReleaseChannel).not.toHaveBeenCalled();
    expect(api.applyOpenclawVersion).not.toHaveBeenCalled();
    state = renderHook({});
    expect(state.channelSwitchPrompt).toEqual(
      expect.objectContaining({ nextChannel: "beta" }),
    );
    expect(state.channelSwitchPrompt.model.title).toBe("Switch to latest beta?");
  });

  it("selecting the already-active channel does not open the prompt", async () => {
    let state = await hydrate();

    state.onSelectChannel("stable");

    state = renderHook({});
    expect(state.channelSwitchPrompt).toBeNull();
  });

  it("browse-only persists the channel via PUT without applying", async () => {
    let state = await hydrate();
    state.onSelectChannel("beta");
    state = renderHook({});

    await state.onConfirmSwitchBrowse();

    expect(api.updateOpenclawReleaseChannel).toHaveBeenCalledWith("beta");
    expect(api.applyOpenclawVersion).not.toHaveBeenCalled();
    state = renderHook({});
    expect(state.channelSwitchPrompt).toBeNull();
    expect(state.activeChannel).toBe("beta");
  });

  it("Apply now persists the channel, then applies the newest target of that channel (U1/U2)", async () => {
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      operationId: "op-1",
      events: "/api/operations/op-1/events",
    });
    let state = await hydrate();
    state.onSelectChannel("beta");
    state = renderHook({});

    await state.onConfirmSwitchApply();

    expect(api.updateOpenclawReleaseChannel).toHaveBeenCalledWith("beta");
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({
      channel: "beta",
      version: "2026.7.3-beta.1",
    });
    expect(api.subscribeOpenclawApplyEvents).toHaveBeenCalledWith(
      expect.objectContaining({ operationId: "op-1" }),
    );
    state = renderHook({});
    expect(state.operation).toEqual(
      expect.objectContaining({ operationId: "op-1", phase: "running" }),
    );
  });

  it("apply requests go through a confirm dialog before anything runs (U3)", async () => {
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      operationId: "op-2",
      events: "/api/operations/op-2/events",
    });
    let state = await hydrate();

    state.onRequestApply({
      payload: { channel: "stable", version: "2026.7.2" },
      label: "2026.7.2",
      isDowngrade: false,
    });
    expect(api.applyOpenclawVersion).not.toHaveBeenCalled();

    state = renderHook({});
    expect(state.pendingApply.confirm.title).toBe("Switch to 2026.7.2?");

    await state.onConfirmApply();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({
      channel: "stable",
      version: "2026.7.2",
    });
  });

  it("switches to the RESTARTING phase when the restarting step arrives (U4)", async () => {
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return () => {};
    });
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      operationId: "op-3",
      events: "/api/operations/op-3/events",
    });
    let state = await hydrate();
    state.onRequestApply({
      payload: { channel: "stable", version: "2026.7.2" },
      label: "2026.7.2",
    });
    state = renderHook({});
    await state.onConfirmApply();

    captured.onMessage({
      event: "step",
      data: { name: "verify", status: "completed", at: 1 },
    });
    captured.onMessage({ event: "output", data: { chunk: "verified\n" } });
    captured.onMessage({
      event: "step",
      data: { name: "restarting", status: "running", at: 2 },
    });

    state = renderHook({});
    expect(state.operation.phase).toBe("restarting");
    expect(state.operation.output).toContain("verified");
    expect(state.operation.steps.map((step) => step.name)).toEqual([
      "verify",
      "restarting",
    ]);
  });

  it("marks the operation failed with the envelope message on an error event (U5/U12)", async () => {
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return () => {};
    });
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      operationId: "op-4",
      events: "/api/operations/op-4/events",
    });
    let state = await hydrate();
    state.onRequestApply({
      payload: { channel: "dev", devHead: true },
      label: "latest dev (main HEAD)",
    });
    state = renderHook({});
    await state.onConfirmApply();

    captured.onMessage({
      event: "error",
      data: { error: "build failed: tsc exited 2" },
    });

    state = renderHook({});
    expect(state.operation.phase).toBe("failed");
    expect(state.operation.error.message).toBe("build failed: tsc exited 2");
  });

  it("clears the progress view on a noop apply", async () => {
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      noop: true,
      operationId: "op-5",
    });
    let state = await hydrate();
    state.onRequestApply({
      payload: { channel: "stable", version: "2026.7.1-2" },
      label: "2026.7.1-2",
    });
    state = renderHook({});

    await state.onConfirmApply();

    state = renderHook({});
    expect(state.operation).toBeNull();
    expect(api.subscribeOpenclawApplyEvents).not.toHaveBeenCalled();
  });

  it("captures the error envelope (message + hint) when the apply is rejected (U12)", async () => {
    const envelopeError = Object.assign(new Error("insufficient disk space"), {
      code: "preflight_failed",
      hint: "Free at least 5 GB on the data volume.",
    });
    api.applyOpenclawVersion.mockRejectedValue(envelopeError);
    let state = await hydrate();
    state.onRequestApply({
      payload: { channel: "stable", version: "2026.7.2" },
      label: "2026.7.2",
    });
    state = renderHook({});

    await state.onConfirmApply();

    state = renderHook({});
    expect(state.operation).toBeNull();
    expect(state.applyError).toEqual(
      expect.objectContaining({
        message: "insufficient disk space",
        hint: "Free at least 5 GB on the data volume.",
      }),
    );
  });

  it("rehydrates an in-flight apply from lastUpdateRun on mount (U4/EV10)", async () => {
    api.fetchOpenclawChannel.mockResolvedValue(
      makeChannelInfo({
        lastUpdateRun: {
          target: { channel: "dev", devHead: true },
          startedAt: kNow - 60_000,
          finishedAt: null,
          ok: null,
          steps: [
            { name: "preflight", status: "completed", at: kNow - 55_000 },
            { name: "build", status: "running", at: kNow - 30_000 },
          ],
        },
      }),
    );
    let state = await hydrate({
      statusData: { openclawChannel: { applyInProgress: true } },
    });

    // Run the rehydration effect (registered after the data-load effect).
    harness.effects[1]();
    state = renderHook({
      statusData: { openclawChannel: { applyInProgress: true } },
    });

    expect(state.operation).toEqual(
      expect.objectContaining({ resumed: true, phase: "running" }),
    );
    expect(state.operation.steps.map((step) => step.name)).toEqual([
      "preflight",
      "build",
    ]);
    expect(state.operation.label).toBe("latest dev (main HEAD)");
  });

  it("clears a blocklist entry and refreshes the catalog (U14)", async () => {
    api.clearOpenclawBlocklist.mockResolvedValue({ ok: true, blocklist: [] });
    let state = await hydrate();

    await state.onClearBlocklist("2026.7.2");

    expect(api.clearOpenclawBlocklist).toHaveBeenCalledWith("2026.7.2");
    state = renderHook({});
    expect(state.lastClearedId).toBe("2026.7.2");
    expect(state.channelInfo.blocklist).toEqual([]);
    // catalog reloaded to drop the row annotation
    expect(api.fetchOpenclawCatalog).toHaveBeenCalledTimes(2);
  });

  it("Check now refreshes the catalog with refresh=1 (U15)", async () => {
    let state = await hydrate();

    state.onCheckNow();
    await flushAsync();

    expect(api.fetchOpenclawCatalog).toHaveBeenLastCalledWith({ refresh: true });
  });

  it("marks the running version good and reloads channel state (U7)", async () => {
    api.markOpenclawGood.mockResolvedValue({ ok: true, acceptedAt: kNow });
    let state = await hydrate();

    await state.onMarkGood();

    expect(api.markOpenclawGood).toHaveBeenCalledTimes(1);
    expect(api.fetchOpenclawChannel).toHaveBeenCalledTimes(2);
  });

  it("rollback goes through a confirm prompt, then enters the restarting phase", async () => {
    api.rollbackOpenclaw.mockResolvedValue({ ok: true, target: { kind: "pin" } });
    let state = await hydrate();

    // The CTA only opens the prompt — nothing rolls back yet.
    state.onRequestRollback();
    expect(api.rollbackOpenclaw).not.toHaveBeenCalled();
    state = renderHook({});
    expect(state.rollbackPrompt).toBe(true);

    // Confirming fires the rollback and hands off to the restart poller.
    await state.onRollback();

    expect(api.rollbackOpenclaw).toHaveBeenCalledTimes(1);
    state = renderHook({});
    expect(state.rollbackPrompt).toBe(false);
    expect(state.rollingBack).toBe(false);
    expect(state.operation).toEqual(
      expect.objectContaining({ phase: "restarting", label: "2026.7.1-2" }),
    );
  });

  it("cancelling the rollback prompt closes it without calling the API", async () => {
    let state = await hydrate();

    state.onRequestRollback();
    state = renderHook({});
    expect(state.rollbackPrompt).toBe(true);

    state.onCancelRollback();
    state = renderHook({});
    expect(state.rollbackPrompt).toBe(false);
    expect(api.rollbackOpenclaw).not.toHaveBeenCalled();
  });

  it("shows an error toast when the rollback is rejected with an envelope", async () => {
    const envelopeError = Object.assign(
      new Error("no rollback target available"),
      { code: "rollback_unavailable", hint: "Clear the blocklist first." },
    );
    api.rollbackOpenclaw.mockRejectedValue(envelopeError);
    let state = await hydrate();
    state.onRequestRollback();
    state = renderHook({});

    await state.onRollback();

    expect(showToast).toHaveBeenCalledWith("no rollback target available", "error");
    state = renderHook({});
    expect(state.operation).toBeNull();
    expect(state.rollingBack).toBe(false);
  });

  it("feeds streamed error envelopes (code/hint/docsUrl) into the failure model (U12)", async () => {
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return () => {};
    });
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      operationId: "op-6",
      events: "/api/operations/op-6/events",
    });
    let state = await hydrate();
    state.onRequestApply({
      payload: { channel: "dev", devHead: true },
      label: "latest dev (main HEAD)",
    });
    state = renderHook({});
    await state.onConfirmApply();

    captured.onMessage({
      event: "error",
      data: {
        error: "build failed: tsc exited 2",
        code: "build_failed",
        hint: "Check the raw log for the first TypeScript error.",
        docsUrl: "https://docs.openclaw.ai/updates#build-failures",
      },
    });

    state = renderHook({});
    expect(state.operation.phase).toBe("failed");
    expect(state.operation.error).toEqual(
      expect.objectContaining({
        message: "build failed: tsc exited 2",
        code: "build_failed",
        hint: "Check the raw log for the first TypeScript error.",
        docsUrl: "https://docs.openclaw.ai/updates#build-failures",
      }),
    );
  });
});

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
  fetchOpenclawRun: vi.fn(),
  fetchOpenclawRunLogText: vi.fn(),
  fetchOpenclawRuns: vi.fn(),
  fetchStatus: vi.fn(),
  markOpenclawGood: vi.fn(),
  retryOpenclawReconcile: vi.fn(),
  rollbackOpenclaw: vi.fn(),
  runOpenclawRepair: vi.fn(),
  subscribeOpenclawApplyEvents: vi.fn(() => () => {}),
  updateOpenclawReleaseChannel: vi.fn(),
}));

vi.mock("../../lib/public/js/components/toast.js", () => ({
  showToast: vi.fn(),
  ToastContainer: () => null,
}));

import * as preactHooks from "preact/hooks";
import * as api from "../../lib/public/js/lib/api.js";
import {
  getCached,
  invalidateCache,
  setCached,
} from "../../lib/public/js/lib/api-cache.js";
import { showToast } from "../../lib/public/js/components/toast.js";
import { gatewayShellStore } from "../../lib/public/js/components/restart-progress-card.js";
import { UpgradeTabView } from "../../lib/public/js/components/upgrade-tab/index.js";
import { useUpgradeTab } from "../../lib/public/js/components/upgrade-tab/use-upgrade-tab.js";
import { buildChannelSaveErrorModel } from "../../lib/public/js/components/upgrade-tab/helpers.js";
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

  it("renders the channel picker (disabled) inside the loading skeleton — the card is never a hostage", () => {
    const tree = renderView({ loadingChannel: true, loadingCatalog: true });
    // The segmented control's static options render even before the channel
    // GET resolves; only the data region shows the loading line.
    const text = treeText(tree);
    expect(text).toContain("Release channel");
    expect(text).toContain("Stable");
    expect(text).toContain("Beta");
  });

  it("renders a Dismiss affordance on a failed operation so the page is never dead", () => {
    const onDismissOperation = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      operation: {
        operationId: "op-9",
        phase: "failed",
        label: "2026.8.1-beta.3",
        startedAt: kNow - 60_000,
        steps: [],
        output: "",
        lastOutputAt: null,
        error: { message: "activation failed" },
      },
      onDismissOperation,
    });
    const text = treeText(tree);
    expect(text).toContain("Dismiss to re-enable the page");
    const dismiss = findButtonByText(tree, "Dismiss");
    expect(dismiss).toBeTruthy();
    dismiss.props.onclick();
    expect(onDismissOperation).toHaveBeenCalled();
  });

  it("warns inline when a catalog refresh fails but stale data is shown", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog({ staleAsOf: kNow - 3_600_000 }),
      catalogError: { message: "npm registry timeout", hint: null },
    });
    const text = treeText(tree);
    expect(text).toContain(
      "Could not refresh the catalog — showing the last loaded data",
    );
    expect(text).toContain("npm registry timeout");
  });

  it("renders the persistent action-error chip with a Dismiss button", () => {
    const onDismissActionError = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      actionError: {
        headline: "Couldn't roll back OpenClaw.",
        error: Object.assign(new Error("no rollback target"), {
          hint: "Clear the blocklist first.",
        }),
      },
      onDismissActionError,
    });
    const text = treeText(tree);
    expect(text).toContain("Couldn't roll back OpenClaw.");
    expect(text).toContain("no rollback target");
    expect(text).toContain("Clear the blocklist first.");
    const dismiss = findButtonByText(tree, "Dismiss");
    expect(dismiss).toBeTruthy();
    dismiss.props.onclick();
    expect(onDismissActionError).toHaveBeenCalled();
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
    expect(text).toContain("Technical details");

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

    // The green (success) styling carries the banner — never the warning or
    // failure tones.
    const banners = collectNodes(tree).filter((vnode) =>
      String(vnode.props?.class || "").includes("border-green-500/40"),
    );
    expect(banners.length).toBeGreaterThan(0);
  });

  it("renders the gateway-held verdict as a WARNING banner, never green", () => {
    const kHeldMessage =
      "Activated, but settings migration failed — the gateway is held. Check the notification for the exact keys, then use Retry migration.";
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      // The restart-handoff poller builds this from the /api/status
      // openclawChannel summary when it carries a non-null gatewayHold.
      verdict: { ok: true, tone: "warning", message: kHeldMessage },
    });

    expect(treeText(tree)).toContain(kHeldMessage);
    const nodes = collectNodes(tree);
    const warningBanner = nodes.find(
      (vnode) =>
        String(vnode.props?.class || "").includes("border-yellow-500/40") &&
        collectText(vnode).join(" ").includes(kHeldMessage),
    );
    expect(warningBanner).toBeTruthy();
    const greenBanner = nodes.find(
      (vnode) =>
        String(vnode.props?.class || "").includes("border-green-500/40") &&
        collectText(vnode).join(" ").includes(kHeldMessage),
    );
    expect(greenBanner).toBeUndefined();
  });

  it("renders the gateway-hold section with reason, blamed keys, and both actions", () => {
    const onRetryReconcile = vi.fn();
    const onRequestStripReconcile = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo({
        gatewayHold: {
          reason: "settings migration for 2026.8.1 failed: doctor exited 1",
          at: kNow - 60_000,
          operationId: "op-hold-1",
          blamedKeys: ["gateway.oldKey", "channels.legacy"],
        },
      }),
      catalog: makeCatalog(),
      onRetryReconcile,
      onRequestStripReconcile,
    });

    const text = treeText(tree);
    expect(text).toContain("Settings migration needs attention");
    expect(text).toContain(
      "settings migration for 2026.8.1 failed: doctor exited 1",
    );
    expect(text).toContain("gateway.oldKey");
    expect(text).toContain("channels.legacy");

    findActionButtonByLabel(tree, "Retry migration").props.onClick();
    expect(onRetryReconcile).toHaveBeenCalledTimes(1);

    // The strip CTA never fires the retry directly — it only OPENS the
    // confirm dialog (which is not on screen yet).
    findActionButtonByLabel(tree, "Strip blamed keys and retry").props.onClick();
    expect(onRequestStripReconcile).toHaveBeenCalledTimes(1);
    expect(text).not.toContain("Strip blamed keys and retry?");
  });

  it("hides the strip action when the validator parsed no keys", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo({
        gatewayHold: {
          reason: "migration failed",
          at: kNow,
          operationId: null,
          blamedKeys: [],
        },
      }),
      catalog: makeCatalog(),
    });

    expect(findActionButtonByLabel(tree, "Retry migration")).toBeTruthy();
    expect(
      findActionButtonByLabel(tree, "Strip blamed keys and retry"),
    ).toBeUndefined();
  });

  it("strip goes through a confirm dialog with the exact count, backup, and protected-keys copy", () => {
    const onConfirmStripReconcile = vi.fn();
    const onCancelStripReconcile = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo({
        gatewayHold: {
          reason: "migration failed",
          at: kNow,
          operationId: null,
          blamedKeys: ["gateway.oldKey", "channels.legacy"],
        },
      }),
      catalog: makeCatalog(),
      stripReconcilePrompt: true,
      onConfirmStripReconcile,
      onCancelStripReconcile,
    });

    const text = treeText(tree);
    expect(text).toContain("Strip blamed keys and retry?");
    expect(text).toContain(
      "Remove the 2 setting keys OpenClaw's validator rejected? A backup was saved before migration; protected security settings are never removable.",
    );

    const stripConfirm = findActionButtonByLabel(tree, "Strip and retry");
    // Destructive-confirm convention: stripping keys deletes user data
    // (backup-mitigated), so the confirm is danger like RollbackConfirmDialog.
    expect(stripConfirm.props.tone).toBe("danger");
    stripConfirm.props.onClick();
    expect(onConfirmStripReconcile).toHaveBeenCalledTimes(1);

    findActionButtonByLabel(tree, "Cancel").props.onClick();
    expect(onCancelStripReconcile).toHaveBeenCalledTimes(1);
  });

  it("shows the retry in flight and disables the sibling strip action", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo({
        gatewayHold: {
          reason: "migration failed",
          at: kNow,
          operationId: null,
          blamedKeys: ["gateway.oldKey"],
        },
      }),
      catalog: makeCatalog(),
      retryingReconcile: "retry",
      actionsDisabled: true,
    });

    const retry = findActionButtonByLabel(tree, "Retry migration");
    expect(retry.props.loading).toBe(true);
    const strip = findActionButtonByLabel(tree, "Strip blamed keys and retry");
    expect(strip.props.disabled).toBe(true);
    expect(strip.props.loading).toBe(false);
  });

  it("renders the still-held reason inline in the hold card with a Dismiss", () => {
    const onDismissReconcileError = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo({
        gatewayHold: {
          reason: "migration failed",
          at: kNow,
          operationId: null,
          blamedKeys: ["gateway.oldKey"],
        },
      }),
      catalog: makeCatalog(),
      reconcileError: {
        headline: "Migration is still held: doctor exited 1 again",
        error: null,
      },
      onDismissReconcileError,
    });

    expect(treeText(tree)).toContain(
      "Migration is still held: doctor exited 1 again",
    );
    const dismiss = findAllByType(tree, "button").find(
      (vnode) =>
        collectText(vnode).join(" ").includes("Dismiss") &&
        vnode.props.onclick === onDismissReconcileError,
    );
    expect(dismiss).toBeTruthy();
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
      "Channel-applied versions add ~10-60s to the first restart after a version change",
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
    expect(rollback.props.tone).toBe("danger");
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

    const dialogText = treeText(tree);
    expect(dialogText).toContain(
      "Roll back to the last known good version now? The current version will be blocklisted.",
    );
    // Danger copy: stable usually cannot verify beta-written state; the
    // pre-apply backup is the recovery path.
    expect(dialogText).toContain(
      "The older version usually cannot verify state written by this one",
    );
    expect(dialogText).toContain(
      "the backup taken before the update is the recovery path",
    );

    // The dialog's confirm — the only rollback ActionButton in this render.
    const confirmButton = findActionButtonByLabel(tree, "Roll back anyway");
    expect(confirmButton).toBeTruthy();
    confirmButton.props.onClick();
    expect(onRollback).toHaveBeenCalledTimes(1);

    findActionButtonByLabel(tree, "Cancel").props.onClick();
    expect(onCancelRollback).toHaveBeenCalledTimes(1);
  });

  it("renders the second-stage data-risk confirm with the server's message and the verified backup file (#20)", () => {
    const onConfirmRollbackDataRisk = vi.fn();
    const onCancelRollbackDataRisk = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      rollbackDataRisk: {
        message:
          "This update migrated your state databases — the rollback target may not be able to read them.",
        backupFile: "backup-2026-08-29.tar.gz",
      },
      onConfirmRollbackDataRisk,
      onCancelRollbackDataRisk,
    });

    const text = treeText(tree);
    expect(text).toContain("Roll back despite migrated data?");
    // The server's 409 message renders verbatim; the guidance line names the
    // verified pre-update backup to restore first.
    expect(text).toContain(
      "This update migrated your state databases — the rollback target may not be able to read them.",
    );
    expect(text).toContain(
      "Restore the verified pre-update backup first (backup-2026-08-29.tar.gz), or roll back anyway — data written by the newer version may be unreadable.",
    );

    const confirmButton = findActionButtonByLabel(tree, "Roll back anyway");
    expect(confirmButton).toBeTruthy();
    expect(confirmButton.props.tone).toBe("danger");
    confirmButton.props.onClick();
    expect(onConfirmRollbackDataRisk).toHaveBeenCalledTimes(1);

    findActionButtonByLabel(tree, "Cancel").props.onClick();
    expect(onCancelRollbackDataRisk).toHaveBeenCalledTimes(1);
  });

  it("falls back to the no-backup data-risk line when the server recorded none", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      rollbackDataRisk: { message: null, backupFile: null },
    });

    const text = treeText(tree);
    expect(text).toContain("Roll back despite migrated data?");
    // Message fallback for older servers that omit the envelope message.
    expect(text).toContain(
      "This update migrated your state databases — the rollback target may not be able to read them.",
    );
    expect(text).toContain(
      "No verified pre-update backup is recorded — data written by the newer version may be unreadable if you roll back anyway.",
    );
  });

  it("a segment change goes straight to onSelectChannel — no dialog in between (U1)", () => {
    const onSelectChannel = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      onSelectChannel,
    });

    const segmented = findAllByType(tree, SegmentedControl)[0];
    segmented.props.onChange("beta");
    expect(onSelectChannel).toHaveBeenCalledWith("beta");

    const text = treeText(tree);
    expect(text).not.toContain("Switch to latest beta?");
    expect(text).not.toContain("Just browse the catalog");
  });

  it("renders the persistent channel-save error chip next to the control (U1 regression)", () => {
    const onDismissChannelSaveError = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      activeChannel: "stable",
      channelSaveError: buildChannelSaveErrorModel({
        attempted: "beta",
        activeChannel: "stable",
        error: Object.assign(new Error("disk full"), {
          hint: "Check disk space on the data volume.",
        }),
      }),
      onDismissChannelSaveError,
    });

    const text = treeText(tree);
    expect(text).toContain("Couldn't switch to beta — still on stable.");
    expect(text).toContain("disk full");
    expect(text).toContain("Check disk space on the data volume.");

    const dismiss = findAllByType(tree, "button").find(
      (vnode) =>
        collectText(vnode).join(" ").includes("Dismiss") &&
        vnode.props.onclick === onDismissChannelSaveError,
    );
    expect(dismiss).toBeTruthy();
  });

  it("shows a saving spinner state on the segmented control while the channel persists", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      savingChannel: true,
    });

    const segmented = findAllByType(tree, SegmentedControl)[0];
    expect(segmented.props.disabled).toBe(true);
  });

  it("renders the channel-intent mismatch banner with Apply, notes, and Back actions", () => {
    const onRequestApply = vi.fn();
    const onToggleNotes = vi.fn();
    const onSelectChannel = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      activeChannel: "beta",
      catalog: makeCatalog(),
      onRequestApply,
      onToggleNotes,
      onSelectChannel,
    });

    const text = treeText(tree);
    expect(text).toContain(
      "Channel set to beta — still running stable 2026.7.1-2.",
    );

    const update = findActionButtonByLabel(tree, "Update to 2026.7.3-beta.1");
    expect(update).toBeTruthy();
    update.props.onClick();
    expect(onRequestApply).toHaveBeenCalledWith({
      payload: { channel: "beta", version: "2026.7.3-beta.1" },
      label: "2026.7.3-beta.1",
      isDowngrade: false,
    });

    findButtonByText(tree, "Release notes").props.onclick();
    expect(onToggleNotes).toHaveBeenCalledWith("2026.7.3-beta.1");

    const back = findActionButtonByLabel(tree, "Back to stable");
    expect(back).toBeTruthy();
    back.props.onClick();
    expect(onSelectChannel).toHaveBeenCalledWith("stable");
  });

  it("mismatch banner has no Apply button when no newer target is published", () => {
    const catalog = makeCatalog({ beta: [] });
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      activeChannel: "beta",
      catalog,
    });

    const text = treeText(tree);
    expect(text).toContain(
      "No newer beta is published — stable 2026.7.1-2 is current.",
    );
    expect(
      findAllByType(tree, ActionButton).filter((vnode) =>
        String(vnode.props.idleLabel || "").startsWith("Update to 2026"),
      ),
    ).toEqual([]);
    expect(findActionButtonByLabel(tree, "Back to stable")).toBeTruthy();
  });

  it("hides the mismatch banner while an operation is in flight", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      activeChannel: "beta",
      catalog: makeCatalog(),
      operation: {
        label: "2026.7.3-beta.1",
        startedAt: kNow,
        steps: [],
        output: "",
        lastOutputAt: null,
        phase: "running",
      },
    });

    expect(treeText(tree)).not.toContain("Channel set to beta");
  });

  it("gates Apply on npm degradation with an explanation chip, keeping GitHub-only degradation apply-enabled", () => {
    const npmDegraded = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog({ degraded: { github: false, npm: true } }),
    });
    expect(treeText(npmDegraded)).toContain(
      "npm registry unreachable — installs are gated on npm",
    );
    const applyButtons = findAllByType(npmDegraded, ActionButton).filter(
      (vnode) =>
        ["Upgrade", "Downgrade", "Switch", "Latest dev (main HEAD)"].includes(
          vnode.props.idleLabel,
        ),
    );
    expect(applyButtons.length).toBeGreaterThan(0);
    for (const button of applyButtons) {
      expect(button.props.disabled).toBe(true);
    }

    const githubDegraded = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog({ degraded: { github: true, npm: false } }),
    });
    expect(treeText(githubDegraded)).toContain(
      "GitHub unreachable — release notes may be unavailable",
    );
    const enabledApply = findAllByType(githubDegraded, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Upgrade",
    );
    expect(enabledApply.props.disabled).toBe(false);
  });

  it("renders the update timeline with state, target, relative time, and a view-log link", () => {
    const onViewRunLog = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      runs: [
        {
          operationId: "0b1c2d3e-0000-4000-8000-000000000001",
          target: { channel: "stable", version: "2026.7.2" },
          state: "activated",
          startedAt: kNow - 3_700_000,
          finishedAt: kNow - 3_600_000,
          ok: true,
          hasLog: true,
        },
        {
          operationId: "0b1c2d3e-0000-4000-8000-000000000002",
          target: { channel: "beta", version: "2026.7.3-beta.1" },
          state: "activation_failed",
          startedAt: kNow - 86_400_000,
          finishedAt: kNow - 86_300_000,
          ok: false,
          hasLog: false,
        },
      ],
      onViewRunLog,
    });

    const text = treeText(tree);
    expect(text).toContain("Update history");
    expect(text).toContain("2026.7.2");
    expect(text).toContain("activated");
    expect(text).toContain("1 hour ago");
    expect(text).toContain("activation failed");

    const viewLogs = findAllByType(tree, "button").filter((vnode) =>
      collectText(vnode).join(" ").includes("View log"),
    );
    // Only the run that recorded a log offers the link.
    expect(viewLogs.length).toBe(1);
    viewLogs[0].props.onclick();
    expect(onViewRunLog).toHaveBeenCalledWith(
      "0b1c2d3e-0000-4000-8000-000000000001",
    );
  });

  it("renders the run-failure card with the result envelope and a View full log action", () => {
    const onViewRunLog = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      runFailure: {
        operationId: "0b1c2d3e-0000-4000-8000-00000000000f",
        state: "activation_failed",
        title: "Update to 2026.7.3-beta.1 did not activate",
        error: {
          message: "health check failed after restart",
          hint: "The previous version was restored.",
          code: "activation_failed",
          docsUrl: null,
        },
        hasLog: true,
      },
      onViewRunLog,
    });

    const text = treeText(tree);
    expect(text).toContain("Update to 2026.7.3-beta.1 did not activate");
    expect(text).toContain("health check failed after restart");

    findButtonByText(tree, "View full log").props.onclick();
    expect(onViewRunLog).toHaveBeenCalledWith(
      "0b1c2d3e-0000-4000-8000-00000000000f",
    );
  });

  it("shows the fetched run log text in the durable log viewer", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      runs: [
        {
          operationId: "0b1c2d3e-0000-4000-8000-000000000001",
          target: { channel: "stable", version: "2026.7.2" },
          state: "activated",
          startedAt: kNow - 3_700_000,
          finishedAt: kNow - 3_600_000,
          hasLog: true,
        },
      ],
      runLog: {
        operationId: "0b1c2d3e-0000-4000-8000-000000000001",
        loading: false,
        text: "npm install openclaw@2026.7.2\nverified\n",
        error: null,
      },
    });

    expect(treeText(tree)).toContain("npm install openclaw@2026.7.2");
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
          // The server flags dev-build failures as repair-applicable.
          repairApplicable: true,
        },
      },
    });

    const text = treeText(tree);
    expect(text).toContain("build failed: tsc exited 2");
    expect(text).toContain("Check the raw log for the first TypeScript error.");
    // A failed op explains the recovery path (D3): with no target/repair
    // props on this view the re-stage caption is shown (the interactive
    // re-stage/repair buttons are covered in the hook + repair suites).
    expect(text).toContain("Re-staging downloads and installs");
  });

  it("hides the repair caption when the failure is not repair-applicable", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      operation: {
        label: "2026.7.2",
        startedAt: kNow - 60_000,
        steps: [{ name: "backup", status: "failed", at: kNow - 5_000 }],
        output: "",
        lastOutputAt: null,
        phase: "failed",
        error: {
          message: "backup failed: disk full",
          hint: null,
          code: "backup_failed",
          docsUrl: null,
        },
      },
    });

    const text = treeText(tree);
    expect(text).toContain("backup failed: disk full");
    expect(text).not.toContain("Repair (run");
  });

  it("freezes the elapsed counter at finishedAt once the operation fails (#9)", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      operation: {
        label: "latest dev (main HEAD)",
        startedAt: kNow - 100_000,
        finishedAt: kNow - 63_000,
        steps: [{ name: "build", status: "failed", at: kNow - 63_000 }],
        output: "",
        lastOutputAt: null,
        phase: "failed",
        error: {
          message: "build failed: tsc exited 2",
          hint: null,
          code: "build_failed",
          docsUrl: null,
          repairApplicable: true,
        },
      },
    });

    const text = treeText(tree);
    expect(text).toContain("37s");
    expect(text).not.toContain("1m 40s");
  });

  describe("WhatsNewCard (2.1)", () => {
    const kWhatsNew = {
      minor: "2026.8",
      channel: "beta",
      lastVerifiedVersion: "2026.8.1-beta.3",
      channelLatest: "2026.8.1-beta.3",
      newerThanVerified: false,
      highlights: [
        { title: "Team access", body: "Profiles and per-member permissions.", tone: "info" },
      ],
      securityFlips: [
        {
          key: "gateway.terminal.enabled",
          from: "off",
          to: "on",
          warning: "The dashboard gains a host terminal by default.",
        },
      ],
    };

    it("renders security flips ABOVE highlights for the active channel", () => {
      const tree = renderView({
        channelInfo: makeChannelInfo({ releaseChannel: "beta" }),
        activeChannel: "beta",
        catalog: makeCatalog(),
        whatsNew: kWhatsNew,
      });
      const text = treeText(tree);
      expect(text.replace(/\s+/g, " ")).toContain("What's new in 2026.8 ( beta )");
      expect(text).toContain("Security changes to review");
      expect(text).toContain("gateway.terminal.enabled");
      expect(text).toContain("Team access");
      // Hierarchy: the security section precedes the highlights (D5).
      expect(text.indexOf("Security changes to review")).toBeLessThan(
        text.indexOf("Team access"),
      );
    });

    it("hides the card when browsing a different channel or with no entry", () => {
      const stableText = treeText(
        renderView({
          channelInfo: makeChannelInfo(),
          activeChannel: "stable",
          catalog: makeCatalog(),
          whatsNew: kWhatsNew, // beta entry, stable view
        }),
      );
      expect(stableText.replace(/\s+/g, " ")).not.toContain("What's new in 2026.8");
      const noneText = treeText(
        renderView({
          channelInfo: makeChannelInfo(),
          catalog: makeCatalog(),
          whatsNew: null,
        }),
      );
      expect(noneText).not.toContain("Security changes to review");
    });

    it("notes when the channel has moved past the verified version", () => {
      const text = treeText(
        renderView({
          channelInfo: makeChannelInfo({ releaseChannel: "beta" }),
          activeChannel: "beta",
          catalog: makeCatalog(),
          whatsNew: {
            ...kWhatsNew,
            channelLatest: "2026.8.1-beta.9",
            newerThanVerified: true,
          },
        }),
      );
      expect(text.replace(/\s+/g, " ")).toContain("tested with 2026.8.1-beta.3");
    });

    it("renders the flips as an amber block inside the apply confirm dialog (D5)", () => {
      const tree = renderView({
        channelInfo: makeChannelInfo(),
        catalog: makeCatalog(),
        pendingApply: {
          payload: { channel: "beta", version: "2026.8.1-beta.3" },
          label: "2026.8.1-beta.3",
          isDowngrade: false,
          confirm: {
            title: "Switch to 2026.8.1-beta.3?",
            tone: "primary",
            confirmLabel: "Apply",
            lines: ["Impact: ~2 min.", "Backup included."],
            isDowngrade: false,
            isBreaking: true,
            steps: ["Backup", "Download", "Verify"],
            securityFlips: kWhatsNew.securityFlips,
          },
        },
      });
      const text = treeText(tree);
      expect(text).toContain("Security changes to review");
      expect(text).toContain("gateway.terminal.enabled");
      expect(text).toContain("The dashboard gains a host terminal by default.");
      // The security block precedes the "What happens next" step list.
      expect(text.indexOf("Security changes to review")).toBeLessThan(
        text.indexOf("What happens next:"),
      );
    });
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
    // The mount loads go through the module-level SWR cache — drop entries a
    // previous test seeded so every test observes its own mocked responses.
    invalidateCache("/api/openclaw/channel");
    invalidateCache("/api/openclaw/catalog");
    api.fetchOpenclawChannel.mockResolvedValue(makeChannelInfo());
    api.fetchOpenclawCatalog.mockResolvedValue({
      ok: true,
      catalog: makeCatalog(),
      channel: { releaseChannel: "stable" },
    });
    api.fetchOpenclawRuns.mockResolvedValue({ ok: true, runs: [] });
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

  it("a segment change persists IMMEDIATELY via PUT — no dialog, nothing installs (U1)", async () => {
    let state = await hydrate();

    await state.onSelectChannel("beta");

    expect(api.updateOpenclawReleaseChannel).toHaveBeenCalledWith("beta");
    expect(api.applyOpenclawVersion).not.toHaveBeenCalled();
    state = renderHook({});
    expect(state.activeChannel).toBe("beta");
    expect(state.channelSaveError).toBeNull();
    expect(state.savingChannel).toBe(false);
  });

  // REGRESSION (2.1): whatsNew is channel-scoped and rides the catalog
  // payload — a same-session switch must reload it so the WhatsNewCard and the
  // apply dialog's security-flips block reflect the NEW channel, not the old.
  it("reloads the whats-new catalog after a channel switch so flips refresh", async () => {
    api.fetchOpenclawCatalog
      .mockResolvedValueOnce({
        ok: true,
        catalog: makeCatalog(),
        channel: { releaseChannel: "stable" },
        whatsNew: { channel: "stable", securityFlips: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        catalog: makeCatalog(),
        channel: { releaseChannel: "beta" },
        whatsNew: {
          channel: "beta",
          securityFlips: [{ key: "gateway.terminal.enabled" }],
        },
      });

    let state = await hydrate();
    expect(api.fetchOpenclawCatalog).toHaveBeenCalledTimes(1);

    await state.onSelectChannel("beta");

    // The switch triggered a second catalog read (no forced refresh).
    expect(api.fetchOpenclawCatalog).toHaveBeenCalledTimes(2);
    expect(api.fetchOpenclawCatalog).toHaveBeenLastCalledWith({
      refresh: false,
    });

    state = renderHook({});
    expect(state.whatsNew).toEqual({
      channel: "beta",
      securityFlips: [{ key: "gateway.terminal.enabled" }],
    });
  });

  it("selecting the already-active channel does not PUT", async () => {
    let state = await hydrate();

    await state.onSelectChannel("stable");

    expect(api.updateOpenclawReleaseChannel).not.toHaveBeenCalled();
  });

  it("a successful channel save refreshes the shared /api/status consumers; a failed one does not", async () => {
    const onRefreshStatuses = vi.fn();
    let state = await hydrate({ onRefreshStatuses });

    await state.onSelectChannel("beta");
    // The sidebar footer reads the shared status channel — it must update
    // immediately, not on the next poll tick.
    expect(onRefreshStatuses).toHaveBeenCalled();

    onRefreshStatuses.mockClear();
    api.updateOpenclawReleaseChannel.mockRejectedValue(new Error("nope"));
    state = renderHook({ onRefreshStatuses });
    await state.onSelectChannel("stable");
    expect(onRefreshStatuses).not.toHaveBeenCalled();
  });

  it("onDismissOperation revives a dead page: operation cleared, stream stopped, data reloaded", async () => {
    const unsubscribe = vi.fn();
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return unsubscribe;
    });
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      operationId: "op-dead",
      events: "/api/operations/op-dead/events",
    });
    let state = await hydrate();
    state.onRequestApply({ payload: { version: "x" }, label: "x" });
    state = renderHook({});
    await state.onConfirmApply();
    state = renderHook({});
    expect(state.operation).toBeTruthy();
    expect(state.actionsDisabled).toBe(true);

    // Dismiss clears only FAILED operations (a running apply must never be
    // cleared out from under the user) — fail it via the stream first.
    captured.onMessage({ event: "error", data: { error: "boom" } });
    state = renderHook({});
    expect(state.operation.phase).toBe("failed");

    api.fetchOpenclawChannel.mockClear();
    api.fetchOpenclawRuns.mockClear();
    state.onDismissOperation();
    await flushAsync();
    state = renderHook({});
    expect(state.operation).toBeNull();
    expect(state.logOpen).toBe(false);
    expect(state.actionsDisabled).toBe(false); // every control re-enables
    expect(unsubscribe).toHaveBeenCalled();
    expect(api.fetchOpenclawChannel).toHaveBeenCalled();
    expect(api.fetchOpenclawRuns).toHaveBeenCalled();
  });

  it("actionsDisabled covers blocklist clears and catalog refreshes in flight", async () => {
    let resolveClear;
    api.clearOpenclawBlocklist.mockImplementation(
      () => new Promise((resolve) => (resolveClear = resolve)),
    );
    let state = await hydrate();
    expect(state.actionsDisabled).toBe(false);

    const clearing = state.onClearBlocklist("v1");
    state = renderHook({});
    expect(state.actionsDisabled).toBe(true); // a reload race window is open
    resolveClear({ ok: true, blocklist: [] });
    await clearing;
    state = renderHook({});
    expect(state.actionsDisabled).toBe(false);

    let resolveCatalog;
    api.fetchOpenclawCatalog.mockImplementation(
      () => new Promise((resolve) => (resolveCatalog = resolve)),
    );
    state.onCheckNow();
    state = renderHook({});
    expect(state.actionsDisabled).toBe(true);
    resolveCatalog({ ok: true, catalog: makeCatalog() });
    await flushAsync();
    state = renderHook({});
    expect(state.actionsDisabled).toBe(false);
  });

  // REGRESSION: a failed persist must revert the selection LOUDLY — the
  // persistent inline error chip state is set and the segment snaps back with
  // an explanation, never silently.
  it("a failed channel save reverts the selection and raises the error-chip state", async () => {
    api.updateOpenclawReleaseChannel.mockRejectedValue(
      Object.assign(new Error("disk full"), {
        code: "config_write_failed",
        hint: "Check disk space on the data volume.",
      }),
    );
    let state = await hydrate();

    await state.onSelectChannel("beta");

    state = renderHook({});
    expect(state.activeChannel).toBe("stable");
    expect(state.savingChannel).toBe(false);
    expect(state.channelSaveError).toEqual(
      expect.objectContaining({
        attempted: "beta",
        activeChannel: "stable",
        message: "Couldn't switch to beta — still on stable.",
        detail: "disk full",
        hint: "Check disk space on the data volume.",
      }),
    );

    // The chip is persistent until dismissed (not a toast).
    state.onDismissChannelSaveError();
    state = renderHook({});
    expect(state.channelSaveError).toBeNull();

    // A later successful save clears the error state on its own.
    api.updateOpenclawReleaseChannel.mockResolvedValue({ ok: true });
    await state.onSelectChannel("beta");
    state = renderHook({});
    expect(state.activeChannel).toBe("beta");
    expect(state.channelSaveError).toBeNull();
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

  it("passes curated security flips into the apply confirm when the target crosses into beta (D5)", async () => {
    const kFlips = [
      {
        key: "gateway.terminal.enabled",
        from: "off",
        to: "on",
        warning: "The dashboard gains a host terminal by default.",
      },
    ];
    api.fetchOpenclawCatalog.mockResolvedValue({
      ok: true,
      catalog: makeCatalog(),
      whatsNew: { minor: "2026.8", channel: "beta", securityFlips: kFlips },
      channel: { releaseChannel: "stable" },
    });
    let state = await hydrate();
    expect(state.whatsNew).toEqual(
      expect.objectContaining({ channel: "beta" }),
    );

    // stable → beta: the flips ride along into the confirm model.
    state.onRequestApply({
      payload: { channel: "beta", version: "2026.7.3-beta.1" },
      label: "2026.7.3-beta.1",
    });
    state = renderHook({});
    expect(state.pendingApply.confirm.securityFlips).toEqual(kFlips);

    // stable → stable: no channel crossing, no flips.
    state.onCancelApply();
    state = renderHook({});
    state.onRequestApply({
      payload: { channel: "stable", version: "2026.7.2" },
      label: "2026.7.2",
    });
    state = renderHook({});
    expect(state.pendingApply.confirm.securityFlips).toEqual([]);

    // beta → beta: already running the channel, the flips already happened.
    harness.reset();
    // harness.reset() clears hook state but not the module-level api-cache;
    // drop the cached stable channel/catalog so the fresh beta mocks below win.
    invalidateCache("/api/openclaw/channel");
    invalidateCache("/api/openclaw/catalog");
    api.fetchOpenclawChannel.mockResolvedValue(
      makeChannelInfo({
        releaseChannel: "beta",
        applied: { channel: "beta", version: "2026.7.3-beta.1" },
        isPin: false,
      }),
    );
    state = await hydrate();
    state.onRequestApply({
      payload: { channel: "beta", version: "2026.7.3-beta.1" },
      label: "2026.7.3-beta.1",
    });
    state = renderHook({});
    expect(state.pendingApply.confirm.securityFlips).toEqual([]);
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
      data: {
        error: "build failed: tsc exited 2",
        finishedAt: kNow - 1_000,
        repairApplicable: true,
      },
    });

    state = renderHook({});
    expect(state.operation.phase).toBe("failed");
    expect(state.operation.error.message).toBe("build failed: tsc exited 2");
    // The server stamps failure time; the elapsed counter freezes on it (#9).
    expect(typeof state.operation.finishedAt).toBe("number");
    expect(state.operation.finishedAt).toBe(kNow - 1_000);
    expect(state.operation.error.repairApplicable).toBe(true);
  });

  it("stamps a local finishedAt when the error event omits one", async () => {
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return () => {};
    });
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      operationId: "op-4b",
      events: "/api/operations/op-4b/events",
    });
    let state = await hydrate();
    state.onRequestApply({
      payload: { channel: "stable", version: "2026.7.2" },
      label: "2026.7.2",
    });
    state = renderHook({});
    await state.onConfirmApply();

    captured.onMessage({
      event: "error",
      data: { error: "backup failed: disk full" },
    });

    state = renderHook({});
    expect(state.operation.phase).toBe("failed");
    expect(typeof state.operation.finishedAt).toBe("number");
    expect(state.operation.error.repairApplicable).toBe(false);
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

  it("a 409 rollback fence opens the data-risk dialog naming the backup — never the error chip (#20)", async () => {
    const fenceError = Object.assign(
      new Error(
        "This update migrated your state databases — the rollback target may not be able to read them.",
      ),
      {
        code: "rollback_requires_confirmation",
        status: 409,
        backupFile: "backup-2026-08-29.tar.gz",
      },
    );
    api.rollbackOpenclaw.mockRejectedValueOnce(fenceError);
    api.rollbackOpenclaw.mockResolvedValueOnce({ ok: true, target: { kind: "pin" } });
    let state = await hydrate();
    state.onRequestRollback();
    state = renderHook({});

    await state.onRollback();
    expect(api.rollbackOpenclaw).toHaveBeenCalledWith({});

    state = renderHook({});
    // The fence is a consent gate, not a failure: no chip, no operation.
    expect(state.actionError).toBeNull();
    expect(state.operation).toBeNull();
    expect(state.rollingBack).toBe(false);
    expect(state.rollbackDataRisk).toEqual({
      message:
        "This update migrated your state databases — the rollback target may not be able to read them.",
      backupFile: "backup-2026-08-29.tar.gz",
    });

    // Confirming re-sends the rollback WITH consent and hands off to the
    // restart poller like a first-attempt success.
    await state.onConfirmRollbackDataRisk();
    expect(api.rollbackOpenclaw).toHaveBeenCalledTimes(2);
    expect(api.rollbackOpenclaw).toHaveBeenLastCalledWith({
      confirmDataRisk: true,
    });
    state = renderHook({});
    expect(state.rollbackDataRisk).toBeNull();
    expect(state.operation).toEqual(
      expect.objectContaining({ phase: "restarting", label: "2026.7.1-2" }),
    );
  });

  it("cancelling the data-risk dialog closes it without re-calling the API", async () => {
    api.rollbackOpenclaw.mockRejectedValue(
      Object.assign(new Error("migrated"), {
        code: "rollback_requires_confirmation",
        status: 409,
        backupFile: null,
      }),
    );
    let state = await hydrate();
    state.onRequestRollback();
    state = renderHook({});
    await state.onRollback();
    state = renderHook({});
    expect(state.rollbackDataRisk).toEqual({
      message: "migrated",
      backupFile: null,
    });

    state.onCancelRollbackDataRisk();
    state = renderHook({});
    expect(state.rollbackDataRisk).toBeNull();
    expect(api.rollbackOpenclaw).toHaveBeenCalledTimes(1);
    expect(state.operation).toBeNull();
  });

  it("surfaces a rejected rollback as a persistent inline action error (never toast-only)", async () => {
    const envelopeError = Object.assign(
      new Error("no rollback target available"),
      { code: "rollback_unavailable", hint: "Clear the blocklist first." },
    );
    api.rollbackOpenclaw.mockRejectedValue(envelopeError);
    let state = await hydrate();
    state.onRequestRollback();
    state = renderHook({});

    await state.onRollback();

    state = renderHook({});
    expect(state.actionError).toEqual({
      headline: "Couldn't roll back OpenClaw.",
      error: envelopeError,
    });
    expect(showToast).not.toHaveBeenCalledWith(
      "no rollback target available",
      "error",
    );
    expect(state.operation).toBeNull();
    expect(state.rollingBack).toBe(false);

    state.onDismissActionError();
    state = renderHook({});
    expect(state.actionError).toBeNull();
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

  it("paints a fresh-cached channel + catalog instantly without refetching (M4)", async () => {
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(kNow);
    setCached("/api/openclaw/channel", makeChannelInfo({ releaseChannel: "beta" }));
    setCached("/api/openclaw/catalog", { ok: true, catalog: makeCatalog() });
    nowSpy.mockReturnValue(kNow + 1_000);

    const state = await hydrate();

    // Back-navigation inside the cache window: no network calls at all.
    expect(api.fetchOpenclawChannel).not.toHaveBeenCalled();
    expect(api.fetchOpenclawCatalog).not.toHaveBeenCalled();
    expect(state.channelInfo.releaseChannel).toBe("beta");
    expect(state.catalog).toEqual(makeCatalog());
    expect(state.loadingChannel).toBe(false);
    expect(state.loadingCatalog).toBe(false);
  });

  it("serves a stale-cached channel instantly, then applies the revalidated result (M4)", async () => {
    const staleChannel = makeChannelInfo({ installedVersion: "2026.7.0" });
    const freshChannel = makeChannelInfo({ installedVersion: "2026.7.1-2" });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(kNow);
    setCached("/api/openclaw/channel", staleChannel);
    setCached("/api/openclaw/catalog", { ok: true, catalog: makeCatalog() });
    nowSpy.mockReturnValue(kNow + 61_000); // past the 60s maxAge → SWR path

    let resolveFreshChannel;
    api.fetchOpenclawChannel.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFreshChannel = resolve;
        }),
    );

    let state = await hydrate();

    // Instant paint from the stale entry while the revalidation is in flight.
    expect(state.channelInfo.installedVersion).toBe("2026.7.0");
    expect(state.loadingChannel).toBe(false);
    expect(api.fetchOpenclawChannel).toHaveBeenCalledTimes(1);

    resolveFreshChannel(freshChannel);
    await flushAsync();
    state = renderHook({});
    expect(state.channelInfo.installedVersion).toBe("2026.7.1-2");
  });

  it("a late SWR revalidation never clobbers a fresher mutation result (mutation-stamp guard)", async () => {
    const staleChannel = makeChannelInfo({
      blocklist: [{ id: "stable:2026.7.2", reason: "crash loop" }],
    });
    const freshChannel = makeChannelInfo({ blocklist: [] });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(kNow);
    setCached("/api/openclaw/channel", staleChannel);
    setCached("/api/openclaw/catalog", { ok: true, catalog: makeCatalog() });
    nowSpy.mockReturnValue(kNow + 61_000); // past the 60s maxAge → SWR path

    // The mount revalidation stalls in flight; the mutation reload resolves
    // before it.
    let resolveRevalidation;
    api.fetchOpenclawChannel
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRevalidation = resolve;
          }),
      )
      .mockResolvedValueOnce(freshChannel);
    api.markOpenclawGood.mockResolvedValue({ ok: true });

    let state = await hydrate();
    expect(state.channelInfo.blocklist).toHaveLength(1);

    // A mutation completes while the revalidation is still in flight.
    await state.onMarkGood();
    state = renderHook({});
    expect(state.channelInfo.blocklist).toEqual([]);

    // The pre-mutation revalidation resolves late: it must neither overwrite
    // the fresher state nor leave its stale payload re-stamped as "fresh" in
    // the shared cache (which would resurrect it for the next mount).
    resolveRevalidation(staleChannel);
    await flushAsync();
    state = renderHook({});
    expect(state.channelInfo.blocklist).toEqual([]);
    expect(getCached("/api/openclaw/channel")).not.toEqual(staleChannel);
  });

  it("clearing a blocklist entry supersedes an in-flight revalidation and drops the cached channel payload", async () => {
    const staleChannel = makeChannelInfo({
      blocklist: [{ id: "stable:2026.7.2", reason: "crash loop" }],
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(kNow);
    setCached("/api/openclaw/channel", staleChannel);
    setCached("/api/openclaw/catalog", { ok: true, catalog: makeCatalog() });
    nowSpy.mockReturnValue(kNow + 61_000);

    let resolveRevalidation;
    api.fetchOpenclawChannel.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRevalidation = resolve;
        }),
    );
    api.clearOpenclawBlocklist.mockResolvedValue({ ok: true, blocklist: [] });

    let state = await hydrate();
    expect(state.channelInfo.blocklist).toHaveLength(1);

    await state.onClearBlocklist("stable:2026.7.2");
    state = renderHook({});
    expect(state.channelInfo.blocklist).toEqual([]);

    // The pre-clear revalidation resolves late: the cleared row must not be
    // resurrected — not in state, and not via the cache on the next mount.
    resolveRevalidation(staleChannel);
    await flushAsync();
    state = renderHook({});
    expect(state.channelInfo.blocklist).toEqual([]);
    expect(getCached("/api/openclaw/channel")).not.toEqual(staleChannel);
  });

  it("serves a stale-cached catalog instantly, then applies the revalidated result (M4)", async () => {
    const staleCatalog = makeCatalog({ distTags: { latest: "2026.7.1-2" } });
    const freshCatalog = makeCatalog({ distTags: { latest: "2026.7.2" } });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(kNow);
    setCached("/api/openclaw/channel", makeChannelInfo());
    setCached("/api/openclaw/catalog", { ok: true, catalog: staleCatalog });
    nowSpy.mockReturnValue(kNow + 61_000);

    let resolveFreshCatalog;
    api.fetchOpenclawCatalog.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFreshCatalog = resolve;
        }),
    );

    let state = await hydrate();

    expect(state.catalog.distTags.latest).toBe("2026.7.1-2");
    expect(state.loadingCatalog).toBe(false);
    expect(api.fetchOpenclawCatalog).toHaveBeenCalledTimes(1);
    // Mount revalidation never force-bypasses the server catalog cache.
    expect(api.fetchOpenclawCatalog).toHaveBeenCalledWith({ refresh: false });

    resolveFreshCatalog({ ok: true, catalog: freshCatalog });
    await flushAsync();
    state = renderHook({});
    expect(state.catalog.distTags.latest).toBe("2026.7.2");
  });

  it("Check now bypasses the client cache and re-seeds it (M4)", async () => {
    let state = await hydrate();
    expect(api.fetchOpenclawCatalog).toHaveBeenCalledTimes(1);

    state.onCheckNow();
    await flushAsync();

    // refresh:true always hits the network, never the SWR cache.
    expect(api.fetchOpenclawCatalog).toHaveBeenCalledTimes(2);
    expect(api.fetchOpenclawCatalog).toHaveBeenLastCalledWith({ refresh: true });
    // ...and the result re-seeds the cache for the next mount.
    expect(getCached("/api/openclaw/catalog")).toEqual({
      ok: true,
      catalog: makeCatalog(),
      channel: { releaseChannel: "stable" },
    });
  });

  it("loads the recent-runs timeline on mount", async () => {
    api.fetchOpenclawRuns.mockResolvedValue({
      ok: true,
      runs: [
        {
          operationId: "0b1c2d3e-0000-4000-8000-000000000001",
          target: { channel: "stable", version: "2026.7.2" },
          state: "activated",
          startedAt: kNow - 3_700_000,
          finishedAt: kNow - 3_600_000,
          hasLog: true,
        },
      ],
    });
    const state = await hydrate();

    expect(api.fetchOpenclawRuns).toHaveBeenCalledTimes(1);
    expect(state.runs).toEqual([
      expect.objectContaining({
        operationId: "0b1c2d3e-0000-4000-8000-000000000001",
        state: "activated",
      }),
    ]);
  });

  it("fetches the durable run log — works for finished runs, not just live SSE", async () => {
    api.fetchOpenclawRunLogText.mockResolvedValue("npm install\nverified\n");
    let state = await hydrate();

    await state.onViewRunLog("0b1c2d3e-0000-4000-8000-000000000001");

    expect(api.fetchOpenclawRunLogText).toHaveBeenCalledWith(
      "0b1c2d3e-0000-4000-8000-000000000001",
    );
    state = renderHook({});
    expect(state.runLog).toEqual({
      operationId: "0b1c2d3e-0000-4000-8000-000000000001",
      loading: false,
      text: "npm install\nverified\n",
      error: null,
    });

    state.onCloseRunLog();
    state = renderHook({});
    expect(state.runLog).toBeNull();
  });

  it("keeps the envelope when the run log is missing (404)", async () => {
    api.fetchOpenclawRunLogText.mockRejectedValue(
      Object.assign(new Error("No log recorded for this run."), {
        code: "log_not_found",
      }),
    );
    let state = await hydrate();

    await state.onViewRunLog("0b1c2d3e-0000-4000-8000-000000000002");

    state = renderHook({});
    expect(state.runLog.error).toEqual(
      expect.objectContaining({
        message: "No log recorded for this run.",
        code: "log_not_found",
      }),
    );
  });

  it("the restart handoff publishes upgradeRestartActive to the shell store; cleanup clears it (M3.4 global banner)", async () => {
    gatewayShellStore.reset();
    try {
      // No operationId/events in the apply result: the quick synchronous
      // success path hands off to the restart phase immediately.
      api.applyOpenclawVersion.mockResolvedValue({ ok: true });
      let state = await hydrate();
      expect(gatewayShellStore.get().upgradeRestartActive).toBe(false);

      state.onRequestApply({
        payload: { channel: "stable", version: "2026.7.2" },
        label: "2026.7.2",
        isDowngrade: false,
      });
      state = renderHook({});
      await state.onConfirmApply();
      state = renderHook({});
      expect(state.operation?.phase).toBe("restarting");

      // Effect #3 in hook declaration order is the upgradeRestartActive
      // publish (mount load, rehydration, and the elapsed tick precede it).
      const cleanup = harness.effects[3]();
      expect(gatewayShellStore.get().upgradeRestartActive).toBe(true);

      // Unmount (or leaving the restarting phase) clears the announcement —
      // the global banner must never stick after the handoff ends.
      cleanup();
      expect(gatewayShellStore.get().upgradeRestartActive).toBe(false);
    } finally {
      gatewayShellStore.reset();
    }
  });
});

describe("frontend/upgrade-tab repair (2.3)", () => {
  const flushAsync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const renderHook = (props = {}) => {
    harness.beginRender();
    return useUpgradeTab(props);
  };

  const hydrate = async (props = {}) => {
    let state = renderHook(props);
    harness.effects[0]();
    await flushAsync();
    state = renderHook(props);
    return state;
  };

  const makeFailedOperation = (overrides = {}) => ({
    operationId: "op-9",
    resumed: false,
    target: { channel: "beta", version: "2026.8.1-beta.3" },
    label: "2026.8.1-beta.3",
    startedAt: kNow - 60_000,
    steps: [{ name: "activate", status: "failed", at: kNow - 5_000 }],
    output: "raw log",
    lastOutputAt: null,
    phase: "failed",
    error: {
      message: "activation failed",
      hint: null,
      code: "activate_failed",
      docsUrl: null,
    },
    ...overrides,
  });

  beforeEach(() => {
    harness.reset();
    // Drop the module-level api-cache so each case's fresh channel/catalog
    // mocks win instead of a prior test's cached (dev/beta) payload.
    invalidateCache("/api/openclaw/channel");
    invalidateCache("/api/openclaw/catalog");
    api.fetchOpenclawChannel.mockResolvedValue(makeChannelInfo());
    api.fetchOpenclawCatalog.mockResolvedValue({
      ok: true,
      catalog: makeCatalog(),
      channel: { releaseChannel: "stable" },
    });
    api.fetchOpenclawRuns.mockResolvedValue({ ok: true, runs: [] });
    api.subscribeOpenclawApplyEvents.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("offers Run repair on a failed operation when the dev checkout is active (D3)", () => {
    const onRunRepair = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo({ releaseChannel: "dev" }),
      catalog: makeCatalog(),
      repairAvailable: true,
      onRunRepair,
      operation: makeFailedOperation({
        target: { channel: "dev", devHead: true },
        label: "latest dev (main HEAD)",
      }),
    });
    const button = findActionButtonByLabel(tree, "Run repair");
    expect(button).toBeTruthy();
    button.props.onClick();
    expect(onRunRepair).toHaveBeenCalledTimes(1);
    // D3: one primary recovery action per failure state.
    expect(findActionButtonByLabel(tree, "Re-stage version")).toBeFalsy();
    expect(treeText(tree)).toContain("Repair:");
  });

  it("offers Re-stage version instead on package channels (D3/E-C7)", () => {
    const onRetryApply = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      repairAvailable: false,
      onRetryApply,
      operation: makeFailedOperation(),
    });
    const button = findActionButtonByLabel(tree, "Re-stage version");
    expect(button).toBeTruthy();
    button.props.onClick();
    expect(onRetryApply).toHaveBeenCalledTimes(1);
    expect(findActionButtonByLabel(tree, "Run repair")).toBeFalsy();
    expect(treeText(tree)).toContain("Re-staging downloads and installs");
  });

  it("a failed operation card can be dismissed", () => {
    const onDismissOperation = vi.fn();
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      onDismissOperation,
      operation: makeFailedOperation(),
    });
    const button = findButtonByText(tree, "Dismiss");
    expect(button).toBeTruthy();
    button.props.onclick();
    expect(onDismissOperation).toHaveBeenCalledTimes(1);
  });

  it("labels a repair operation as a repair, not an update", () => {
    const running = renderView({
      channelInfo: makeChannelInfo({ releaseChannel: "dev" }),
      catalog: makeCatalog(),
      operation: makeFailedOperation({
        target: { repair: true },
        label: "repair",
        phase: "running",
        error: null,
      }),
    });
    expect(treeText(running)).toContain("Repairing the dev build");

    const failed = renderView({
      channelInfo: makeChannelInfo({ releaseChannel: "dev" }),
      catalog: makeCatalog(),
      repairAvailable: true,
      operation: makeFailedOperation({ target: { repair: true }, label: "repair" }),
    });
    expect(treeText(failed)).toContain("Repair failed");
  });

  it("onRunRepair streams the repair and clears the card on done (no restart poll)", async () => {
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return () => {};
    });
    api.runOpenclawRepair.mockResolvedValue({
      ok: true,
      operationId: "op-r1",
      events: "/api/operations/op-r1/events",
    });
    let state = await hydrate();

    await state.onRunRepair();
    state = renderHook({});
    expect(state.operation).toEqual(
      expect.objectContaining({ operationId: "op-r1", phase: "running" }),
    );
    expect(state.operation.target).toEqual({ repair: true });

    captured.onMessage({ event: "done", data: {} });
    state = renderHook({});
    expect(state.operation).toBeNull();
    expect(showToast).toHaveBeenCalledWith("Repair completed", "success");
  });

  it("surfaces the repair_not_applicable envelope as an apply error (E-C7)", async () => {
    api.runOpenclawRepair.mockRejectedValue(
      Object.assign(new Error("Repair only applies to dev builds from source."), {
        code: "repair_not_applicable",
        hint: "For stable or beta, re-apply the version from the catalog instead.",
      }),
    );
    let state = await hydrate();

    await state.onRunRepair();
    state = renderHook({});
    expect(state.operation).toBeNull();
    expect(state.applyError).toEqual(
      expect.objectContaining({
        message: "Repair only applies to dev builds from source.",
        hint: "For stable or beta, re-apply the version from the catalog instead.",
      }),
    );
  });

  it("marks the repair operation failed on a streamed error event", async () => {
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return () => {};
    });
    api.runOpenclawRepair.mockResolvedValue({
      ok: true,
      operationId: "op-r2",
      events: "/api/operations/op-r2/events",
    });
    let state = await hydrate();
    await state.onRunRepair();

    captured.onMessage({
      event: "error",
      data: { error: "OpenClaw repair did not complete.", code: "repair_failed" },
    });
    state = renderHook({});
    expect(state.operation.phase).toBe("failed");
    expect(state.operation.error.message).toBe("OpenClaw repair did not complete.");
  });

  it("onRetryApply re-applies the failed operation's own target", async () => {
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return () => {};
    });
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      operationId: "op-a1",
      events: "/api/operations/op-a1/events",
    });
    let state = await hydrate();
    state.onRequestApply({
      payload: { channel: "beta", version: "2026.7.3-beta.1" },
      label: "2026.7.3-beta.1",
    });
    state = renderHook({});
    await state.onConfirmApply();
    captured.onMessage({
      event: "error",
      data: { error: "activation failed" },
    });
    state = renderHook({});
    expect(state.operation.phase).toBe("failed");

    api.applyOpenclawVersion.mockClear();
    await state.onRetryApply();
    expect(api.applyOpenclawVersion).toHaveBeenCalledWith({
      channel: "beta",
      version: "2026.7.3-beta.1",
    });
  });

  it("onDismissOperation clears only a FAILED operation", async () => {
    let captured = null;
    api.subscribeOpenclawApplyEvents.mockImplementation((options) => {
      captured = options;
      return () => {};
    });
    api.applyOpenclawVersion.mockResolvedValue({
      ok: true,
      operationId: "op-a2",
      events: "/api/operations/op-a2/events",
    });
    let state = await hydrate();
    state.onRequestApply({
      payload: { channel: "stable", version: "2026.7.2" },
      label: "2026.7.2",
    });
    state = renderHook({});
    await state.onConfirmApply();

    // Running: dismiss is a no-op.
    state = renderHook({});
    state.onDismissOperation();
    state = renderHook({});
    expect(state.operation).not.toBeNull();

    captured.onMessage({ event: "error", data: { error: "boom" } });
    state = renderHook({});
    state.onDismissOperation();
    state = renderHook({});
    expect(state.operation).toBeNull();
  });

  it("repairAvailable follows the dev channel/applied state", async () => {
    api.fetchOpenclawChannel.mockResolvedValue(
      makeChannelInfo({ releaseChannel: "dev" }),
    );
    let state = await hydrate();
    expect(state.repairAvailable).toBe(true);

    harness.reset();
    invalidateCache("/api/openclaw/channel");
    api.fetchOpenclawChannel.mockResolvedValue(makeChannelInfo());
    state = await hydrate();
    expect(state.repairAvailable).toBe(false);

    harness.reset();
    invalidateCache("/api/openclaw/channel");
    api.fetchOpenclawChannel.mockResolvedValue(
      makeChannelInfo({ applied: { channel: "dev", sha: "abc1234" } }),
    );
    state = await hydrate();
    expect(state.repairAvailable).toBe(true);
  });
});

describe("frontend/upgrade-tab gateway-hold recovery", () => {
  const flushAsync = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  const renderHook = (props = {}) => {
    harness.beginRender();
    return useUpgradeTab(props);
  };

  const hydrate = async (props = {}) => {
    let state = renderHook(props);
    harness.effects[0]();
    await flushAsync();
    state = renderHook(props);
    return state;
  };

  beforeEach(() => {
    harness.reset();
    // Drop the module-level api-cache so each case's fresh channel/catalog
    // mocks win instead of a prior test's cached (dev/beta) payload.
    invalidateCache("/api/openclaw/channel");
    invalidateCache("/api/openclaw/catalog");
    api.fetchOpenclawChannel.mockResolvedValue(makeChannelInfo());
    api.fetchOpenclawCatalog.mockResolvedValue({
      ok: true,
      catalog: makeCatalog(),
      channel: { releaseChannel: "stable" },
    });
    api.fetchOpenclawRuns.mockResolvedValue({ ok: true, runs: [] });
    api.subscribeOpenclawApplyEvents.mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("Retry migration calls the reconcile api and reloads the channel on success", async () => {
    const onRefreshStatuses = vi.fn();
    api.retryOpenclawReconcile.mockResolvedValue({
      ok: true,
      outcome: { status: "ok" },
    });
    let state = await hydrate({ onRefreshStatuses });
    api.fetchOpenclawChannel.mockClear();
    onRefreshStatuses.mockClear();

    await state.onRetryReconcile();

    expect(api.retryOpenclawReconcile).toHaveBeenCalledWith({});
    // The hold lives on the channel payload — success re-reads it and
    // refreshes the shared /api/status consumers (matches onMarkGood).
    expect(api.fetchOpenclawChannel).toHaveBeenCalled();
    expect(onRefreshStatuses).toHaveBeenCalled();
    state = renderHook({ onRefreshStatuses });
    expect(state.retryingReconcile).toBeNull();
    expect(state.reconcileError).toBeNull();
  });

  it("the strip confirm consents with stripBlamedKeys: true — the prompt alone calls nothing", async () => {
    api.retryOpenclawReconcile.mockResolvedValue({
      ok: true,
      outcome: { status: "ok" },
    });
    let state = await hydrate();

    state.onRequestStripReconcile();
    state = renderHook({});
    expect(state.stripReconcilePrompt).toBe(true);
    expect(api.retryOpenclawReconcile).not.toHaveBeenCalled();

    // Cancel closes the prompt without consenting.
    state.onCancelStripReconcile();
    state = renderHook({});
    expect(state.stripReconcilePrompt).toBe(false);
    expect(api.retryOpenclawReconcile).not.toHaveBeenCalled();

    state.onRequestStripReconcile();
    state = renderHook({});
    await state.onConfirmStripReconcile();
    expect(api.retryOpenclawReconcile).toHaveBeenCalledWith({
      stripBlamedKeys: true,
    });
    state = renderHook({});
    expect(state.stripReconcilePrompt).toBe(false);
  });

  it("a 409 still-held response surfaces the fresh hold reason inline", async () => {
    api.retryOpenclawReconcile.mockRejectedValue(
      Object.assign(new Error("Could not retry the settings migration"), {
        code: "reconcile_still_held",
        status: 409,
        outcome: {
          status: "held",
          hold: {
            reason: "doctor exited 1 again",
            blamedKeys: ["gateway.oldKey"],
          },
        },
      }),
    );
    let state = await hydrate();

    await state.onRetryReconcile();

    state = renderHook({});
    expect(state.reconcileError).toEqual({
      headline: "Migration is still held: doctor exited 1 again",
      error: null,
    });
    expect(state.retryingReconcile).toBeNull();

    state.onDismissReconcileError();
    state = renderHook({});
    expect(state.reconcileError).toBeNull();
  });

  it("a non-409 retry failure keeps the error envelope for the inline chip", async () => {
    const err = Object.assign(new Error("network down"), {
      code: "reconcile_unavailable",
      status: 501,
    });
    api.retryOpenclawReconcile.mockRejectedValue(err);
    let state = await hydrate();

    await state.onRetryReconcile();

    state = renderHook({});
    expect(state.reconcileError).toEqual({
      headline: "Couldn't retry the settings migration.",
      error: err,
    });
  });

  it("the route's other 409 codes keep the SERVER message on the chip, never a bare generic string", async () => {
    // reconcile_skipped / reconcile_not_needed carry a server-set message and
    // hint — the hook must hand the whole error to the InlineErrorChip so
    // err.message renders under the headline.
    const err = Object.assign(
      new Error("The gateway is running and no hold is set."),
      {
        code: "reconcile_not_needed",
        hint: "Nothing to retry — the doctor never touches live databases.",
        status: 409,
      },
    );
    api.retryOpenclawReconcile.mockRejectedValue(err);
    let state = await hydrate();

    await state.onRetryReconcile();

    state = renderHook({});
    expect(state.reconcileError).toEqual({
      headline: "Couldn't retry the settings migration.",
      error: err,
    });
    expect(state.reconcileError.error.message).toBe(
      "The gateway is running and no hold is set.",
    );
  });

  it("a succeeded migration with a failed gateway relaunch is not a silent success", async () => {
    api.retryOpenclawReconcile.mockResolvedValue({
      ok: true,
      outcome: { status: "ok" },
      gatewayStart: { ok: false, error: "spawn ENOENT" },
    });
    let state = await hydrate();

    await state.onRetryReconcile();

    state = renderHook({});
    expect(state.reconcileError).toEqual({
      headline: "Settings migration succeeded, but the gateway failed to start.",
      error: { message: "spawn ENOENT" },
    });
  });

  it("retryingReconcile disables the page's actions while a retry is in flight", async () => {
    let resolveRetry;
    api.retryOpenclawReconcile.mockImplementation(
      () => new Promise((resolve) => (resolveRetry = resolve)),
    );
    let state = await hydrate();
    expect(state.actionsDisabled).toBe(false);

    const retrying = state.onRetryReconcile();
    state = renderHook({});
    expect(state.retryingReconcile).toBe("retry");
    expect(state.actionsDisabled).toBe(true);

    resolveRetry({ ok: true, outcome: { status: "ok" } });
    await retrying;
    state = renderHook({});
    expect(state.retryingReconcile).toBeNull();
    expect(state.actionsDisabled).toBe(false);
  });
});

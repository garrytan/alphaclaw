import { beforeEach, describe, expect, it, vi } from "vitest";

// View-level coverage for the pre-ship review fixes (stabilization actions
// while auto-accepted, incident-card rollback gating, docsUrl links, CTA
// loading, dialog cancel styling). Kept separate from upgrade-tab.test.js so
// concurrent additions there don't conflict.

// Minimal hook harness (same pattern as upgrade-tab.test.js): hook state
// lives in per-call-index slots so component/hook functions can be invoked
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
import { UpgradeTabView } from "../../lib/public/js/components/upgrade-tab/index.js";
import { buildChannelSwitchModel } from "../../lib/public/js/components/upgrade-tab/helpers.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
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

const findActionButtonByLabel = (tree, label) =>
  findAllByType(tree, ActionButton).find(
    (vnode) => vnode.props.idleLabel === label,
  );

const findAnchorByHref = (tree, href) =>
  findAllByType(tree, "a").find((vnode) => vnode.props.href === href);

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

describe("frontend/upgrade-tab ship fixes", () => {
  beforeEach(() => {
    harness.reset();
  });

  it("keeps Mark-as-good and Roll-back actions available while auto-accepted inside the window", () => {
    const onMarkGood = vi.fn();
    const onRequestRollback = vi.fn();
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
        lastKnownGood: { package: "2026.7.2", dev: null },
      }),
      activeChannel: "beta",
      catalog: makeCatalog(),
      onMarkGood,
      onRequestRollback,
    });

    const text = treeText(tree);
    // Auto-accepted: no STABILIZING badge/countdown, but the note that says
    // "'Mark as good now' disarms it" must sit next to an actual button.
    expect(text).not.toContain("STABILIZING");
    expect(text).toContain(
      "Auto-rollback stays armed for 24h after activation — 'Mark as good now' disarms it.",
    );

    const markGood = findActionButtonByLabel(tree, "Mark as good now");
    expect(markGood).toBeTruthy();
    markGood.props.onClick();
    expect(onMarkGood).toHaveBeenCalledTimes(1);

    const rollback = findActionButtonByLabel(tree, "Roll back now");
    expect(rollback).toBeTruthy();
    rollback.props.onClick();
    expect(onRequestRollback).toHaveBeenCalledTimes(1);
  });

  it("hides the stabilization actions entirely once the window has passed", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo({
        releaseChannel: "beta",
        installedVersion: "2026.7.3-beta.1",
        applied: { channel: "beta", version: "2026.7.3-beta.1" },
        appliedId: "2026.7.3-beta.1",
        isPin: false,
        inStabilizationWindow: false,
        acceptedAt: kNow - 90_000_000,
      }),
      activeChannel: "beta",
      catalog: makeCatalog(),
    });

    expect(findActionButtonByLabel(tree, "Mark as good now")).toBeUndefined();
    expect(findActionButtonByLabel(tree, "Roll back now")).toBeUndefined();
  });

  it("offers no Roll back button for an apply-failed incident (nothing changed)", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo({
        lastUpdateRun: {
          target: { channel: "stable", version: "2026.7.2" },
          startedAt: kNow - 7_200_000,
          finishedAt: kNow - 7_100_000,
          ok: false,
          steps: [],
          result: {
            ok: false,
            code: "preflight_failed",
            message: "insufficient disk",
          },
        },
        blocklist: [],
      }),
      catalog: makeCatalog(),
    });

    const text = treeText(tree);
    expect(text).toContain("Update to 2026.7.2 failed");
    expect(text).toContain(
      "Nothing was changed — you're still on your previous version.",
    );
    // "You're still on your previous version" — rolling that version back
    // (and blocklisting it) would be contradictory, so the CTA must not show.
    expect(findActionButtonByLabel(tree, "Roll back")).toBeUndefined();
  });

  it("keeps the Roll back button for a rollback-kind incident", () => {
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

    const rollback = findActionButtonByLabel(tree, "Roll back");
    expect(rollback).toBeTruthy();
    rollback.props.onClick();
    expect(onRequestRollback).toHaveBeenCalledTimes(1);
  });

  it("renders a Learn more link when a streamed failure carries docsUrl", () => {
    const docsUrl = "https://docs.openclaw.ai/updates#build-failures";
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
          docsUrl,
        },
      },
    });

    expect(treeText(tree)).toContain("build failed: tsc exited 2");
    const link = findAnchorByHref(tree, docsUrl);
    expect(link).toBeTruthy();
    expect(collectText(link).join(" ")).toContain("Learn more");
    expect(link.props.target).toBe("_blank");
    expect(link.props.rel).toBe("noreferrer");
  });

  it("omits the Learn more link when the streamed failure has no docsUrl", () => {
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
          hint: null,
          code: "build_failed",
          docsUrl: null,
        },
      },
    });

    const links = findAllByType(tree, "a").filter((vnode) =>
      collectText(vnode).join(" ").includes("Learn more"),
    );
    expect(links).toEqual([]);
  });

  it("renders a Learn more link on the apply-error card when docsUrl is present", () => {
    const docsUrl = "https://docs.openclaw.ai/updates#preflight";
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      applyError: {
        message: "insufficient disk space",
        hint: "Free at least 5 GB on the data volume.",
        code: "preflight_failed",
        docsUrl,
      },
    });

    const link = findAnchorByHref(tree, docsUrl);
    expect(link).toBeTruthy();
    expect(collectText(link).join(" ")).toContain("Learn more");
    expect(link.props.target).toBe("_blank");
    expect(link.props.rel).toBe("noreferrer");
  });

  it("does not borrow savingChannel as a loading state on the Update-to-latest CTA", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      savingChannel: true,
    });

    const cta = findActionButtonByLabel(tree, "Update to latest stable");
    expect(cta).toBeTruthy();
    // Its click only opens a dialog — "Saving..." would be a lie. The
    // actionsDisabled window (which includes savingChannel) covers it.
    expect(cta.props.loading).toBeFalsy();
    expect(cta.props.loadingLabel).toBeUndefined();
  });

  it("styles the channel-switch dialog Cancel like ConfirmDialog's cancel", () => {
    const tree = renderView({
      channelInfo: makeChannelInfo(),
      catalog: makeCatalog(),
      channelSwitchPrompt: {
        nextChannel: "beta",
        latestLabel: "2026.7.3-beta.1",
        model: buildChannelSwitchModel({
          nextChannel: "beta",
          latestLabel: "2026.7.3-beta.1",
        }),
      },
    });

    const cancel = findActionButtonByLabel(tree, "Cancel");
    expect(cancel).toBeTruthy();
    expect(cancel.props.tone).toBe("secondary");
    expect(cancel.props.size).toBe("md");
    expect(cancel.props.className).toContain("px-4 py-2 rounded-lg");
  });
});

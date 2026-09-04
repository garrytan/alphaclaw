import { beforeEach, describe, expect, it, vi } from "vitest";

// Collect-only hook harness (see gateway-card.test.js).
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
import {
  GlobalRestartBanner,
  buildGlobalBannerModel,
  buildRestartBannerProgress,
  kAlphaclawRestartingBannerText,
  kReconnectingBannerText,
  kRestartRequiredBannerText,
  kUnreachableBannerText,
} from "../../lib/public/js/components/global-restart-banner.js";
import { gatewayShellStore } from "../../lib/public/js/components/restart-progress-card.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";

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

const treeText = (tree) => collectText(tree).join(" ").replace(/\s+/g, " ");

const renderBanner = (props = {}) => {
  harness.beginRender();
  return expandTree(GlobalRestartBanner(props));
};

const kRunningOperation = {
  operationId: "op-1",
  startedAt: Date.now() - 5000,
  phase: "running",
  steps: [
    { name: "stopping", label: "Stopping gateway", status: "running" },
    { name: "stopping", label: "Stopping gateway", status: "done" },
    { name: "launching", label: "Starting gateway", status: "running" },
  ],
  error: null,
};

describe("frontend/global-restart-banner (demoted)", () => {
  beforeEach(() => {
    harness.reset();
    gatewayShellStore.reset();
  });

  it("restart-required: passive announcement + view deep-link + dismiss, NO restart button", () => {
    const dismiss = vi.fn();
    gatewayShellStore.publish({
      restartRequired: true,
      actions: { dismissRestartBanner: dismiss },
    });
    const tree = renderBanner({ visible: true, onRestart: vi.fn() });
    const text = treeText(tree);
    expect(text).toContain(kRestartRequiredBannerText);

    // Demotion: no action button that triggers a restart, anywhere.
    const actionButtons = findAllByType(tree, ActionButton);
    expect(
      actionButtons.filter((vnode) =>
        /restart/i.test(String(vnode.props.idleLabel || "")),
      ),
    ).toEqual([]);

    const viewLink = findAllByType(tree, "a").find(
      (vnode) => vnode.props.href === "#/general",
    );
    expect(viewLink).toBeTruthy();
    expect(collectText(viewLink).join(" ")).toContain("view");

    const dismissButton = findAllByType(tree, "button").find(
      (vnode) => vnode.props["aria-label"] === "Dismiss restart banner",
    );
    expect(dismissButton).toBeTruthy();
    dismissButton.props.onclick();
    expect(dismiss).toHaveBeenCalledTimes(1);

    // Announcement, not interaction: the banner is a status live region.
    const root = collectNodes(tree).find(
      (vnode) => vnode.props?.role === "status",
    );
    expect(root).toBeTruthy();
  });

  it("while an operation runs: 'Restart in progress — step X/Y' with view link and no buttons", () => {
    gatewayShellStore.publish({
      restartRequired: true,
      restartOperation: kRunningOperation,
    });
    const tree = renderBanner({ visible: true });
    const text = treeText(tree);
    expect(text).toContain("Restart in progress — step 2/4");
    expect(
      findAllByType(tree, "a").find((vnode) => vnode.props.href === "#/general"),
    ).toBeTruthy();
    expect(findAllByType(tree, ActionButton)).toEqual([]);
    expect(
      findAllByType(tree, "button").filter(
        (vnode) => vnode.props["aria-label"] === "Dismiss restart banner",
      ),
    ).toEqual([]);
  });

  it("unresolved failure: passive failure announcement with view link", () => {
    gatewayShellStore.publish({
      restartOperation: {
        ...kRunningOperation,
        phase: "failed",
        error: { message: "boom", hint: null, code: null },
      },
    });
    const tree = renderBanner({ visible: false });
    expect(treeText(tree)).toContain("Gateway restart failed");
    expect(
      findAllByType(tree, "a").find((vnode) => vnode.props.href === "#/general"),
    ).toBeTruthy();
  });

  it("reconnecting supersedes the restart slot", () => {
    gatewayShellStore.publish({
      restartRequired: true,
      connectivityMode: "reconnecting",
    });
    const tree = renderBanner({ visible: true });
    const text = treeText(tree);
    expect(text).toContain(kReconnectingBannerText);
    expect(text).not.toContain(kRestartRequiredBannerText);
  });

  it("unreachable: escape-hatch copy plus a manual Retry button", () => {
    const retryConnect = vi.fn();
    gatewayShellStore.publish({
      connectivityMode: "unreachable",
      actions: { retryConnect },
    });
    const tree = renderBanner({});
    expect(treeText(tree)).toContain(kUnreachableBannerText);
    const retry = findAllByType(tree, ActionButton).find(
      (vnode) => vnode.props.idleLabel === "Retry",
    );
    expect(retry).toBeTruthy();
    retry.props.onClick();
    expect(retryConnect).toHaveBeenCalledTimes(1);
  });

  it("AlphaClaw self-restart (controller or upgrade tab) shows the restarting banner", () => {
    gatewayShellStore.publish({ connectivityMode: "alphaclaw_restarting" });
    expect(treeText(renderBanner({}))).toContain(kAlphaclawRestartingBannerText);

    harness.reset();
    gatewayShellStore.reset();
    gatewayShellStore.publish({ upgradeRestartActive: true });
    expect(treeText(renderBanner({}))).toContain(kAlphaclawRestartingBannerText);
  });

  it("renders nothing when there is nothing to announce", () => {
    harness.beginRender();
    expect(GlobalRestartBanner({ visible: false })).toBeNull();
  });

  it("buildGlobalBannerModel picks connectivity over operation over required", () => {
    expect(
      buildGlobalBannerModel({
        shell: {
          connectivityMode: "unreachable",
          restartOperation: kRunningOperation,
          restartRequired: true,
        },
      }).kind,
    ).toBe("unreachable");
    expect(
      buildGlobalBannerModel({
        shell: {
          connectivityMode: "online",
          restartOperation: kRunningOperation,
          restartRequired: true,
        },
      }).kind,
    ).toBe("operation");
    expect(
      buildGlobalBannerModel({
        shell: { connectivityMode: "online", restartRequired: true },
      }).kind,
    ).toBe("required");
    expect(
      buildGlobalBannerModel({ shell: { connectivityMode: "online" } }),
    ).toBeNull();
  });

  it("buildRestartBannerProgress widens the total for a leading waiting_for_lock step (queued restart) so the counter never runs ahead", () => {
    const queued = {
      ...kRunningOperation,
      steps: [
        { name: "waiting_for_lock", label: "Waiting for the current operation to finish", status: "done" },
        { name: "preparing_plugins", label: "Checking plugins", status: "skipped" },
        ...kRunningOperation.steps,
      ],
    };
    // waiting + preparing + stopping + launching started = step 4 of 6.
    expect(buildRestartBannerProgress(queued)).toEqual({ step: 4, of: 6 });
    const queuedNoPrepare = {
      ...kRunningOperation,
      steps: [
        { name: "waiting_for_lock", label: "Waiting for the current operation to finish", status: "running" },
      ],
    };
    expect(buildRestartBannerProgress(queuedNoPrepare)).toEqual({ step: 1, of: 5 });
  });

  it("buildRestartBannerProgress counts server steps (optional preparing_plugins widens the total)", () => {
    expect(buildRestartBannerProgress(kRunningOperation)).toEqual({
      step: 2,
      of: 4,
    });
    expect(
      buildRestartBannerProgress({
        ...kRunningOperation,
        steps: [
          { name: "preparing_plugins", label: "Checking plugins", status: "done" },
          ...kRunningOperation.steps,
        ],
      }),
    ).toEqual({ step: 3, of: 5 });
    // The optimistic placeholder never counts — with no real step yet there
    // is no plan to count against (the banner shows plain "Restart in
    // progress" instead of a denominator that would jump 4→5 mid-op).
    expect(
      buildRestartBannerProgress({
        ...kRunningOperation,
        steps: [{ name: "__requesting", label: "Contacting AlphaClaw…", status: "running" }],
      }),
    ).toBeNull();
    expect(buildRestartBannerProgress(null)).toBeNull();
  });

  it("tracks the started step across the REAL server sequence ('skipped' prepare, no launching terminal) instead of sticking at 2/5", () => {
    // The exact emission order locked in by tests/server/gateway-restart
    // .e2e.test.js: preparing_plugins running→skipped, stopping running→done,
    // launching running (never gets a terminal status), waiting_ready
    // running, ready done. done_count+1 arithmetic sat at "step 2/5" through
    // launch and the entire (up to 120s) health-check wait.
    const emitted = [];
    const progressAfter = (event) => {
      emitted.push(event);
      return buildRestartBannerProgress({
        ...kRunningOperation,
        steps: [...emitted],
      });
    };

    expect(
      progressAfter({ name: "preparing_plugins", label: "Checking plugins", status: "running" }),
    ).toEqual({ step: 1, of: 5 });
    expect(
      progressAfter({ name: "preparing_plugins", label: "Checking plugins", status: "skipped" }),
    ).toEqual({ step: 1, of: 5 });
    expect(
      progressAfter({ name: "stopping", label: "Stopping gateway", status: "running" }),
    ).toEqual({ step: 2, of: 5 });
    expect(
      progressAfter({ name: "stopping", label: "Stopping gateway", status: "done" }),
    ).toEqual({ step: 2, of: 5 });
    expect(
      progressAfter({ name: "launching", label: "Starting gateway", status: "running" }),
    ).toEqual({ step: 3, of: 5 });
    expect(
      progressAfter({ name: "waiting_ready", label: "Waiting for health check", status: "running" }),
    ).toEqual({ step: 4, of: 5 });
    expect(
      progressAfter({ name: "ready", label: "Ready", status: "done" }),
    ).toEqual({ step: 5, of: 5 });
  });
});

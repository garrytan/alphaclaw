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
import { Gateway } from "../../lib/public/js/components/gateway.js";
import { gatewayShellStore } from "../../lib/public/js/components/restart-progress-card.js";

const harness = preactHooks.__harness;

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

import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (same pattern as envars-component.test.js): hook state
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

// Heavy sidebar children are irrelevant to nav-item rendering.
vi.mock("../../lib/public/js/components/file-tree.js", () => ({
  FileTree: () => null,
}));
vi.mock("../../lib/public/js/components/sidebar-git-panel.js", () => ({
  SidebarGitPanel: () => null,
}));
vi.mock("../../lib/public/js/components/update-modal.js", () => ({
  UpdateModal: () => null,
}));
vi.mock("../../lib/public/js/components/theme-toggle.js", () => ({
  ThemeToggle: () => null,
}));

import * as preactHooks from "preact/hooks";
import { AppSidebar } from "../../lib/public/js/components/sidebar.js";
import {
  buildNavSections,
  kDashboardsNavItem,
} from "../../lib/public/js/lib/app-navigation.js";

const harness = preactHooks.__harness;

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

const renderSidebar = (props = {}) => {
  harness.beginRender();
  return AppSidebar({
    navSections: buildNavSections({ features: { sessionDashboards: true } }),
    ...props,
  });
};

const findAnchorByHref = (tree, href) =>
  collectNodes(tree).find(
    (vnode) => vnode.type === "a" && vnode.props.href === href,
  );

describe("frontend/sidebar external nav items", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  it("notifies onExternalNavClick on click WITHOUT preventing native navigation", () => {
    const onExternalNavClick = vi.fn();
    const onSelectNavItem = vi.fn();
    const tree = renderSidebar({ onExternalNavClick, onSelectNavItem });

    const anchor = findAnchorByHref(tree, kDashboardsNavItem.href);
    expect(anchor).toBeTruthy();
    expect(anchor.props.target).toBe("_blank");
    expect(anchor.props.rel).toBe("noreferrer");

    const event = { preventDefault: vi.fn() };
    const returned = anchor.props.onclick(event);
    expect(onExternalNavClick).toHaveBeenCalledTimes(1);
    // Native new-tab navigation must proceed: no preventDefault, and no
    // `return false` (htm/preact would not translate it, but pin it anyway).
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(returned).not.toBe(false);
    // The click is a shell notification, never an SPA route change.
    expect(onSelectNavItem).not.toHaveBeenCalled();
  });

  it("renders the Dashboards launcher item with its tooltip and icon", () => {
    const tree = renderSidebar({});
    const anchor = findAnchorByHref(tree, kDashboardsNavItem.href);
    expect(anchor).toBeTruthy();
    expect(kDashboardsNavItem.href).toBe("/gateway/launch?to=dashboards");
    expect(anchor.props.title).toBe(
      "Opens OpenClaw session dashboards in a new tab (signed in automatically)",
    );
    // Accessible name stays visible-label-first (screen readers announce
    // "Dashboards", not the tooltip sentence); the title carries the detail.
    expect(anchor.props["aria-label"]).toBe(`${kDashboardsNavItem.label} (opens in a new tab)`);
    // Distinct icon: Dashboards no longer borrows Usage's bar chart.
    const iconNode = collectNodes(anchor.props.children).find(
      (vnode) => typeof vnode.type === "function",
    );
    expect(iconNode.type.name).toBe("DashboardLineIcon");
  });

  it("keeps internal items on the SPA route path (no external notify)", () => {
    const onExternalNavClick = vi.fn();
    const onSelectNavItem = vi.fn();
    const tree = renderSidebar({ onExternalNavClick, onSelectNavItem });

    const internal = collectNodes(tree).find(
      (vnode) =>
        vnode.type === "a" && vnode.props.href === undefined && vnode.props.onclick,
    );
    expect(internal).toBeTruthy();
    internal.props.onclick();
    expect(onSelectNavItem).toHaveBeenCalledTimes(1);
    expect(onExternalNavClick).not.toHaveBeenCalled();
  });
});

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
  kThemeOptions: [],
  useThemePreference: () => ["dark", () => {}],
}));

import * as preactHooks from "preact/hooks";
import { AppSidebar } from "../../lib/public/js/components/sidebar.js";
import { StatusChip } from "../../lib/public/js/components/status-chip.js";
import { Badge } from "../../lib/public/js/components/badge.js";
import {
  buildNavSections,
  filterNavSectionsForRole,
} from "../../lib/public/js/lib/app-navigation.js";

// ALPH-69 PR 2b: the sidebar's groups, labels, agent rows, chip and foot.
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

const textOf = (node) =>
  collectNodes(node)
    .flatMap((vnode) => [vnode.props?.children].flat())
    .filter((child) => typeof child === "string")
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

const kAgents = [
  { id: "main", name: "main", default: true },
  { id: "scout", name: "Scout" },
  { id: "ledger", name: "Ledger" },
];

const renderSidebar = (props = {}) => {
  harness.beginRender();
  return AppSidebar({ navSections: buildNavSections(), agents: kAgents, ...props });
};

const mainNav = (tree) =>
  collectNodes(tree).find((vnode) => vnode.type === "nav" && vnode.props["aria-label"] === "Main");

const groupsOf = (tree) =>
  collectNodes(mainNav(tree))
    .filter((vnode) => vnode.props?.class === "sidebar-group")
    .map((group) => {
      const nodes = collectNodes(group);
      const label = nodes.find((vnode) => vnode.props?.class === "sidebar-label");
      const rows = nodes.filter(
        (vnode) => vnode.type === "a" || (vnode.type === "button" && vnode.props.class === "sidebar-agent-add"),
      );
      return {
        label: label ? textOf(label) : "",
        rows: rows.map((row) => textOf(row.props.children)),
      };
    });

describe("frontend/sidebar IA", () => {
  beforeEach(() => {
    harness.reset();
    vi.clearAllMocks();
  });

  it("draws the admin tree in order with always-open, sentence-case groups", () => {
    expect(groupsOf(renderSidebar())).toEqual([
      { label: "", rows: ["Home", "Chat"] },
      { label: "Agents", rows: ["main Default", "Scout", "Ledger", "Add agent"] },
      {
        label: "Operate",
        rows: ["Health", "Doctor", "Schedules", "Usage", "Open Claude Code"],
      },
      { label: "Connect", rows: ["Channels", "Integrations", "Relay"] },
      { label: "Settings", rows: ["Models & keys", "Environment", "Team"] },
    ]);
    const tree = renderSidebar();
    expect(collectNodes(mainNav(tree)).some((vnode) => vnode.props?.["aria-expanded"] !== undefined)).toBe(false);
  });

  it("appends Dashboards at the foot of Operate when the gate is open", () => {
    const operate = groupsOf(
      renderSidebar({ navSections: buildNavSections({ features: { sessionDashboards: true } }) }),
    ).find((group) => group.label === "Operate");
    expect(operate.rows.slice(-2)).toEqual(["Open Claude Code", "Dashboards"]);
  });

  it("marks the default agent with a Default badge and the selected one as current", () => {
    const tree = renderSidebar({ selectedAgentId: "scout" });
    const rows = collectNodes(mainNav(tree)).filter((vnode) => vnode.props?.class?.startsWith?.("sidebar-agent-item"));
    expect(rows.map((row) => row.props.href)).toEqual(["#/agents/main", "#/agents/scout", "#/agents/ledger"]);
    expect(collectNodes(rows[0]).some((vnode) => vnode.type === Badge)).toBe(true);
    expect(collectNodes(rows[1]).some((vnode) => vnode.type === Badge)).toBe(false);
    expect(rows[1].props["aria-current"]).toBe("page");
    expect(rows[0].props["aria-current"]).toBeUndefined();
  });

  it("highlights the selected item with aria-current", () => {
    const tree = renderSidebar({ selectedNavId: "health" });
    const current = collectNodes(mainNav(tree)).filter((vnode) => vnode.props?.["aria-current"] === "page");
    expect(current.map((vnode) => vnode.props.href)).toEqual(["#/health"]);
    expect(current[0].props.class).toBe("active");
  });

  it("shows a member only Usage, Schedules and Team", () => {
    const tree = renderSidebar({
      navSections: filterNavSectionsForRole(buildNavSections(), "member"),
      showAgents: false,
    });
    expect(groupsOf(tree)).toEqual([
      { label: "Operate", rows: ["Schedules", "Usage"] },
      { label: "Settings", rows: ["Team"] },
    ]);
  });

  it("puts the status chip under the wordmark", () => {
    const nodes = collectNodes(renderSidebar());
    const brandIndex = nodes.findIndex((vnode) => vnode.props?.class === "sidebar-brand");
    const chipIndex = nodes.findIndex((vnode) => vnode.type === StatusChip);
    expect(brandIndex).toBeGreaterThanOrEqual(0);
    expect(chipIndex).toBeGreaterThan(brandIndex);
    expect(nodes[chipIndex - 1].props.class).toBe("sidebar-status");
  });

  it("ends with the version line and an overflow holding the links, theme and Log out", () => {
    const tree = renderSidebar({
      versionLine: "OpenClaw 2026.10.9 / AlphaClaw 0.10.186",
      authEnabled: true,
      menuOpen: true,
    });
    const foot = collectNodes(tree).find((vnode) => vnode.props?.class === "sidebar-foot");
    const version = collectNodes(foot).find((vnode) => vnode.props?.class === "sidebar-version");
    expect(version.props.title).toBe("OpenClaw 2026.10.9 / AlphaClaw 0.10.186");
    const lines = collectNodes(version).filter((vnode) => vnode.props?.class === "sidebar-version-line");
    expect(lines.map((line) => textOf(line))).toEqual(["AlphaClaw 0.10.186", "OpenClaw 2026.10.9"]);
    const menu = collectNodes(foot).find((vnode) => vnode.type?.name === "OverflowMenu");
    const links = collectNodes(menu.props.children).filter((vnode) => vnode.type === "a");
    expect(links.map((link) => link.props.href)).toEqual([
      "https://docs.openclaw.ai",
      "https://discord.com/invite/clawd",
      "https://github.com/openclaw/openclaw",
    ]);
    expect(textOf(menu.props.children)).toContain("Log out");
    expect(collectNodes(tree).some((vnode) => vnode.props?.class === "app-statusbar")).toBe(false);
  });
});

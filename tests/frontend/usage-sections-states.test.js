import { describe, expect, it } from "vitest";
import { SessionsSection } from "../../lib/public/js/components/usage-tab/sessions-section.js";
import { OverviewSection } from "../../lib/public/js/components/usage-tab/overview-section.js";
import { SegmentedControl } from "../../lib/public/js/components/segmented-control.js";

// Stateless components: invoke them directly and walk the vnode tree
// (saved-toggle-component.test.js pattern) — no DOM renderer needed.
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

const kSession = {
  sessionId: "s1",
  sessionKey: "agent:main",
  totalTokens: 10,
  totalCost: 0.01,
  lastActivityMs: 0,
};

describe("frontend/usage-tab sessions-section detail states", () => {
  it("renders the detail-load error with a retry instruction instead of 'not available'", () => {
    const tree = expandTree(
      SessionsSection({
        sessions: [kSession],
        expandedSessionIds: ["s1"],
        loadingDetailById: {},
        sessionDetailById: { s1: { status: "error", message: "boom" } },
      }),
    );
    const text = collectText(tree).join(" ").replace(/\s+/g, " ");
    expect(text).toContain("boom");
    expect(text).toContain("Close and reopen to retry.");
    expect(text).not.toContain("Session detail not available.");

    // Falls back to a generic message when the error carries none.
    const generic = expandTree(
      SessionsSection({
        sessions: [kSession],
        expandedSessionIds: ["s1"],
        sessionDetailById: { s1: { status: "error" } },
      }),
    );
    expect(collectText(generic).join(" ")).toContain(
      "Could not load session detail.",
    );
  });
});

describe("frontend/usage-tab overview-section initial load", () => {
  const kPeriodSummary = {
    today: { tokens: 0, cost: 0 },
    week: { tokens: 0, cost: 0 },
    month: { tokens: 0, cost: 0 },
  };

  it("scopes the loading placeholder to the chart while controls stay interactive", () => {
    const tree = expandTree(
      OverviewSection({
        summary: null,
        summaryLoading: true,
        periodSummary: kPeriodSummary,
      }),
    );
    expect(collectText(tree).join(" ")).toContain("Loading usage summary...");
    const controls = collectNodes(tree).filter(
      (vnode) => vnode.type === SegmentedControl,
    );
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.props.disabled).not.toBe(true);
    }

    // The placeholder drops once a summary exists, even mid-refresh.
    const refreshed = expandTree(
      OverviewSection({
        summary: { totals: {}, models: [] },
        summaryLoading: true,
        periodSummary: kPeriodSummary,
      }),
    );
    expect(collectText(refreshed).join(" ")).not.toContain(
      "Loading usage summary...",
    );
  });
});

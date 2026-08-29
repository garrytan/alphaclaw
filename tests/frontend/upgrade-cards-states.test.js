import { describe, expect, it, vi } from "vitest";
import { UpgradeStatusCard } from "../../lib/public/js/components/upgrade-tab/status-card.js";
import { UpgradeProgressCard } from "../../lib/public/js/components/upgrade-tab/progress-card.js";
import { UpgradeCatalogCard } from "../../lib/public/js/components/upgrade-tab/catalog-card.js";
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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

describe("frontend/upgrade-tab status-card loading frame", () => {
  it("renders the frame with disabled channel options instead of blanking while loading", () => {
    expect(UpgradeStatusCard({ model: null, loadingChannel: false })).toBe(null);

    const tree = expandTree(
      UpgradeStatusCard({ model: null, loadingChannel: true, activeChannel: "stable" }),
    );
    const controls = findAllByType(tree, SegmentedControl);
    expect(controls.length).toBe(1);
    expect(controls[0].props.disabled).toBe(true);
    const text = collectText(tree).join(" ");
    expect(text).toContain("Release channel");
    expect(text).toContain("Loading version info...");
  });
});

describe("frontend/upgrade-tab progress-card failure affordances", () => {
  const failedOperation = {
    phase: "failed",
    label: "2026.8.1",
    steps: [],
    startedAt: 0,
    finishedAt: 60_000,
    error: { message: "npm run build failed" },
  };

  it("offers Dismiss (wired to onDismissOperation) with the re-enable hint on failure", () => {
    const onDismissOperation = vi.fn();
    const tree = expandTree(
      UpgradeProgressCard({ operation: failedOperation, nowMs: 60_000, onDismissOperation }),
    );
    const dismiss = collectNodes(tree).find(
      (vnode) =>
        vnode.type === "button" &&
        collectText(vnode.props.children).join("").includes("Dismiss"),
    );
    expect(dismiss).toBeTruthy();
    dismiss.props.onclick();
    expect(onDismissOperation).toHaveBeenCalledTimes(1);
    const text = collectText(tree).join(" ");
    expect(text).toContain("Update to 2026.8.1 failed");
    expect(text).toContain("Dismiss to re-enable the page");
    expect(text).toContain("npm run build failed");

    // Still-running operations get no Dismiss affordance.
    const running = expandTree(
      UpgradeProgressCard({
        operation: { phase: "applying", label: "2026.8.1", steps: [], startedAt: 0 },
        nowMs: 1_000,
      }),
    );
    const runningDismiss = collectNodes(running).find(
      (vnode) =>
        vnode.type === "button" &&
        collectText(vnode.props.children).join("").includes("Dismiss"),
    );
    expect(runningDismiss).toBeUndefined();
    expect(collectText(running).join(" ")).not.toContain("Dismiss to re-enable");
  });
});

describe("frontend/upgrade-tab catalog-card refresh failure", () => {
  it("keeps stale data with a refresh warning instead of replacing it with the error panel", () => {
    const catalog = { stable: [], beta: [], dev: null, staleAsOf: 0 };
    const tree = expandTree(
      UpgradeCatalogCard({
        catalog,
        catalogError: new Error("registry unreachable"),
        nowMs: 1_000,
      }),
    );
    const text = collectText(tree).join(" ");
    expect(text).toContain("Could not refresh the catalog");
    expect(text).toContain("registry unreachable");
    // The hard-error panel (status-error paragraph) is reserved for no-data.
    const errorParagraphs = collectNodes(tree).filter(
      (vnode) =>
        vnode.type === "p" &&
        String(vnode.props.class || "").includes("text-status-error") &&
        !String(vnode.props.class || "").includes("warning"),
    );
    expect(errorParagraphs.length).toBe(0);

    const noData = expandTree(
      UpgradeCatalogCard({ catalog: null, catalogError: new Error("registry unreachable") }),
    );
    const noDataText = collectText(noData).join(" ");
    expect(noDataText).toContain("registry unreachable");
    expect(noDataText).not.toContain("Could not refresh the catalog");
  });
});

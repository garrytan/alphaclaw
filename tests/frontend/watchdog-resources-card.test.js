import { describe, expect, it } from "vitest";
import { WatchdogResourcesCard } from "../../lib/public/js/components/watchdog-tab/resources/index.js";
import { ResourceBar } from "../../lib/public/js/components/watchdog-tab/resource-bar.js";
import { AsyncSection } from "../../lib/public/js/components/async-section.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { Tooltip } from "../../lib/public/js/components/tooltip.js";

// Stateless component: invoke directly and walk the vnode tree (the
// saved-toggle-component.test.js pattern) — no DOM renderer needed.
const kSkipExpand = new Set([Tooltip]);

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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const kResources = {
  memory: { usedBytes: 1024, totalBytes: 4096, percent: 25 },
  disk: { usedBytes: 10, totalBytes: 100, percent: 10, path: "/data" },
  cpu: { percent: 5, cores: 2 },
};

const renderCard = (props = {}) => expandTree(WatchdogResourcesCard(props));

describe("frontend/watchdog resources card", () => {
  it("keeps the card frame while loading instead of unmounting", () => {
    const tree = renderCard({ resources: null, error: null });
    // The frame (root div) is present with a scoped loading line.
    expect(collectNodes(tree).some((n) => n.type === "div")).toBe(true);
    expect(treeText(tree)).toContain("Loading system resources...");
    expect(findAllByType(tree, ResourceBar).length).toBe(0);
  });

  it("renders an inline error with Retry when the poll fails before any data", () => {
    const onRetry = () => {};
    const tree = renderCard({ resources: null, error: new Error("boom"), onRetry });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips.length).toBe(1);
    expect(chips[0].props.onRetry).toBe(onRetry);
    expect(treeText(tree)).toContain("Couldn't load system resources.");
    expect(treeText(tree)).not.toContain("Loading system resources...");
  });

  it("keeps stale bars on screen with a refresh-failed note", () => {
    const tree = renderCard({ resources: kResources, error: new Error("flaky") });
    expect(findAllByType(tree, ResourceBar).length).toBe(3); // stale data still shown
    expect(treeText(tree)).toContain(
      "Couldn't refresh system resources — showing the last loaded values.",
    );
  });

  it("renders the three bars with no chip when healthy", () => {
    const tree = renderCard({ resources: kResources });
    expect(findAllByType(tree, ResourceBar).length).toBe(3);
    expect(findAllByType(tree, InlineErrorChip).length).toBe(0);
    expect(findAllByType(tree, AsyncSection).length).toBe(0);
  });

  it("renders the expanded memory bar with process segments", () => {
    const tree = renderCard({
      resources: {
        ...kResources,
        processes: { gateway: { rssBytes: 256 }, alphaclaw: { rssBytes: 128 } },
      },
      memoryExpanded: true,
    });
    const bars = findAllByType(tree, ResourceBar);
    expect(bars.length).toBe(1);
    expect(bars[0].props.expanded).toBe(true);
    expect(bars[0].props.segments.map((segment) => segment.label)).toEqual([
      "Gateway 256 B",
      "AlphaClaw 128 B",
      "Other 640 B",
    ]);
  });
});

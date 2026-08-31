import { describe, expect, it, vi } from "vitest";

// The card's data hook is not under test — stub it to an inert state so the
// component renders as a pure function of its props.
vi.mock(
  "../../lib/public/js/components/nodes-tab/connected-nodes/use-connected-nodes-card.js",
  () => ({
    useConnectedNodesCard: () => ({
      browserStatusByNodeId: {},
      browserErrorByNodeId: {},
      checkingBrowserNodeIds: new Set(),
      browserAttachStateByNodeId: {},
      menuOpenNodeId: "",
      removeDialogNode: null,
      removingNodeId: "",
      handleCopyText: () => {},
      handleCheckNodeBrowser: () => {},
      handleAttachNodeBrowser: () => {},
      handleDetachNodeBrowser: () => {},
      handleOpenNodeMenu: () => {},
      handleRemoveNode: () => {},
      setMenuOpenNodeId: () => {},
      setRemoveDialogNode: () => {},
    }),
  }),
);

import { ConnectedNodesCard } from "../../lib/public/js/components/nodes-tab/connected-nodes/index.js";
import { TooltipBadge } from "../../lib/public/js/components/tooltip-badge.js";
import { Badge } from "../../lib/public/js/components/badge.js";

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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

describe("frontend/connected-nodes status badges", () => {
  it("paired-but-disconnected renders a warning TooltipBadge naming the reconnect action", () => {
    const tree = ConnectedNodesCard({
      nodes: [{ nodeId: "n1", displayName: "Mac", paired: true, connected: false }],
    });
    const chips = findAllByType(tree, TooltipBadge);
    expect(chips).toHaveLength(1);
    expect(chips[0].props.tone).toBe("warning");
    expect(chips[0].props.label).toBe("Disconnected");
    expect(chips[0].props.text).toContain("run the node command again");
  });

  it("an unpaired node renders a danger 'Pending approval' TooltipBadge pointing at the pairing flow", () => {
    const tree = ConnectedNodesCard({
      nodes: [{ nodeId: "n3", displayName: "Pixel", paired: false, connected: false }],
    });
    const chips = findAllByType(tree, TooltipBadge);
    expect(chips).toHaveLength(1);
    expect(chips[0].props.tone).toBe("danger");
    expect(chips[0].props.label).toBe("Pending approval");
    expect(chips[0].props.text).toContain("Add node pairing flow");
  });

  it("a connected node keeps the plain success badge with no tooltip", () => {
    const tree = ConnectedNodesCard({
      nodes: [{ nodeId: "n2", displayName: "Mini", paired: true, connected: true }],
    });
    expect(findAllByType(tree, TooltipBadge)).toHaveLength(0);
    const success = findAllByType(tree, Badge).find(
      (badge) => badge.props.tone === "success",
    );
    expect(success).toBeTruthy();
  });

  it("the pending banner names where to approve, not just the count", () => {
    const tree = ConnectedNodesCard({ nodes: [], pending: [{ nodeId: "p1" }] });
    const text = collectText(tree).join(" ").replace(/\s+/g, " ");
    expect(text).toContain("1 pending node");
    expect(text).toContain("approve them in the Add node pairing flow");
  });
});

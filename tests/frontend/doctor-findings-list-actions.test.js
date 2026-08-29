import { describe, expect, it } from "vitest";
import { DoctorFindingsList } from "../../lib/public/js/components/doctor/findings-list.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";

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

const makeCard = (overrides = {}) => ({
  id: 7,
  runId: 3,
  status: "open",
  priority: "P1",
  category: "drift",
  title: "Guidance drift",
  summary: "",
  recommendation: "Fix it",
  targetPaths: [],
  evidence: [],
  ...overrides,
});

const renderList = (props) => expandTree(DoctorFindingsList(props));

const actionButtons = (tree) =>
  collectNodes(tree).filter((vnode) => vnode.type === ActionButton);

const buttonByLabel = (tree, idleLabel) =>
  actionButtons(tree).find((vnode) => vnode.props.idleLabel === idleLabel);

describe("frontend/doctor-findings-list status action pending affordance", () => {
  it("shows an action-specific loading label on the clicked button and disables siblings", () => {
    const tree = renderList({
      cards: [makeCard()],
      busyAction: { cardId: 7, status: "fixed" },
    });
    const markFixed = buttonByLabel(tree, "Mark fixed");
    expect(markFixed.props.loading).toBe(true);
    expect(markFixed.props.loadingLabel).toBe("Marking fixed...");
    expect(buttonByLabel(tree, "Dismiss").props.disabled).toBe(true);
    expect(buttonByLabel(tree, "Ask agent to fix").props.disabled).toBe(true);
  });

  it("maps each status action to its own pending label", () => {
    const dismissing = renderList({
      cards: [makeCard()],
      busyAction: { cardId: 7, status: "dismissed" },
    });
    expect(buttonByLabel(dismissing, "Dismiss").props.loading).toBe(true);
    expect(buttonByLabel(dismissing, "Dismiss").props.loadingLabel).toBe(
      "Dismissing...",
    );
    expect(buttonByLabel(dismissing, "Mark fixed").props.disabled).toBe(true);

    const reopening = renderList({
      cards: [makeCard({ status: "fixed" })],
      busyAction: { cardId: 7, status: "open" },
    });
    expect(buttonByLabel(reopening, "Reopen").props.loading).toBe(true);
    expect(buttonByLabel(reopening, "Reopen").props.loadingLabel).toBe(
      "Reopening...",
    );

    const restoring = renderList({
      cards: [makeCard({ status: "dismissed" })],
      busyAction: { cardId: 7, status: "open" },
    });
    expect(buttonByLabel(restoring, "Restore").props.loading).toBe(true);
    expect(buttonByLabel(restoring, "Restore").props.loadingLabel).toBe(
      "Restoring...",
    );
  });

  it("leaves other cards fully interactive while one card is busy", () => {
    const tree = renderList({
      cards: [makeCard(), makeCard({ id: 8 })],
      busyAction: { cardId: 7, status: "fixed" },
    });
    const markFixedButtons = actionButtons(tree).filter(
      (vnode) => vnode.props.idleLabel === "Mark fixed",
    );
    expect(markFixedButtons.length).toBe(2);
    const otherCardButton = markFixedButtons.find((vnode) => !vnode.props.loading);
    expect(otherCardButton.props.disabled).toBe(false);
  });

  it("renders idle labels with nothing busy", () => {
    const tree = renderList({ cards: [makeCard()], busyAction: null });
    expect(buttonByLabel(tree, "Mark fixed").props.loading).toBe(false);
    expect(buttonByLabel(tree, "Mark fixed").props.disabled).toBe(false);
    expect(buttonByLabel(tree, "Dismiss").props.loading).toBe(false);
    expect(buttonByLabel(tree, "Dismiss").props.disabled).toBe(false);
  });
});

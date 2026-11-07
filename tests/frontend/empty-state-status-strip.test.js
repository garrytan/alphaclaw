import { describe, expect, it } from "vitest";
import { EmptyState } from "../../lib/public/js/components/empty-state.js";
import { StatusStrip } from "../../lib/public/js/components/status-strip.js";

const collectText = (node, out = []) => {
  if (node == null || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  collectText(node.props?.children, out);
  return out;
};

const findAll = (node, predicate, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  findAll(node.props?.children, predicate, out);
  return out;
};

describe("frontend/EmptyState", () => {
  it("renders a title, one sentence and an action", () => {
    const tree = EmptyState({ title: "No schedules yet", body: "Why.", action: "ACTION" });
    expect(collectText(tree)).toEqual(["No schedules yet", "Why.", "ACTION"]);
  });

  it("omits the body and action when absent", () => {
    const tree = EmptyState({ title: "Nothing" });
    expect(collectText(tree)).toEqual(["Nothing"]);
    expect(findAll(tree, (node) => node.props?.class === "ac-empty-state-action")).toHaveLength(0);
  });
});

describe("frontend/StatusStrip", () => {
  it("renders a labelled list with one cell per entry and its state", () => {
    const tree = StatusStrip({
      ariaLabel: "Usage summary",
      cells: [
        { key: "spend", label: "Spend 30d", value: "$2.00", detail: "today" },
        { key: "model", label: "Most used model", value: "m1", mono: true, title: "m1", href: "#/models" },
        { key: "turns", label: "Turns", value: "—", detail: "down", error: true },
        { key: "tokens", label: "Tokens", value: "—", loading: true },
      ],
    });
    expect(tree.props["aria-label"]).toBe("Usage summary");
    const cells = findAll(tree, (node) => node.type === "li");
    expect(cells.map((cell) => cell.props["data-state"])).toEqual(["loaded", "loaded", "error", "loading"]);
    const links = findAll(tree, (node) => node.type === "a");
    expect(links.map((link) => link.props.href)).toEqual(["#/models"]);
    const mono = findAll(tree, (node) => String(node.props?.class || "").includes("home-strip-value--mono"));
    expect(mono).toHaveLength(1);
    expect(mono[0].props.title).toBe("m1");
  });
});

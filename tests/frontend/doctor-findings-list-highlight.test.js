import { describe, expect, it } from "vitest";
import { DoctorFindingsList } from "../../lib/public/js/components/doctor/findings-list.js";

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

const makeCard = (overrides = {}) => ({
  id: 7,
  runId: 42,
  priority: "P0",
  title: "Hardening blocked",
  category: "project context",
  status: "open",
  summary: "Safety rules are not injected.",
  recommendation: "Restart AlphaClaw.",
  targetPaths: [],
  evidence: [],
  sourceKey: "det:hardening:blocked",
  ...overrides,
});

const cardContainers = (tree) =>
  collectNodes(tree).filter((node) =>
    String(node.props?.class || "").includes("doctor-finding "),
  );

describe("frontend/doctor findings list focus highlight", () => {
  it("only the card matching highlightCardId gets the incident cyan border (string/number id tolerant)", () => {
    const tree = DoctorFindingsList({
      cards: [makeCard({ id: 7 }), makeCard({ id: 8, title: "Other" })],
      highlightCardId: "7",
    });
    const containers = cardContainers(tree);
    expect(containers).toHaveLength(2);
    expect(containers[0].props.class).toContain("is-highlighted");
    expect(containers[1].props.class).not.toContain("is-highlighted");
  });

  it("no card is highlighted when highlightCardId is empty", () => {
    const tree = DoctorFindingsList({
      cards: [makeCard({ id: 7 })],
      highlightCardId: "",
    });
    const containers = cardContainers(tree);
    expect(containers).toHaveLength(1);
    expect(containers[0].props.class).not.toContain("is-highlighted");
  });
});

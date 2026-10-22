import { describe, expect, it, vi } from "vitest";

const kState = { value: null };
vi.mock("../../lib/public/js/components/team-tab/use-team-tab.js", () => ({
  useTeamTab: () => kState.value,
}));

import { TeamTab } from "../../lib/public/js/components/team-tab/index.js";

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

const componentNames = (tree) =>
  collectNodes(tree)
    .map((node) => (typeof node.type === "function" ? node.type.name : null))
    .filter(Boolean);

const renderFor = (team) => {
  kState.value = { team, loading: false, loadError: null, setWizardOpen: () => {} };
  return TeamTab({});
};

describe("frontend/team-tab enable entry (refactor plan PR 16a)", () => {
  it("an admin gets the intro card even when the route reports the capability missing", () => {
    const tree = renderFor({
      enabled: false,
      me: { role: "admin" },
      capability: { trustedProxyTeam: false },
    });
    const names = componentNames(tree);
    expect(names).toContain("IntroCard");
    expect(names).not.toContain("UpsellCard");
  });

  it("a member never gets the intro card", () => {
    const tree = renderFor({ enabled: false, me: { role: "member" }, capability: { trustedProxyTeam: true } });
    expect(componentNames(tree)).not.toContain("IntroCard");
  });
});

import { describe, expect, it } from "vitest";
import { GmailWatchToggle } from "../../lib/public/js/components/google/gmail-watch-toggle.js";
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

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const kAccount = {
  id: "a1",
  email: "ada@example.com",
  activeScopes: ["gmail:read"],
};

const render = (props) => GmailWatchToggle({ account: kAccount, ...props });

describe("frontend/gmail-watch-toggle watch-not-running state", () => {
  it("enabled-but-not-running renders a danger 'Watch not running' TooltipBadge — never a bare 'Error'", () => {
    const tree = render({ watchStatus: { enabled: true, running: false } });
    const chips = findAllByType(tree, TooltipBadge);
    expect(chips).toHaveLength(1);
    expect(chips[0].props.tone).toBe("danger");
    // Self-standing label stating the observed fact.
    expect(chips[0].props.label).toBe("Watch not running");
    expect(chips[0].props.label).not.toBe("Error");
    // Supplementary remediation rides the tooltip.
    expect(chips[0].props.text).toContain("Pub/Sub");
    expect(chips[0].props.text).toContain("renew the watch");
  });

  it("a healthy running watch keeps the plain success Badge with no tooltip", () => {
    const tree = render({ watchStatus: { enabled: true, running: true } });
    expect(findAllByType(tree, TooltipBadge)).toHaveLength(0);
    const badge = findAllByType(tree, Badge)[0];
    expect(badge.props.tone).toBe("success");
  });

  it("a disabled watch stays the neutral Stopped badge (no danger, no tooltip)", () => {
    const tree = render({ watchStatus: { enabled: false, running: false } });
    expect(findAllByType(tree, TooltipBadge)).toHaveLength(0);
    const badge = findAllByType(tree, Badge)[0];
    expect(badge.props.tone).toBe("neutral");
  });
});

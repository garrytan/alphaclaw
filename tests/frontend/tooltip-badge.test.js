import { describe, expect, it } from "vitest";
import { TooltipBadge } from "../../lib/public/js/components/tooltip-badge.js";

const walk = (node, predicate) => {
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = walk(child, predicate);
    if (found) return found;
  }
  return null;
};

describe("frontend/tooltip badge", () => {
  it("keeps the visible label as the accessible name and wires describedby", () => {
    const vnode = TooltipBadge({
      tone: "danger",
      label: "Blocked",
      text: "cause\nfix",
    });
    // The trigger references the tooltip panel as DESCRIPTION — never
    // replaces the visible label as the accessible name.
    const trigger = walk(vnode, (node) => node.props?.["aria-describedby"]);
    expect(trigger).not.toBe(null);
    expect(trigger.props["aria-describedby"]).toMatch(/^ac-tooltip-/);
    expect(trigger.props.tabindex).toBe("0");
    // The Tooltip receives the matching id and pre-line formatting.
    expect(vnode.props.tooltipId).toBe(trigger.props["aria-describedby"]);
    expect(vnode.props.tooltipClassName).toBe("whitespace-pre-line");
    expect(vnode.props.text).toBe("cause\nfix");
  });

  it("renders a plain badge when there is no supplementary text", () => {
    const vnode = TooltipBadge({ tone: "warning", label: "Partial", text: "" });
    expect(vnode.props.tooltipId).toBeUndefined();
    expect(vnode.props.tone).toBe("warning");
  });
});

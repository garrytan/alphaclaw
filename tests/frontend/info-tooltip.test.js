import { describe, expect, it, vi } from "vitest";
import { InfoTooltip } from "../../lib/public/js/components/info-tooltip.js";
import { Tooltip } from "../../lib/public/js/components/tooltip.js";

describe("frontend/info tooltip", () => {
  it("renders no unnamed tab stop when there is no text", () => {
    expect(InfoTooltip({ text: "" })).toBe(null);
    expect(InfoTooltip({ text: "   " })).toBe(null);
    expect(InfoTooltip({})).toBe(null);
  });

  it("is a named, focusable mark inside a Tooltip", () => {
    const tree = InfoTooltip({ text: "What this does" });
    expect(tree.type).toBe(Tooltip);
    const mark = tree.props.children;
    expect(mark.props.tabindex).toBe("0");
    expect(mark.props.role).toBe("img");
    expect(mark.props["aria-label"]).toBe("What this does");
  });

  it("keeps Space on the focused mark from scrolling the page", () => {
    const mark = InfoTooltip({ text: "What this does" }).props.children;
    const space = { key: " ", preventDefault: vi.fn() };
    mark.props.onKeyDown(space);
    expect(space.preventDefault).toHaveBeenCalledTimes(1);
    const tab = { key: "Tab", preventDefault: vi.fn() };
    mark.props.onKeyDown(tab);
    expect(tab.preventDefault).not.toHaveBeenCalled();
  });
});

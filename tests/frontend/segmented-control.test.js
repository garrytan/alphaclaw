import { describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "../../lib/public/js/components/segmented-control.js";
import { Tooltip } from "../../lib/public/js/components/tooltip.js";

const buttonsOf = (tree) =>
  tree.props.children.map((child) => (child.type === Tooltip ? child.props.children : child));

describe("frontend/segmented control", () => {
  const kOptions = [
    { label: "7d", value: "7d" },
    { label: "30d", value: "30d", title: "Last 30 days" },
  ];

  it("gives every option type=button and aria-pressed for the selected value", () => {
    const buttons = buttonsOf(SegmentedControl({ options: kOptions, value: "30d" }));
    expect(buttons.map((button) => button.props.type)).toEqual(["button", "button"]);
    expect(buttons.map((button) => button.props["aria-pressed"])).toEqual(["false", "true"]);
  });

  it("keeps the change and disabled behaviour", () => {
    const onChange = vi.fn();
    const buttons = buttonsOf(SegmentedControl({ options: kOptions, value: "7d", onChange }));
    buttons[1].props.onclick();
    expect(onChange).toHaveBeenCalledWith("30d");
    const disabled = buttonsOf(SegmentedControl({ options: kOptions, value: "7d", onChange, disabled: true }));
    disabled[0].props.onclick();
    expect(disabled[0].props.disabled).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

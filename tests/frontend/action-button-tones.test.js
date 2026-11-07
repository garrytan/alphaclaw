import { describe, expect, it } from "vitest";
import {
  ActionButton,
  getActionButtonToneClass,
} from "../../lib/public/js/components/action-button.js";

const kRawPalette = /\b(?:bg|text|border)-(?:gray|green|yellow|red|blue|purple|cyan|indigo)-\d/;
const buttonClass = (props) => String(ActionButton({ idleLabel: "Go", ...props }).props.class);

describe("frontend/action button tones", () => {
  it("maps every tone to a token-backed ac-btn class", () => {
    expect(getActionButtonToneClass("primary", true)).toBe("ac-btn-cyan");
    expect(getActionButtonToneClass("secondary", true)).toBe("ac-btn-secondary");
    expect(getActionButtonToneClass("success", true)).toBe("ac-btn-green");
    expect(getActionButtonToneClass("danger", true)).toBe("ac-btn-danger");
    expect(getActionButtonToneClass("ghost", true)).toBe("ac-btn-ghost");
    expect(getActionButtonToneClass("neutral", true)).toBe("ac-btn-neutral");
    expect(getActionButtonToneClass("warning", true)).toBe("ac-btn-warning");
    expect(getActionButtonToneClass("unknown", true)).toBe("ac-btn-cyan");
  });

  it("keeps subtle as an alias of neutral", () => {
    expect(buttonClass({ tone: "subtle" })).toBe(buttonClass({ tone: "neutral" }));
    expect(buttonClass({ tone: "subtle", disabled: true })).toBe(
      buttonClass({ tone: "neutral", disabled: true }),
    );
  });

  it("uses no raw palette classes for any tone", () => {
    for (const tone of ["primary", "secondary", "success", "danger", "ghost", "neutral", "subtle", "warning"]) {
      expect(buttonClass({ tone })).not.toMatch(kRawPalette);
    }
  });

  it("dims a plain-disabled neutral or warning button but not a loading one", () => {
    expect(getActionButtonToneClass("neutral", false)).toContain("opacity-50");
    expect(getActionButtonToneClass("warning", false)).toContain("cursor-not-allowed");
    expect(getActionButtonToneClass("neutral", false, true)).toBe("ac-btn-neutral");
    expect(getActionButtonToneClass("primary", false)).toBe("ac-btn-cyan");
  });

  it("keeps the button API", () => {
    const vnode = ActionButton({ idleLabel: "Save", tone: "warning", type: "submit", ariaLabel: "Save key" });
    expect(vnode.type).toBe("button");
    expect(vnode.props.type).toBe("submit");
    expect(vnode.props["aria-label"]).toBe("Save key");
    expect(vnode.props.disabled).toBe(false);
  });
});

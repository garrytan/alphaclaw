import { describe, expect, it } from "vitest";
import { Badge, resolveBadgeTone } from "../../lib/public/js/components/badge.js";

const kRawPalette = /\b(?:bg|text|border)-(?:gray|green|yellow|red|blue|purple|cyan|indigo)-\d/;
const classOf = (tone) => String(Badge({ tone, children: "x" }).props.class);

describe("frontend/badge tones", () => {
  it("renders the five status tones from the tone tokens", () => {
    for (const tone of ["ok", "warn", "bad", "accent", "neutral"]) {
      const cls = classOf(tone);
      expect(cls).toContain(`bg-tone-${tone}-bg`);
      expect(cls).toContain(`text-tone-${tone}`);
      expect(cls).not.toMatch(kRawPalette);
    }
  });

  it("keeps the older tone names as aliases", () => {
    expect(resolveBadgeTone("success")).toBe("ok");
    expect(resolveBadgeTone("warning")).toBe("warn");
    expect(resolveBadgeTone("danger")).toBe("bad");
    expect(resolveBadgeTone("info")).toBe("accent");
    expect(resolveBadgeTone("cyan")).toBe("accent");
    expect(resolveBadgeTone("secondary")).toBe("neutral");
    expect(resolveBadgeTone("subtle")).toBe("neutral");
    expect(classOf("success")).toBe(classOf("ok"));
    expect(classOf("subtle")).toBe(classOf("neutral"));
  });

  it("falls back to neutral for a missing or unknown tone", () => {
    expect(resolveBadgeTone(undefined)).toBe("neutral");
    expect(resolveBadgeTone("nope")).toBe("neutral");
    expect(String(Badge({ children: "x" }).props.class)).toBe(classOf("neutral"));
  });

  it("keeps the badge markup and children", () => {
    const vnode = Badge({ tone: "ok", children: "Running" });
    expect(vnode.type).toBe("span");
    expect(String(vnode.props.class)).toContain("rounded-full");
    expect(vnode.props.children).toBe("Running");
  });
});

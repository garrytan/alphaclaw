import { describe, expect, it } from "vitest";
import {
  OpenclawPinWarning,
  getOpenclawPinWarning,
} from "../../lib/public/js/components/general/openclaw-pin-warning.js";

const collectText = (node, out = []) => {
  if (node == null || typeof node === "boolean") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node !== "object") {
    out.push(String(node));
    return out;
  }
  if (node.props) collectText(node.props.children, out);
  return out;
};

describe("frontend/general OpenClaw pin warning", () => {
  it("renders nothing for a matching install, an undeclared pin, or an old server", () => {
    expect(getOpenclawPinWarning({ state: "match", installed: "2026.10.4", pinned: "2026.10.4" })).toBe(null);
    expect(getOpenclawPinWarning({ state: "unknown", installed: "2026.10.4", pinned: null })).toBe(null);
    expect(getOpenclawPinWarning(null)).toBe(null);
    expect(OpenclawPinWarning({ openclawPin: null })).toBe(null);
  });

  it("names both versions when the install diverged from the pin", () => {
    const warning = getOpenclawPinWarning({ state: "diverged", installed: "2026.10.2", pinned: "2026.10.4" });
    expect(warning.title).toBe("OpenClaw is not the pinned version");
    expect(warning.body).toContain("OpenClaw 2026.10.2 is installed");
    expect(warning.body).toContain("pins 2026.10.4");
  });

  it("renders the unreadable warning as a status region", () => {
    const vnode = OpenclawPinWarning({ openclawPin: { state: "unreadable", installed: null, pinned: "2026.10.4" } });
    expect(vnode.props.role).toBe("status");
    const text = collectText(vnode).join(" ");
    expect(text).toContain("OpenClaw version unreadable");
    expect(text).toContain("pins 2026.10.4");
  });
});

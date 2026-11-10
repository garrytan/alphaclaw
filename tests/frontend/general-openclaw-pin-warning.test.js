import { describe, expect, it } from "vitest";
import {
  OpenclawPinWarning,
  describeOpenclawHold,
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

  it("a deliberate hold warns nobody and the version line says it is held (GST-2293)", () => {
    const held = { state: "held", installed: "2026.10.9", pinned: "2026.11.2", held: "2026.10.9" };
    expect(getOpenclawPinWarning(held)).toBe(null);
    expect(describeOpenclawHold(held)).toBe("held (pin 2026.11.2)");
    expect(describeOpenclawHold({ state: "match", installed: "2026.11.2", pinned: "2026.11.2" })).toBe(null);
    const tooOld = getOpenclawPinWarning({
      state: "diverged", installed: "2026.10.4", pinned: "2026.11.2", held: "2026.10.4", floor: "2026.10.9", reason: "below_floor",
    });
    expect(tooOld.body).toContain("holds OpenClaw at 2026.10.4, older than 2026.10.9");
  });

  it("renders the unreadable warning as a status region", () => {
    const vnode = OpenclawPinWarning({ openclawPin: { state: "unreadable", installed: null, pinned: "2026.10.4" } });
    expect(vnode.props.role).toBe("status");
    const text = collectText(vnode).join(" ");
    expect(text).toContain("OpenClaw version unreadable");
    expect(text).toContain("pins 2026.10.4");
  });
});

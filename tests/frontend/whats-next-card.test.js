import { describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => ({
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useRef: (v = null) => ({ current: v }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: () => {},
}));

import { WhatsNextCard } from "../../lib/public/js/components/general/whats-next-card.js";

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    if (typeof node.type === "function") {
      try {
        collectText(node.type(node.props || {}), out);
      } catch {}
    }
    if (node.props) collectText(node.props.children, out);
  }
  return out;
};

const renderText = (props) =>
  collectText(WhatsNextCard(props)).join(" ").replace(/\s+/g, " ");

describe("frontend/whats-next-card (E4/D14)", () => {
  it("shows the add-a-channel row when no channels are configured", () => {
    const text = renderText({ channels: {} });
    expect(text).toContain("What's next");
    expect(text).toContain("Add a chat channel");
    expect(text).toContain("Review your update channel");
    expect(text).toContain("Connect Google Workspace");
    expect(text).toContain("Hide for now");
  });

  it("auto-hides the channel row once a channel exists", () => {
    const text = renderText({ channels: { telegram: { status: "ok" } } });
    expect(text).not.toContain("Add a chat channel");
    expect(text).toContain("Review your update channel");
  });

  it("uses the D14 wording: Review, not pick", () => {
    const text = renderText({ channels: {} });
    expect(text).not.toContain("pick a release channel");
    expect(text).toContain("Review your update channel");
  });
});

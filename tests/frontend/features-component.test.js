import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: vi.fn(),
}));

vi.mock("../../lib/public/js/lib/api.js", () => ({
  fetchEnvVars: vi.fn(),
}));

import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { AsyncSection } from "../../lib/public/js/components/async-section.js";
import { Features } from "../../lib/public/js/components/features.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";

// Stateless component (its only hook is the mocked useCachedFetch): invoke it
// directly and walk the vnode tree — no DOM renderer needed.
const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  const out = { type: node.type, props: { ...(node.props || {}) } };
  if (typeof node.type === "function") {
    try {
      out.rendered = expandTree(node.type(node.props || {}));
    } catch {
      out.rendered = null;
    }
  }
  if (out.props.children !== undefined) {
    out.props = { ...out.props, children: expandTree(out.props.children) };
  }
  return out;
};

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  if (node.rendered) collectNodes(node.rendered, out);
  return out;
};

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
    if (node.props) collectText(node.props.children, out);
    if (node.rendered) collectText(node.rendered, out);
  }
  return out;
};

const renderFeatures = () => expandTree(Features({ onSwitchTab: () => {} }));

// AsyncSection's unrendered `children` prop always carries the badge markup;
// what the user sees is only its RENDERED branch.
const visibleRegionText = (tree) => {
  const region = collectNodes(tree).find((node) => node.type === AsyncSection);
  return collectText(region.rendered).join(" ");
};

describe("frontend/features card", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the frame with a scoped loading state instead of vanishing", () => {
    useCachedFetch.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refresh: vi.fn(async () => {}),
    });
    const tree = renderFeatures();
    expect(collectText(tree).join(" ")).toContain("Features");
    const regionText = visibleRegionText(tree);
    expect(regionText).toContain("Loading feature status...");
    expect(regionText).not.toContain("Disabled");
  });

  it("renders an inline error + Retry on load failure — never confident 'Disabled' badges", () => {
    const refresh = vi.fn(async () => {});
    useCachedFetch.mockReturnValue({
      data: null,
      loading: false,
      error: new Error("env boom"),
      refresh,
    });
    const tree = renderFeatures();
    const regionText = visibleRegionText(tree);
    expect(regionText).toContain("Couldn't load feature status.");
    expect(regionText).not.toContain("Disabled");

    const chip = collectNodes(tree).find((node) => node.type === InlineErrorChip);
    chip.props.onRetry();
    expect(refresh).toHaveBeenCalledWith({ force: true });
  });

  it("renders badges from data, even while a background refresh is in flight", () => {
    useCachedFetch.mockReturnValue({
      data: { vars: [] },
      loading: true,
      error: null,
      refresh: vi.fn(async () => {}),
    });
    const tree = renderFeatures();
    const regionText = visibleRegionText(tree);
    expect(regionText).toContain("Disabled");
    expect(regionText).toContain("Add provider");
    expect(regionText).not.toContain("Loading feature status...");
  });

  it("keeps last-known-good badges when a later refresh fails", () => {
    useCachedFetch.mockReturnValue({
      data: { vars: [{ key: "OPENAI_API_KEY", value: "sk-x" }] },
      loading: false,
      error: new Error("stale refresh boom"),
      refresh: vi.fn(async () => {}),
    });
    const tree = renderFeatures();
    const regionText = visibleRegionText(tree);
    expect(regionText).toContain("Enabled");
    expect(regionText).not.toContain("Couldn't load feature status.");
  });
});

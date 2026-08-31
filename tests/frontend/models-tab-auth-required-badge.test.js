import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal hook harness (models-tab-index-component.test.js pattern):
// components are invoked directly and the vnode tree is walked.
vi.mock("preact/hooks", () => ({
  useState: (initialValue) => [
    typeof initialValue === "function" ? initialValue() : initialValue,
    () => {},
  ],
  useEffect: () => {},
  useRef: (initialValue = null) => ({ current: initialValue }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
}));

vi.mock("../../lib/public/js/components/models-tab/use-models.js", () => ({
  useModels: vi.fn(),
  kCodexStatusCacheKey: "/api/codex/status",
}));

import { useModels } from "../../lib/public/js/components/models-tab/use-models.js";
import { Models } from "../../lib/public/js/components/models-tab/index.js";
import { TooltipBadge } from "../../lib/public/js/components/tooltip-badge.js";

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

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object" && node.props) {
    collectText(node.props.children, out);
  }
  return out;
};

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const kModelsBase = {
  catalog: [],
  primary: "",
  configuredModels: {},
  authProfiles: [],
  authOrder: {},
  codexStatus: { connected: false },
  codexStatusError: "",
  codexStatusKnown: false,
  loading: false,
  saving: false,
  ready: true,
  error: null,
  isDirty: false,
  addModel: vi.fn(),
  removeModel: vi.fn(),
  setPrimaryModel: vi.fn(),
  editProfile: vi.fn(),
  editAuthOrder: vi.fn(),
  getProfileValue: vi.fn(() => null),
  getEffectiveOrder: vi.fn(() => []),
  cancelChanges: vi.fn(),
  saveAll: vi.fn(),
  refreshCodexStatus: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("frontend/models-tab authentication-required badge", () => {
  it("a configured model whose provider lacks auth gets a self-standing TooltipBadge, not bare 'Needs auth'", () => {
    useModels.mockReturnValue({
      ...kModelsBase,
      configuredModels: { "anthropic/claude-opus-4-6": {} },
    });
    const tree = Models({ agentId: "main" });

    const chips = findAllByType(tree, TooltipBadge).filter(
      (chip) => chip.props.label === "Authentication required",
    );
    expect(chips).toHaveLength(1);
    expect(chips[0].props.tone).toBe("warning");
    // Supplementary detail names where to fix it.
    expect(chips[0].props.text).toContain("Providers");
    // The old bare label is gone.
    expect(collectText(tree).join(" ")).not.toContain("Needs auth");
  });

  it("a model whose provider HAS auth renders the Set primary control instead of the badge", () => {
    useModels.mockReturnValue({
      ...kModelsBase,
      configuredModels: { "openai-codex/gpt-5.6-sol": {} },
      codexStatus: { connected: true },
      codexStatusKnown: true,
    });
    const tree = Models({ agentId: "main" });

    expect(
      findAllByType(tree, TooltipBadge).filter(
        (chip) => chip.props.label === "Authentication required",
      ),
    ).toHaveLength(0);
    expect(collectText(tree).join(" ")).toContain("Set primary");
  });
});

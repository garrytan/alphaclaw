import { beforeEach, describe, expect, it, vi } from "vitest";

// channels.js transitively imports channel-login-modal, which uses CDN URL
// imports the node ESM loader can't resolve.
vi.mock("../../lib/public/js/components/channels.js", () => ({
  ALL_CHANNELS: ["telegram", "discord", "slack", "whatsapp"],
  CREATABLE_CHANNELS: ["telegram", "discord", "slack", "whatsapp"],
  ChannelsCard: () => null,
  getChannelMeta: (id) => ({ label: String(id || "") }),
}));

vi.mock(
  "../../lib/public/js/components/agents-tab/agent-bindings-section/use-agent-bindings.js",
  () => ({
    useAgentBindings: vi.fn(),
    // Real implementation: the shared key builder the row's pending compare
    // uses — mocking it away would decouple the test from the set side.
    buildBindKey: (provider, accountId) =>
      `${String(provider || "").trim()}:${String(accountId || "").trim() || "default"}`,
  }),
);

vi.mock(
  "../../lib/public/js/components/agents-tab/agent-bindings-section/use-channel-items.js",
  () => ({ useChannelItems: vi.fn(() => ({ mergedChannelItems: [] })) }),
);

import { useAgentBindings } from "../../lib/public/js/components/agents-tab/agent-bindings-section/use-agent-bindings.js";
import { AgentBindingsSection } from "../../lib/public/js/components/agents-tab/agent-bindings-section/index.js";
import { ChannelItemTrailing } from "../../lib/public/js/components/agents-tab/agent-bindings-section/channel-item-trailing.js";
import { InlineErrorChip } from "../../lib/public/js/components/inline-error-chip.js";
import { ChannelsCard } from "../../lib/public/js/components/channels.js";

// Shallow walk (no function-component rendering): assertions target vnode
// props, which exist without a DOM renderer.
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

const kBaseHookState = {
  agentId: "a1",
  agentNameMap: new Map(),
  channelStatus: {},
  channels: [],
  configuredChannelMap: new Map(),
  configuredChannels: [],
  createLoadingLabel: "Creating...",
  createProvider: "",
  defaultAgentId: "a1",
  deletingAccount: null,
  editingAccount: null,
  handleCreateChannel: vi.fn(),
  handleDeleteChannel: vi.fn(),
  handleQuickBind: vi.fn(),
  handleUpdateChannel: vi.fn(),
  isDefaultAgent: true,
  loadError: null,
  loading: false,
  menuOpenId: "",
  openCreateChannelModal: vi.fn(),
  openDeleteChannelDialog: vi.fn(),
  openEditChannelModal: vi.fn(),
  pendingBindAccount: null,
  pendingBindKey: "",
  refreshing: false,
  requestBindAccount: vi.fn(),
  retryLoad: vi.fn(),
  saving: false,
  setCreateProvider: vi.fn(),
  setDeletingAccount: vi.fn(),
  setEditingAccount: vi.fn(),
  setMenuOpenId: vi.fn(),
  setPendingBindAccount: vi.fn(),
  setShowCreateModal: vi.fn(),
  showCreateModal: false,
};

describe("frontend/agents-tab bindings section component", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders a retryable error card when the initial load failed with no data", () => {
    const retryLoad = vi.fn();
    useAgentBindings.mockReturnValue({
      ...kBaseHookState,
      loadError: new Error("channels down"),
      retryLoad,
    });

    const tree = AgentBindingsSection({ agent: { id: "a1" }, agents: [] });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips).toHaveLength(1);
    expect(chips[0].props.headline).toBe("Couldn't load channels.");

    chips[0].props.onRetry();
    expect(retryLoad).toHaveBeenCalledTimes(1);
  });

  it("keeps the list rendered with a refresh-error chip when data exists", () => {
    useAgentBindings.mockReturnValue({
      ...kBaseHookState,
      channels: [{ channel: "telegram", accounts: [{ id: "default" }] }],
      loadError: new Error("refresh failed"),
    });

    const tree = AgentBindingsSection({ agent: { id: "a1" }, agents: [] });
    const chips = findAllByType(tree, InlineErrorChip);
    expect(chips).toHaveLength(1);
    expect(chips[0].props.headline).toContain("Couldn't refresh channels");
    expect(findAllByType(tree, ChannelsCard)).toHaveLength(1);
  });

  it("shows no error chip when loading succeeds", () => {
    useAgentBindings.mockReturnValue({
      ...kBaseHookState,
      channels: [{ channel: "telegram", accounts: [{ id: "default" }] }],
    });

    const tree = AgentBindingsSection({ agent: { id: "a1" }, agents: [] });
    expect(findAllByType(tree, InlineErrorChip)).toHaveLength(0);
  });

  describe("ChannelItemTrailing bind affordance", () => {
    const kAvailableItem = {
      accountData: { id: "default", provider: "telegram" },
      accountId: "default",
      channel: "telegram",
      isAvailable: true,
      isOwned: false,
    };

    const findBindButton = (tree) =>
      findAllByType(tree, "button").find((vnode) => {
        const text = collectText(vnode).join(" ");
        return text.includes("Bind");
      });

    it("shows Binding... on the pending row and disables the button", () => {
      const tree = ChannelItemTrailing({
        item: kAvailableItem,
        bindPendingKey: "telegram:default",
        bindDisabled: true,
      });
      const button = findBindButton(tree);
      expect(collectText(button).join(" ")).toContain("Binding...");
      expect(button.props.disabled).toBe(true);
    });

    it("disables sibling Bind buttons while another bind is in flight", () => {
      const tree = ChannelItemTrailing({
        item: kAvailableItem,
        bindPendingKey: "discord:default",
        bindDisabled: true,
      });
      const button = findBindButton(tree);
      expect(collectText(button).join(" ")).toContain("Bind");
      expect(collectText(button).join(" ")).not.toContain("Binding...");
      expect(button.props.disabled).toBe(true);
    });

    it("renders an enabled Bind button when nothing is in flight", () => {
      const tree = ChannelItemTrailing({ item: kAvailableItem });
      const button = findBindButton(tree);
      expect(collectText(button).join(" ")).toContain("Bind");
      expect(button.props.disabled).toBe(false);
    });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// The Channels and Integrations pages (ALPH-69 PR 3a) render every card the
// General card disposition moved to them (DESIGN.md).
vi.mock("preact/hooks", () => ({
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: (v = null) => ({ current: v }),
}));
// channel-login-modal.js imports preact from a CDN URL, which Node's ESM
// loader can't resolve in tests — stub the whole module.
vi.mock("../../lib/public/js/components/channel-login-modal.js", () => ({
  ChannelLoginModal: () => null,
  kPreservedChannelLoginModalState: {},
  cloneLoginModalState: (value) => ({ ...(value || {}) }),
}));
vi.mock("../../lib/public/js/components/general/use-general-tab.js", () => ({ useGeneralTab: vi.fn() }));
vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({ useCachedFetch: vi.fn() }));
vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: vi.fn(() => ({ data: null, error: null, refresh: async () => null, isPolling: false })),
}));

import { useGeneralTab } from "../../lib/public/js/components/general/use-general-tab.js";
import { useCachedFetch } from "../../lib/public/js/hooks/use-cached-fetch.js";
import { usePolling } from "../../lib/public/js/hooks/usePolling.js";
import {
  ChannelPairingsSection,
  ChannelsRoute,
  DeviceApprovalsCard,
  kChannelsEmptyCopy,
} from "../../lib/public/js/components/routes/channels-route.js";
import { IntegrationLinkRow, IntegrationsRoute } from "../../lib/public/js/components/routes/integrations-route.js";
import { RoutePageHeader } from "../../lib/public/js/components/page-header.js";
import { Channels } from "../../lib/public/js/components/channels/index.js";
import { ChannelOperationsPanel } from "../../lib/public/js/components/channel-operations-panel.js";
import { Pairings } from "../../lib/public/js/components/pairings.js";
import { DevicePairings } from "../../lib/public/js/components/device-pairings.js";
import { AddChannelMenu } from "../../lib/public/js/components/add-channel-menu.js";
import { ActionButton } from "../../lib/public/js/components/action-button.js";
import { Google } from "../../lib/public/js/components/google/index.js";
import { Features } from "../../lib/public/js/components/features.js";
import { ApiFeaturePanel } from "../../lib/public/js/components/api-feature-panel.js";
import { AgentAdminPanel } from "../../lib/public/js/components/agent-admin-panel.js";

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) {
    collectNodes(node.props.children, out);
    for (const value of Object.values(node.props)) {
      if (value && typeof value === "object" && value !== node.props.children) collectNodes(value, out);
    }
  }
  return out;
};
const byType = (tree, type) => collectNodes(tree).filter((vnode) => vnode.type === type);
const textOf = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") out.push(String(node));
  else if (Array.isArray(node)) node.forEach((child) => textOf(child, out));
  else if (node?.props) textOf(node.props.children, out);
  return out;
};

const actions = new Proxy({}, { get: (_target, key) => (key === "then" ? undefined : vi.fn()) });
const mockState = (state = {}) =>
  useGeneralTab.mockReturnValue({
    state: { channels: { telegram: { status: "paired" } }, pending: [], devicePending: [], hasUnpaired: false, ...state },
    actions,
  });

beforeEach(() => {
  mockState();
  useCachedFetch.mockReturnValue({ data: null, error: null, loading: false, refresh: async () => null });
});

describe("frontend/channels page", () => {
  it("renders the channel accounts, pairings and device approvals under its header", () => {
    const tree = ChannelsRoute({ agents: [{ id: "main" }] });
    expect(byType(tree, RoutePageHeader)[0].props.routeId).toBe("channels");
    const panel = byType(tree, ChannelOperationsPanel);
    expect(panel).toHaveLength(1);
    const channels = byType(panel[0].props.channelsSection, Channels);
    expect(channels).toHaveLength(1);
    expect(channels[0].props.emptyLabel).toBe(kChannelsEmptyCopy);
    expect(byType(tree, ChannelPairingsSection)).toHaveLength(1);
    expect(byType(tree, DeviceApprovalsCard)).toHaveLength(1);
  });

  it("puts Add channel in the page header as the page's one solid button", () => {
    const menu = AddChannelMenu({ triggerLabel: "Add channel" });
    const trigger = menu.props.renderTrigger({ onToggle: () => {}, ariaLabel: "Add channel", title: "Add channel" });
    const button = byType(trigger, ActionButton)[0] || trigger;
    expect(button.props).toMatchObject({ tone: "solid", idleLabel: "Add channel" });
    const iconTrigger = AddChannelMenu({}).props.renderTrigger({ onToggle: () => {}, ariaLabel: "a", title: "t" });
    expect((byType(iconTrigger, ActionButton)[0] || iconTrigger).props.tone).toBe("subtle");
  });

  it("shows chat pairing requests, or the WhatsApp QR prompt while WhatsApp waits", () => {
    const pending = [{ id: "p1", channel: "telegram" }];
    const pairings = ChannelPairingsSection({ state: { pending, channels: {} }, actions });
    expect(pairings.type).toBe(Pairings);
    expect(pairings.props).toMatchObject({ pending, visible: true });
    const whatsapp = ChannelPairingsSection({
      state: { hasUnpaired: true, pending: [], channels: { whatsapp: { status: "configured" } } },
      actions,
    });
    expect(textOf(whatsapp).join(" ")).toContain("WhatsApp needs to be linked");
  });

  it("keeps polling device approvals while the page is open", () => {
    ChannelsRoute({});
    expect(useGeneralTab.mock.calls.at(-1)[0]).toMatchObject({ isActive: true, keepPollingDevices: true });
  });

  it("lists pending devices, or says none are waiting", () => {
    const withDevices = DeviceApprovalsCard({ pending: [{ id: "d1" }] });
    expect(byType(withDevices, DevicePairings)[0].props).toMatchObject({ embedded: true, approveTone: "secondary" });
    expect(textOf(DeviceApprovalsCard({ pending: [] })).join(" ")).toContain("No devices are waiting.");
  });
});

describe("frontend/integrations page", () => {
  it("renders Google, Features, the API and Agent administration cards", () => {
    const tree = IntegrationsRoute({ statusData: { agentAdmin: { enabled: true } } });
    expect(byType(tree, RoutePageHeader)[0].props).toMatchObject({ routeId: "integrations" });
    expect(byType(tree, RoutePageHeader)[0].props.actions).toBeUndefined();
    for (const card of [Google, Features, ApiFeaturePanel, AgentAdminPanel]) {
      expect(byType(tree, card), card.name).toHaveLength(1);
    }
    expect(byType(tree, AgentAdminPanel)[0].props.agentAdmin).toEqual({ enabled: true });
  });

  const reads = (byKey) =>
    useCachedFetch.mockImplementation((key) => ({ data: null, error: null, loading: false, ...(byKey[key] || {}) }));

  it("links through to Webhooks and Nodes with their counts", () => {
    reads({
      "/api/webhooks": { data: { webhooks: [{}, {}, {}] } },
      "/api/nodes": { data: { nodes: [{ connected: true }, { connected: false }] } },
    });
    const rows = byType(IntegrationsRoute({}), IntegrationLinkRow).map((row) => row.props);
    expect(rows).toEqual([
      { href: "#/webhooks", title: "Webhooks", detail: "3 hooks" },
      { href: "#/nodes", title: "Nodes", detail: "1 connected" },
    ]);
  });

  it("reads nodes once on mount instead of polling them", () => {
    reads({});
    IntegrationsRoute({});
    expect(useCachedFetch.mock.calls.filter(([key]) => key === "/api/nodes")).toHaveLength(1);
    expect(usePolling.mock.calls.filter(([, , options]) => options?.cacheKey === "/api/nodes")).toEqual([]);
  });

  it("says the nodes read failed rather than 0 connected", () => {
    reads({ "/api/nodes": { error: new Error("spawn failed") } });
    const nodes = byType(IntegrationsRoute({}), IntegrationLinkRow).find((row) => row.props.title === "Nodes");
    expect(nodes.props.detail).toBe("Couldn't load nodes");
  });

  it("shows a failed re-read even when an earlier read is cached", () => {
    reads({ "/api/nodes": { data: { nodes: [] }, error: new Error("spawn failed") } });
    const nodes = byType(IntegrationsRoute({}), IntegrationLinkRow).find((row) => row.props.title === "Nodes");
    expect(nodes.props.detail).toBe("Couldn't load nodes");
  });

  it("shows a dash while the counts load", () => {
    reads({});
    const rows = byType(IntegrationsRoute({}), IntegrationLinkRow).map((row) => row.props.detail);
    expect(rows).toEqual(["—", "—"]);
  });
});

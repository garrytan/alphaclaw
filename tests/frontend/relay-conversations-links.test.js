import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => ({
  useState: (value) => [typeof value === "function" ? value() : value, () => {}],
  useRef: (value = null) => ({ current: value }),
  useMemo: (factory) => factory(),
  useCallback: (fn) => fn,
  useEffect: () => {},
  useLayoutEffect: () => {},
}));

const relaySession = (peer) => "agent:main:relay-" + peer;
const kPolled = new Map();
vi.mock("../../lib/public/js/hooks/usePolling.js", () => ({
  usePolling: vi.fn((_fetcher, _interval, { cacheKey } = {}) => ({
    data: kPolled.get(String(cacheKey).split("?")[0]) ?? null,
    error: null,
    refresh: vi.fn(),
  })),
}));

vi.mock("../../lib/public/js/lib/api.js", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchRelayConversations: vi.fn(async () => ({ conversations: [] })),
  fetchRelayConversation: vi.fn(async () => ({ messages: [] })),
}));

import { usePolling } from "../../lib/public/js/hooks/usePolling.js";
import { fetchRelayConversation } from "../../lib/public/js/lib/api.js";
import { RelayConversations } from "../../lib/public/js/components/relay-tab/conversations.js";
import { useRelayConversations } from "../../lib/public/js/components/relay-tab/use-relay-conversations.js";
import { RelayRoute } from "../../lib/public/js/components/routes/relay-route.js";
import { getSelectedNavId } from "../../lib/public/js/lib/app-navigation.js";

const expandTree = (node) => {
  if (node == null || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(expandTree);
  if (typeof node.type === "function") return expandTree(node.type(node.props || {}));
  const children = node.props?.children;
  if (children === undefined) return node;
  return { ...node, props: { ...node.props, children: expandTree(children) } };
};

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  collectNodes(node.props?.children, out);
  return out;
};

const collectText = (node) => {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(collectText).join("");
  return collectText(node.props?.children);
};

const kConversations = [
  {
    id: "conv-1",
    participants: ["wintermute", "capy-ops"],
    peer: "capy-ops",
    messageCount: 4,
    lastMessageAt: "2026-11-06T18:00:00.000Z",
    lastFrom: "wintermute",
    lastText: "pong: disk is at 41%",
    lastStatus: "answered",
    lastCode: null,
    sessionKey: relaySession("capy-ops"),
    sessionOnly: false,
  },
  {
    id: "session:agent:main:relay-researcher",
    participants: ["wintermute", "researcher"],
    peer: "researcher",
    messageCount: null,
    lastMessageAt: "2026-11-01T09:00:00.000Z",
    lastFrom: null,
    lastText: "",
    lastStatus: null,
    lastCode: null,
    sessionKey: relaySession("researcher"),
    sessionOnly: true,
  },
  {
    id: "conv-3",
    participants: ["capy-a", "capy-b"],
    peer: null,
    messageCount: 2,
    lastMessageAt: "2026-11-05T09:00:00.000Z",
    lastFrom: "capy-b",
    lastText: "thanks",
    lastStatus: null,
    lastCode: null,
    sessionKey: null,
    sessionOnly: false,
  },
];

const renderConversations = (overrides = {}) =>
  expandTree(
    RelayConversations({
      ready: true,
      agents: [{ name: "wintermute" }, { name: "capy-ops" }],
      conversations: {
        filters: { q: "", agent: "", from: "", to: "" },
        setFilters: vi.fn(),
        conversations: kConversations,
        listLoading: false,
        listError: null,
        moreError: null,
        hasMoreConversations: false,
        loadMoreConversations: vi.fn(),
        loadingMore: false,
        ...overrides,
      },
    }),
  );

describe("Relay page conversations open in Chat (ALPH-69)", () => {
  beforeEach(() => {
    kPolled.clear();
    vi.clearAllMocks();
  });

  it("makes every conversation with this box a link to #/chat/<session key>", () => {
    const anchors = collectNodes(renderConversations()).filter((node) => node.type === "a");
    expect(anchors.map((node) => node.props.href)).toEqual([
      "#/chat/" + encodeURIComponent("agent:main:relay-capy-ops"),
      "#/chat/" + encodeURIComponent("agent:main:relay-researcher"),
    ]);
    const first = collectText(anchors[0]);
    expect(first).toContain("@capy-ops");
    expect(first).toContain("Answered");
    expect(first).toContain("4 messages");
    expect(first).toContain("Open in Chat");
    expect(first).toContain("@wintermute: pong: disk is at 41%");
  });

  it("opens a row on Space as well as on Enter and click", () => {
    const [anchor] = collectNodes(renderConversations()).filter((node) => node.type === "a");
    const click = vi.fn();
    const space = { key: " ", preventDefault: vi.fn(), currentTarget: { click } };
    anchor.props.onkeydown(space);
    expect(space.preventDefault).toHaveBeenCalledTimes(1);
    expect(click).toHaveBeenCalledTimes(1);
    const other = { key: "a", preventDefault: vi.fn(), currentTarget: { click } };
    anchor.props.onkeydown(other);
    expect(other.preventDefault).not.toHaveBeenCalled();
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("has no inline transcript pane and no separate Open session in Chat button", () => {
    const text = collectText(renderConversations());
    expect(text).not.toContain("Open session in Chat");
    expect(text).not.toContain("Pick a conversation");
    expect(text).not.toContain("Load earlier messages");
  });

  it("lists a conversation between two other agents without a link", () => {
    const nodes = collectNodes(renderConversations());
    const otherRow = nodes.find((node) => node.type === "li" && collectText(node).includes("@capy-a ↔ @capy-b"));
    expect(otherRow).toBeTruthy();
    expect(collectNodes(otherRow).some((node) => node.type === "a")).toBe(false);
    expect(collectText(otherRow)).toContain("Between two other agents");
  });

  it("keeps the search, agent and date filters", () => {
    const nodes = collectNodes(renderConversations());
    const labels = nodes.map((node) => node.props?.["aria-label"]).filter(Boolean);
    expect(labels).toEqual(expect.arrayContaining(["Search relay conversations", "Agent", "From date", "To date"]));
  });

  it("polls the conversation list and no relay log while no row is expanded", () => {
    kPolled.set("/api/relay/conversations", { conversations: kConversations, nextBefore: null });
    const state = useRelayConversations({ ready: true });
    expect(state.conversations.map((item) => item.id)).toEqual(kConversations.map((item) => item.id));
    expect(usePolling).toHaveBeenCalledTimes(2);
    expect(usePolling.mock.calls[0][2]).toMatchObject({ cacheKey: "/api/relay/conversations?", enabled: true });
    expect(usePolling.mock.calls[1][2].enabled).toBe(false);
    expect(fetchRelayConversation).not.toHaveBeenCalled();
    expect(state.log).toBeNull();
  });
});

const kLog = {
  messages: [
    { id: "m1", from: "capy-ops", text: "Disk check please", createdAt: "2026-11-06T17:59:00.000Z", relayStatus: null, bridge: { state: "answered", code: null, hop: 0 } },
    { id: "m2", from: "wintermute", text: "pong: disk is at 41%", createdAt: "2026-11-06T18:00:00.000Z", relayStatus: "answered", bridge: null },
  ],
  loading: false,
  error: null,
  hasEarlier: true,
  loadingEarlier: false,
  loadEarlier: vi.fn(),
};

const rowFor = (tree, text) => collectNodes(tree).find((node) => node.type === "li" && collectText(node).includes(text));
const logButton = (node) =>
  collectNodes(node).find((child) => child.type === "button" && collectText(child).includes("Relay log"));

describe("Relay log beside each conversation (ALPH-69 fix round)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("puts a Relay log disclosure button beside the Chat link, never inside it", () => {
    const toggleLog = vi.fn();
    const tree = renderConversations({ expandedId: "", toggleLog, log: null, agentName: "wintermute" });
    const row = rowFor(tree, "@capy-ops");
    const link = collectNodes(row).find((node) => node.type === "a");
    expect(link.props.href).toBe("#/chat/" + encodeURIComponent("agent:main:relay-capy-ops"));
    expect(logButton(link)).toBeUndefined();
    const button = logButton(row);
    expect(button.props).toMatchObject({ type: "button", "aria-expanded": "false" });
    button.props.onclick();
    expect(toggleLog).toHaveBeenCalledWith("conv-1");
    expect(collectText(row)).not.toContain("Disk check please");
  });

  it("expands the read-only relay log under the one expanded row", () => {
    const tree = renderConversations({ expandedId: "conv-1", toggleLog: vi.fn(), log: kLog, agentName: "wintermute" });
    const row = rowFor(tree, "@capy-ops");
    const button = logButton(row);
    expect(button.props["aria-expanded"]).toBe("true");
    const pane = collectNodes(row).find((node) => node.props?.id === button.props["aria-controls"]);
    expect(pane).toBeTruthy();
    const text = collectText(pane);
    expect(text).toContain("@capy-ops");
    expect(text).toContain("Disk check please");
    expect(text).toContain("@wintermute");
    expect(text).toContain("pong: disk is at 41%");
    expect(text).toContain("Answered");
    const earlier = collectNodes(pane).find((node) => node.type === "button" && collectText(node).includes("Load earlier"));
    earlier.props.onclick();
    expect(kLog.loadEarlier).toHaveBeenCalledTimes(1);
    expect(collectNodes(pane).some((node) => node.type === "textarea" || node.type === "input")).toBe(false);
    const otherRow = rowFor(tree, "@capy-a ↔ @capy-b");
    expect(logButton(otherRow).props["aria-expanded"]).toBe("false");
    expect(collectText(otherRow)).not.toContain("Disk check please");
  });

  it("makes the relay log the only view of a conversation between two other agents", () => {
    const tree = renderConversations({ expandedId: "conv-3", toggleLog: vi.fn(), log: { ...kLog, hasEarlier: false }, agentName: "wintermute" });
    const row = rowFor(tree, "@capy-a ↔ @capy-b");
    expect(collectNodes(row).some((node) => node.type === "a")).toBe(false);
    expect(collectText(row)).toContain("Read it in the relay log");
    expect(logButton(row).props["aria-expanded"]).toBe("true");
    expect(collectText(row)).toContain("pong: disk is at 41%");
  });

  it("offers no relay log for a session past retention", () => {
    const tree = renderConversations({ expandedId: "", toggleLog: vi.fn(), log: null, agentName: "wintermute" });
    expect(logButton(rowFor(tree, "@researcher"))).toBeUndefined();
  });
});

describe("old #/relay links (ALPH-69)", () => {
  beforeEach(() => {
    kPolled.clear();
    vi.clearAllMocks();
  });

  it("still renders the Relay page, with its conversations as Chat links", () => {
    kPolled.set("/api/relay/status", { enabled: true, phase: "ready", agentName: "wintermute", agents: [], settings: {}, engine: { exposure: { exposedOn: [] } } });
    kPolled.set("/api/relay/conversations", { conversations: kConversations, nextBefore: null });
    const tree = expandTree(RelayRoute());
    const text = collectText(tree);
    expect(text).toContain("Relay");
    expect(text).toContain("Other agents can message this box's agent over the relay");
    expect(text).toContain("Conversations");
    const hrefs = collectNodes(tree).filter((node) => node.type === "a").map((node) => node.props.href);
    expect(hrefs).toContain("#/chat/" + encodeURIComponent("agent:main:relay-capy-ops"));
    expect(getSelectedNavId({ location: "/relay" })).toBe("relay");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Agent detail: the description sentence, the 7-day activity
// numbers, the tabs and the header's one solid button and overflow.
const readFixtures = new Map();
const fetchRefreshes = [];

vi.mock("preact/hooks", () => {
  const harness = { slots: [], cursor: 0, effects: [] };
  harness.begin = () => {
    harness.cursor = 0;
    harness.effects = [];
  };
  harness.reset = () => {
    harness.slots = [];
    harness.cursor = 0;
    harness.effects = [];
  };
  const useState = (initial) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = typeof initial === "function" ? initial() : initial;
    return [
      harness.slots[index],
      (next) => {
        harness.slots[index] = typeof next === "function" ? next(harness.slots[index]) : next;
      },
    ];
  };
  const useRef = (initial = null) => {
    const index = harness.cursor++;
    if (!(index in harness.slots)) harness.slots[index] = { current: initial };
    return harness.slots[index];
  };
  return {
    useState,
    useRef,
    useMemo: (factory) => factory(),
    useCallback: (fn) => fn,
    useEffect: (effect) => {
      harness.effects.push(effect);
    },
    useLayoutEffect: () => {},
    __harness: harness,
  };
});
vi.mock("../../lib/public/js/components/channels/index.js", () => ({
  ALL_CHANNELS: ["telegram", "discord", "slack", "whatsapp"],
  ChannelsCard: () => null,
  getChannelMeta: (id) => ({ label: String(id || "") }),
}));
vi.mock("../../lib/public/js/hooks/use-cached-fetch.js", () => ({
  useCachedFetch: (key) => ({
    data: readFixtures.get(key) ?? null,
    error: null,
    loading: false,
    refresh: async (options) => {
      fetchRefreshes.push([key, options]);
      return null;
    },
  }),
}));
vi.mock("../../lib/public/js/components/models-tab/use-models.js", () => ({
  useModels: () => ({
    catalog: [],
    primary: "anthropic/claude-opus-4-8",
    configuredModels: {},
    authProfiles: [],
    codexStatus: { connected: false },
    loading: false,
    ready: true,
  }),
}));

const preactHooks = await import("preact/hooks");
const model = await import("../../lib/public/js/components/agents-tab/agent-detail-model.js");
const { AgentDetailPanel } = await import("../../lib/public/js/components/agents-tab/agent-detail-panel.js");
const { AgentsTab } = await import("../../lib/public/js/components/agents-tab/index.js");
const { EditAgentModal } = await import("../../lib/public/js/components/agents-tab/edit-agent-modal.js");
const { DeleteAgentDialog } = await import("../../lib/public/js/components/agents-tab/delete-agent-dialog.js");
const { Tabs, getTabId } = await import("../../lib/public/js/components/tabs.js");
const { ActionButton } = await import("../../lib/public/js/components/action-button.js");
const { OverflowMenuItem } = await import("../../lib/public/js/components/overflow-menu.js");
const { ChannelOperationsPanel } = await import("../../lib/public/js/components/channel-operations-panel.js");
const { AgentSessionsList } = await import("../../lib/public/js/components/agents-tab/agent-sessions-list.js");

const { kAgentBindingsChangedEvent } = await import("../../lib/public/js/lib/ui-events.js");

const harness = preactHooks.__harness;

const collect = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collect(node.props.children, out);
  return out;
};
const textOf = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, out);
    return out;
  }
  if (node && typeof node === "object" && node.props) textOf(node.props.children, out);
  return out;
};

const kMain = { id: "main", name: "main", default: true, workspace: "/data/.openclaw/workspace", tools: { profile: "full" } };
const kOps = { id: "ops", name: "Ops", workspace: "/data/.openclaw/workspace-ops", tools: { profile: "full" } };

const render = (props = {}) => {
  harness.begin();
  return AgentDetailPanel({ agent: kMain, agents: [kMain, kOps], ...props });
};

beforeEach(() => {
  harness.reset();
  readFixtures.clear();
  fetchRefreshes.length = 0;
  vi.clearAllMocks();
});

describe("frontend/agent detail description", () => {
  it("names the channels, relay and model", () => {
    expect(model.describeAgent({ name: "main", channelLabels: ["Telegram"], relay: true, modelLabel: "Claude Opus 4.8" })).toBe(
      "main answers Telegram and relay messages using Claude Opus 4.8.",
    );
    expect(
      model.describeAgent({ name: "main", channelLabels: ["Telegram", "Discord", "Telegram"], relay: true, modelLabel: "Claude Opus 4.8" }),
    ).toBe("main answers Telegram, Discord and relay messages using Claude Opus 4.8.");
    expect(model.describeAgent({ name: "Ops", channelLabels: ["Slack"], modelLabel: "GPT-5.5" })).toBe(
      "Ops answers Slack messages using GPT-5.5.",
    );
  });

  it("says when there are no channels, no model, or the channels are unknown", () => {
    expect(model.describeAgent({ name: "Ops", channelLabels: [], modelLabel: "GPT-5.5" })).toBe(
      "Ops has no channels yet. Chat with it here or add a channel.",
    );
    expect(model.describeAgent({ name: "Ops", channelLabels: ["Slack"], modelLabel: "" })).toBe("Ops has no model yet.");
    expect(model.describeAgent({ name: "Ops", channelLabels: [], modelLabel: "GPT-5.5", channelsKnown: false })).toBe(
      "Ops uses GPT-5.5.",
    );
  });

  it("counts an account as this agent's when bound to it, or the unbound default account on the default agent", () => {
    const channels = [
      { channel: "telegram", accounts: [{ id: "default" }, { id: "ops-bot", boundAgentId: "ops" }] },
      { channel: "discord", accounts: [{ id: "x", boundAgentId: "main" }] },
    ];
    expect(model.getAgentChannelAccounts({ agent: kMain, channels }).map((entry) => entry.channel)).toEqual(["telegram", "discord"]);
    expect(model.getAgentChannelAccounts({ agent: kOps, channels }).map((entry) => entry.accountId)).toEqual(["ops-bot"]);
    expect(model.answersRelay({ agent: kMain, relayStatus: { phase: "ready" } })).toBe(true);
    expect(model.answersRelay({ agent: kOps, relayStatus: { phase: "ready" } })).toBe(false);
    expect(model.answersRelay({ agent: kMain, relayStatus: { phase: "failed" } })).toBe(false);
  });

  it("the header sentence agrees with the channels read and the model", () => {
    readFixtures.set("/api/channels/accounts", { channels: [{ channel: "telegram", accounts: [{ id: "default" }] }] });
    readFixtures.set("/api/relay/status", { phase: "ready" });
    const text = textOf(render()).join("");
    expect(text).toContain("main answers Telegram and relay messages using Claude Opus 4.8.");
    expect(text.match(/main answers/g)).toHaveLength(1);
  });
});

describe("frontend/agent detail activity", () => {
  it("takes turns and cost from daily[].agents for this agent over seven calendar days", () => {
    const nowMs = new Date(2026, 10, 7, 9, 0, 0).getTime();
    const summary = {
      daily: [
        { date: "2026-11-01", agents: [{ agent: "main", turnCount: 5, totalCost: 1.25 }, { agent: "ops", turnCount: 9, totalCost: 4 }] },
        { date: "2026-11-06", agents: [{ agent: "main", turnCount: 12, totalCost: 2.5 }] },
        { date: "2026-10-31", agents: [{ agent: "main", turnCount: 99, totalCost: 99 }] },
      ],
    };
    const activity = model.buildAgentActivity({ summary, agentId: "main", nowMs });
    expect(activity.days.map((day) => day.date)).toEqual([
      "2026-11-01",
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
    ]);
    expect(activity.days.map((day) => day.turns)).toEqual([5, 0, 0, 0, 0, 12, 0]);
    expect(activity.totalTurns).toBe(17);
    expect(activity.totalCost).toBeCloseTo(3.75);
    expect(model.buildAgentActivity({ summary: { daily: [] }, agentId: "main", nowMs }).totalTurns).toBe(0);
  });
});

describe("frontend/agent detail header and tabs", () => {
  it("shows the name once, the id only in the mono meta line, Open chat as the one solid button", () => {
    const tree = render();
    const h1 = collect(tree).filter((node) => node.type === "h1");
    expect(h1).toHaveLength(1);
    expect(textOf(h1[0]).join("").trim()).toBe("main");
    const solid = collect(tree).filter((node) => node.type === ActionButton && node.props.tone === "solid");
    expect(solid.map((node) => node.props.idleLabel)).toEqual(["Open chat"]);
  });

  it("Open chat, Edit, Set as default and Delete call the handlers they were given", () => {
    const onOpenChat = vi.fn();
    const onEdit = vi.fn();
    const onSetDefault = vi.fn();
    const onDelete = vi.fn();
    const tree = render({ agent: kOps, onOpenChat, onEdit, onSetDefault, onDelete });
    collect(tree).find((node) => node.type === ActionButton && node.props.idleLabel === "Open chat").props.onClick();
    expect(onOpenChat).toHaveBeenCalledWith(kOps);
    const items = collect(tree).filter((node) => node.type === OverflowMenuItem);
    expect(items.map((node) => textOf(node).join("").trim())).toEqual(["Edit", "Set as default", "Delete"]);
    items.forEach((node) => node.props.onClick());
    expect(onEdit).toHaveBeenCalledWith(kOps);
    expect(onSetDefault).toHaveBeenCalledWith("ops");
    expect(onDelete).toHaveBeenCalledWith(kOps);
  });

  it("AgentsTab hands the panel the same edit, delete and set-default handlers that open the existing dialogs", async () => {
    const setDefault = vi.fn(async () => {});
    const props = { agents: [kMain, kOps], selectedAgentId: "ops", agentsActions: { setDefault, loadAgents: vi.fn() } };
    harness.begin();
    let tree = AgentsTab(props);
    const panel = () => collect(tree).find((node) => node.type === AgentDetailPanel);
    panel().props.onEdit(kOps);
    panel().props.onDelete(kOps);
    await panel().props.onSetDefault("ops");
    harness.begin();
    tree = AgentsTab(props);
    expect(collect(tree).find((node) => node.type === EditAgentModal).props.agent).toBe(kOps);
    expect(collect(tree).find((node) => node.type === DeleteAgentDialog).props.agent).toBe(kOps);
    expect(setDefault).toHaveBeenCalledWith("ops");
  });

  it("tabs carry counts, select the route's tab and label its tabpanel", () => {
    readFixtures.set("/api/channels/accounts", { channels: [{ channel: "telegram", accounts: [{ id: "default" }] }] });
    readFixtures.set("/api/relay/status", { phase: "failed" });
    const sessions = [{ key: "agent:main:main" }, { key: "agent:main:telegram:direct:1" }, { key: "agent:ops:main" }];
    const tree = render({ sessions, activeTab: "channels" });
    const tabs = collect(tree).find((node) => node.type === Tabs);
    expect(tabs.props.tabs.map((tab) => tab.label)).toEqual(["Overview", "Tools " + tabs.props.tabs[1].label.split(" ")[1], "Channels 1", "Sessions 2"]);
    expect(Number(tabs.props.tabs[1].label.split(" ")[1])).toBeGreaterThan(0);
    expect(tabs.props.activeTab).toBe("channels");
    const rendered = Tabs(tabs.props);
    expect(rendered.props.role).toBe("tablist");
    const buttons = collect(rendered).filter((node) => node.props?.role === "tab");
    expect(buttons.map((node) => node.props["aria-selected"])).toEqual(["false", "false", "true", "false"]);
    const panel = collect(tree).find((node) => node.props?.role === "tabpanel");
    expect(panel.props["aria-labelledby"]).toBe(getTabId("agent-detail", "channels"));
    expect(collect(tree).some((node) => node.type === ChannelOperationsPanel)).toBe(true);
  });

  it("the Channels tab count includes relay when the agent answers relay messages, and the tab says so", () => {
    readFixtures.set("/api/channels/accounts", { channels: [] });
    readFixtures.set("/api/relay/status", { phase: "ready" });
    const tree = render({ agent: kMain, activeTab: "channels" });
    const tabs = collect(tree).find((node) => node.type === Tabs);
    expect(tabs.props.tabs[2].label).toBe("Channels 1");
    expect(textOf(tree).join("")).toContain("main also answers relay messages. Open Relay");
    readFixtures.delete("/api/relay/status");
    const unknown = collect(render({ agent: kMain, activeTab: "channels" })).find((node) => node.type === Tabs);
    expect(unknown.props.tabs[2].label).toBe("Channels");
  });

  it("arrow keys move between the tabs", () => {
    const onSelectTab = vi.fn();
    const tabs = collect(render({ onSelectTab })).find((node) => node.type === Tabs);
    const rendered = Tabs(tabs.props);
    const targets = tabs.props.tabs.map(() => ({ focus: vi.fn() }));
    const keyDown = (key) =>
      rendered.props.onKeyDown({ key, preventDefault: vi.fn(), currentTarget: { querySelectorAll: () => targets } });
    keyDown("ArrowRight");
    expect(onSelectTab).toHaveBeenLastCalledWith("tools");
    keyDown("ArrowLeft");
    expect(onSelectTab).toHaveBeenLastCalledWith("sessions");
    expect(targets[3].focus).toHaveBeenCalled();
  });

  it("the Sessions tab lists this agent's sessions, linking the ones Chat opens", () => {
    const sessions = [{ key: "agent:main:main" }, { key: "agent:ops:main" }, { key: "agent:main:telegram:direct:1" }];
    expect(model.getAgentSessions({ sessions, agentId: "main" }).map((row) => row.key)).toEqual([
      "agent:main:main",
      "agent:main:telegram:direct:1",
    ]);
    expect(model.canOpenSessionInChat("agent:main:main")).toBe(true);
    expect(model.canOpenSessionInChat("cron:abc")).toBe(false);
    const list = AgentSessionsList({ sessions: [{ key: "agent:main:main" }, { key: "cron:abc", label: "Cron" }] });
    const links = collect(list).filter((node) => node.type === "a");
    expect(links.map((node) => node.props.href)).toEqual(["#/chat/" + encodeURIComponent("agent:main:main")]);
  });
});

describe("frontend/agent detail after review", () => {
  it("re-reads the channel accounts when the Channels tab changes a binding, so the summary stays current", () => {
    const listeners = new Map();
    const previousWindow = globalThis.window;
    globalThis.window = {
      addEventListener: (name, handler) => listeners.set(name, handler),
      removeEventListener: (name, handler) => {
        if (listeners.get(name) === handler) listeners.delete(name);
      },
    };
    try {
      render({ activeTab: "overview" });
      const cleanups = harness.effects.map((effect) => effect());
      const handler = listeners.get(kAgentBindingsChangedEvent);
      expect(typeof handler).toBe("function");
      handler({ detail: { agentId: "ops" } });
      expect(fetchRefreshes).toContainEqual(["/api/channels/accounts", { force: true }]);
      cleanups.forEach((cleanup) => cleanup?.());
      expect(listeners.has(kAgentBindingsChangedEvent)).toBe(false);
    } finally {
      globalThis.window = previousWindow;
    }
  });

});

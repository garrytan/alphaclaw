import { describe, expect, it, vi } from "vitest";

vi.mock("preact/hooks", () => ({
  useMemo: (factory) => factory(),
  useRef: (initialValue = null) => ({ current: initialValue }),
  useState: (initialValue) => [initialValue, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
}));

const {
  Tabs,
  getNextTabIndex,
  getTabId,
  getTabPanelId,
  getTabPanelProps,
} = await import("../../lib/public/js/components/tabs.js");
const { WatchdogConsoleCard } = await import(
  "../../lib/public/js/components/watchdog-tab/console/index.js"
);

const kTabs = [
  { label: "Overview", value: "overview" },
  { label: "Tools", value: "tools" },
  { label: "Sessions", value: "sessions" },
];

const collect = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    node.forEach((child) => collect(child, out));
    return out;
  }
  out.push(node);
  collect(node.props?.children, out);
  return out;
};

const tabButtons = (tree) => collect(tree).filter((node) => node.props?.role === "tab");

const keyDown = (tree, key) => {
  const focusTargets = kTabs.map(() => ({ focus: vi.fn() }));
  const event = {
    key,
    preventDefault: vi.fn(),
    currentTarget: { querySelectorAll: () => focusTargets },
  };
  tree.props.onKeyDown(event);
  return { event, focusTargets };
};

describe("frontend/tabs semantics", () => {
  it("renders a labelled tablist of typed tab buttons", () => {
    const tree = Tabs({ tabs: kTabs, activeTab: "tools", idBase: "agent", ariaLabel: "Agent sections" });
    expect(tree.props.role).toBe("tablist");
    expect(tree.props["aria-label"]).toBe("Agent sections");
    const buttons = tabButtons(tree);
    expect(buttons).toHaveLength(3);
    for (const button of buttons) expect(button.props.type).toBe("button");
    expect(buttons.map((button) => button.props.id)).toEqual([
      "agent-tab-overview",
      "agent-tab-tools",
      "agent-tab-sessions",
    ]);
    expect(buttons.map((button) => button.props["aria-selected"])).toEqual(["false", "true", "false"]);
  });

  it("points only the selected tab at its panel and keeps only it in the Tab order", () => {
    const buttons = tabButtons(Tabs({ tabs: kTabs, activeTab: "tools", idBase: "agent" }));
    expect(buttons.map((button) => button.props["aria-controls"])).toEqual([
      undefined,
      "agent-panel-tools",
      undefined,
    ]);
    expect(buttons.map((button) => button.props.tabindex)).toEqual(["-1", "0", "-1"]);
  });

  it("keeps the first tab reachable when nothing matches activeTab", () => {
    const buttons = tabButtons(Tabs({ tabs: kTabs, activeTab: "missing", idBase: "agent" }));
    expect(buttons.map((button) => button.props.tabindex)).toEqual(["0", "-1", "-1"]);
  });

  it("selects a tab on click", () => {
    const onSelectTab = vi.fn();
    const buttons = tabButtons(Tabs({ tabs: kTabs, activeTab: "overview", onSelectTab }));
    buttons[2].props.onclick();
    expect(onSelectTab).toHaveBeenCalledWith("sessions");
  });

  it("gives the panel ids that match its tab", () => {
    expect(getTabPanelProps("agent", "tools")).toEqual({
      role: "tabpanel",
      id: getTabPanelId("agent", "tools"),
      "aria-labelledby": getTabId("agent", "tools"),
    });
  });

  it("keeps the Phase 1a look: accent pill, or the segmented console look", () => {
    const pill = tabButtons(Tabs({ tabs: kTabs, activeTab: "overview" }));
    expect(pill[0].props.class).toContain("bg-tone-accent-bg text-tone-accent");
    expect(pill[1].props.class).toContain("bg-field text-fg-muted");
    const segmented = Tabs({ tabs: kTabs, activeTab: "overview", variant: "segmented" });
    expect(segmented.props.class).toContain("rounded-lg border border-border bg-field p-0.5");
    expect(tabButtons(segmented)[0].props.class).toContain("bg-surface text-bright");
  });
});

describe("frontend/tabs keyboard model", () => {
  it("computes the next index: arrows wrap, Home and End jump, other keys do nothing", () => {
    expect(getNextTabIndex("ArrowRight", 0, 3)).toBe(1);
    expect(getNextTabIndex("ArrowRight", 2, 3)).toBe(0);
    expect(getNextTabIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(getNextTabIndex("Home", 2, 3)).toBe(0);
    expect(getNextTabIndex("End", 0, 3)).toBe(2);
    expect(getNextTabIndex("Enter", 0, 3)).toBe(-1);
    expect(getNextTabIndex("ArrowRight", 0, 0)).toBe(-1);
  });

  it("ArrowRight selects and focuses the next tab, wrapping at the end", () => {
    const onSelectTab = vi.fn();
    const { event, focusTargets } = keyDown(Tabs({ tabs: kTabs, activeTab: "sessions", onSelectTab }), "ArrowRight");
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onSelectTab).toHaveBeenCalledWith("overview");
    expect(focusTargets[0].focus).toHaveBeenCalled();
  });

  it("ArrowLeft, Home and End move the selection", () => {
    const onSelectTab = vi.fn();
    const tree = Tabs({ tabs: kTabs, activeTab: "tools", onSelectTab });
    keyDown(tree, "ArrowLeft");
    keyDown(tree, "End");
    const { focusTargets } = keyDown(tree, "Home");
    expect(onSelectTab.mock.calls.map(([value]) => value)).toEqual(["overview", "sessions", "overview"]);
    expect(focusTargets[0].focus).toHaveBeenCalled();
  });

  it("with manual activation, arrows move focus from the focused tab without selecting", () => {
    const onSelectTab = vi.fn();
    const tree = Tabs({ tabs: kTabs, activeTab: "overview", onSelectTab, activation: "manual" });
    const focusTargets = kTabs.map(() => ({ focus: vi.fn() }));
    const event = {
      key: "ArrowRight",
      preventDefault: vi.fn(),
      target: focusTargets[1],
      currentTarget: { querySelectorAll: () => focusTargets },
    };
    tree.props.onKeyDown(event);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(onSelectTab).not.toHaveBeenCalled();
    expect(focusTargets[2].focus).toHaveBeenCalled();
    tabButtons(tree)[2].props.onclick();
    expect(onSelectTab).toHaveBeenCalledWith("sessions");
  });

  it("leaves other keys to the browser", () => {
    const onSelectTab = vi.fn();
    const { event } = keyDown(Tabs({ tabs: kTabs, activeTab: "tools", onSelectTab }), "Tab");
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(onSelectTab).not.toHaveBeenCalled();
  });
});

describe("frontend/watchdog console tabs", () => {
  it("uses the Tabs primitive for Logs and Terminal, with matching panels", () => {
    const tree = WatchdogConsoleCard({ activeConsoleTab: "logs", logs: "line", loadingLogs: false });
    const tablist = collect(tree).find((node) => node.type === Tabs);
    expect(tablist.props.variant).toBe("segmented");
    expect(tablist.props.activation).toBe("manual");
    expect(tablist.props.tabs.map((tab) => tab.label)).toEqual(["Logs", "Terminal"]);
    const panels = collect(tree).filter((node) => node.props?.role === "tabpanel");
    expect(panels.map((panel) => panel.props.id)).toEqual([
      getTabPanelId(tablist.props.idBase, "logs"),
      getTabPanelId(tablist.props.idBase, "terminal"),
    ]);
  });

  it("makes the scrolling log reachable by keyboard", () => {
    const tree = WatchdogConsoleCard({ activeConsoleTab: "logs", logs: "line", loadingLogs: false });
    const pre = collect(tree).find((node) => node.type === "pre");
    expect(pre.props.tabindex).toBe("0");
    expect(pre.props.role).toBe("region");
    expect(pre.props["aria-label"]).toBeTruthy();
  });
});

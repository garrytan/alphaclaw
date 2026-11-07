import { describe, expect, it } from "vitest";
import { RoutePageHeader } from "../../lib/public/js/components/page-header.js";
import { getRoute, kRoutes } from "../../lib/public/js/lib/routes.js";
import { HomeRoute } from "../../lib/public/js/components/routes/home-route.js";
import { TelegramRoute } from "../../lib/public/js/components/routes/telegram-route.js";

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

const textOf = (node) =>
  collectNodes(node)
    .flatMap((vnode) => [vnode.props?.children].flat())
    .filter((child) => typeof child === "string")
    .join("");

// ALPH-69 design review, PR 2b: one title and purpose line per page.
const kSpecHeaders = {
  home: ["Home", "Status and next steps for this box"],
  health: ["Health", "Gateway, watchdog and incidents"],
  doctor: ["Doctor", "Checks this box's setup and finds what to fix"],
  schedules: ["Schedules", "Jobs your agents run on a timetable"],
  usage: ["Usage", "Turns and spend by agent, model and day"],
  channels: ["Channels", "Where people reach your agents"],
  integrations: ["Integrations", "Services and tools this box connects to"],
  relay: ["Relay", "Other agents can message this box's agent over the relay"],
  models: ["Models & keys", "The models this box can use and the keys that pay for them"],
  environment: ["Environment", "Every other variable this box runs with"],
  team: ["Team", "Who can open this box"],
};

describe("RoutePageHeader", () => {
  it.each(Object.entries(kSpecHeaders))("renders %s's title and purpose from the route table", (routeId, [title, purpose]) => {
    expect(getRoute(routeId)).toMatchObject({ title, purpose });
    const header = RoutePageHeader({ routeId });
    expect(header.type).toBe("header");
    const nodes = collectNodes(header);
    const headings = nodes.filter((vnode) => vnode.type === "h1");
    expect(headings).toHaveLength(1);
    expect(headings[0].props.class).toBe("ac-page-title");
    expect(textOf(headings[0])).toBe(title);
    const purposeLine = nodes.find((vnode) => vnode.type === "p");
    expect(purposeLine.props.class).toBe("ac-page-purpose");
    expect(textOf(purposeLine)).toBe(purpose);
  });

  it("gives every route a title, and omits the purpose line where the route has none", () => {
    for (const route of kRoutes) {
      const nodes = collectNodes(RoutePageHeader({ routeId: route.id }));
      expect(textOf(nodes.find((vnode) => vnode.type === "h1")), route.id).toBe(route.title);
      expect(nodes.some((vnode) => vnode.type === "p"), route.id).toBe(Boolean(route.purpose));
    }
  });

  it("takes a title override (an agent's name) and puts actions on the right", () => {
    const action = { type: "button", props: { children: "Run" } };
    const nodes = collectNodes(RoutePageHeader({ routeId: "agents", title: "Scout", actions: action }));
    expect(textOf(nodes.find((vnode) => vnode.type === "h1"))).toBe("Scout");
    const actions = nodes.find((vnode) => vnode.props?.class === "ac-page-header-actions");
    expect(actions.props.children).toBe(action);
  });
});

describe("page headers on the column routes", () => {
  it.each([
    ["home", HomeRoute],
    ["telegram", TelegramRoute],
  ])("puts the %s header above the page body", (routeId, Route) => {
    const tree = Route({});
    const header = collectNodes(tree).find((vnode) => vnode.type === RoutePageHeader);
    expect(header?.props.routeId).toBe(routeId);
    expect(collectNodes(tree)[1]).toBe(header);
  });
});

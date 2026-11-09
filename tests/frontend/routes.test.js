import { afterEach, describe, expect, it } from "vitest";
import {
  getRoute,
  getRouteId,
  getRoutePath,
  kDefaultRouteId,
  kRouteGroups,
  kRoutes,
  resolveRoute,
} from "../../lib/public/js/lib/routes.js";
import {
  filterNavSectionsForRole,
  getSelectedNavId,
  kClaudeCodeNavItem,
  kDashboardsNavItem,
  kDefaultUiTab,
  kMemberNavIds,
  kNavSections,
} from "../../lib/public/js/lib/app-navigation.js";
import { parseBrowseRoute } from "../../lib/public/js/lib/browse-route.js";
import { getHashRouterPath } from "../../lib/public/js/hooks/use-hash-location.js";

// ALPH-69 PR 2a/2b: the route table is the single source for every Setup UI
// hash route. These tests pin today's hashes, the old -> new redirects (query
// kept), the sidebar's groups and highlight, and the IA data the shell renders.

const servedRoutes = kRoutes;

// Every hash the Setup UI serves, with the route id and params it resolves to.
const kTodaysHashes = [
  ["/home", "home", {}],
  ["/doctor", "doctor", {}],
  ["/health", "health", {}],
  ["/health?incident=5", "health", {}],
  ["/team", "team", {}],
  ["/usage", "usage", {}],
  ["/usage/sess-1", "usage", { sessionId: "sess-1" }],
  ["/relay", "relay", {}],
  ["/relay?tab=log", "relay", {}],
  ["/groups", "groups", {}],
  ["/groups/ops", "groups", { accountId: "ops" }],
  ["/webhooks", "webhooks", {}],
  ["/webhooks/gmail", "webhooks", { hookName: "gmail" }],
  ["/telegram/default", "telegram", { accountId: "default" }],
  ["/telegram/ops%20bot", "telegram", { accountId: "ops%20bot" }],
  ["/agents", "agents", {}],
  ["/agents/main", "agents", { agentId: "main" }],
  ["/agents/main/tools", "agents", { agentId: "main", tab: "tools" }],
  ["/chat", "chat", {}],
  ["/chat/agent%3Amain%3Amain", "chat", { sessionKey: "agent%3Amain%3Amain" }],
  ["/schedules", "schedules", {}],
  ["/schedules/nightly%20sync", "schedules", { jobId: "nightly%20sync" }],
  ["/environment", "environment", {}],
  ["/models", "models", {}],
  ["/nodes", "nodes", {}],
  ["/browse", "browse", {}],
  ["/browse/skills/notes.md?view=diff", "browse", { filePath: "skills/notes.md" }],
];

describe("route table shape", () => {
  it("has no duplicate ids, paths, patterns or aliases", () => {
    const ids = kRoutes.map((route) => route.id);
    expect(new Set(ids).size).toBe(ids.length);
    const paths = kRoutes.map((route) => route.path);
    expect(new Set(paths).size).toBe(paths.length);
    const patterns = kRoutes.flatMap((route) => route.patterns);
    expect(new Set(patterns).size).toBe(patterns.length);
    const aliases = kRoutes.flatMap((route) => route.redirectFrom);
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("gives every route a title, nav label, IA group and admin flag", () => {
    for (const route of kRoutes) {
      expect(route.title, route.id).toEqual(expect.any(String));
      expect(route.navLabel, route.id).toEqual(expect.any(String));
      expect(typeof route.adminOnly, route.id).toBe("boolean");
      if (route.id === "browse") {
        expect(route.group).toBeNull();
      } else {
        expect(kRouteGroups, route.id).toContain(route.group);
      }
    }
    expect(kRouteGroups).toEqual(["home", "chat", "agents", "operate", "connect", "settings"]);
  });

  it("shows the new names in the sidebar", () => {
    const labels = Object.fromEntries(kRoutes.map((route) => [route.id, route.navLabel]));
    expect(labels).toMatchObject({
      home: "Home",
      health: "Health",
      schedules: "Schedules",
      environment: "Environment",
      models: "Models & keys",
      channels: "Channels",
      integrations: "Integrations",
    });
    expect(getRoute("home").title).toBe("Home");
    expect(getRoute("health").purpose).toBe("Gateway, watchdog and incidents");
    const shownLabels = kNavSections.flatMap((section) => section.items.map((item) => item.label));
    for (const label of ["Home", "Health", "Schedules", "Environment", "Models & keys"]) {
      expect(shownLabels).toContain(label);
    }
    for (const label of ["General", "Watchdog", "Cron", "Envars", "Models"]) {
      expect(shownLabels).not.toContain(label);
    }
    for (const label of ["Config", "Monitoring", "Setup"]) {
      expect(kNavSections.map((section) => section.label)).not.toContain(label);
    }
  });

  it("puts each route in its IA group", () => {
    const groupOf = (id) => getRoute(id).group;
    expect(groupOf("home")).toBe("home");
    expect(groupOf("chat")).toBe("chat");
    expect(groupOf("agents")).toBe("agents");
    expect(["health", "doctor", "schedules", "usage"].map(groupOf)).toEqual(Array(4).fill("operate"));
    expect(["channels", "groups", "integrations", "relay", "webhooks", "nodes", "telegram"].map(groupOf)).toEqual(
      Array(7).fill("connect"),
    );
    expect(["models", "environment", "team"].map(groupOf)).toEqual(Array(3).fill("settings"));
  });

  it("serves the renamed hashes and the Channels and Integrations pages", () => {
    for (const [id, path] of [
      ["home", "/home"],
      ["health", "/health"],
      ["schedules", "/schedules"],
      ["environment", "/environment"],
      ["channels", "/channels"],
      ["integrations", "/integrations"],
    ]) {
      expect(getRoutePath(id)).toBe(path);
      expect(resolveRoute(path)).toEqual({ route: getRoute(id), params: {}, redirectTo: "" });
    }
    expect(kRoutes.some((route) => "planned" in route)).toBe(false);
  });
});

describe("route resolution", () => {
  it("reaches every served route at its own path", () => {
    for (const route of servedRoutes) {
      const resolved = resolveRoute(route.path);
      expect(resolved.route?.id, route.path).toBe(route.id);
      expect(resolved.redirectTo, route.path).toBe("");
      expect(getRoutePath(route.id)).toBe(route.path);
    }
  });

  it.each(kTodaysHashes)("keeps today's hash %s on route %s", (location, id, params) => {
    expect(resolveRoute(location)).toEqual({ route: getRoute(id), params, redirectTo: "" });
  });

  it("redirects every old alias to its new hash", () => {
    const aliases = Object.fromEntries(
      kRoutes.flatMap((route) => route.redirectFrom.map((from) => [from, route.path])),
    );
    expect(aliases).toEqual({
      "/general": "/home",
      "/watchdog": "/health",
      "/cron/:jobId?": "/schedules",
      "/envars/:rest*": "/environment",
      "/providers": "/models",
      "/telegram": "/telegram/default",
    });
    for (const [from, to] of [
      ["/general", "/home"],
      ["/watchdog", "/health"],
      ["/cron", "/schedules"],
      ["/envars", "/environment"],
      ["/providers", "/models"],
      ["/telegram", "/telegram/default"],
    ]) {
      expect(resolveRoute(from).redirectTo).toBe(to);
      expect(resolveRoute(`${from}/`).redirectTo).toBe(to);
      expect(resolveRoute(to).redirectTo).toBe("");
    }
  });

  it.each([
    ["/watchdog?incident=x", "health", "/health?incident=x"],
    ["/watchdog?incident=12&tab=log", "health", "/health?incident=12&tab=log"],
    ["/Watchdog?incident=3", "health", "/health?incident=3"],
    ["/general?focus=channels", "home", "/home?focus=channels"],
    ["/cron/nightly%20sync", "schedules", "/schedules/nightly%20sync"],
    ["/cron/nightly?trendStart=1", "schedules", "/schedules/nightly?trendStart=1"],
    ["/envars/anything", "environment", "/environment"],
    ["/providers?x=1", "models", "/models?x=1"],
  ])("redirects %s to %s with its params and query", (location, id, redirectTo) => {
    const resolved = resolveRoute(location);
    expect(resolved.route.id).toBe(id);
    expect(resolved.redirectTo).toBe(redirectTo);
    expect(resolveRoute(redirectTo)).toMatchObject({ route: getRoute(id), redirectTo: "" });
  });

  it("drops the query when an unknown hash falls back to Home", () => {
    expect(resolveRoute("/nope?incident=1").redirectTo).toBe("/home");
  });

  it("sends unknown and empty hashes to the default route", () => {
    expect(kDefaultUiTab).toBe(kDefaultRouteId);
    for (const location of ["", "/", "/nope", "/webhooks/a/b", "/telegram/a/b", "/chatty", "/general/x", "/home/x"]) {
      expect(resolveRoute(location), location).toEqual({
        route: null,
        params: {},
        redirectTo: "/home",
      });
    }
  });

  it("matches like wouter did: case-insensitive with one optional trailing slash", () => {
    expect(getRouteId("/Health")).toBe("health");
    expect(getRouteId("/usage/")).toBe("usage");
    expect(getRouteId("/doctor/")).toBe("doctor");
  });

  it("lets pane routes own their deeper paths, as location.startsWith did", () => {
    expect(getRouteId("/models/anything")).toBe("models");
    expect(getRouteId("/environment/x/y")).toBe("environment");
    expect(getRouteId("/schedules/a")).toBe("schedules");
    expect(getRouteId("/nodes/x")).toBe("nodes");
    expect(resolveRoute("/agents/main/tools/extra").params).toEqual({ agentId: "main", tab: "tools" });
    expect(resolveRoute("/chat/agent:main:a/b").params).toEqual({ sessionKey: "agent:main:a/b" });
  });

  describe("slashless and empty hashes", () => {
    const originalWindow = globalThis.window;
    afterEach(() => {
      globalThis.window = originalWindow;
    });
    it.each([
      ["#environment", "environment"],
      ["#health?incident=5", "health"],
      ["#envars", "environment"],
      ["#watchdog?incident=5", "health"],
      ["#browse/skills/notes.md", "browse"],
      ["", "home"],
      ["#/chat/agent%3Amain%3Amain", "chat"],
    ])("resolves %s to %s", (hash, id) => {
      globalThis.window = { location: { hash } };
      expect(getRouteId(getHashRouterPath())).toBe(id);
    });
  });

  it("feeds the browse parser", () => {
    expect(parseBrowseRoute({ location: "/browse/a.md" }).isBrowseRoute).toBe(true);
    expect(parseBrowseRoute({ location: "/Browse/notes/a.md" }).activeBrowsePath).toBe("notes/a.md");
    expect(parseBrowseRoute({ location: "/doctor" }).isBrowseRoute).toBe(false);
  });

  it("marks the sidebar mode, last-visited memory and Gateway surfaces as before", () => {
    const byField = (field) =>
      Object.fromEntries(servedRoutes.map((route) => [route.id, route[field]]));
    expect(Object.entries(byField("sidebarTab")).filter(([, tab]) => tab !== "menu")).toEqual([
      ["chat", "chat"],
      ["browse", "browse"],
    ]);
    const menuReturn = byField("menuReturn");
    expect(Object.keys(menuReturn).filter((id) => menuReturn[id] === "never").sort()).toEqual([
      "browse",
      "chat",
      "telegram",
    ]);
    expect(menuReturn.agents).toBe("session");
    const surfaces = servedRoutes.filter((route) => route.gatewaySurface).map((route) => route.id);
    expect(surfaces).toEqual(["home", "health"]);
    const panes = servedRoutes.filter((route) => route.shell === "pane").map((route) => route.id);
    expect(panes.sort()).toEqual(["agents", "browse", "chat", "environment", "models", "nodes", "schedules"]);
  });
});

describe("sidebar lists and highlight from the route table", () => {
  it("builds exactly today's sidebar sections", () => {
    expect(kNavSections).toEqual([
      {
        id: "start",
        label: "",
        items: [
          { id: "home", label: "Home", path: "/home" },
          { id: "chat", label: "Chat", path: "/chat" },
        ],
      },
      {
        id: "operate",
        label: "Operate",
        items: [
          { id: "health", label: "Health", path: "/health" },
          { id: "doctor", label: "Doctor", path: "/doctor" },
          { id: "schedules", label: "Schedules", path: "/schedules" },
          { id: "usage", label: "Usage", path: "/usage" },
          kClaudeCodeNavItem,
          kDashboardsNavItem,
        ],
      },
      {
        id: "connect",
        label: "Connect",
        items: [
          { id: "channels", label: "Channels", path: "/channels" },
          { id: "groups", label: "Groups", path: "/groups" },
          { id: "integrations", label: "Integrations", path: "/integrations" },
          { id: "relay", label: "Relay", path: "/relay" },
        ],
      },
      {
        id: "settings",
        label: "Settings",
        items: [
          { id: "models", label: "Models & keys", path: "/models" },
          { id: "environment", label: "Environment", path: "/environment" },
          { id: "team", label: "Team", path: "/team" },
        ],
      },
    ]);
    for (const item of kNavSections.flatMap((section) => section.items)) {
      if (item.href) continue;
      expect(item.path).toBe(getRoutePath(item.id));
    }
  });

  it("gives members exactly Usage, Schedules and Team", () => {
    expect([...kMemberNavIds].sort()).toEqual(["schedules", "team", "usage"]);
    const memberSections = filterNavSectionsForRole(kNavSections, "member");
    const memberIds = memberSections.flatMap((section) => section.items.map((item) => item.id));
    expect(memberIds).toEqual(["schedules", "usage", "team"]);
    expect(memberSections.map((section) => section.label)).toEqual(["Operate", "Settings"]);
    const adminOnly = kRoutes.filter((route) => route.adminOnly).map((route) => route.id);
    expect(adminOnly.sort()).toEqual(
      kRoutes
        .map((route) => route.id)
        .filter((id) => !["schedules", "team", "usage"].includes(id))
        .sort(),
    );
    expect(filterNavSectionsForRole(kNavSections, "admin")).toBe(kNavSections);
  });

  it.each([
    ["/home", "home"],
    ["/general", "home"],
    ["/health?incident=5", "health"],
    ["/watchdog?incident=5", "health"],
    ["/schedules/nightly", "schedules"],
    ["/cron/nightly", "schedules"],
    ["/usage/sess-1", "usage"],
    ["/doctor", "doctor"],
    ["/relay", "relay"],
    ["/groups", "groups"],
    ["/groups/ops", "groups"],
    ["/models", "models"],
    ["/providers", "models"],
    ["/environment", "environment"],
    ["/envars", "environment"],
    ["/webhooks/gmail", "integrations"],
    ["/webhooks", "integrations"],
    ["/nodes", "integrations"],
    ["/nodes/x", "integrations"],
    ["/channels", "channels"],
    ["/integrations", "integrations"],
    ["/team", "team"],
    ["/agents/main/tools", "agents"],
    ["/telegram/default", "channels"],
    ["/telegram", "channels"],
    ["/chat/agent%3Amain%3Amain", "chat"],
    ["/team/anything", "team"],
    ["/health/extra", "health"],
    ["/telegram/a/b", "channels"],
    ["/providers/x", "models"],
    ["/nope", "home"],
    ["", "home"],
  ])("highlights today's sidebar item for %s", (location, navId) => {
    expect(getSelectedNavId({ location })).toBe(navId);
  });

  it("highlights browse while the browse route is open", () => {
    expect(getSelectedNavId({ isBrowseRoute: true, location: "/browse/a.md" })).toBe("browse");
  });

  it("records the parent highlights PR 2b uses", () => {
    const parents = Object.fromEntries(
      kRoutes.filter((route) => route.parentId).map((route) => [route.id, route.parentId]),
    );
    expect(parents).toEqual({
      webhooks: "integrations",
      nodes: "integrations",
      telegram: "channels",
    });
    for (const [id, parentId] of Object.entries(parents)) {
      const parent = getRoute(parentId);
      expect(parent, parentId).not.toBeNull();
      expect(parent.parentId).toBeNull();
      expect(parent.group).toBe(getRoute(id).group);
    }
  });
});

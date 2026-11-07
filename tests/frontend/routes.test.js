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
  kDefaultUiTab,
  kMemberNavIds,
  kNavSections,
} from "../../lib/public/js/lib/app-navigation.js";
import { parseBrowseRoute } from "../../lib/public/js/lib/browse-route.js";
import { getHashRouterPath } from "../../lib/public/js/hooks/use-hash-location.js";

// ALPH-69 PR 2a: the route table is the single source for every Setup UI
// hash route. These tests pin today's hashes, the old -> new aliases, the
// sidebar's current lists and highlight, and the IA data PR 2b will render.

const servedRoutes = kRoutes.filter((route) => !route.planned);

// Every hash the Setup UI served before the route table, with the route id
// and params it must still resolve to.
const kTodaysHashes = [
  ["/general", "general", {}],
  ["/doctor", "doctor", {}],
  ["/watchdog", "watchdog", {}],
  ["/watchdog?incident=5", "watchdog", {}],
  ["/team", "team", {}],
  ["/usage", "usage", {}],
  ["/usage/sess-1", "usage", { sessionId: "sess-1" }],
  ["/relay", "relay", {}],
  ["/relay?tab=log", "relay", {}],
  ["/webhooks", "webhooks", {}],
  ["/webhooks/gmail", "webhooks", { hookName: "gmail" }],
  ["/telegram/default", "telegram", { accountId: "default" }],
  ["/telegram/ops%20bot", "telegram", { accountId: "ops%20bot" }],
  ["/agents", "agents", {}],
  ["/agents/main", "agents", { agentId: "main" }],
  ["/agents/main/tools", "agents", { agentId: "main", tab: "tools" }],
  ["/chat", "chat", {}],
  ["/chat/agent%3Amain%3Amain", "chat", { sessionKey: "agent%3Amain%3Amain" }],
  ["/cron", "cron", {}],
  ["/cron/nightly%20sync", "cron", { jobId: "nightly%20sync" }],
  ["/envars", "envars", {}],
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
    const planned = kRoutes.map((route) => route.plannedPath).filter(Boolean);
    expect(new Set(planned).size).toBe(planned.length);
    expect(planned.filter((path) => paths.includes(path))).toEqual([]);
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

  it("carries the new names without showing them yet", () => {
    const labels = Object.fromEntries(kRoutes.map((route) => [route.id, route.navLabel]));
    expect(labels).toMatchObject({
      general: "Home",
      watchdog: "Health",
      cron: "Schedules",
      envars: "Environment",
      models: "Models & keys",
      channels: "Channels",
      integrations: "Integrations",
    });
    expect(getRoute("general").title).toBe("Home");
    expect(getRoute("watchdog").purpose).toBe("Gateway, watchdog and incidents");
    const shownLabels = kNavSections.flatMap((section) => section.items.map((item) => item.label));
    for (const label of ["Home", "Health", "Schedules", "Environment", "Models & keys"]) {
      expect(shownLabels).not.toContain(label);
    }
  });

  it("puts each route in its IA group", () => {
    const groupOf = (id) => getRoute(id).group;
    expect(groupOf("general")).toBe("home");
    expect(groupOf("chat")).toBe("chat");
    expect(groupOf("agents")).toBe("agents");
    expect(["watchdog", "doctor", "cron", "usage"].map(groupOf)).toEqual(Array(4).fill("operate"));
    expect(["channels", "integrations", "relay", "webhooks", "nodes", "telegram"].map(groupOf)).toEqual(
      Array(6).fill("connect"),
    );
    expect(["models", "envars", "team"].map(groupOf)).toEqual(Array(3).fill("settings"));
  });

  it("records the hashes PR 2b moves to, none of which is served yet", () => {
    const planned = Object.fromEntries(
      kRoutes.filter((route) => route.plannedPath).map((route) => [route.id, route.plannedPath]),
    );
    expect(planned).toEqual({
      general: "/home",
      watchdog: "/health",
      cron: "/schedules",
      envars: "/environment",
    });
    for (const path of [...Object.values(planned), "/channels", "/integrations"]) {
      expect(resolveRoute(path), path).toEqual({ route: null, params: {}, redirectTo: "/general" });
    }
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
      "/providers": "/models",
      "/telegram": "/telegram/default",
    });
    for (const [from, to] of Object.entries(aliases)) {
      expect(resolveRoute(from).redirectTo).toBe(to);
      expect(resolveRoute(`${from}/`).redirectTo).toBe(to);
      expect(resolveRoute(to).redirectTo).toBe("");
    }
  });

  it("sends unknown and empty hashes to the default route", () => {
    expect(kDefaultUiTab).toBe(kDefaultRouteId);
    for (const location of ["", "/", "/nope", "/webhooks/a/b", "/telegram/a/b", "/chatty", "/general/x"]) {
      expect(resolveRoute(location), location).toEqual({
        route: null,
        params: {},
        redirectTo: "/general",
      });
    }
  });

  it("matches like wouter did: case-insensitive with one optional trailing slash", () => {
    expect(getRouteId("/Watchdog")).toBe("watchdog");
    expect(getRouteId("/usage/")).toBe("usage");
    expect(getRouteId("/doctor/")).toBe("doctor");
  });

  it("lets pane routes own their deeper paths, as location.startsWith did", () => {
    expect(getRouteId("/models/anything")).toBe("models");
    expect(getRouteId("/envars/x/y")).toBe("envars");
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
      ["#envars", "envars"],
      ["#watchdog?incident=5", "watchdog"],
      ["#browse/skills/notes.md", "browse"],
      ["", "general"],
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
    expect(surfaces).toEqual(["general", "watchdog"]);
    const panes = servedRoutes.filter((route) => route.shell === "pane").map((route) => route.id);
    expect(panes.sort()).toEqual(["agents", "browse", "chat", "cron", "envars", "models", "nodes"]);
  });
});

describe("sidebar lists and highlight from the route table", () => {
  it("builds exactly today's sidebar sections", () => {
    expect(kNavSections).toEqual([
      { label: "Setup", items: [{ id: "general", label: "General" }] },
      {
        label: "Monitoring",
        items: [
          { id: "cron", label: "Cron" },
          { id: "usage", label: "Usage" },
          { id: "doctor", label: "Doctor" },
          { id: "watchdog", label: "Watchdog" },
          { id: "relay", label: "Relay" },
          kClaudeCodeNavItem,
        ],
      },
      {
        label: "Config",
        items: [
          { id: "models", label: "Models" },
          { id: "envars", label: "Envars" },
          { id: "webhooks", label: "Webhooks" },
          { id: "nodes", label: "Nodes" },
          { id: "team", label: "Team" },
        ],
      },
    ]);
    for (const item of kNavSections.flatMap((section) => section.items)) {
      if (item.href) continue;
      expect(getRoutePath(item.id)).toBe(`/${item.id}`);
    }
  });

  it("matches today's admin gating: members see only Cron, Usage and Team", () => {
    expect([...kMemberNavIds].sort()).toEqual(["cron", "team", "usage"]);
    const memberIds = filterNavSectionsForRole(kNavSections, "member").flatMap((section) =>
      section.items.map((item) => item.id),
    );
    expect(memberIds).toEqual(["cron", "usage", "team"]);
    const adminOnly = kRoutes.filter((route) => route.adminOnly).map((route) => route.id);
    expect(adminOnly.sort()).toEqual(
      kRoutes
        .map((route) => route.id)
        .filter((id) => !["cron", "team", "usage"].includes(id))
        .sort(),
    );
  });

  it.each([
    ["/general", "general"],
    ["/watchdog?incident=5", "watchdog"],
    ["/cron/nightly", "cron"],
    ["/usage/sess-1", "usage"],
    ["/doctor", "doctor"],
    ["/relay", "relay"],
    ["/models", "models"],
    ["/providers", "models"],
    ["/envars", "envars"],
    ["/webhooks/gmail", "webhooks"],
    ["/nodes", "nodes"],
    ["/team", "team"],
    ["/agents/main/tools", "agents"],
    ["/telegram/default", ""],
    ["/telegram", ""],
    ["/chat/agent%3Amain%3Amain", ""],
    ["/team/anything", "team"],
    ["/watchdog/extra", "watchdog"],
    ["/telegram/a/b", ""],
    ["/providers/x", "models"],
    ["/nope", "general"],
    ["", "general"],
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

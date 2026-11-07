// The Setup UI route table: the single source for every hash route (ALPH-69
// PR 2a). Hash routing in app.js, the sidebar's item lists and highlight
// (app-navigation.js), the sidebar mode and last-visited tab
// (use-browse-navigation.js), the browse parser and the Gateway-surface check
// (use-app-shell-controller.js) all resolve a location through here.
//
// Two sets of names live side by side until PR 2b switches the sidebar:
//   - `navId` and `legacyLabel` are what the sidebar highlights and shows
//     today; PR 2b removes them.
//   - `title`, `navLabel`, `purpose`, `group`, `layout`, `parentId` and
//     `plannedPath` are the new IA from the ALPH-69 design review (General ->
//     Home, Watchdog -> Health, Cron -> Schedules, Envars -> Environment).
//     Nothing renders them yet. `planned` routes are not served yet (PR 3a).
//
// Patterns: `:name` is one segment, `:name?` an optional segment and `:name*`
// an optional rest (slashes included). Matching is case-insensitive and allows
// one trailing slash, as wouter's did. A `prefix` route also owns every deeper
// path (the panes that used `location.startsWith`). Param values are returned
// raw; callers decode them.

export const kRouteGroups = ["home", "chat", "agents", "operate", "connect", "settings"];

const route = (fields) => ({
  prefix: false,
  planned: false,
  purpose: null,
  layout: null,
  parentId: null,
  shell: "column",
  sidebarTab: "menu",
  menuReturn: "persist",
  gatewaySurface: false,
  redirectFrom: [],
  plannedPath: null,
  legacyLabel: null,
  ...fields,
});

export const kRoutes = [
  route({
    id: "general",
    path: "/general",
    patterns: ["/general"],
    title: "Home",
    navLabel: "Home",
    legacyLabel: "General",
    purpose: "Status and next steps for this box",
    group: "home",
    layout: "console",
    adminOnly: true,
    navId: "general",
    gatewaySurface: true,
    plannedPath: "/home",
  }),
  route({
    id: "chat",
    path: "/chat",
    patterns: ["/chat/:sessionKey*"],
    prefix: true,
    title: "Chat",
    navLabel: "Chat",
    group: "chat",
    layout: "pane",
    adminOnly: true,
    navId: "",
    shell: "pane",
    sidebarTab: "chat",
    menuReturn: "never",
  }),
  route({
    id: "agents",
    path: "/agents",
    patterns: ["/agents/:agentId?/:tab?"],
    prefix: true,
    title: "Agents",
    navLabel: "Agents",
    group: "agents",
    layout: "console",
    adminOnly: true,
    navId: "agents",
    shell: "pane",
    menuReturn: "session",
  }),
  route({
    id: "watchdog",
    path: "/watchdog",
    patterns: ["/watchdog"],
    title: "Health",
    navLabel: "Health",
    legacyLabel: "Watchdog",
    purpose: "Gateway, watchdog and incidents",
    group: "operate",
    layout: "briefing",
    adminOnly: true,
    navId: "watchdog",
    gatewaySurface: true,
    plannedPath: "/health",
  }),
  route({
    id: "doctor",
    path: "/doctor",
    patterns: ["/doctor"],
    title: "Doctor",
    navLabel: "Doctor",
    legacyLabel: "Doctor",
    purpose: "Checks this box's setup and finds what to fix",
    group: "operate",
    layout: "briefing",
    adminOnly: true,
    navId: "doctor",
  }),
  route({
    id: "cron",
    path: "/cron",
    patterns: ["/cron/:jobId?"],
    prefix: true,
    title: "Schedules",
    navLabel: "Schedules",
    legacyLabel: "Cron",
    purpose: "Jobs your agents run on a timetable",
    group: "operate",
    layout: "pane",
    adminOnly: false,
    navId: "cron",
    shell: "pane",
    plannedPath: "/schedules",
  }),
  route({
    id: "usage",
    path: "/usage",
    patterns: ["/usage/:sessionId?"],
    title: "Usage",
    navLabel: "Usage",
    legacyLabel: "Usage",
    purpose: "Turns and spend by agent, model and day",
    group: "operate",
    adminOnly: false,
    navId: "usage",
  }),
  route({
    id: "channels",
    path: "/channels",
    patterns: ["/channels"],
    planned: true,
    title: "Channels",
    navLabel: "Channels",
    purpose: "Where people reach your agents",
    group: "connect",
    layout: "console",
    adminOnly: true,
    navId: "channels",
  }),
  route({
    id: "integrations",
    path: "/integrations",
    patterns: ["/integrations"],
    planned: true,
    title: "Integrations",
    navLabel: "Integrations",
    purpose: "Services and tools this box connects to",
    group: "connect",
    layout: "console",
    adminOnly: true,
    navId: "integrations",
  }),
  route({
    id: "relay",
    path: "/relay",
    patterns: ["/relay"],
    title: "Relay",
    navLabel: "Relay",
    legacyLabel: "Relay",
    purpose: "Other agents can message this box's agent over the relay",
    group: "connect",
    layout: "briefing",
    adminOnly: true,
    navId: "relay",
  }),
  route({
    id: "models",
    path: "/models",
    patterns: ["/models"],
    prefix: true,
    title: "Models & keys",
    navLabel: "Models & keys",
    legacyLabel: "Models",
    purpose: "The models this box can use and the keys that pay for them",
    group: "settings",
    layout: "briefing",
    adminOnly: true,
    navId: "models",
    shell: "pane",
    redirectFrom: ["/providers"],
  }),
  route({
    id: "envars",
    path: "/envars",
    patterns: ["/envars"],
    prefix: true,
    title: "Environment",
    navLabel: "Environment",
    legacyLabel: "Envars",
    purpose: "Every other variable this box runs with",
    group: "settings",
    adminOnly: true,
    navId: "envars",
    shell: "pane",
    plannedPath: "/environment",
  }),
  route({
    id: "team",
    path: "/team",
    patterns: ["/team"],
    title: "Team",
    navLabel: "Team",
    legacyLabel: "Team",
    purpose: "Who can open this box",
    group: "settings",
    adminOnly: false,
    navId: "team",
  }),
  route({
    id: "webhooks",
    path: "/webhooks",
    patterns: ["/webhooks/:hookName?"],
    title: "Webhooks",
    navLabel: "Webhooks",
    legacyLabel: "Webhooks",
    group: "connect",
    adminOnly: true,
    parentId: "integrations",
    navId: "webhooks",
  }),
  route({
    id: "nodes",
    path: "/nodes",
    patterns: ["/nodes"],
    prefix: true,
    title: "Nodes",
    navLabel: "Nodes",
    legacyLabel: "Nodes",
    group: "connect",
    adminOnly: true,
    parentId: "integrations",
    navId: "nodes",
    shell: "pane",
  }),
  route({
    id: "telegram",
    path: "/telegram/default",
    patterns: ["/telegram/:accountId"],
    title: "Telegram",
    navLabel: "Telegram",
    group: "connect",
    adminOnly: true,
    parentId: "channels",
    navId: "",
    menuReturn: "never",
    redirectFrom: ["/telegram"],
  }),
  route({
    id: "browse",
    path: "/browse",
    patterns: ["/browse/:filePath*"],
    prefix: true,
    title: "Browse",
    navLabel: "Browse",
    group: null,
    layout: "pane",
    adminOnly: true,
    navId: "browse",
    shell: "pane",
    sidebarTab: "browse",
    menuReturn: "never",
  }),
];

export const kDefaultRouteId = "general";

const kRoutesById = new Map(kRoutes.map((entry) => [entry.id, entry]));

export const getRoute = (id) => kRoutesById.get(id) || null;

export const getRoutePath = (id) =>
  (getRoute(id) || getRoute(kDefaultRouteId)).path;

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const compilePattern = (pattern, prefix = false) => {
  const keys = [];
  const source = pattern
    .split("/")
    .filter(Boolean)
    .map((segment) => {
      if (!segment.startsWith(":")) return `/${escapeRegex(segment)}`;
      const modifier = segment.slice(-1);
      if (modifier === "*") {
        keys.push(segment.slice(1, -1));
        return "(?:/(.+))?";
      }
      if (modifier === "?") {
        keys.push(segment.slice(1, -1));
        return "(?:/([^/]+?))?";
      }
      keys.push(segment.slice(1));
      return "/([^/]+?)";
    })
    .join("");
  return { keys, regex: new RegExp(`^${source}${prefix ? "(?=$|/)" : "/?$"}`, "i") };
};

const kCompiledRoutes = kRoutes
  .filter((entry) => !entry.planned)
  .map((entry) => ({
    route: entry,
    matchers: entry.patterns.map((pattern) => compilePattern(pattern, entry.prefix)),
    redirects: entry.redirectFrom.map((pattern) => compilePattern(pattern)),
  }));

const matchAny = (matchers, path) => {
  for (const { keys, regex } of matchers) {
    const match = path.match(regex);
    if (!match) continue;
    const params = {};
    keys.forEach((key, index) => {
      if (match[index + 1] !== undefined) params[key] = match[index + 1];
    });
    return params;
  }
  return null;
};

// Resolves a hash location (a query is allowed and ignored) to
// `{ route, params, redirectTo }`. An old hash returns its target route and
// `redirectTo` set to the target's path; an unknown one returns `route: null`
// and redirects to the default route.
export const resolveRoute = (location = "") => {
  const path = String(location || "").split("?")[0];
  for (const { route: entry, matchers } of kCompiledRoutes) {
    const params = matchAny(matchers, path);
    if (params) return { route: entry, params, redirectTo: "" };
  }
  for (const { route: entry, redirects } of kCompiledRoutes) {
    if (matchAny(redirects, path)) {
      return { route: entry, params: {}, redirectTo: entry.path };
    }
  }
  return { route: null, params: {}, redirectTo: getRoutePath(kDefaultRouteId) };
};

export const getRouteId = (location = "") => resolveRoute(location).route?.id || "";

const firstSegment = (path) =>
  String(path || "").split("?")[0].split("/").filter(Boolean)[0]?.toLowerCase() || "";

// The route that owns a location's first segment, even when the full path
// does not resolve (`/team/anything` belongs to Team). The sidebar
// highlights this owner, as its `location.startsWith` checks did.
export const getRouteOwner = (location = "") => {
  const resolved = resolveRoute(location).route;
  if (resolved) return resolved;
  const segment = firstSegment(location);
  if (!segment) return null;
  return (
    kCompiledRoutes.find(({ route: entry }) =>
      [...entry.patterns, ...entry.redirectFrom].some(
        (pattern) => firstSegment(pattern) === segment,
      ),
    )?.route || null
  );
};

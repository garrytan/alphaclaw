// The Setup UI route table: the single source for every hash route (ALPH-69
// PR 2a). Hash routing in app.js, the sidebar's item lists and highlight
// (app-navigation.js), the sidebar mode and last-visited tab
// (use-browse-navigation.js), the browse parser, the Gateway-surface check
// (isGatewaySurfaceLocation, used by the app-shell controller's hooks) and
// every page header (page-header.js) all resolve a location through here.
//
// PR 2b serves the new IA: General moved to #/home, Watchdog to #/health, Cron
// to #/schedules and Envars to #/environment. Each old hash stays in its
// route's `redirectFrom`, so links already sent keep working. `title` and
// `purpose` feed the page header and document.title, `navLabel` and `group`
// the sidebar, and `parentId` names the sidebar item a page without its own
// item highlights. PR 3a gave Channels and Integrations their own pages;
// Webhooks and Nodes are reached from Integrations and highlight it.
//
// Patterns: `:name` is one segment, `:name?` an optional segment and `:name*`
// an optional rest (slashes included). Matching is case-insensitive and allows
// one trailing slash, as wouter's did. A `prefix` route also owns every deeper
// path (the panes that used `location.startsWith`). Param values are returned
// raw; callers decode them. A redirect keeps the params its old pattern shares
// with the route's first pattern (`/cron/a` -> `/schedules/a`) and the query.

export const kRouteGroups = ["home", "chat", "agents", "operate", "connect", "settings"];

const route = (fields) => ({
  prefix: false,
  purpose: null,
  layout: null,
  // A Briefing page whose screen pass landed reads at the content width.
  wide: false,
  parentId: null,
  shell: "column",
  sidebarTab: "menu",
  menuReturn: "persist",
  gatewaySurface: false,
  redirectFrom: [],
  ...fields,
});

export const kRoutes = [
  route({
    id: "home",
    path: "/home",
    patterns: ["/home"],
    title: "Home",
    navLabel: "Home",
    purpose: "Status and next steps for this box",
    group: "home",
    layout: "console",
    adminOnly: true,
    gatewaySurface: true,
    redirectFrom: ["/general"],
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
    shell: "pane",
    menuReturn: "session",
  }),
  route({
    id: "health",
    path: "/health",
    patterns: ["/health"],
    title: "Health",
    navLabel: "Health",
    purpose: "Gateway, watchdog and incidents",
    group: "operate",
    layout: "briefing",
    wide: true,
    adminOnly: true,
    gatewaySurface: true,
    redirectFrom: ["/watchdog"],
  }),
  route({
    id: "doctor",
    path: "/doctor",
    patterns: ["/doctor"],
    title: "Doctor",
    navLabel: "Doctor",
    purpose: "Checks this box's setup and finds what to fix",
    group: "operate",
    layout: "briefing",
    wide: true,
    adminOnly: true,
  }),
  route({
    id: "schedules",
    path: "/schedules",
    patterns: ["/schedules/:jobId?"],
    prefix: true,
    title: "Schedules",
    navLabel: "Schedules",
    purpose: "Jobs your agents run on a timetable",
    group: "operate",
    layout: "pane",
    adminOnly: false,
    shell: "pane",
    redirectFrom: ["/cron/:jobId?"],
  }),
  route({
    id: "usage",
    path: "/usage",
    patterns: ["/usage/:sessionId?"],
    title: "Usage",
    navLabel: "Usage",
    purpose: "Turns and spend by agent, model and day",
    group: "operate",
    layout: "console",
    adminOnly: false,
  }),
  route({
    id: "channels",
    path: "/channels",
    patterns: ["/channels"],
    title: "Channels",
    navLabel: "Channels",
    purpose: "Where people reach your agents",
    group: "connect",
    layout: "console",
    adminOnly: true,
  }),
  route({
    id: "integrations",
    path: "/integrations",
    patterns: ["/integrations"],
    title: "Integrations",
    navLabel: "Integrations",
    purpose: "Services and tools this box connects to",
    group: "connect",
    layout: "console",
    adminOnly: true,
  }),
  route({
    id: "relay",
    path: "/relay",
    patterns: ["/relay"],
    title: "Relay",
    navLabel: "Relay",
    purpose: "Other agents can message this box's agent over the relay",
    group: "connect",
    layout: "briefing",
    wide: true,
    adminOnly: true,
  }),
  route({
    id: "models",
    path: "/models",
    patterns: ["/models"],
    prefix: true,
    title: "Models & keys",
    navLabel: "Models & keys",
    purpose: "The models this box can use and the keys that pay for them",
    group: "settings",
    layout: "briefing",
    adminOnly: true,
    shell: "pane",
    redirectFrom: ["/providers"],
  }),
  route({
    id: "environment",
    path: "/environment",
    patterns: ["/environment"],
    prefix: true,
    title: "Environment",
    navLabel: "Environment",
    purpose: "Every other variable this box runs with",
    group: "settings",
    adminOnly: true,
    shell: "pane",
    redirectFrom: ["/envars/:rest*"],
  }),
  route({
    id: "team",
    path: "/team",
    patterns: ["/team"],
    title: "Team",
    navLabel: "Team",
    purpose: "Who can open this box",
    group: "settings",
    adminOnly: false,
  }),
  route({
    id: "webhooks",
    path: "/webhooks",
    patterns: ["/webhooks/:hookName?"],
    title: "Webhooks",
    navLabel: "Webhooks",
    group: "connect",
    adminOnly: true,
    parentId: "integrations",
  }),
  route({
    id: "nodes",
    path: "/nodes",
    patterns: ["/nodes"],
    prefix: true,
    title: "Nodes",
    navLabel: "Nodes",
    group: "connect",
    adminOnly: true,
    parentId: "integrations",
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
    shell: "pane",
    sidebarTab: "browse",
    menuReturn: "never",
  }),
];

export const kDefaultRouteId = "home";

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

const kCompiledRoutes = kRoutes.map((entry) => ({
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

// Fills a pattern's params; null when a required one is missing.
const fillPattern = (pattern, params) => {
  const segments = [];
  for (const segment of pattern.split("/").filter(Boolean)) {
    if (!segment.startsWith(":")) {
      segments.push(segment);
      continue;
    }
    const optional = segment.endsWith("?") || segment.endsWith("*");
    const value = params[segment.slice(1, optional ? -1 : undefined)];
    if (value !== undefined) segments.push(value);
    else if (!optional) return null;
  }
  return `/${segments.join("/")}`;
};

// Resolves a hash location to `{ route, params, redirectTo }`. An old hash
// returns its target route, the params it carries over, and `redirectTo` set
// to the new hash with the query kept; an unknown one returns `route: null`
// and redirects to the default route.
export const resolveRoute = (location = "") => {
  const [path, ...queryParts] = String(location || "").split("?");
  const query = queryParts.join("?");
  for (const { route: entry, matchers } of kCompiledRoutes) {
    const params = matchAny(matchers, path);
    if (params) return { route: entry, params, redirectTo: "" };
  }
  for (const { route: entry, matchers, redirects } of kCompiledRoutes) {
    const oldParams = matchAny(redirects, path);
    if (!oldParams) continue;
    const target = fillPattern(entry.patterns[0], oldParams) || entry.path;
    const params = matchAny(matchers, target);
    return { route: entry, params, redirectTo: query ? `${target}?${query}` : target };
  }
  return { route: null, params: {}, redirectTo: getRoutePath(kDefaultRouteId) };
};

export const getRouteId = (location = "") => resolveRoute(location).route?.id || "";

// The routes that render the Gateway card (`gatewaySurface`); operation
// outcomes reaching the user elsewhere surface as toasts.
export const isGatewaySurfaceLocation = (location = "") =>
  resolveRoute(location).route?.gatewaySurface === true;

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

import { getRoute, getRouteOwner, kDefaultRouteId, kRoutes } from "./routes.js";

export const kDefaultUiTab = kDefaultRouteId;

// The Claude Code launcher's fallback destination — also the nav item's real
// href, so keyboard focus and modifier-clicks keep native link semantics.
export const kClaudeCodeUrl = "https://claude.ai/code";

// Claude Code launcher: an action item, not a hash route. Lives at the foot
// of Operate, before Dashboards. Admin-only via filterNavSectionsForRole.
export const kClaudeCodeNavItem = {
  id: "claude-code",
  label: "Open Claude Code",
  href: kClaudeCodeUrl,
};

// Server-side Control UI launcher: an authenticated 302 that primes the
// #token= fragment (or stays tokenless for members/trusted-proxy), so the
// gateway token never enters the SPA's JS.
export const kDashboardLaunchUrl = "/gateway/launch";

// OpenClaw session dashboards. Routed through the launcher so the new tab
// lands auto-connected; an external href rather than a hash route. Admin-only
// via filterNavSectionsForRole.
export const kDashboardsNavItem = {
  id: "dashboards",
  label: "Dashboards",
  href: `${kDashboardLaunchUrl}?to=dashboards`,
  title:
    "Opens OpenClaw session dashboards in a new tab (signed in automatically)",
};

// The sidebar groups in order (ALPH-69 IA). The first group has no label;
// the agent rows render between it and Operate.
const kNavLayout = [
  { id: "start", label: "", routeIds: ["home", "chat"] },
  {
    id: "operate",
    label: "Operate",
    routeIds: ["health", "doctor", "schedules", "usage"],
    trailingItems: [kClaudeCodeNavItem, kDashboardsNavItem],
  },
  { id: "connect", label: "Connect", routeIds: ["channels", "integrations", "relay"] },
  { id: "settings", label: "Settings", routeIds: ["models", "environment", "team"] },
];

const buildRouteNavItem = (id) => {
  const route = getRoute(id);
  return { id, label: route.navLabel, path: route.path };
};

export const kNavSections = kNavLayout.map(({ id, label, routeIds, trailingItems = [] }) => ({
  id,
  label,
  items: [...routeIds.map(buildRouteNavItem), ...trailingItems],
}));

const kRouteNavItemIds = new Set(
  kNavSections.flatMap((section) => section.items.filter((item) => item.path).map((item) => item.id)),
);

// Pages whose APIs are member-readable (4.6 matrix). Members see only these
// in the nav — the admin pages would render as walls of 403s otherwise.
export const kMemberNavIds = new Set(
  kRoutes.filter((route) => !route.adminOnly).map((route) => route.id),
);

export const filterNavSectionsForRole = (sections = [], role = null) => {
  if (role !== "member") return sections;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => kMemberNavIds.has(item.id)),
    }))
    .filter((section) => section.items.length > 0);
};

// A page highlights its own sidebar item, or its parent's when it has none
// (Telegram highlights Channels, Webhooks and Nodes highlight Integrations). Agent pages highlight their agent row, which
// the sidebar draws from the selected agent.
export const getSelectedNavId = ({ isBrowseRoute = false, location = "" } = {}) => {
  if (isBrowseRoute) return "browse";
  const owner = getRouteOwner(location);
  if (!owner) return kDefaultUiTab;
  return kRouteNavItemIds.has(owner.id) ? owner.id : owner.parentId || owner.id;
};

import {
  getAgentIdFromSessionKey,
  getNormalizedSessionKey,
} from "./session-keys.js";
import { getRoute, getRouteOwner, kDefaultRouteId, kRoutes } from "./routes.js";

export const kDefaultUiTab = kDefaultRouteId;

// The Claude Code launcher's fallback destination — also the nav item's real
// href, so keyboard focus and modifier-clicks keep native link semantics.
export const kClaudeCodeUrl = "https://claude.ai/code";

// Claude Code launcher: an action item, not a hash route. Lives at the foot
// of Operate (Dashboards appends after it when version-gated in). Admin-only
// via filterNavSectionsForRole.
export const kClaudeCodeNavItem = {
  id: "claude-code",
  label: "Open Claude Code",
  href: kClaudeCodeUrl,
};

// The sidebar groups in order (ALPH-69 IA). The first group has no label;
// the agent rows render between it and Operate.
const kNavLayout = [
  { id: "start", label: "", routeIds: ["home", "chat"] },
  {
    id: "operate",
    label: "Operate",
    routeIds: ["health", "doctor", "schedules", "usage"],
    trailingItems: [kClaudeCodeNavItem],
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

// Server-side Control UI launcher: an authenticated 302 that primes the
// #token= fragment (or stays tokenless for members/trusted-proxy), so the
// gateway token never enters the SPA's JS.
export const kDashboardLaunchUrl = "/gateway/launch";

// OpenClaw session dashboards (2026.8.1-beta.1+, version-gated). Routed
// through the launcher so the new tab lands auto-connected; still an
// external href rather than a hash route.
export const kDashboardsNavItem = {
  id: "dashboards",
  label: "Dashboards",
  href: `${kDashboardLaunchUrl}?to=dashboards`,
  title:
    "Opens OpenClaw session dashboards in a new tab (signed in automatically)",
};

// Focus-mode deep link into a single session's dashboard.
//
// Contract (OpenClaw 2026.8.1-beta.3, docs/web/urls.md — "Session and dashboard
// URLs" + "Focus presentation routes"): focus deep links are PATH-form only,
// `<basePath>/focus/dashboard/<agentId>[/<sessionRef...>]` (AlphaClaw proxies
// the gateway UI at /openclaw). The old `?focus=` query form is NOT accepted
// ("the removed desktop and dashboard query forms are not accepted"), and a
// raw session key is NOT a valid single path segment either — only
// `/focus/desktop/session/<encodedExactSessionKey>` takes one. The session ref
// is instead derived from the key per the documented grammar:
//   - Short-id form when the key's rest (everything after `agent:<id>:`) ends
//     in a UUID: >=8 lowercase hex chars of that trailing UUID with dashes
//     omitted; "longer prefixes up to all 32 hexadecimal characters are
//     accepted", so we emit all 32 for uniqueness. The display-name slug is
//     optional and decorative, so we omit it (we only have the key).
//   - Literal-key form otherwise: each colon-delimited rest segment becomes
//     one URL-encoded path segment, with `.` -> `~dot`, `..` -> `~dotdot`, a
//     doubled leading `~`, and a `~key` marker inserted before a one-segment
//     rest that could be mistaken for a short id (docs example:
//     `agent:main:release-deadbeef` -> `/chat/main/~key/release-deadbeef`).
//     We never collapse the configured `session.mainKey` to the agent-only
//     path (we cannot know it here); the literal form stays authoritative
//     (`agent:research:main` -> `/dashboard/research/main` per urls.md).
// This helper has no production callers yet (tests only), so this is a
// contract-only fix ahead of first use.
const kFocusDashboardBase = "/openclaw/focus/dashboard";
const kTrailingUuidPattern =
  /([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/;
const kShortIdLikeRestPattern = /(?:^|-)[0-9a-f]{8,32}$/;

const escapeLiteralRefSegment = (segment) => {
  if (segment === ".") return "~dot";
  if (segment === "..") return "~dotdot";
  return segment.startsWith("~") ? `~${segment}` : segment;
};

export const buildDashboardFocusUrl = (sessionKey = "") => {
  const key = getNormalizedSessionKey(sessionKey);
  const agentId = getAgentIdFromSessionKey(key);
  if (!agentId) return kDashboardsNavItem.href;
  const agentPath = `${kFocusDashboardBase}/${encodeURIComponent(agentId)}`;
  const rest = key.slice(`agent:${agentId}:`.length);
  if (!rest) return agentPath;
  const uuidMatch = rest.match(kTrailingUuidPattern);
  if (uuidMatch) return `${agentPath}/${uuidMatch.slice(1).join("")}`;
  const literalSegments = rest.split(":").map(escapeLiteralRefSegment);
  const needsKeyMarker =
    literalSegments.length === 1 && kShortIdLikeRestPattern.test(rest);
  const refSegments = needsKeyMarker
    ? ["~key", ...literalSegments]
    : literalSegments;
  return `${agentPath}/${refSegments.map(encodeURIComponent).join("/")}`;
};

// Gated nav assembly: with features.sessionDashboards false (or unknown) the
// sections are exactly kNavSections — nothing observable changes on stable.
export const buildNavSections = ({ features = {} } = {}) => {
  if (features?.sessionDashboards !== true) return kNavSections;
  return kNavSections.map((section) =>
    section.id === "operate"
      ? { ...section, items: [...section.items, kDashboardsNavItem] }
      : section,
  );
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

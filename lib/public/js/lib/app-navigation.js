import {
  getAgentIdFromSessionKey,
  getNormalizedSessionKey,
} from "./session-keys.js";

export const kDefaultUiTab = "general";

export const kNavSections = [
  {
    label: "Setup",
    items: [
      { id: "general", label: "General" },
    ],
  },
  {
    label: "Monitoring",
    items: [
      { id: "cron", label: "Cron" },
      { id: "usage", label: "Usage" },
      { id: "doctor", label: "Doctor" },
      { id: "watchdog", label: "Watchdog" },
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
      { id: "upgrade", label: "Upgrade" },
    ],
  },
];

// Pages whose APIs are member-readable (4.6 matrix). Members see only these
// in the nav — the admin pages would render as walls of 403s otherwise.
export const kMemberNavIds = new Set(["usage", "cron", "team"]);

export const filterNavSectionsForRole = (sections = [], role = null) => {
  if (role !== "member") return sections;
  return sections
    .map((section) => ({
      ...section,
      items: section.items.filter((item) => kMemberNavIds.has(item.id)),
    }))
    .filter((section) => section.items.length > 0);
};

// OpenClaw session dashboards (2026.8.1-beta.1+, version-gated). The gateway
// serves them itself; AlphaClaw already proxies /openclaw/* through, so the
// nav item is an external href rather than a hash route.
export const kDashboardsNavItem = {
  id: "dashboards",
  label: "Dashboards",
  href: "/openclaw/dashboards",
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
    section.label === "Monitoring"
      ? { ...section, items: [...section.items, kDashboardsNavItem] }
      : section,
  );
};

export const getSelectedNavId = ({ isBrowseRoute = false, location = "" } = {}) => {
  if (isBrowseRoute) return "browse";
  if (location.startsWith("/telegram")) return "";
  if (location.startsWith("/chat")) return "";
  if (location.startsWith("/models")) return "models";
  if (location.startsWith("/agents")) return "agents";
  if (location.startsWith("/providers")) return "models";
  if (location.startsWith("/watchdog")) return "watchdog";
  if (location.startsWith("/cron")) return "cron";
  if (location.startsWith("/usage")) return "usage";
  if (location.startsWith("/doctor")) return "doctor";
  if (location.startsWith("/nodes")) return "nodes";
  if (location.startsWith("/team")) return "team";
  if (location.startsWith("/upgrade")) return "upgrade";
  if (location.startsWith("/envars")) return "envars";
  if (location.startsWith("/webhooks")) return "webhooks";
  return kDefaultUiTab;
};

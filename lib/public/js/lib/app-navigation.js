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
export const buildDashboardFocusUrl = (sessionKey = "") => {
  const key = String(sessionKey || "").trim();
  return key
    ? `${kDashboardsNavItem.href}?focus=${encodeURIComponent(key)}`
    : kDashboardsNavItem.href;
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

import { describe, expect, it } from "vitest";
import {
  buildDashboardFocusUrl,
  buildNavSections,
  getSelectedNavId,
  kDashboardsNavItem,
  kNavSections,
} from "../../lib/public/js/lib/app-navigation.js";

describe("app-navigation gated sections", () => {
  it("returns exactly the base sections when the dashboards gate is closed or unknown", () => {
    expect(buildNavSections()).toBe(kNavSections);
    expect(buildNavSections({ features: {} })).toBe(kNavSections);
    expect(buildNavSections({ features: { sessionDashboards: false } })).toBe(
      kNavSections,
    );
    // Fail-closed on non-boolean truthiness too.
    expect(buildNavSections({ features: { sessionDashboards: "yes" } })).toBe(
      kNavSections,
    );
  });

  it("appends the Dashboards external link to Monitoring when the gate is open", () => {
    const sections = buildNavSections({
      features: { sessionDashboards: true },
    });
    const monitoring = sections.find((s) => s.label === "Monitoring");
    expect(monitoring.items[monitoring.items.length - 1]).toEqual(
      kDashboardsNavItem,
    );
    expect(kDashboardsNavItem.href).toBe("/openclaw/dashboards");
    // The base sections are never mutated.
    const baseMonitoring = kNavSections.find((s) => s.label === "Monitoring");
    expect(
      baseMonitoring.items.some((item) => item.id === "dashboards"),
    ).toBe(false);
  });

  it("selects the team nav item for /team locations", () => {
    expect(getSelectedNavId({ location: "/team" })).toBe("team");
    expect(getSelectedNavId({ location: "/team/anything" })).toBe("team");
  });
});

// Path-form focus links per OpenClaw 2026.8.1-beta docs/web/urls.md — the
// Control UI does not accept query focus forms.
describe("buildDashboardFocusUrl", () => {
  it("emits literal-key path refs (one URL-encoded segment per colon segment)", () => {
    expect(buildDashboardFocusUrl("agent:main:main")).toBe(
      "/openclaw/focus/dashboard/main/main",
    );
    expect(buildDashboardFocusUrl("agent:main:telegram:12345")).toBe(
      "/openclaw/focus/dashboard/main/telegram/12345",
    );
    expect(buildDashboardFocusUrl("agent:main:cron:nightly:run:8821")).toBe(
      "/openclaw/focus/dashboard/main/cron/nightly/run/8821",
    );
    // Whitespace is trimmed before parsing.
    expect(buildDashboardFocusUrl("  agent:main:main  ")).toBe(
      "/openclaw/focus/dashboard/main/main",
    );
  });

  it("uses the short-id form (trailing UUID hex, dashes omitted) when the rest ends in a UUID", () => {
    expect(
      buildDashboardFocusUrl("agent:main:6db92d48-13f2-4a7c-9e21-0123456789ab"),
    ).toBe("/openclaw/focus/dashboard/main/6db92d4813f24a7c9e210123456789ab");
    expect(
      buildDashboardFocusUrl(
        "agent:roboclaw:subagent:6db92d48-13f2-4a7c-9e21-0123456789ab",
      ),
    ).toBe(
      "/openclaw/focus/dashboard/roboclaw/6db92d4813f24a7c9e210123456789ab",
    );
  });

  it("escapes literal segments per the documented grammar", () => {
    // ~key disambiguation for a one-segment rest that parses like a short id
    // (docs example: agent:main:release-deadbeef).
    expect(buildDashboardFocusUrl("agent:main:release-deadbeef")).toBe(
      "/openclaw/focus/dashboard/main/~key/release-deadbeef",
    );
    expect(buildDashboardFocusUrl("agent:main:deadbeefcafe1234")).toBe(
      "/openclaw/focus/dashboard/main/~key/deadbeefcafe1234",
    );
    // Reserved literal names never need the marker.
    expect(buildDashboardFocusUrl("agent:main:global")).toBe(
      "/openclaw/focus/dashboard/main/global",
    );
    // Dot segments and leading ~ escaping.
    expect(buildDashboardFocusUrl("agent:main:.:x")).toBe(
      "/openclaw/focus/dashboard/main/~dot/x",
    );
    expect(buildDashboardFocusUrl("agent:main:..")).toBe(
      "/openclaw/focus/dashboard/main/~dotdot",
    );
    expect(buildDashboardFocusUrl("agent:main:~weird")).toBe(
      "/openclaw/focus/dashboard/main/~~weird",
    );
    // encodeURIComponent applies per segment (agent id included).
    expect(buildDashboardFocusUrl("agent:my agent:a b/c")).toBe(
      "/openclaw/focus/dashboard/my%20agent/a%20b%2Fc",
    );
  });

  it("emits the agent-level focus URL when the key has an empty rest", () => {
    expect(buildDashboardFocusUrl("agent:main:")).toBe(
      "/openclaw/focus/dashboard/main",
    );
  });

  it("falls back to the dashboards index for unparseable keys", () => {
    expect(buildDashboardFocusUrl("")).toBe("/openclaw/dashboards");
    expect(buildDashboardFocusUrl("   ")).toBe("/openclaw/dashboards");
    expect(buildDashboardFocusUrl(null)).toBe("/openclaw/dashboards");
    expect(buildDashboardFocusUrl(undefined)).toBe("/openclaw/dashboards");
    expect(buildDashboardFocusUrl("main")).toBe("/openclaw/dashboards");
    expect(buildDashboardFocusUrl("agent:")).toBe("/openclaw/dashboards");
    // No rest separator at all -> not a session key.
    expect(buildDashboardFocusUrl("agent:main")).toBe("/openclaw/dashboards");
    // Empty agent id.
    expect(buildDashboardFocusUrl("agent::main")).toBe("/openclaw/dashboards");
  });
});

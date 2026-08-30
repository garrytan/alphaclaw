import { describe, expect, it } from "vitest";
import {
  buildDashboardFocusUrl,
  buildNavSections,
  filterNavSectionsForRole,
  getSelectedNavId,
  kClaudeCodeNavItem,
  kClaudeCodeUrl,
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

  it("buildDashboardFocusUrl encodes the session key and falls back to the base href", () => {
    expect(buildDashboardFocusUrl("agent:main:main")).toBe(
      "/openclaw/dashboards?focus=agent%3Amain%3Amain",
    );
    expect(buildDashboardFocusUrl("")).toBe("/openclaw/dashboards");
    expect(buildDashboardFocusUrl("   ")).toBe("/openclaw/dashboards");
  });

  it("selects the team nav item for /team locations", () => {
    expect(getSelectedNavId({ location: "/team" })).toBe("team");
    expect(getSelectedNavId({ location: "/team/anything" })).toBe("team");
  });
});

describe("claude-code launcher nav item", () => {
  it("is the last static Monitoring item with the external href", () => {
    const monitoring = kNavSections.find((s) => s.label === "Monitoring");
    const last = monitoring.items[monitoring.items.length - 1];
    expect(last).toEqual(kClaudeCodeNavItem);
    expect(last).toEqual({
      id: "claude-code",
      label: "Open Claude Code",
      href: kClaudeCodeUrl,
    });
    expect(kClaudeCodeUrl).toBe("https://claude.ai/code");
  });

  it("keeps Dashboards appended after it when the gate is open", () => {
    const sections = buildNavSections({ features: { sessionDashboards: true } });
    const monitoring = sections.find((s) => s.label === "Monitoring");
    const ids = monitoring.items.map((item) => item.id);
    expect(ids.indexOf("claude-code")).toBe(ids.length - 2);
    expect(ids[ids.length - 1]).toBe("dashboards");
  });

  it("is hidden from members (firing bills the owner's claude.ai account)", () => {
    const memberSections = filterNavSectionsForRole(kNavSections, "member");
    const memberIds = memberSections.flatMap((s) => s.items.map((i) => i.id));
    expect(memberIds).not.toContain("claude-code");
    const adminIds = filterNavSectionsForRole(kNavSections, "admin").flatMap(
      (s) => s.items.map((i) => i.id),
    );
    expect(adminIds).toContain("claude-code");
  });
});

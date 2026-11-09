import { describe, expect, it } from "vitest";
import {
  filterNavSectionsForRole,
  getSelectedNavId,
  kClaudeCodeNavItem,
  kClaudeCodeUrl,
  kDashboardLaunchUrl,
  kDashboardsNavItem,
  kNavSections,
} from "../../lib/public/js/lib/app-navigation.js";

describe("app-navigation sections", () => {
  it("ends Operate with the Dashboards external link", () => {
    const operate = kNavSections.find((s) => s.id === "operate");
    expect(operate.items[operate.items.length - 1]).toEqual(
      kDashboardsNavItem,
    );
    // Contract pin: the server-side launcher route the item (and the three
    // window.open consumers) depend on.
    expect(kDashboardLaunchUrl).toBe("/gateway/launch");
    expect(kDashboardsNavItem.href).toBe("/gateway/launch?to=dashboards");
    expect(kDashboardsNavItem.title).toBe(
      "Opens OpenClaw session dashboards in a new tab (signed in automatically)",
    );
  });

  it("hides Dashboards from members", () => {
    const memberIds = filterNavSectionsForRole(kNavSections, "member").flatMap(
      (s) => s.items.map((i) => i.id),
    );
    expect(memberIds).not.toContain("dashboards");
  });

  it("selects the relay nav item for /relay locations", () => {
    expect(getSelectedNavId({ location: "/relay" })).toBe("relay");
    expect(getSelectedNavId({ location: "/relay?tab=log" })).toBe("relay");
  });

  it("selects the team nav item for /team locations", () => {
    expect(getSelectedNavId({ location: "/team" })).toBe("team");
    expect(getSelectedNavId({ location: "/team/anything" })).toBe("team");
  });
});

describe("claude-code launcher nav item", () => {
  it("sits in Operate just before Dashboards with the external href", () => {
    const operate = kNavSections.find((s) => s.id === "operate");
    const ids = operate.items.map((item) => item.id);
    expect(ids.slice(-2)).toEqual(["claude-code", "dashboards"]);
    expect(operate.items[ids.length - 2]).toEqual(kClaudeCodeNavItem);
    expect(kClaudeCodeNavItem).toEqual({
      id: "claude-code",
      label: "Open Claude Code",
      href: kClaudeCodeUrl,
    });
    expect(kClaudeCodeUrl).toBe("https://claude.ai/code");
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

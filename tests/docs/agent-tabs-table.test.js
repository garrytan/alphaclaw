import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { kNavSections } from "../../lib/public/js/lib/app-navigation.js";

// Docs-lint (fix wave PR 13, audit F200): the agent-facing Tabs table in
// core-prompts/TOOLS.md (rendered into the workspace's hooks/bootstrap/AGENTS.md)
// went six months stale — 6 tabs listed against 11 routed. The nav registry is
// the one source of truth; the table must name every tab it routes.
const kToolsMd = readFileSync(
  path.join(__dirname, "..", "..", "lib", "setup", "core-prompts", "TOOLS.md"),
  "utf8",
);

const tabsSection = () => {
  const start = kToolsMd.indexOf("### Tabs");
  expect(start).toBeGreaterThan(-1);
  const rest = kToolsMd.slice(start);
  const next = rest.indexOf("\n#", 4);
  return next === -1 ? rest : rest.slice(0, next);
};

describe("docs/agent-facing TOOLS.md Tabs table", () => {
  // Items with an `href` are action items (the Claude Code launcher), not hash
  // routes — the table documents tabs the agent can point the user at.
  const routed = kNavSections.flatMap((section) =>
    section.items.filter((item) => !item.href).map((item) => item.id),
  );

  it("lists every hash-routed tab from kNavSections with its {{SETUP_UI_URL}}#<id> link", () => {
    const section = tabsSection();
    const missing = routed.filter((id) => !section.includes(`{{SETUP_UI_URL}}#${id}`));
    expect(missing, `TOOLS.md Tabs table is missing: ${missing.join(", ")}`).toEqual([]);
  });

  // Routes the app serves outside the nav registry: the beta-gated Dashboards
  // item and the file browser (`#browse/<path>`, reached from the sidebar tree).
  const kNonNavRoutes = new Set(["dashboards", "browse"]);

  it("names no tab the nav registry does not route (beyond the non-nav routes)", () => {
    const linked = [...tabsSection().matchAll(/\{\{SETUP_UI_URL\}\}#([a-z-]+)/g)].map((m) => m[1]);
    const unknown = linked.filter((id) => !routed.includes(id) && !kNonNavRoutes.has(id));
    expect(unknown, `TOOLS.md links tabs that are not routed: ${unknown.join(", ")}`).toEqual([]);
  });
});

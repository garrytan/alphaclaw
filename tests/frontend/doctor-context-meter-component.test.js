import { describe, expect, it } from "vitest";
import { ContextBudgetMeter } from "../../lib/public/js/components/doctor/context-budget-meter.js";
import { TooltipBadge } from "../../lib/public/js/components/tooltip-badge.js";
import { Badge } from "../../lib/public/js/components/badge.js";

const collectNodes = (node, out = []) => {
  if (node == null || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const child of node) collectNodes(child, out);
    return out;
  }
  out.push(node);
  if (node.props) collectNodes(node.props.children, out);
  return out;
};

const collectText = (node, out = []) => {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object" && node.props) {
    collectText(node.props.children, out);
  }
  return out;
};

const findAllByType = (tree, type) =>
  collectNodes(tree).filter((vnode) => vnode.type === type);

const kOkRootFile = {
  kind: "root",
  exists: true,
  active: true,
  injectable: true,
  skipped: false,
  truncated: false,
  nearFileLimit: false,
  reason: "",
  activeReason: "",
  path: "AGENTS.md",
  injectedChars: 500,
  rawChars: 500,
};

const kBlockedExtraFile = {
  kind: "extra",
  exists: true,
  active: false,
  activeReason: "hook_disabled",
  injectable: true,
  skipped: false,
  truncated: false,
  nearFileLimit: false,
  reason: "",
  path: "hooks/bootstrap/AGENTS.md",
  injectedChars: 0,
  rawChars: 900,
};

const makeStatus = ({ files, hardening }) => ({
  bootstrapContext: {
    estimated: true,
    bootstrapMaxChars: 20000,
    bootstrapTotalMaxChars: 60000,
    activeInjectedChars: 500,
    hardening,
    files,
  },
});

describe("frontend/doctor context budget meter component", () => {
  it("the deep-link focus highlight swaps the section border to the incident cyan", () => {
    const status = makeStatus({
      files: [kOkRootFile],
      hardening: { state: "injected", reason: "", files: [] },
    });
    const highlightedTree = ContextBudgetMeter({
      doctorStatus: status,
      highlighted: true,
    });
    const rootDiv = collectNodes(highlightedTree).find((node) =>
      String(node.props?.class || "").includes("rounded-xl p-4 space-y-3"),
    );
    expect(rootDiv).toBeTruthy();
    expect(rootDiv.props.class).toContain("border-cyan-500/60");
    expect(rootDiv.props.class).not.toContain("border-border");

    const plainTree = ContextBudgetMeter({ doctorStatus: status });
    const plainRoot = collectNodes(plainTree).find((node) =>
      String(node.props?.class || "").includes("rounded-xl p-4 space-y-3"),
    );
    expect(plainRoot.props.class).toContain("border-border");
  });

  it("problem rows render a TooltipBadge chip carrying cause+fix; healthy rows keep the plain Badge", () => {
    const tree = ContextBudgetMeter({
      doctorStatus: makeStatus({
        files: [kOkRootFile, kBlockedExtraFile],
        hardening: { state: "blocked", reason: "", files: [] },
      }),
    });
    const chips = findAllByType(tree, TooltipBadge);
    expect(chips).toHaveLength(1);
    expect(chips[0].props.label).toBe("Blocked");
    expect(chips[0].props.tone).toBe("danger");
    // Cause on one line, imperative fix on the next (hook_disabled copy).
    expect(chips[0].props.text).toContain("hooks.internal");
    expect(chips[0].props.text).toContain("\n");
    // The healthy root row stays a plain OK Badge, never tooltip'd.
    const plainBadges = findAllByType(tree, Badge);
    expect(
      plainBadges.some((badge) =>
        collectText(badge).join("").includes("OK"),
      ),
    ).toBe(true);
  });

  it("rejected-read hints render as muted paragraphs under the rows", () => {
    const tree = ContextBudgetMeter({
      doctorStatus: makeStatus({
        files: [kOkRootFile],
        hardening: {
          state: "blocked",
          reason: "escapes_workspace",
          files: [
            {
              path: "hooks/bootstrap/AGENTS.md",
              exists: false,
              reason: "escapes_workspace",
            },
          ],
        },
      }),
    });
    const text = collectText(tree).join(" ").replace(/\s+/g, " ");
    expect(text).toContain(
      "hooks/bootstrap/AGENTS.md is rejected before it can be read — run a scan for the full finding.",
    );
  });
});

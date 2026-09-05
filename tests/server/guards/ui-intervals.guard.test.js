// Guard (d): no raw setInterval in the Setup UI. Recurring refreshes go
// through usePolling (pauseWhenHidden, cacheKey hydration) or useNowMs
// (shared 1s ticker) per AGENTS.md "Networking and Fetching". Raw intervals
// keep spawning git/openclaw CLIs and TCP probes from backgrounded tabs
// (audit F143/F159/F160/F170/F202). Counted per file so a moved line does
// not churn the list; PR 11 drives every count to zero.
const { auditTree, formatHits } = require("./guard-utils");
const { scanUiIntervals } = require("./scanners");

// file → number of raw intervals still allowed. PR 11 (polling sweep) drives
// every count to zero; an ADDED interval changes the key and goes red.
const kKnownOffenders = {
  // PR 11 converted every other raw interval onto usePolling / useNowMs /
  // useVisibleInterval. This file is edited by open PR #64 (restart banner
  // work) — it follows once #64 lands, to avoid a rival branch on the same file.
  "lib/public/js/hooks/use-app-shell-controller.js::3": "after PR #64: restart-status 2s poll + stale checks → usePolling (F143)",
};

describe("guard: the UI polls through usePolling/useNowMs, never raw setInterval", () => {
  it("counts raw intervals per file incl. window./globalThis. forms and ignores comments (self-test)", () => {
    const fixture = [
      "const a = setInterval(tick, 1000);",
      "const b = window.setInterval(tick, 1000);",
      "// setInterval(commented, 1)",
      "const c = globalThis.setInterval(tick, 5000);",
    ].join("\n");
    const hits = scanUiIntervals(fixture, "lib/public/js/components/planted.js");
    expect(hits).toHaveLength(1);
    expect(hits[0].key).toBe("lib/public/js/components/planted.js::3");
  });

  it("exempts the two polling primitives (self-test)", () => {
    expect(scanUiIntervals("setInterval(x, 1)", "lib/public/js/hooks/usePolling.js")).toEqual([]);
  });

  it("has no raw setInterval outside the allowlist, and no stale entries", () => {
    const { unexpected, stale } = auditTree({
      roots: ["lib/public/js"],
      scan: scanUiIntervals,
      allowlist: kKnownOffenders,
    });
    expect(
      unexpected,
      `Raw setInterval in UI code — use usePolling (with pauseWhenHidden) or useNowMs:\n${formatHits(unexpected)}`,
    ).toEqual([]);
    expect(stale, `Stale allowlist entries:\n  ${stale.join("\n  ")}`).toEqual([]);
  });
});

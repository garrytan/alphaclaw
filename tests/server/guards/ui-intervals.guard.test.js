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
  "lib/public/js/components/chat/index.js::1": "PR 11: heartbeat tick → useNowMs",
  "lib/public/js/components/chat/use-chat-connection.js::1": "PR 11: ws ping keeps its own timer or moves under the connection hook",
  "lib/public/js/components/chat/use-chat-store.js::1": "PR 11: outbox flush tick",
  "lib/public/js/components/cron-tab/cron-calendar.js::1": "PR 11: now ticker → useNowMs",
  "lib/public/js/components/file-tree.js::1": "PR 11: tree refresh → usePolling (F202)",
  "lib/public/js/components/file-viewer/use-file-loader.js::1": "PR 11: disk refresh → usePolling (F202)",
  "lib/public/js/components/gateway.js::2": "PR 11: 1s tickers → useNowMs (F160)",
  "lib/public/js/components/models-tab/provider-auth-card.js::1": "PR 11: popup poll",
  "lib/public/js/components/nodes-tab/connected-nodes/use-connected-nodes-card.js::1": "PR 11: browser poll → usePolling (F202)",
  "lib/public/js/components/nodes-tab/setup-wizard/use-setup-wizard.js::1": "PR 11: discovery poll → usePolling",
  "lib/public/js/components/onboarding/use-welcome-codex.js::1": "PR 11: popup poll",
  "lib/public/js/components/onboarding/welcome-setup-step.js::3": "PR 11: progress polls → usePolling",
  "lib/public/js/components/providers.js::1": "PR 11: popup poll",
  "lib/public/js/components/sidebar-git-panel.js::1": "PR 11: git summary poll → usePolling (F202)",
  "lib/public/js/components/team-tab/use-team-tab.js::2": "PR 11: presence/devices polls → usePolling (F170)",
  "lib/public/js/components/upgrade-tab/use-upgrade-tab.js::1": "PR 11: now ticker → useNowMs",
  "lib/public/js/hooks/use-app-shell-controller.js::3": "PR 11: restart-status 2s poll + stale checks → usePolling (F143)",
  "lib/public/js/hooks/use-claude-code-local.js::1": "PR 11: status poll → usePolling",
  "lib/public/js/hooks/useAgentSessions.js::1": "PR 11: sessions poll → usePolling",
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

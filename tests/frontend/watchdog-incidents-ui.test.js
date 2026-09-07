import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const loadIncidentHelpers = () =>
  import("../../lib/public/js/components/watchdog-tab/incidents/helpers.js");
const loadTabHelpers = () =>
  import("../../lib/public/js/components/watchdog-tab/helpers.js");

const kNow = Date.parse("2026-08-29T12:00:00Z");

// The REAL drift pin: extract the event-type literals from the watchdog's own
// logEvent()/insertWatchdogEvent-adjacent call sites (lib/server is CJS, this
// bundle is browser ESM — no shared constants module exists). A hardcoded
// mirror list here would only test itself.
const extractServerEventTypes = () => {
  const source = readFileSync(
    fileURLToPath(new URL("../../lib/server/watchdog.js", import.meta.url)),
    "utf8",
  );
  const types = new Set();
  for (const match of source.matchAll(/logEvent\(\s*"([a-z_]+)"/g)) {
    types.add(match[1]);
  }
  // The notification event type is written by the notify path with a variable
  // first arg in some shapes; assert it explicitly if present in source.
  if (source.includes('"notification"')) types.add("notification");
  return [...types];
};

describe("describeEvent", () => {
  it("labels every event type the watchdog actually logs (source-extracted drift pin)", async () => {
    const { kWatchdogEventLabels } = await loadIncidentHelpers();
    const serverTypes = extractServerEventTypes();
    expect(serverTypes.length).toBeGreaterThanOrEqual(10);
    for (const eventType of serverTypes) {
      expect(
        Object.keys(kWatchdogEventLabels),
        `label map is missing "${eventType}" (logged by lib/server/watchdog.js)`,
      ).toContain(eventType);
    }
  });

  // The prelaunch-hook row is written through recordOperationEvent (kind) and
  // the notify path's eventType, not a logEvent("prelaunch_hook", …) literal,
  // so the source-extracted pin above cannot see it — pin the label directly.
  it("labels prelaunch_hook rows (written outside the logEvent literal the drift pin scans)", async () => {
    const { kWatchdogEventLabels, describeEvent } = await loadIncidentHelpers();
    expect(kWatchdogEventLabels.prelaunch_hook).toBe("Prelaunch hook");
    const described = describeEvent({
      eventType: "prelaunch_hook",
      status: "failed",
      details: { reason: "prelaunch_hook_failed", code: "not_root_owned", site: "managed launch" },
    });
    expect(described.label).toBe("Prelaunch hook");
    expect(described.tone).toBe("danger");
  });

  // The boot-verdict row is written once per boot by lib/server/
  // boot-report-steps.js through the wrapped incident sink (CEO 8.1), not by
  // a watchdog.js logEvent literal — pin the label and the verdict phrase by
  // hand, like prelaunch_hook. Details shape: { bootId, verdict, pidfile:
  // { decision, reason }, installed, expected }.
  it("labels boot rows (written outside the logEvent literal the drift pin scans) and names the verdict", async () => {
    const { kWatchdogEventLabels, describeEvent } = await loadIncidentHelpers();
    expect(kWatchdogEventLabels.boot).toBe("Boot verdict");
    const consistent = describeEvent({
      eventType: "boot",
      status: "ok",
      details: {
        bootId: "40:1700000000000",
        verdict: [],
        pidfile: { decision: "proceed", reason: "absent" },
        installed: "2026.9.2",
        expected: "2026.9.2",
      },
    });
    expect(consistent).toMatchObject({ label: "Boot verdict", detail: "consistent", tone: "success" });
    const inconsistent = describeEvent({
      eventType: "boot",
      status: "failed",
      details: {
        bootId: "40:1700000000000",
        verdict: ["installed_not_expected", "pidfile_contradiction"],
        pidfile: { decision: "skip", reason: "legacy_argv_match" },
        installed: "2026.7.1-2",
        expected: "2026.8.1",
      },
    });
    expect(inconsistent).toMatchObject({
      label: "Boot verdict",
      detail: "inconsistent: installed not expected, pidfile contradiction",
      tone: "danger",
    });
    // A boot row with no details still renders (older or hand-edited rows).
    expect(describeEvent({ eventType: "boot", status: "ok" }).label).toBe("Boot verdict");
  });

  // Issue #76 A3/A4: the classifier's follow-up row and the latched mismatch
  // are logEvent literals in watchdog.js (the drift pin above sees them);
  // their outcome phrases are hand-pinned here because the status column
  // alone misleads (a corroborated cause is the danger, a suspected one is
  // only a warning).
  it("labels crash_cause rows and says whether the cause was corroborated", async () => {
    const { kWatchdogEventLabels, describeEvent } = await loadIncidentHelpers();
    expect(kWatchdogEventLabels.crash_cause).toBe("Crash cause");
    const corroborated = describeEvent({
      eventType: "crash_cause",
      source: "crash_classifier",
      status: "failed",
      details: {
        cause: "state_schema_too_new",
        fingerprint: "0123456789ab",
        corroborated: true,
        by: "user_version",
        code: 1,
      },
    });
    expect(corroborated).toMatchObject({
      label: "Crash cause",
      tone: "danger",
    });
    expect(corroborated.detail).toContain("confirmed: state schema too new (by user version)");
    const suspected = describeEvent({
      eventType: "crash_cause",
      source: "crash_classifier",
      status: "info",
      details: { cause: "plugin_api_too_old", corroborated: false, by: null, suspectedCause: "plugin_api_too_old" },
    });
    expect(suspected).toMatchObject({ label: "Crash cause", tone: "warning" });
    expect(suspected.detail).toContain("suspected: plugin api too old — not corroborated");
    // No details still renders.
    expect(describeEvent({ eventType: "crash_cause", status: "info" }).detail).toContain("suspected: unknown");
  });

  it("labels version_mismatch rows with the running/expected pair", async () => {
    const { kWatchdogEventLabels, describeEvent } = await loadIncidentHelpers();
    expect(kWatchdogEventLabels.version_mismatch).toBe("Version mismatch");
    const described = describeEvent({
      eventType: "version_mismatch",
      source: "boot",
      status: "failed",
      details: { expected: "2026.9.2", running: "2026.7.1-2", source: "boot" },
    });
    expect(described).toMatchObject({
      label: "Version mismatch",
      detail: "running 2026.7.1-2, expected 2026.9.2",
      tone: "danger",
    });
    expect(describeEvent({ eventType: "version_mismatch", status: "failed" }).detail).toBe(
      "running unknown, expected unknown",
    );
  });

  it("labels overseer audit rows and surfaces their verdict or refusal as the detail", async () => {
    const { kWatchdogEventLabels, describeEvent } = await loadIncidentHelpers();
    expect(kWatchdogEventLabels.overseer_review).toBe("Overseer review");
    const ok = describeEvent({
      eventType: "overseer_review",
      status: "ok",
      details: { mode: "situation", manual: true, verdict: "all_clear", durationMs: 1200 },
    });
    expect(ok.label).toBe("Overseer review");
    expect(ok.detail).toBe("situation report: all clear");
    const refused = describeEvent({
      eventType: "overseer_review",
      status: "failed",
      details: { mode: "incident", manual: true, unavailableReason: "cli_flags_unverifiable" },
    });
    expect(refused.detail).toBe("incident review refused: cli flags unverifiable");
  });

  it("humanizes unknown/foreign event types instead of failing", async () => {
    const { describeEvent } = await loadIncidentHelpers();
    const described = describeEvent({
      eventType: "topic_discovery_sweep",
      status: "ok",
    });
    expect(described.label).toBe("Topic discovery sweep");
    expect(described.tone).toBe("success");
  });

  it("extracts one salient detail and neutralizes skipped probes", async () => {
    const { describeEvent } = await loadIncidentHelpers();
    expect(
      describeEvent({
        eventType: "health_check",
        status: "failed",
        details: { reason: "gateway health returned HTTP 503" },
      }),
    ).toMatchObject({
      label: "Health check",
      detail: "gateway health returned HTTP 503",
      tone: "danger",
    });
    expect(
      describeEvent({
        eventType: "health_check",
        status: "ok",
        details: { skipped: true, startupGraceActive: true },
      }),
    ).toMatchObject({ detail: "skipped (startup grace)", tone: "neutral" });
    expect(
      describeEvent({
        eventType: "restart",
        status: "backoff",
        details: { backoffMs: 8000 },
      }),
    ).toMatchObject({ detail: "backoff 8s", tone: "warning" });
    expect(
      describeEvent({ eventType: "crash", status: "failed", details: { code: 1 } }),
    ).toMatchObject({ detail: "exit code 1" });
  });
});

describe("buildIncidentCardModel", () => {
  it("renders a resolved rollup as a deterministic title + outcome", async () => {
    const { buildIncidentCardModel } = await loadIncidentHelpers();
    const model = buildIncidentCardModel(
      {
        id: 12,
        incidentKey: "crash_loop",
        status: "resolved",
        openedAt: new Date(kNow - 3_600_000).toISOString(),
        resolvedAt: new Date(kNow - 3_120_000).toISOString(),
        eventCount: 9,
        summary: {
          v: 1,
          trigger: "crash_loop",
          severity: "critical",
          outcome: "recovered",
          durationMs: 8 * 60_000,
          actions: ["restart", "channel_rollback"],
        },
      },
      kNow,
    );
    expect(model.title).toBe("Crash loop → rolled back");
    expect(model.badgeTone).toBe("danger");
    expect(model.badgeLabel).toBe("critical");
    expect(model.outcome).toBe("recovered in 8m 0s");
    expect(model.openedAgo).toBe("1h ago");
    expect(model.eventsPruned).toBe(false);
  });

  it("marks open incidents as ongoing and pruned incidents honestly", async () => {
    const { buildIncidentCardModel } = await loadIncidentHelpers();
    const open = buildIncidentCardModel(
      {
        id: 13,
        incidentKey: "gateway_degraded",
        status: "open",
        openedAt: new Date(kNow - 90_000).toISOString(),
        eventCount: 3,
        summary: null,
      },
      kNow,
    );
    expect(open.open).toBe(true);
    expect(open.badgeLabel).toBe("Ongoing");
    expect(open.outcome).toBe("ongoing");

    const pruned = buildIncidentCardModel(
      {
        id: 2,
        incidentKey: "gateway_crash",
        status: "abandoned",
        openedAt: new Date(kNow - 40 * 86_400_000).toISOString(),
        eventCount: 0,
        summary: {
          trigger: "gateway_crash",
          severity: "warning",
          outcome: "abandoned",
          durationMs: 120_000,
        },
      },
      kNow,
    );
    expect(pruned.eventsPruned).toBe(true);
    expect(pruned.outcome).toBe("interrupted by restart in 2m 0s");
  });

  it("renders corrupt rollups as readable cards, never throws", async () => {
    const { buildIncidentCardModel } = await loadIncidentHelpers();
    const model = buildIncidentCardModel(
      {
        id: 3,
        incidentKey: "gateway_crash",
        status: "resolved",
        openedAt: new Date(kNow - 60_000).toISOString(),
        eventCount: 4,
        summary: { unreadable: true },
      },
      kNow,
    );
    expect(model.outcome).toBe("record unreadable");
    expect(buildIncidentCardModel(null, kNow)).toBe(null);
  });
});

describe("buildIncidentTimeTooltip", () => {
  it("dual-registers the local+offset half with the raw UTC ISO half", async () => {
    const { buildIncidentTimeTooltip } = await loadIncidentHelpers();
    const { formatLocaleDateTimeWithZone } = await import(
      "../../lib/public/js/lib/format.js"
    );
    const iso = "2026-08-28T10:00:02.114Z";
    const tooltip = buildIncidentTimeTooltip(iso);
    expect(tooltip.endsWith(` · ${iso}`)).toBe(true);
    const formatted = tooltip.slice(0, tooltip.length - ` · ${iso}`.length);
    expect(formatted).toBe(formatLocaleDateTimeWithZone(iso, { fallback: "" }));
    expect(formatted.length).toBeGreaterThan(0);
    // The local half carries a numeric UTC offset (DST-fold disambiguation).
    expect(formatted).toMatch(/GMT|UTC/);
  });

  it("derives the ISO half from Date and epoch-ms values via toISOString", async () => {
    const { buildIncidentTimeTooltip } = await loadIncidentHelpers();
    const iso = "2026-08-28T10:00:02.114Z";
    expect(buildIncidentTimeTooltip(new Date(iso)).endsWith(` · ${iso}`)).toBe(
      true,
    );
    expect(
      buildIncidentTimeTooltip(Date.parse(iso)).endsWith(` · ${iso}`),
    ).toBe(true);
  });

  it("returns empty string for missing or invalid values", async () => {
    const { buildIncidentTimeTooltip } = await loadIncidentHelpers();
    expect(buildIncidentTimeTooltip(null)).toBe("");
    expect(buildIncidentTimeTooltip(undefined)).toBe("");
    expect(buildIncidentTimeTooltip("")).toBe("");
    expect(buildIncidentTimeTooltip("not a timestamp")).toBe("");
    expect(buildIncidentTimeTooltip(new Date(NaN))).toBe("");
  });
});

describe("mergeIncidentPages", () => {
  it("dedups by id across the polling first page and cached older pages", async () => {
    const { mergeIncidentPages } = await loadIncidentHelpers();
    const merged = mergeIncidentPages([
      [{ id: 9 }, { id: 8 }],
      [{ id: 8 }, { id: 7 }],
      [{ id: 7 }, { id: 6 }, null, { id: "bad" }],
    ]);
    expect(merged.map((incident) => incident.id)).toEqual([9, 8, 7, 6]);
  });
});

describe("hash routing with deep-link queries", () => {
  it("getHashRouterPath strips the query so /#/watchdog?incident=5 still matches the route", async () => {
    const originalWindow = globalThis.window;
    globalThis.window = { location: { hash: "#/watchdog?incident=5" } };
    try {
      const { getHashRouterPath } = await import(
        "../../lib/public/js/hooks/use-hash-location.js"
      );
      expect(getHashRouterPath()).toBe("/watchdog");
      globalThis.window.location.hash = "#/watchdog";
      expect(getHashRouterPath()).toBe("/watchdog");
      globalThis.window.location.hash = "";
      expect(getHashRouterPath()).toBe("/general");
    } finally {
      globalThis.window = originalWindow;
    }
  });
});

describe("parseIncidentAnchor", () => {
  it("parses the deep-link id and rejects garbage without throwing", async () => {
    const { parseIncidentAnchor } = await loadIncidentHelpers();
    expect(parseIncidentAnchor("#/watchdog?incident=12")).toBe(12);
    expect(parseIncidentAnchor("#/watchdog?other=1&incident=5")).toBe(5);
    expect(parseIncidentAnchor("#/watchdog")).toBe(null);
    expect(parseIncidentAnchor("#/watchdog?incident=abc")).toBe(null);
    expect(parseIncidentAnchor("#/watchdog?incident=-3")).toBe(null);
    expect(parseIncidentAnchor("#/watchdog?incident=1.5")).toBe(null);
    expect(parseIncidentAnchor("#/watchdog?incident=12extra")).toBe(null);
    expect(parseIncidentAnchor("")).toBe(null);
    expect(parseIncidentAnchor(null)).toBe(null);
  });
});

describe("formatWatchdogCopyAllText extras (E6)", () => {
  it("includes the status snapshot and recent incident rollups alongside logs", async () => {
    const { formatWatchdogCopyAllText } = await loadTabHelpers();
    const text = formatWatchdogCopyAllText({
      logs: "line one",
      generatedAt: new Date(kNow),
      status: { phase: "healthy", health: "healthy" },
      incidents: [
        {
          id: 12,
          incidentKey: "crash_loop",
          status: "resolved",
          openedAt: "2026-08-29T10:00:00.000Z",
          summary: { trigger: "crash_loop", severity: "critical", durationMs: 480000 },
        },
      ],
    });
    expect(text).toContain("## Watchdog Status");
    expect(text).toContain('"phase": "healthy"');
    expect(text).toContain("## Recent Incidents");
    expect(text).toContain("#12 crash_loop · critical · resolved · 480s");
    expect(text).toContain("## Gateway Logs");
    expect(text).toContain("line one");
  });

  it("stays backward-compatible without extras", async () => {
    const { formatWatchdogCopyAllText } = await loadTabHelpers();
    const text = formatWatchdogCopyAllText({ logs: "" });
    expect(text).toContain("# AlphaClaw Watchdog Export");
    expect(text).not.toContain("## Watchdog Status");
    expect(text).toContain("No logs yet.");
  });
});

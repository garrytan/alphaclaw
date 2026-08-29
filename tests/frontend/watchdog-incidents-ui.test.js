import { describe, expect, it } from "vitest";

const loadIncidentHelpers = () =>
  import("../../lib/public/js/components/watchdog-tab/incidents/helpers.js");
const loadTabHelpers = () =>
  import("../../lib/public/js/components/watchdog-tab/helpers.js");

const kNow = Date.parse("2026-08-29T12:00:00Z");

// The documented watchdog event-type list (lib/server/watchdog.js logEvent
// call sites). lib/server (CJS) and lib/public (browser ESM) share no
// constants module, so this mirrored list + the assertion below is the
// drift pin.
const kDocumentedEventTypes = [
  "health_check",
  "crash",
  "crash_loop",
  "restart",
  "repair",
  "recovery",
  "config_error",
  "safe_mode",
  "safe_mode_resume",
  "channel_rollback",
  "notification",
];

describe("describeEvent", () => {
  it("labels every documented watchdog event type (drift pin)", async () => {
    const { kWatchdogEventLabels } = await loadIncidentHelpers();
    expect(Object.keys(kWatchdogEventLabels).sort()).toEqual(
      [...kDocumentedEventTypes].sort(),
    );
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

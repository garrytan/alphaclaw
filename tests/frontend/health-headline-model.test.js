import { describe, expect, it } from "vitest";
import {
  buildHealthHeadline,
  describeWatchdogState,
  summarizeIncidentsToday,
} from "../../lib/public/js/components/watchdog-tab/headline-model.js";
import { kWatchdogPhaseCopy } from "../../lib/public/js/components/watchdog-tab/helpers.js";

const kNow = new Date(2026, 10, 7, 15, 0, 0).getTime();
const at = (hours) => new Date(2026, 10, 7, hours, 0, 0).toISOString();
const narrative = (phase, extra = {}) => ({ phase, headline: "Narrative headline", tone: "neutral", ...extra });
const healthy = (incidentsToday) =>
  buildHealthHeadline({
    watchdogStatus: { phase: "healthy" },
    narrative: narrative("healthy"),
    chipKey: "running",
    incidentsToday,
  }).text;

describe("frontend/health headline model", () => {
  it("says no incidents when today's list is empty", () => {
    expect(healthy({ count: 0, recovered: 0 })).toBe("Healthy. No incidents today.");
  });

  it("counts recoveries in words, then numbers", () => {
    expect(healthy({ count: 1, recovered: 1 })).toBe("Healthy. The gateway recovered on its own once today.");
    expect(healthy({ count: 2, recovered: 2 })).toBe("Healthy. The gateway recovered on its own twice today.");
    expect(healthy({ count: 5, recovered: 5 })).toBe("Healthy. The gateway recovered on its own 5 times today.");
  });

  it("does not claim a count before the incident list loads", () => {
    expect(healthy(null)).toBe("Healthy.");
  });

  it("names the degraded reason's first sentence", () => {
    const result = buildHealthHeadline({
      watchdogStatus: { phase: "degraded_retrying" },
      narrative: narrative("degraded_retrying"),
      chipKey: "degraded",
    });
    const detail = String(kWatchdogPhaseCopy.degraded_retrying.detail);
    expect(result.tone).toBe("warn");
    expect(result.text.startsWith("Degraded. ")).toBe(true);
    expect(detail.startsWith(result.text.slice("Degraded. ".length))).toBe(true);
  });

  it("treats safe mode as degraded", () => {
    const result = buildHealthHeadline({
      watchdogStatus: { phase: "healthy", safeMode: true },
      narrative: narrative("healthy"),
      chipKey: "running",
      incidentsToday: { count: 0, recovered: 0 },
    });
    expect(result.tone).toBe("warn");
    expect(result.text.startsWith("Degraded. ")).toBe(true);
  });

  it("says the watchdog is repairing while it repairs", () => {
    for (const phase of ["degraded_repairing", "crash_backoff", "crash_loop_repair_ladder"]) {
      expect(
        buildHealthHeadline({ watchdogStatus: { phase }, narrative: narrative(phase), chipKey: "down" }).text,
      ).toBe("The gateway is down. The watchdog is repairing it.");
    }
  });

  it("points at Repair and Restart when the watchdog is out of attempts or off", () => {
    expect(
      buildHealthHeadline({
        watchdogStatus: { phase: "awaiting_repair_recovery" },
        narrative: narrative("awaiting_repair_recovery"),
        chipKey: "down",
      }).text,
    ).toBe("The gateway is down. Use Repair or Restart gateway.");
    expect(
      buildHealthHeadline({
        watchdogStatus: { phase: "unknown", autoRepair: false },
        narrative: narrative("unknown"),
        chipKey: "down",
      }).text,
    ).toBe("The gateway is down. Use Repair or Restart gateway.");
  });

  it("says restarting while a restart runs, whatever the phase", () => {
    expect(
      buildHealthHeadline({
        watchdogStatus: { phase: "healthy" },
        narrative: narrative("healthy"),
        chipKey: "running",
        restarting: true,
      }).text,
    ).toBe("Restarting the gateway.");
  });

  it("falls back to the narrative's own headline as a sentence", () => {
    expect(
      buildHealthHeadline({ watchdogStatus: {}, narrative: narrative("starting"), chipKey: "connecting" }).text,
    ).toBe("Narrative headline.");
  });

  it("counts today's incidents by local calendar day", () => {
    const yesterday = new Date(2026, 10, 6, 23, 30, 0).toISOString();
    const summary = summarizeIncidentsToday(
      [
        { openedAt: at(1), status: "closed", summary: { outcome: "recovered" } },
        { openedAt: at(9), status: "open", summary: { outcome: "recovered" } },
        { openedAt: yesterday, status: "closed", summary: { outcome: "recovered" } },
      ],
      kNow,
    );
    expect(summary).toEqual({ count: 2, recovered: 1 });
  });

  it("reads the watchdog's state word", () => {
    expect(describeWatchdogState({ lifecycle: "running" }).word).toBe("On");
    expect(describeWatchdogState({ autoRepair: false }).word).toBe("Off");
    expect(describeWatchdogState({ operationInProgress: true }).word).toBe("Repairing");
    expect(describeWatchdogState(null)).toBe(null);
  });
});

describe("frontend/health headline model (manual repair)", () => {
  it("says the gateway is being repaired while a Repair runs", () => {
    expect(
      buildHealthHeadline({
        watchdogStatus: { phase: "healthy" },
        narrative: { phase: "healthy", headline: "x", tone: "neutral" },
        chipKey: "running",
        repairing: true,
        incidentsToday: { count: 0, recovered: 0 },
      }),
    ).toEqual({ tone: "accent", text: "Repairing the gateway." });
  });
});

describe("frontend/health headline model (snapshot that is not live)", () => {
  const healthyInput = {
    watchdogStatus: { phase: "healthy" },
    narrative: { phase: "healthy", headline: "x", tone: "neutral" },
    chipKey: "running",
    incidentsToday: { count: 0, recovered: 0 },
  };
  const downInput = {
    watchdogStatus: { phase: "awaiting_repair_recovery" },
    narrative: { phase: "awaiting_repair_recovery", headline: "x", tone: "danger" },
    chipKey: "down",
  };

  it("does not report Healthy while AlphaClaw is offline", () => {
    expect(buildHealthHeadline({ ...healthyInput, chipKey: "offline", connectivityMode: "offline" })).toEqual({
      tone: "neutral",
      text: "AlphaClaw is not answering. Showing the last known status.",
    });
    expect(buildHealthHeadline({ ...healthyInput, connectivityMode: "alphaclaw_restarting" }).text).toBe(
      "AlphaClaw is restarting. Showing the last known status.",
    );
  });

  it("does not report Healthy from a stale snapshot", () => {
    expect(buildHealthHeadline({ ...healthyInput, chipKey: "connecting", stale: true })).toEqual({
      tone: "neutral",
      text: "Gateway status is out of date. Showing the last known status.",
    });
  });

  it("does not report Down from a stale snapshot", () => {
    expect(buildHealthHeadline({ ...downInput, stale: true }).text).toBe(
      "Gateway status is out of date. Showing the last known status.",
    );
  });

  it("does not report a live state while reconnecting", () => {
    expect(buildHealthHeadline({ ...healthyInput, connectivityMode: "reconnecting" }).text).toBe(
      "Reconnecting to AlphaClaw. Showing the last known status.",
    );
  });

  it("puts this tab's own restart before the connection", () => {
    expect(buildHealthHeadline({ ...healthyInput, connectivityMode: "offline", restarting: true }).text).toBe(
      "Restarting the gateway.",
    );
  });
});

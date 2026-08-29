import { describe, expect, it } from "vitest";

const loadFormat = () => import("../../lib/public/js/lib/format.js");
const loadHelpers = () =>
  import("../../lib/public/js/components/watchdog-tab/helpers.js");

describe("format.js shared time helpers", () => {
  it("formatDurationLongMs covers s/m/h/d tiers", async () => {
    const { formatDurationLongMs } = await loadFormat();
    expect(formatDurationLongMs(0)).toBe("0s");
    expect(formatDurationLongMs(-5)).toBe("0s");
    expect(formatDurationLongMs(45_000)).toBe("45s");
    expect(formatDurationLongMs(252_000)).toBe("4m 12s");
    expect(formatDurationLongMs(3_723_000)).toBe("1h 2m 3s");
    expect(formatDurationLongMs(90_061_000)).toBe("1d 1h 1m 1s");
  });

  it("formatRelativeTime is pure given nowMs and clamps edge cases", async () => {
    const { formatRelativeTime } = await loadFormat();
    const nowMs = Date.parse("2026-08-29T12:00:00Z");
    const at = (deltaMs) => new Date(nowMs - deltaMs).toISOString();
    expect(formatRelativeTime(at(0), { nowMs })).toBe("just now");
    expect(formatRelativeTime(at(3_000), { nowMs })).toBe("just now");
    expect(formatRelativeTime(at(38_000), { nowMs })).toBe("38s ago");
    expect(formatRelativeTime(at(4 * 60_000), { nowMs })).toBe("4m ago");
    expect(formatRelativeTime(at(3 * 3_600_000), { nowMs })).toBe("3h ago");
    expect(formatRelativeTime(at(2 * 86_400_000), { nowMs })).toBe("2d ago");
    // Future timestamps (clock skew) must not render negative ages.
    expect(formatRelativeTime(at(-10_000), { nowMs })).toBe("just now");
    expect(formatRelativeTime("not-a-date", { nowMs })).toBe("—");
    expect(formatRelativeTime(null, { nowMs, fallback: "?" })).toBe("?");
  });
});

describe("watchdog-tab status helpers", () => {
  it("resourceLevel maps hardcoded 80/90 thresholds", async () => {
    const { resourceLevel } = await loadHelpers();
    expect(resourceLevel(null)).toBe("unknown");
    expect(resourceLevel("nope")).toBe("unknown");
    expect(resourceLevel(0)).toBe("ok");
    expect(resourceLevel(79.9)).toBe("ok");
    expect(resourceLevel(80)).toBe("warn");
    expect(resourceLevel(89.9)).toBe("warn");
    expect(resourceLevel(90)).toBe("crit");
    expect(resourceLevel(150)).toBe("crit");
  });

  it("crashWindowLabel renders the crash budget with its window", async () => {
    const { crashWindowLabel } = await loadHelpers();
    expect(crashWindowLabel({})).toBe(null);
    expect(crashWindowLabel(null)).toBe(null);
    expect(
      crashWindowLabel({
        crashCountInWindow: 2,
        crashLoopThreshold: 3,
        crashLoopWindowMs: 300_000,
      }),
    ).toBe("2 of 3 (5-min window)");
    expect(
      crashWindowLabel({ crashCountInWindow: 0, crashLoopThreshold: 3 }),
    ).toBe("0 of 3");
  });

  it("buildWatchdogStatusDetails renders only meaningful rows", async () => {
    const { buildWatchdogStatusDetails } = await loadHelpers();
    const nowMs = Date.parse("2026-08-29T12:00:00Z");
    expect(buildWatchdogStatusDetails(null, nowMs)).toEqual([]);
    expect(buildWatchdogStatusDetails({}, nowMs)).toEqual([]);

    const details = buildWatchdogStatusDetails(
      {
        degradedSince: new Date(nowMs - 252_000).toISOString(),
        lastHealthCheckAt: new Date(nowMs - 38_000).toISOString(),
        crashCountInWindow: 2,
        crashLoopThreshold: 3,
        crashLoopWindowMs: 300_000,
        repairAttempts: 1,
        operationInProgress: true,
        gatewayPid: 4123,
      },
      nowMs,
    );
    expect(details.map((d) => d.key)).toEqual([
      "degraded",
      "lastProbe",
      "crashes",
      "repairs",
      "operation",
      "pid",
    ]);
    expect(details[0].label).toBe("Degraded for 4m 12s");
    expect(details[0].tone).toBe("warning");
    expect(details[1].label).toBe("Last probe 38s ago");
    expect(details[2].label).toBe("Crashes: 2 of 3 (5-min window)");
    expect(details[3].label).toBe("Repair attempts: 1");
    expect(details[5].label).toBe("PID 4123");
  });

  it("buildWatchdogStatusDetails hides zero crash counts and healthy noise", async () => {
    const { buildWatchdogStatusDetails } = await loadHelpers();
    const nowMs = Date.parse("2026-08-29T12:00:00Z");
    const details = buildWatchdogStatusDetails(
      {
        lastHealthCheckAt: new Date(nowMs - 5_000).toISOString(),
        crashCountInWindow: 0,
        crashLoopThreshold: 3,
        repairAttempts: 0,
        operationInProgress: false,
        gatewayPid: null,
      },
      nowMs,
    );
    expect(details.map((d) => d.key)).toEqual(["lastProbe"]);
  });
});

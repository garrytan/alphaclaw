import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const loadHelpers = () =>
  import("../../lib/public/js/components/watchdog-tab/helpers.js");

const kNow = Date.parse("2026-08-29T12:00:00Z");

const baseStatus = {
  phase: "healthy",
  health: "healthy",
  lifecycle: "running",
  autoRepair: true,
  crashCountInWindow: 0,
  crashLoopThreshold: 3,
  repairAttempts: 0,
  repairAttemptLimit: 2,
  doctorFixSuppressed: false,
  stabilization: { active: false, until: null },
  backoff: { active: false, untilMs: null, attempt: 0 },
  serverNow: kNow,
};

describe("phase copy map stays in sync with the server enum", () => {
  it("kWatchdogPhaseCopy keys equal lib/server/watchdog-phase.js kWatchdogPhases", async () => {
    const { kWatchdogPhaseCopy } = await loadHelpers();
    const { kWatchdogPhases } = require("../../lib/server/watchdog-phase.js");
    expect(Object.keys(kWatchdogPhaseCopy).sort()).toEqual(
      [...kWatchdogPhases].sort(),
    );
  });

  it("every phase renders a non-generic headline (the narrator never says Unknown)", async () => {
    const { buildWatchdogNarrative, kWatchdogPhaseCopy } = await loadHelpers();
    for (const phase of Object.keys(kWatchdogPhaseCopy)) {
      const narrative = buildWatchdogNarrative({ ...baseStatus, phase }, kNow);
      expect(narrative).not.toBe(null);
      expect(narrative.phase).toBe(phase);
      expect(narrative.headline).toBeTruthy();
      expect(narrative.headline).not.toMatch(/unknown/i);
      expect(narrative.tone).toMatch(/^(success|info|warning|danger|neutral)$/);
    }
  });
});

describe("buildWatchdogNarrative", () => {
  it("returns null without a status or phase (loading shell renders instead)", async () => {
    const { buildWatchdogNarrative } = await loadHelpers();
    expect(buildWatchdogNarrative(null, kNow)).toBe(null);
    expect(buildWatchdogNarrative({}, kNow)).toBe(null);
  });

  it("narrates a degraded pre-rollback state with reason, duration, and deadline", async () => {
    const { buildWatchdogNarrative } = await loadHelpers();
    const narrative = buildWatchdogNarrative(
      {
        ...baseStatus,
        phase: "degraded_pre_rollback",
        health: "degraded",
        degradedSince: new Date(kNow - 6 * 60_000).toISOString(),
        degradedReason: "gateway health returned HTTP 503",
        rollbackDeadlineAt: new Date(kNow + 4 * 60_000).toISOString(),
        doctorFixSuppressed: true,
        stabilization: {
          active: true,
          until: new Date(kNow + 14 * 3_600_000).toISOString(),
        },
      },
      kNow,
    );
    expect(narrative.tone).toBe("warning");
    expect(narrative.detail).toContain("Degraded for 6m 0s.");
    expect(narrative.detail).toContain("gateway health returned HTTP 503");
    expect(narrative.countdowns).toEqual([
      {
        key: "rollback",
        label: "Auto-rollback if still degraded",
        endsAt: new Date(kNow + 4 * 60_000).toISOString(),
      },
    ]);
    expect(narrative.chips[0].label).toContain("Unattended repair paused");
    expect(narrative.chips[0].label).toContain("14h 0m 0s");
  });

  it("narrates crash backoff with exit detail, attempt, and relaunch countdown", async () => {
    const { buildWatchdogNarrative } = await loadHelpers();
    const narrative = buildWatchdogNarrative(
      {
        ...baseStatus,
        phase: "crash_backoff",
        health: "unhealthy",
        lifecycle: "crashed",
        lastExit: { code: 1, signal: null, at: new Date(kNow).toISOString() },
        backoff: { active: true, untilMs: kNow + 8_000, attempt: 3 },
        crashCountInWindow: 2,
      },
      kNow,
    );
    expect(narrative.tone).toBe("danger");
    expect(narrative.detail).toContain("Last exit: exit code 1.");
    expect(narrative.detail).toContain("Relaunch attempt 3.");
    expect(narrative.countdowns[0].key).toBe("backoff");
    expect(narrative.budgets).toEqual([{ key: "crashes", label: "2/3 crashes" }]);
  });

  it("shows repair attempt budget while repairing", async () => {
    const { buildWatchdogNarrative } = await loadHelpers();
    const narrative = buildWatchdogNarrative(
      {
        ...baseStatus,
        phase: "degraded_repairing",
        health: "degraded",
        repairAttempts: 1,
        degradedSince: new Date(kNow - 60_000).toISOString(),
      },
      kNow,
    );
    expect(narrative.detail).toContain("Attempt 2 of 2.");
    expect(narrative.budgets).toContainEqual({
      key: "repairs",
      label: "1/2 repairs",
    });
  });

  it("suppression chip only renders when auto-repair is configured on", async () => {
    const { buildWatchdogNarrative } = await loadHelpers();
    const suppressed = {
      ...baseStatus,
      doctorFixSuppressed: true,
      stabilization: { active: true, until: null },
    };
    expect(buildWatchdogNarrative(suppressed, kNow).chips).toHaveLength(1);
    expect(
      buildWatchdogNarrative({ ...suppressed, autoRepair: false }, kNow).chips,
    ).toHaveLength(0);
  });

  it("lists suppressed channels in safe mode", async () => {
    const { buildWatchdogNarrative } = await loadHelpers();
    const narrative = buildWatchdogNarrative(
      {
        ...baseStatus,
        phase: "safe_mode",
        safeMode: true,
        suppressedChannels: ["telegram", "discord"],
      },
      kNow,
    );
    expect(narrative.detail).toContain("Suppressed: telegram, discord.");
  });
});

describe("formatCountdownRemaining", () => {
  it("clamps past deadlines to imminent and rejects garbage", async () => {
    const { formatCountdownRemaining } = await loadHelpers();
    expect(
      formatCountdownRemaining(new Date(kNow + 252_000).toISOString(), kNow),
    ).toBe("4m 12s");
    expect(
      formatCountdownRemaining(new Date(kNow - 1_000).toISOString(), kNow),
    ).toBe("imminent");
    expect(formatCountdownRemaining("garbage", kNow)).toBe(null);
    expect(formatCountdownRemaining(null, kNow)).toBe(null);
  });
});

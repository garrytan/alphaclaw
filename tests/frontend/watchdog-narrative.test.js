import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";

// Card-level cases call WatchdogNarrativeCard as a plain function (no DOM
// renderer). It only touches useMemo from preact/hooks, and useNowMs is
// swapped for a clock that honours `enabled` the way the real hook does:
// disabled → frozen at the mount value, enabled → the advancing clock.
const clock = vi.hoisted(() => ({ mountMs: 0, nowMs: 0 }));
vi.mock("preact/hooks", () => ({ useMemo: (factory) => factory() }));
vi.mock("../../lib/public/js/hooks/use-now-ms.js", () => ({
  useNowMs: vi.fn((_intervalMs, { enabled = true } = {}) =>
    enabled ? clock.nowMs : clock.mountMs,
  ),
}));

const require = createRequire(import.meta.url);
const loadHelpers = () =>
  import("../../lib/public/js/components/watchdog-tab/helpers.js");
const loadCard = () =>
  import("../../lib/public/js/components/watchdog-tab/narrative-card.js");
const loadUseNowMs = () => import("../../lib/public/js/hooks/use-now-ms.js");

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
const treeText = (tree) => collectText(tree).join("");

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

  describe("degraded_retrying countdown from status.degradedRetry", () => {
    const kDueAt = new Date(kNow + 20_000).toISOString();
    const degradedRetrying = {
      ...baseStatus,
      phase: "degraded_retrying",
      health: "degraded",
      // 20s, not 15s: the "no 5s" assertion below scans the whole detail
      // string, and "Degraded for 15s." would substring-match it.
      degradedSince: new Date(kNow - 20_000).toISOString(),
      degradedReason: "gateway health returned HTTP 503",
    };
    const armedRetry = {
      attempt: 2,
      nextDelayMs: 20_000,
      dueAt: kDueAt,
      inFlight: false,
    };

    it("pushes a Next retry countdown ending at degradedRetry.dueAt", async () => {
      const { buildWatchdogNarrative } = await loadHelpers();
      const narrative = buildWatchdogNarrative(
        { ...degradedRetrying, degradedRetry: armedRetry },
        kNow,
      );
      expect(narrative.countdowns).toContainEqual({
        key: "degraded_retry",
        label: "Next retry",
        endsAt: kDueAt,
      });
      const retry = narrative.countdowns.find(
        (countdown) => countdown.key === "degraded_retry",
      );
      // No value override while armed — the live countdown is the value.
      expect(retry.value).toBeUndefined();
      expect(narrative.chips.map((chip) => chip.key)).not.toContain(
        "degraded_retry_probe",
      );
    });

    it("overrides the countdown value with probing… while in flight (dueAt is already past), keeping the row shape", async () => {
      const { buildWatchdogNarrative } = await loadHelpers();
      // While inFlight the timer has already fired, so dueAt is in the past —
      // a countdown here would read "imminent" for the whole probe. The row
      // stays mounted (same key/label) so the card doesn't shift; only the
      // value changes. No chip: the chips row is warning-styled and shared
      // with the persistent suppression chip, so a transient activity
      // indicator there reads as high-stakes.
      const dueAt = new Date(kNow - 3_000).toISOString();
      const narrative = buildWatchdogNarrative(
        {
          ...degradedRetrying,
          degradedRetry: {
            attempt: 2,
            nextDelayMs: 20_000,
            dueAt,
            inFlight: true,
          },
        },
        kNow,
      );
      expect(narrative.countdowns).toContainEqual({
        key: "degraded_retry",
        label: "Next retry",
        endsAt: dueAt,
        value: "probing…",
      });
      expect(narrative.chips.map((chip) => chip.key)).not.toContain(
        "degraded_retry_probe",
      );
      expect(narrative.chips.map((chip) => chip.label)).not.toContain(
        "Retry probe running",
      );
    });

    it("still shows probing… when dueAt is null mid-flight (cleared between tick and probe completion)", async () => {
      const { buildWatchdogNarrative } = await loadHelpers();
      const narrative = buildWatchdogNarrative(
        {
          ...degradedRetrying,
          degradedRetry: {
            attempt: 2,
            nextDelayMs: 20_000,
            dueAt: null,
            inFlight: true,
          },
        },
        kNow,
      );
      expect(narrative.countdowns).toContainEqual({
        key: "degraded_retry",
        label: "Next retry",
        endsAt: null,
        value: "probing…",
      });
      expect(narrative.chips).toHaveLength(0);
    });

    it("also counts down in degraded_pre_rollback, ahead of the rollback deadline", async () => {
      const { buildWatchdogNarrative } = await loadHelpers();
      const rollbackDeadlineAt = new Date(kNow + 300_000).toISOString();
      const narrative = buildWatchdogNarrative(
        {
          ...degradedRetrying,
          phase: "degraded_pre_rollback",
          rollbackDeadlineAt,
          degradedRetry: armedRetry,
        },
        kNow,
      );
      expect(narrative.countdowns.map((countdown) => countdown.key)).toEqual([
        "degraded_retry",
        "rollback",
      ]);
    });

    it("ignores degradedRetry outside the degraded phases (no countdown, no chip)", async () => {
      const { buildWatchdogNarrative } = await loadHelpers();
      for (const phase of ["healthy", "crash_backoff"]) {
        for (const degradedRetry of [
          armedRetry,
          { ...armedRetry, inFlight: true },
        ]) {
          const narrative = buildWatchdogNarrative(
            { ...baseStatus, phase, degradedRetry },
            kNow,
          );
          expect(narrative.countdowns.map((countdown) => countdown.key)).not.toContain(
            "degraded_retry",
          );
          expect(narrative.chips.map((chip) => chip.key)).not.toContain(
            "degraded_retry_probe",
          );
        }
      }
    });

    it("pushes no degraded_retry countdown when degradedRetry is null or dueAt is garbage", async () => {
      const { buildWatchdogNarrative } = await loadHelpers();
      const keysFor = (degradedRetry) =>
        buildWatchdogNarrative({ ...degradedRetrying, degradedRetry }, kNow)
          .countdowns.map((countdown) => countdown.key);
      expect(keysFor(null)).not.toContain("degraded_retry");
      expect(keysFor(undefined)).not.toContain("degraded_retry");
      expect(
        keysFor({ attempt: 0, nextDelayMs: 5_000, dueAt: "garbage", inFlight: false }),
      ).not.toContain("degraded_retry");
    });

    it("degraded copy is numberless — retries back off, so no fixed cadence is promised", async () => {
      const { buildWatchdogNarrative, kWatchdogPhaseCopy } = await loadHelpers();
      expect(kWatchdogPhaseCopy.degraded_retrying.detail).not.toContain("5s");
      const narrative = buildWatchdogNarrative(
        { ...degradedRetrying, degradedRetry: armedRetry },
        kNow,
      );
      expect(narrative.detail).toContain("Retrying with exponential backoff");
      expect(narrative.detail).not.toContain("5s");
    });
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

describe("WatchdogNarrativeCard tick gate", () => {
  beforeEach(async () => {
    // The card offsets the tick by (serverNow − Date.now()); pin the wall
    // clock to serverNow so the offset is zero and the countdown is exact.
    vi.useFakeTimers();
    vi.setSystemTime(kNow);
    clock.mountMs = kNow;
    clock.nowMs = kNow;
    const { useNowMs } = await loadUseNowMs();
    useNowMs.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps ticking when degradedRetry is the only time-dependent field (readiness-degraded phase leaves degradedSince null)", async () => {
    const { WatchdogNarrativeCard } = await loadCard();
    const { useNowMs } = await loadUseNowMs();
    const watchdogStatus = {
      ...baseStatus,
      phase: "degraded_retrying",
      health: "degraded",
      degradedSince: null,
      degradedRetry: {
        attempt: 1,
        nextDelayMs: 20_000,
        dueAt: new Date(kNow + 20_000).toISOString(),
        inFlight: false,
      },
    };
    const mounted = treeText(WatchdogNarrativeCard({ watchdogStatus }));
    expect(mounted).toContain("Next retry: 20s");
    expect(useNowMs).toHaveBeenLastCalledWith(1000, { enabled: true });

    clock.nowMs = kNow + 1_000;
    const ticked = treeText(WatchdogNarrativeCard({ watchdogStatus }));
    expect(ticked).toContain("Next retry: 19s");
  });

  it("renders Next retry: probing… (not imminent) while the retry probe is in flight", async () => {
    const { WatchdogNarrativeCard } = await loadCard();
    const inFlight = {
      ...baseStatus,
      phase: "degraded_retrying",
      health: "degraded",
      degradedSince: new Date(kNow - 20_000).toISOString(),
      degradedRetry: {
        attempt: 1,
        nextDelayMs: 20_000,
        dueAt: new Date(kNow - 3_000).toISOString(),
        inFlight: true,
      },
    };
    const text = treeText(WatchdogNarrativeCard({ watchdogStatus: inFlight }));
    expect(text).toContain("Next retry: probing…");
    expect(text).not.toContain("imminent");
    expect(text).not.toContain("Retry probe running");

    // dueAt cleared mid-flight: the row must still render the override
    // rather than throwing on a null endsAt.
    const cleared = {
      ...inFlight,
      degradedRetry: { ...inFlight.degradedRetry, dueAt: null },
    };
    expect(
      treeText(WatchdogNarrativeCard({ watchdogStatus: cleared })),
    ).toContain("Next retry: probing…");
  });

  it("stays idle on a healthy card with nothing time-dependent", async () => {
    const { WatchdogNarrativeCard } = await loadCard();
    const { useNowMs } = await loadUseNowMs();
    WatchdogNarrativeCard({ watchdogStatus: { ...baseStatus, degradedRetry: null } });
    expect(useNowMs).toHaveBeenLastCalledWith(1000, { enabled: false });
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

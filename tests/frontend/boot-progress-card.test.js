import { describe, expect, it } from "vitest";
import { buildBootCardModel, kSuccessLineMs } from "../../lib/public/js/components/boot-progress-card/use-boot-progress.js";

const t0 = 1_800_000_000_000;
const frame = (overrides = {}) => ({
  bootId: "abc",
  kind: "upgrading_openclaw",
  headline: "Upgrading OpenClaw",
  stageLabel: "Upgrading OpenClaw data",
  stage: "upgrading",
  startedAt: t0,
  lastActivityAt: t0,
  estimateMs: null,
  stalled: false,
  outcome: null,
  endedAt: null,
  stages: [
    { id: "preparing", label: "Preparing", status: "done", startedAt: t0, endedAt: t0 + 4_000 },
    { id: "upgrading", label: "Upgrading OpenClaw data", status: "running", startedAt: t0 + 4_000, endedAt: null },
    { id: "gateway", label: "Starting the gateway", status: "pending", startedAt: null, endedAt: null },
    { id: "channels", label: "Connecting channels", status: "pending", startedAt: null, endedAt: null },
  ],
  ...overrides,
});

describe("boot progress card model", () => {
  it("shows elapsed only without three comparable samples", () => {
    const model = buildBootCardModel({ bootProgress: frame(), nowMs: t0 + 42_000 });
    expect(model).toMatchObject({ kind: "running", headline: "Upgrading OpenClaw", stageLabel: "Upgrading OpenClaw data" });
    expect(model.timing).toMatch(/^42s so far$/);
    expect(model.stages.map((stage) => [stage.id, stage.current, stage.statusText])).toEqual([
      ["preparing", false, "done"],
      ["upgrading", true, "in progress"],
      ["gateway", false, "not started"],
      ["channels", false, "not started"],
    ]);
  });

  it("uses the estimate, then admits when the boot runs long", () => {
    expect(buildBootCardModel({ bootProgress: frame({ estimateMs: 85_000 }), nowMs: t0 + 42_000 }).timing).toMatch(/^Usually about 1m 25s — 42s so far$/);
    expect(buildBootCardModel({ bootProgress: frame({ estimateMs: 85_000 }), nowMs: t0 + 123_000 }).timing).toMatch(/^Taking longer than usual \(about 1m 25s\) — 2m 3s so far$/);
  });

  it("never claims a fixed duration", () => {
    const text = JSON.stringify(buildBootCardModel({ bootProgress: frame(), nowMs: t0 + 1_000 }));
    expect(text).not.toMatch(/usually under|under a minute|couple of minutes/i);
  });

  it("anchors to the server clock and freezes while the feed is stale", () => {
    expect(buildBootCardModel({ bootProgress: frame(), nowMs: t0, offsetMs: 10_000 }).timing).toMatch(/^10s so far$/);
    const frozen = buildBootCardModel({ bootProgress: frame(), nowMs: t0 + 999_000, frozenAtMs: t0 + 20_000 });
    expect(frozen).toMatchObject({ frozen: true });
    expect(frozen.timing).toMatch(/^20s so far$/);
  });

  it("names a quiet boot without inventing progress", () => {
    const model = buildBootCardModel({ bootProgress: frame({ stalled: true }), nowMs: t0 + 150_000 });
    expect(model.quiet).toMatch(/^No output for 2m 30s — still running$/);
  });

  it("shows Ready in X briefly after verified readiness, then collapses", () => {
    const done = frame({ outcome: "ready", endedAt: t0 + 85_000 });
    expect(buildBootCardModel({ bootProgress: done, nowMs: t0 + 86_000 })).toMatchObject({ kind: "success", text: "Ready in 1m 25s" });
    expect(buildBootCardModel({ bootProgress: done, nowMs: t0 + 85_000 + kSuccessLineMs })).toBeNull();
  });

  it("says unverified honestly", () => {
    const model = buildBootCardModel({ bootProgress: frame({ outcome: "unverified", endedAt: t0 + 10_000 }), nowMs: t0 + 11_000 });
    expect(model.kind).toBe("unverified");
  });

  it("names the failed stage unless the Gateway card already owns the failure", () => {
    const failed = frame({
      outcome: "failed",
      reason: "readiness_failed",
      endedAt: t0 + 90_000,
      stages: frame().stages.map((stage) => (stage.id === "upgrading" ? { ...stage, status: "done", endedAt: t0 + 60_000 } : stage.id === "gateway" ? { ...stage, status: "failed", startedAt: t0 + 60_000, endedAt: t0 + 90_000 } : stage)),
    });
    expect(buildBootCardModel({ bootProgress: failed, serverState: { state: "degraded" }, nowMs: t0 + 95_000 }))
      .toMatchObject({ kind: "failed", text: "Last boot stopped at Starting the gateway: The gateway started, but its readiness checks failed." });
    for (const state of ["running", "config_error", "down", "boot_failed"]) {
      expect(buildBootCardModel({ bootProgress: failed, serverState: { state }, nowMs: t0 + 95_000 })).toBeNull();
    }
  });

  it("renders nothing for superseded or empty frames", () => {
    expect(buildBootCardModel({ bootProgress: frame({ outcome: "superseded", endedAt: t0 }), nowMs: t0 })).toBeNull();
    expect(buildBootCardModel({ bootProgress: null })).toBeNull();
  });
});

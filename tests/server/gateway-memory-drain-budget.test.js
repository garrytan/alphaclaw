const { resolveMemoryDrainBudget, kImminentEtaMs } = require("../../lib/server/gateway-memory/drain-budget");
const constants = require("../../lib/server/constants");
const { gatewayStopAskBudgetMs } = require("../../lib/server/gateway");

const kMb = 1024 * 1024;
const kNow = 1_700_000_000_000;
// A worker growing at 2021 MB/h (the Oct 22 slope) against an 8384 MB cap,
// placed so the cap crossing is etaMs away; the container far from full.
const at = (etaMs, extra = {}) => {
  const slopeBytesPerMs = 2021 * kMb / 3_600_000;
  const capBytes = 8384 * kMb;
  return { nowMs: kNow, rssBytes: capBytes - slopeBytesPerMs * etaMs, capBytes, slopeBytesPerMs,
    cgroupUsedBytes: 4000 * kMb, containerLimitBytes: 16384 * kMb, ...extra };
};

describe("memory-mitigation drain budget (ALPH-17, D2)", () => {
  it("33 minutes to exhaustion asks for OpenClaw's full 300 s drain", () => {
    expect(resolveMemoryDrainBudget(at(33 * 60_000))).toMatchObject({ askGraceMs: 300_000, reason: "derived" });
  });

  it("4 minutes to exhaustion asks for about 90 s (half the ETA minus SIGTERM and SIGKILL)", () => {
    const budget = resolveMemoryDrainBudget(at(4 * 60_000));
    expect(budget.reason).toBe("derived");
    expect(Math.abs(budget.askGraceMs - 90_000)).toBeLessThanOrEqual(1_000);
    // The worst case (grace + ack + reserve + term + kill) still ends before the projection.
    expect(gatewayStopAskBudgetMs(budget.askGraceMs) + constants.kGatewayStopTermGraceMs +
      constants.kGatewayStopKillGraceMs).toBeLessThan(budget.etaMs);
  });

  it("90 s to exhaustion is imminent: the 30 s short ladder", () => {
    expect(resolveMemoryDrainBudget(at(90_000))).toMatchObject({ askGraceMs: 30_000, reason: "imminent" });
    expect(kImminentEtaMs).toBe(120_000);
  });

  it("a container at 97% or more is imminent however far the policy cap is", () => {
    expect(resolveMemoryDrainBudget(at(60 * 60_000, { cgroupUsedBytes: 15_900 * kMb })))
      .toMatchObject({ askGraceMs: 30_000, reason: "imminent" });
  });

  it("the physical headroom wins when it is sooner than the policy cap", () => {
    // Policy cap 33 min away, but only 300 MB of container left at the same slope (~9 min).
    const budget = resolveMemoryDrainBudget(at(33 * 60_000, { cgroupUsedBytes: 9_000 * kMb, containerLimitBytes: 9_300 * kMb }));
    expect(budget.reason).toBe("derived");
    expect(budget.askGraceMs).toBeLessThan(300_000);
    expect(budget.etaMs).toBeLessThan(10 * 60_000);
  });

  it("never outlasts the exhaustion time fixed at the decision, even if a fresh sample looks better", () => {
    const budget = resolveMemoryDrainBudget(at(60 * 60_000, { exhaustionDeadlineAtMs: kNow + 100_000 }));
    expect(budget).toMatchObject({ askGraceMs: 30_000, reason: "imminent", etaMs: 100_000 });
  });

  it("without a projection: the default 30 s, imminent when policy pressure is already ≥ 97%", () => {
    expect(resolveMemoryDrainBudget({ nowMs: kNow, rssBytes: 500 * kMb, capBytes: 1000 * kMb, slopeBytesPerMs: 0 }))
      .toMatchObject({ askGraceMs: 30_000, reason: "no_projection", etaMs: null });
    expect(resolveMemoryDrainBudget({ nowMs: kNow, rssBytes: 980 * kMb, capBytes: 1000 * kMb, slopeBytesPerMs: null }))
      .toMatchObject({ askGraceMs: 30_000, reason: "imminent" });
  });

  it("the restart operation budget (lease, record, expected-restart window) covers the longest drain", () => {
    expect(constants.kOpenclawDefaultRestartDrainMs).toBe(300_000);
    expect(constants.kGatewayRestartOperationBudgetMs).toBeGreaterThanOrEqual(
      constants.kGatewayRestartReadyTimeoutMs + 240_000 +
      gatewayStopAskBudgetMs(constants.kOpenclawDefaultRestartDrainMs) +
      constants.kGatewayStopTermGraceMs + constants.kGatewayStopKillGraceMs,
    );
  });
});

describe("heap-aware drain budget (ALPH-22)", () => {
  it("the heap's own crossing can be the soonest exhaustion", () => {
    const slope = 40 * 1024 * 1024 / 60_000;
    const budget = resolveMemoryDrainBudget({ nowMs: 0, rssBytes: 7000 * kMb, capBytes: 76_800 * kMb,
      slopeBytesPerMs: slope, heapUsedBytes: 8700 * kMb, heapLimitBytes: 9011 * kMb });
    expect(budget.reason).toBe("derived");
    expect(budget.etaMs).toBeCloseTo((311 * kMb) / slope, -3);
    expect(budget.askGraceMs).toBeLessThan(300_000);
  });

  it("a heap at 97% of its limit takes the short ladder", () => {
    expect(resolveMemoryDrainBudget({ nowMs: 0, rssBytes: kMb, capBytes: 1000 * kMb,
      heapUsedBytes: 975 * kMb, heapLimitBytes: 1000 * kMb }).reason).toBe("imminent");
  });
});


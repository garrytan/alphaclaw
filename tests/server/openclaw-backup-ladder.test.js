const ladder = require("../../lib/server/openclaw-backup-ladder");
const {
  kOpenclawBackupTimeoutMs,
  kOpenclawBackupUpstreamInactivityMs,
} = require("../../lib/server/constants");

// Pure policy pins for the pieces v0.9.81 added (cross-model D15). The full
// table pins live in openclaw-channel-backup-retry.e2e.test.js.
describe("server/openclaw-backup-ladder — stall policy (v0.9.81)", () => {
  it("a stalled in-quiesce upstream attempt hands over like a timeout", () => {
    expect(ladder.kQuiescedOutcomePolicy.stalled).toBe("offline_copy");
    expect(ladder.kQuiescedOutcomePolicy.stalled).toBe(ladder.kQuiescedOutcomePolicy.timeout);
  });

  it("stalled is reuse-eligible and never retried live", () => {
    expect(ladder.kReuseEligibleKinds).toContain("stalled");
    expect(ladder.kLiveRetryPolicy).not.toHaveProperty("stalled");
    expect(ladder.kLiveRetryPolicy).not.toHaveProperty("timeout");
  });

  it("the budget carries the inactivity window under the driver's field name, strictly below the CLI ceiling", () => {
    expect(ladder.kDefaultBackupBudget.upstreamInactivityMs).toBe(kOpenclawBackupUpstreamInactivityMs);
    expect(ladder.kDefaultBackupBudget.upstreamInactivityMs).toBeLessThan(ladder.kDefaultBackupBudget.cliTimeoutMs);
    expect(kOpenclawBackupUpstreamInactivityMs).toBe(3 * 60_000);
    expect(kOpenclawBackupTimeoutMs).toBe(10 * 60_000);
    // Not an envelope term: the pins do not mention it and still hold.
    for (const pin of ladder.backupBudgetPins()) expect(pin.ok).toBe(true);
    expect(JSON.stringify(ladder.kBackupEnvelopePinTerms)).not.toContain("upstreamInactivityMs");
  });
});

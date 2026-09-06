// Config-gate intent + ONE hold model (issue #76 RC3 / Codex 6): the pure
// helpers the boot reconciler decides drift-vs-intent with. Table-driven
// (Eng 2B): one case per row, precedence, and the reasons a stamp is refused
// (not landed, consumed, expired, wrong direction).
const {
  describeVersionRegressionIntent,
  kVersionRegressionIntentRows,
  kTransitionIntentMaxAgeMs,
  kRecentUpdateRunIntentMaxAgeMs,
  computeInstalledDiverged,
  expectedVersionOf,
  advancePinLag,
  kPinLagMaxBoots,
  kPinLagMaxAgeMs,
  isMigrationClassHold,
  kStructuralHoldReasons,
} = require("../../lib/server/openclaw-channel-sync");

const kNow = 1_700_000_000_000;
const kHour = 60 * 60 * 1000;
const kDay = 24 * kHour;
const kInstalled = "2026.7.1-2";
const kNewer = "2026.9.2";

const landedStamp = (extra = {}) => ({
  at: kNow - kHour,
  from: kNewer,
  to: kInstalled,
  kind: "downgrade",
  source: "operator_apply",
  reason: null,
  operationId: "op-1",
  ok: true,
  consumedAt: null,
  ...extra,
});

const describe_ = (overrides = {}) =>
  describeVersionRegressionIntent({
    state: {},
    installedVersion: kInstalled,
    pendingRun: null,
    bootStartedAt: kNow - 10_000,
    now: kNow,
    ...overrides,
  });

describe("server/openclaw-channel-sync config-gate intent (#76 RC3)", () => {
  it("is an ordered table of { source, test } rows — the one list of evidence that counts", () => {
    expect(kVersionRegressionIntentRows.map((row) => row.source)).toEqual([
      "lastTransition",
      "pendingRun",
      "bootRollback",
      "recentUpdateRun",
    ]);
    for (const row of kVersionRegressionIntentRows) {
      expect(typeof row.test).toBe("function");
    }
    expect(kTransitionIntentMaxAgeMs).toBe(7 * kDay);
    expect(kRecentUpdateRunIntentMaxAgeMs).toBe(kDay);
    // No `applied.reason === "pin_rollback"` row: by construction that reason
    // exists only while applied.version ≠ pinVersion — exactly on drift.
    expect(JSON.stringify(kVersionRegressionIntentRows.map(String))).not.toContain(
      "pin_rollback",
    );
  });

  it("nothing recorded → not intentional, every row evaluated and reported", () => {
    expect(describe_()).toEqual({
      intentional: false,
      source: null,
      evaluated: [
        { source: "lastTransition", matched: false },
        { source: "pendingRun", matched: false },
        { source: "bootRollback", matched: false },
        { source: "recentUpdateRun", matched: false },
      ],
    });
    // Hostile shapes never throw.
    expect(describeVersionRegressionIntent().intentional).toBe(false);
    expect(
      describe_({ state: { lastTransition: "x", lastBoot: 7, lastUpdateRun: [] }, pendingRun: "run" })
        .intentional,
    ).toBe(false);
  });

  describe("row: lastTransition (the stamp)", () => {
    it("a landed, unconsumed downgrade stamp onto the installed version within 7 days is intent", () => {
      const result = describe_({ state: { lastTransition: landedStamp() } });
      expect(result).toMatchObject({ intentional: true, source: "lastTransition" });
      // Every source is honoured: apply, rollback consumption, pin bump.
      for (const source of ["operator_apply", "rollback", "pin_bump"]) {
        expect(
          describe_({ state: { lastTransition: landedStamp({ source }) } }).source,
        ).toBe("lastTransition");
      }
      // Exactly at the 7-day bound still counts; one ms past it does not.
      expect(
        describe_({ state: { lastTransition: landedStamp({ at: kNow - kTransitionIntentMaxAgeMs }) } })
          .intentional,
      ).toBe(true);
    });

    it("refuses a stamp that did not land, was consumed, expired, or is not a downgrade onto THIS version", () => {
      const refused = [
        ["in flight (ok null)", landedStamp({ ok: null })],
        ["failed apply (ok false)", landedStamp({ ok: false })],
        ["already consumed", landedStamp({ consumedAt: kNow - 1 })],
        ["older than 7 days", landedStamp({ at: kNow - kTransitionIntentMaxAgeMs - 1 })],
        ["no timestamp", landedStamp({ at: null })],
        ["an upgrade", landedStamp({ kind: "upgrade" })],
        ["same version", landedStamp({ kind: "same" })],
        ["a dev switch", landedStamp({ kind: "dev", to: "abc1234" })],
        ["unknown kind", landedStamp({ kind: null })],
        ["a different target", landedStamp({ to: "2026.8.2" })],
      ];
      for (const [label, lastTransition] of refused) {
        const result = describe_({ state: { lastTransition } });
        expect(result.intentional, label).toBe(false);
        expect(result.evaluated[0], label).toEqual({ source: "lastTransition", matched: false });
      }
    });
  });

  describe("row: pendingRun", () => {
    it("the restart_expected run whose activation restart this boot is targets the installed version", () => {
      expect(
        describe_({ pendingRun: { target: { channel: "stable", version: kInstalled } } }),
      ).toMatchObject({ intentional: true, source: "pendingRun" });
      expect(
        describe_({ pendingRun: { target: { channel: "stable", version: kNewer } } }).intentional,
      ).toBe(false);
      expect(describe_({ pendingRun: { target: {} } }).intentional).toBe(false);
      expect(
        describe_({ installedVersion: null, pendingRun: { target: { version: null } } }).intentional,
      ).toBe(false);
    });
  });

  describe("row: bootRollback (this boot rolled back onto it)", () => {
    const rollbackBoot = (extra = {}) => ({
      at: kNow - 5000,
      action: "rollback",
      rollbackTargetVersion: kInstalled,
      ...extra,
    });

    it("counts only a lastBoot written since the process started", () => {
      expect(describe_({ state: { lastBoot: rollbackBoot() } })).toMatchObject({
        intentional: true,
        source: "bootRollback",
      });
      // Written at exactly the boot start still counts.
      expect(
        describe_({ state: { lastBoot: rollbackBoot({ at: kNow - 10_000 }) } }).intentional,
      ).toBe(true);
      // A stale record from an earlier boot does not.
      expect(
        describe_({ state: { lastBoot: rollbackBoot({ at: kNow - 10_001 }) } }).intentional,
      ).toBe(false);
      // No boot start known → the row cannot vouch for anything.
      expect(describe_({ state: { lastBoot: rollbackBoot() }, bootStartedAt: null }).intentional).toBe(
        false,
      );
      expect(
        describe_({ state: { lastBoot: rollbackBoot({ action: "activated" }) } }).intentional,
      ).toBe(false);
      expect(
        describe_({ state: { lastBoot: rollbackBoot({ rollbackTargetVersion: kNewer }) } })
          .intentional,
      ).toBe(false);
    });
  });

  describe("row: recentUpdateRun", () => {
    const run = (extra = {}) => ({
      operationId: "r1",
      target: { channel: "stable", version: kInstalled },
      startedAt: kNow - 2 * kHour,
      finishedAt: kNow - kHour,
      ok: true,
      ...extra,
    });

    it("an update run that targeted the installed version and finished within 24 h is intent; a failed or old one is not", () => {
      expect(describe_({ state: { lastUpdateRun: run() } })).toMatchObject({
        intentional: true,
        source: "recentUpdateRun",
      });
      expect(
        describe_({ state: { lastUpdateRun: run({ finishedAt: kNow - kRecentUpdateRunIntentMaxAgeMs }) } })
          .intentional,
      ).toBe(true);
      expect(
        describe_({
          state: { lastUpdateRun: run({ finishedAt: kNow - kRecentUpdateRunIntentMaxAgeMs - 1 }) },
        }).intentional,
      ).toBe(false);
      expect(describe_({ state: { lastUpdateRun: run({ ok: false }) } }).intentional).toBe(false);
      expect(describe_({ state: { lastUpdateRun: run({ finishedAt: null }) } }).intentional).toBe(
        false,
      );
      expect(
        describe_({ state: { lastUpdateRun: run({ target: { version: kNewer } }) } }).intentional,
      ).toBe(false);
    });
  });

  it("first matching row in table order names the source; later rows are still evaluated", () => {
    const result = describe_({
      state: {
        lastTransition: landedStamp(),
        lastUpdateRun: {
          target: { version: kInstalled },
          finishedAt: kNow - kHour,
          ok: true,
        },
      },
      pendingRun: { target: { version: kInstalled } },
    });
    expect(result.source).toBe("lastTransition");
    expect(result.evaluated.map((row) => row.matched)).toEqual([true, true, false, true]);
    // With the stamp consumed, the next row takes over.
    expect(
      describe_({
        state: { lastTransition: landedStamp({ consumedAt: kNow }) },
        pendingRun: { target: { version: kInstalled } },
      }).source,
    ).toBe("pendingRun");
  });
});

describe("server/openclaw-channel-sync installed-vs-recorded divergence (#76 RC4)", () => {
  it("expectedVersionOf: applied package version, else the pin, null for a dev apply", () => {
    expect(expectedVersionOf({ applied: { channel: "beta", version: "2.0.0" }, pinVersion: "1.0.0" })).toBe(
      "2.0.0",
    );
    expect(expectedVersionOf({ applied: null, pinVersion: "1.0.0" })).toBe("1.0.0");
    expect(expectedVersionOf({ applied: { channel: "dev", sha: "abc" }, pinVersion: "1.0.0" })).toBe(
      null,
    );
    expect(expectedVersionOf(null)).toBe(null);
    expect(expectedVersionOf({})).toBe(null);
  });

  it("computeInstalledDiverged truth table: applied / pin / dev / pinLag / expired pinLag / unknown", () => {
    const lag = (extra = {}) => ({
      pin: "1.0.1",
      installed: "1.0.0",
      at: kNow - kHour,
      bootId: "1:1",
      bootsSeen: 1,
      ...extra,
    });
    const cases = [
      ["applied matches installed", { applied: { channel: "beta", version: "2.0.0" }, pinVersion: "1.0.0" }, "2.0.0", false],
      ["applied differs from installed (the #76 shape)", { applied: { channel: "beta", version: "2.0.0" }, pinVersion: "1.0.0" }, "1.0.0", true],
      ["pin matches installed", { applied: null, pinVersion: "1.0.0" }, "1.0.0", false],
      ["pin differs from installed", { applied: null, pinVersion: "1.0.1" }, "1.0.0", true],
      ["dev apply never diverges (installed is the dormant fallback)", { applied: { channel: "dev", sha: "abc" }, pinVersion: "1.0.0" }, "1.0.0", false],
      ["pin lag recorded for this installed version is expected, not drift", { applied: null, pinVersion: "1.0.1", pinLag: lag() }, "1.0.0", false],
      ["pin lag at its last allowed boot still excuses", { applied: null, pinVersion: "1.0.1", pinLag: lag({ bootsSeen: kPinLagMaxBoots }) }, "1.0.0", false],
      ["pin lag exactly 24 h old still excuses", { applied: null, pinVersion: "1.0.1", pinLag: lag({ at: kNow - kPinLagMaxAgeMs }) }, "1.0.0", false],
      ["pin lag EXPIRED by boots (more than kPinLagMaxBoots) is drift again", { applied: null, pinVersion: "1.0.1", pinLag: lag({ bootsSeen: kPinLagMaxBoots + 1 }) }, "1.0.0", true],
      ["pin lag EXPIRED by age (older than 24 h) is drift again", { applied: null, pinVersion: "1.0.1", pinLag: lag({ at: kNow - kPinLagMaxAgeMs - 1 }) }, "1.0.0", true],
      ["legacy pin lag without bootsSeen counts as one boot", { applied: null, pinVersion: "1.0.1", pinLag: { pin: "1.0.1", installed: "1.0.0", at: kNow - kHour } }, "1.0.0", false],
      ["pin lag recorded for a DIFFERENT installed version does not excuse it", { applied: null, pinVersion: "1.0.1", pinLag: lag({ installed: "0.9.0" }) }, "1.0.0", true],
      ["pin lag never excuses an APPLIED build's divergence (expected is not the lagging pin)", { applied: { channel: "beta", version: "2.0.0" }, pinVersion: "1.0.1", pinLag: lag() }, "1.0.0", true],
      ["pin lag recorded against a pin that moved on does not excuse it", { applied: null, pinVersion: "1.0.2", pinLag: lag() }, "1.0.0", true],
      ["junk pin lag is ignored", { applied: null, pinVersion: "1.0.1", pinLag: "yes" }, "1.0.0", true],
      ["no expected version", { applied: null, pinVersion: null }, "1.0.0", false],
      ["no installed version", { applied: null, pinVersion: "1.0.0" }, null, false],
      ["empty installed version", { applied: null, pinVersion: "1.0.0" }, "", false],
      ["null state", null, "1.0.0", false],
    ];
    for (const [label, state, installed, expected] of cases) {
      expect(computeInstalledDiverged(state, installed, { now: kNow }), label).toBe(expected);
    }
    // Default clock is the wall clock: a lag stamped "now" is live.
    expect(
      computeInstalledDiverged(
        { applied: null, pinVersion: "1.0.1", pinLag: lag({ at: Date.now() }) },
        "1.0.0",
      ),
    ).toBe(false);
  });

  it("advancePinLag: clears on reconcile or a moved pin, counts non-recording boots, drops an expired record", () => {
    const lag = { pin: "1.0.1", installed: "1.0.0", at: kNow, bootId: "1:1", bootsSeen: 1 };
    const tick = { pinVersion: "1.0.1", installedVersion: "1.0.0", now: kNow + kHour };
    // The recording boot does not count itself.
    expect(advancePinLag(lag, { ...tick, recordedThisBoot: true })).toEqual(lag);
    // Each later boot on the lagging tree counts once.
    expect(advancePinLag(lag, tick)).toEqual({ ...lag, bootsSeen: 2 });
    expect(advancePinLag({ ...lag, bootsSeen: kPinLagMaxBoots - 1 }, tick)).toEqual({
      ...lag,
      bootsSeen: kPinLagMaxBoots,
    });
    // The boot after the last allowed one drops the record.
    expect(advancePinLag({ ...lag, bootsSeen: kPinLagMaxBoots }, tick)).toBeNull();
    // Age expiry, even on the recording boot's own pass.
    expect(
      advancePinLag(lag, { ...tick, now: kNow + kPinLagMaxAgeMs + 1, recordedThisBoot: true }),
    ).toBeNull();
    // Reconciled: the tree reached the pin.
    expect(advancePinLag(lag, { ...tick, installedVersion: "1.0.1" })).toBeNull();
    // The pin moved on (a record about a stale pin).
    expect(advancePinLag(lag, { ...tick, pinVersion: "1.0.2" })).toBeNull();
    // A legacy record without bootsSeen counts from one.
    expect(advancePinLag({ pin: "1.0.1", installed: "1.0.0", at: kNow }, tick)).toEqual(
      expect.objectContaining({ bootsSeen: 2 }),
    );
    expect(advancePinLag(null, tick)).toBeNull();
    expect(advancePinLag("junk", tick)).toBeNull();
  });
});

describe("server/openclaw-channel-sync ONE hold model (#76 Codex 6)", () => {
  it("migration-class holds are every free-text reason; structural class tokens are not", () => {
    expect([...kStructuralHoldReasons].sort()).toEqual([
      "activation_failed",
      "state_db_unreadable",
      "version_mismatch",
    ]);
    for (const reason of [
      "settings migration for 2026.9.2 failed: doctor did not repair the config",
      "config snapshot failed: ENOSPC",
      "reconcile error: boom",
      "agent database agents/main/agent/openclaw-agent.sqlite is at agent schema 21 and OpenClaw 2026.9.1-beta.1 supports up to 17 — the gateway is held so this build never opens a database it cannot read",
    ]) {
      expect(isMigrationClassHold({ reason, at: 1, operationId: null, blamedKeys: [] }), reason).toBe(true);
    }
    for (const reason of kStructuralHoldReasons) {
      expect(isMigrationClassHold({ reason, at: 1 }), reason).toBe(false);
    }
    // No hold / malformed hold is not a migration hold either (nothing to act on).
    expect(isMigrationClassHold(null)).toBe(false);
    expect(isMigrationClassHold({})).toBe(false);
    expect(isMigrationClassHold({ reason: "" })).toBe(false);
    expect(isMigrationClassHold("held")).toBe(false);
  });
});

const loadUpgradeHelpers = async () =>
  import("../../lib/public/js/components/upgrade-tab/helpers.js");

const kNow = Date.parse("2026-08-25T12:00:00.000Z");

// Locale-dependent expectations are computed with the same Intl presets the
// shared formatters use (see tests/frontend/format.test.js) — locale- and
// tz-agnostic in the node test env.
const kDateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

describe("frontend/upgrade-helpers badges", () => {
  it("maps row annotations to badge models", async () => {
    const { buildRowBadges } = await loadUpgradeHelpers();

    const badges = buildRowBadges({
      version: "2026.7.2",
      current: true,
      isDistTagLatest: true,
      lastKnownGood: true,
      blocklisted: null,
    });

    expect(badges.map((badge) => badge.id)).toEqual([
      "current",
      "latest",
      "last-known-good",
    ]);
    expect(badges[0]).toEqual(
      expect.objectContaining({ label: "current", tone: "success" }),
    );
  });

  it("includes an inline blocklist badge with reason, exit code, and time", async () => {
    const { buildRowBadges } = await loadUpgradeHelpers();

    const badges = buildRowBadges({
      version: "2026.7.3",
      blocklisted: { reason: "crash_loop", exitCode: 1, at: kNow },
    });

    const blockBadge = badges.find((badge) => badge.id === "blocklisted");
    expect(blockBadge.tone).toBe("danger");
    expect(blockBadge.detail).toContain("trigger: crash loop");
    expect(blockBadge.detail).toContain("exit code 1");
    expect(blockBadge.detail).toContain(kDateTimeFormat.format(new Date(kNow)));
  });

  it("returns no badges for an unannotated row", async () => {
    const { buildRowBadges } = await loadUpgradeHelpers();
    expect(buildRowBadges({ version: "2026.7.0" })).toEqual([]);
  });

  it("formats blocklist details defensively", async () => {
    const { buildBlocklistDetail } = await loadUpgradeHelpers();
    expect(buildBlocklistDetail({})).toBe("trigger: unknown");
    expect(buildBlocklistDetail({ reason: "verify_failed", exitCode: 0 })).toBe(
      "trigger: verify_failed · exit code 0",
    );
  });
});

describe("frontend/upgrade-helpers row actions", () => {
  const kRows = [
    { version: "2026.7.3", current: false },
    { version: "2026.7.2", current: true },
    { version: "2026.7.1", current: false },
  ];

  it("labels newer rows Upgrade and older rows Downgrade by list position", async () => {
    const { getRowActionModel } = await loadUpgradeHelpers();

    expect(getRowActionModel({ row: kRows[0], rows: kRows })).toEqual({
      label: "Upgrade",
      disabled: false,
      isDowngrade: false,
    });
    expect(getRowActionModel({ row: kRows[2], rows: kRows })).toEqual({
      label: "Downgrade",
      disabled: false,
      isDowngrade: true,
    });
  });

  it("disables the current row", async () => {
    const { getRowActionModel } = await loadUpgradeHelpers();
    expect(getRowActionModel({ row: kRows[1], rows: kRows })).toEqual({
      label: "Current",
      disabled: true,
      isDowngrade: false,
    });
  });

  it("falls back to a version compare when the current row is absent", async () => {
    const { getRowActionModel } = await loadUpgradeHelpers();
    const rows = [{ version: "2026.6.0" }];

    const model = getRowActionModel({
      row: rows[0],
      rows,
      installedVersion: "2026.7.1",
    });

    expect(model.label).toBe("Downgrade");
    expect(model.isDowngrade).toBe(true);
  });

  it("compares dotted versions with prerelease suffixes", async () => {
    const { compareVersions } = await loadUpgradeHelpers();
    expect(compareVersions("2026.7.2", "2026.7.1")).toBe(1);
    expect(compareVersions("2026.7.1", "2026.7.2")).toBe(-1);
    expect(compareVersions("2026.7.2", "2026.7.2")).toBe(0);
    expect(compareVersions("2026.8.0-beta.1", "2026.8.0")).toBe(-1);
    expect(compareVersions("2026.8.0", "2026.8.0-beta.1")).toBe(1);
    // Dotted prerelease counters compare numerically (string compare would
    // rank beta.9 above beta.10) — mirrors the server comparator.
    expect(compareVersions("2026.8.0-beta.10", "2026.8.0-beta.9")).toBe(1);
    expect(compareVersions("2026.8.0-beta.9", "2026.8.0-beta.10")).toBe(-1);
  });
});

describe("frontend/upgrade-helpers latest applicable target (U2)", () => {
  const kCatalog = {
    stable: [
      { version: "2026.7.3", current: false, blocklisted: { reason: "x" } },
      {
        version: "2026.7.2",
        current: false,
        blocklisted: null,
        applyPayload: { channel: "stable", version: "2026.7.2" },
      },
      { version: "2026.7.1", current: true, blocklisted: null },
    ],
    beta: [],
    dev: { commits: [] },
  };

  it("skips blocklisted and current rows", async () => {
    const { getLatestApplicableTarget } = await loadUpgradeHelpers();
    const target = getLatestApplicableTarget({
      catalog: kCatalog,
      releaseChannel: "stable",
    });
    expect(target.label).toBe("2026.7.2");
    expect(target.applyPayload).toEqual({
      channel: "stable",
      version: "2026.7.2",
    });
  });

  it("returns null when nothing is applicable", async () => {
    const { getLatestApplicableTarget } = await loadUpgradeHelpers();
    expect(
      getLatestApplicableTarget({
        catalog: { beta: [{ version: "1", current: true }] },
        releaseChannel: "beta",
      }),
    ).toBeNull();
    expect(getLatestApplicableTarget({ catalog: null })).toBeNull();
  });

  it("targets main HEAD for the dev channel", async () => {
    const { getLatestApplicableTarget } = await loadUpgradeHelpers();
    const target = getLatestApplicableTarget({
      catalog: kCatalog,
      releaseChannel: "dev",
    });
    expect(target.applyPayload).toEqual({ channel: "dev", devHead: true });
    expect(target.label).toBe("latest dev (main HEAD)");
  });
});

describe("frontend/upgrade-helpers step list", () => {
  it("collapses repeated step events to one row with the latest status", async () => {
    const { buildStepListModel } = await loadUpgradeHelpers();

    const model = buildStepListModel([
      { name: "preflight", status: "running", at: 1 },
      { name: "preflight", status: "completed", at: 2 },
      { name: "backup", status: "running", at: 3 },
      { name: "backup", status: "completed", at: 4 },
      { name: "download", status: "running", at: 5, detail: "npm install openclaw@2026.7.2" },
      { name: "download", status: "failed", at: 6, error: "ETIMEDOUT" },
    ]);

    expect(model.map((step) => [step.name, step.status])).toEqual([
      ["preflight", "completed"],
      ["backup", "completed"],
      ["download", "failed"],
    ]);
    expect(model[2].detail).toBe("npm install openclaw@2026.7.2");
    expect(model[2].error).toBe("ETIMEDOUT");
    expect(model[0].label).toBe("Preflight checks");
  });

  it("maps dev sub-steps (fetch → checkout → install → build → doctor)", async () => {
    const { buildStepListModel } = await loadUpgradeHelpers();

    const model = buildStepListModel([
      { name: "preflight", status: "completed", at: 1 },
      { name: "backup", status: "completed", at: 2 },
      { name: "fetch", status: "completed", at: 3 },
      { name: "checkout", status: "completed", at: 4, detail: "abc1234" },
      { name: "install", status: "completed", at: 5 },
      { name: "build", status: "completed", at: 6 },
      { name: "doctor", status: "warning", at: 7 },
      { name: "verify", status: "completed", at: 8 },
      { name: "record", status: "completed", at: 9 },
      { name: "restarting", status: "running", at: 10 },
    ]);

    expect(model.map((step) => step.label)).toEqual([
      "Preflight checks",
      "Backup",
      "Fetch source",
      "Checkout commit",
      "Install dependencies",
      "Build",
      "Doctor",
      "Verify",
      "Record",
      "Restarting",
    ]);
  });

  it("ignores malformed step entries", async () => {
    const { buildStepListModel } = await loadUpgradeHelpers();
    expect(buildStepListModel([null, {}, { name: "" }])).toEqual([]);
    expect(buildStepListModel("nope")).toEqual([]);
  });
});

describe("frontend/upgrade-helpers durations and staleness (U15)", () => {
  it("formats elapsed durations", async () => {
    const { formatElapsed } = await loadUpgradeHelpers();
    expect(formatElapsed(kNow - 42_000, kNow)).toBe("42s");
    expect(formatElapsed(kNow - 83_000, kNow)).toBe("1m 23s");
    expect(formatElapsed(null, kNow)).toBe("0s");
  });

  it("clamps elapsed durations when the end bound precedes the start", async () => {
    const { formatElapsed } = await loadUpgradeHelpers();
    expect(formatElapsed(1000, 500)).toBe("0s");
  });

  it("formats the output heartbeat", async () => {
    const { formatHeartbeat } = await loadUpgradeHelpers();
    expect(formatHeartbeat(kNow - 5_000, kNow)).toBe("last output 5s ago");
    expect(formatHeartbeat(null, kNow)).toBeNull();
  });

  it("formats relative ages in seconds, minutes, hours, and days", async () => {
    const { formatRelativeAge } = await loadUpgradeHelpers();
    // Shared-core dialect: "just now" only under 5s; a seconds tier exists.
    expect(formatRelativeAge(kNow - 2_000, kNow)).toBe("just now");
    expect(formatRelativeAge(kNow - 10_000, kNow)).toBe("10 seconds ago");
    expect(formatRelativeAge(kNow - 60_000, kNow)).toBe("1 minute ago");
    expect(formatRelativeAge(kNow - 5 * 60_000, kNow)).toBe("5 minutes ago");
    expect(formatRelativeAge(kNow - 3 * 3_600_000, kNow)).toBe("3 hours ago");
    expect(formatRelativeAge(kNow - 2 * 86_400_000, kNow)).toBe("2 days ago");
    expect(formatRelativeAge(null, kNow)).toBeNull();
  });

  it("builds the catalog staleness stamp", async () => {
    const { buildStalenessLabel } = await loadUpgradeHelpers();
    expect(buildStalenessLabel(kNow - 5 * 60_000, kNow)).toBe(
      "Catalog as of 5 minutes ago",
    );
    expect(buildStalenessLabel(null, kNow)).toBe("Catalog freshness unknown");
  });
});

describe("frontend/upgrade-helpers incident card (U6)", () => {
  it("builds a rollback incident from a blocklist entry newer than the last apply", async () => {
    const { buildIncidentModel } = await loadUpgradeHelpers();

    const incident = buildIncidentModel({
      lastUpdateRun: { finishedAt: kNow - 3_600_000, ok: true, result: { ok: true } },
      blocklist: [
        { id: "2026.7.3", reason: "crash_loop", exitCode: 1, at: kNow - 60_000 },
        { id: "2026.7.0", reason: "verify_failed", exitCode: 2, at: kNow - 86_400_000 },
      ],
    });

    expect(incident.kind).toBe("rollback");
    expect(incident.title).toContain("2026.7.3 rolled back at");
    expect(incident.detail).toBe("Trigger: crash loop, exit code 1");
    expect(incident.blockedId).toBe("2026.7.3");
    expect(incident.recovery).toContain("clear the blocklist entry");
  });

  it("builds an apply-failed incident from lastUpdateRun.result", async () => {
    const { buildIncidentModel } = await loadUpgradeHelpers();

    const incident = buildIncidentModel({
      lastUpdateRun: {
        target: { channel: "stable", version: "2026.7.2" },
        finishedAt: kNow,
        ok: false,
        result: { ok: false, code: "preflight_failed", message: "insufficient disk" },
      },
      blocklist: [],
    });

    expect(incident.kind).toBe("apply-failed");
    expect(incident.title).toBe("Update to 2026.7.2 failed");
    expect(incident.detail).toBe("insufficient disk");
    expect(incident.blockedId).toBeNull();
  });

  it("returns null when there is nothing to report", async () => {
    const { buildIncidentModel } = await loadUpgradeHelpers();
    expect(buildIncidentModel({})).toBeNull();
    expect(
      buildIncidentModel({
        lastUpdateRun: { finishedAt: kNow, ok: true, result: { ok: true } },
        blocklist: [{ id: "old", reason: "x", at: kNow - 86_400_000 }],
      }),
    ).toBeNull();
  });
});

describe("frontend/upgrade-helpers verdict banner (U4)", () => {
  it("verifies a package activation by version", async () => {
    const { buildVerdictBannerModel } = await loadUpgradeHelpers();

    const verdict = buildVerdictBannerModel({
      expected: { version: "2026.7.2" },
      channel: { installedVersion: "2026.7.2", appliedId: "2026.7.2", isPin: false },
    });

    expect(verdict.ok).toBe(true);
    expect(verdict.message).toBe(
      "Now on OpenClaw 2026.7.2 — activation verified",
    );
  });

  it("reports a failed activation when the version does not match", async () => {
    const { buildVerdictBannerModel } = await loadUpgradeHelpers();

    const verdict = buildVerdictBannerModel({
      expected: { version: "2026.7.2" },
      channel: { installedVersion: "2026.7.1", appliedId: null, isPin: true },
    });

    expect(verdict.ok).toBe(false);
    expect(verdict.message).toContain("2026.7.1");
    expect(verdict.message).toContain("may not have activated");
  });

  it("matches dev activations by sha prefix", async () => {
    const { buildVerdictBannerModel } = await loadUpgradeHelpers();

    const fullSha = "abc1234def5678abc1234def5678abc1234def56";
    const verdict = buildVerdictBannerModel({
      expected: { sha: "abc1234" },
      channel: { installedVersion: "2026.8.0-dev", appliedId: fullSha, isPin: false },
    });

    expect(verdict.ok).toBe(true);
  });

  it("leads with the dev commit, not the dormant pin, after a dev activation", async () => {
    const { buildVerdictBannerModel } = await loadUpgradeHelpers();

    // Realistic dev fixture: installedVersion stays the DORMANT package pin
    // ("2026.7.1-2") while appliedId carries the running commit sha.
    const fullSha = "abc1234def5678abc1234def5678abc1234def56";
    const channel = {
      installedVersion: "2026.7.1-2",
      appliedId: fullSha,
      isPin: false,
    };

    const bySha = buildVerdictBannerModel({
      expected: { sha: "abc1234" },
      channel,
    });
    expect(bySha.ok).toBe(true);
    expect(bySha.message).toBe(
      "Now on OpenClaw dev abc1234 — activation verified",
    );
    expect(bySha.message).not.toContain("2026.7.1-2");

    const byDevHead = buildVerdictBannerModel({
      expected: { devHead: true, previousId: "2026.7.1-2" },
      channel,
    });
    expect(byDevHead.ok).toBe(true);
    expect(byDevHead.message).toBe(
      "Now on OpenClaw dev abc1234 — activation verified",
    );

    // No expected payload, but a sha-shaped applied id on a non-pin install
    // still identifies the running build by commit (mirrors the status card).
    const noExpected = buildVerdictBannerModel({ expected: null, channel });
    expect(noExpected.message).toBe(
      "Now on OpenClaw dev abc1234 — activation verified",
    );

    // A pin install keeps leading with the package version.
    const pinned = buildVerdictBannerModel({
      expected: { version: "2026.7.1-2" },
      channel: {
        installedVersion: "2026.7.1-2",
        appliedId: "2026.7.1-2",
        isPin: true,
      },
    });
    expect(pinned.message).toBe(
      "Now on OpenClaw 2026.7.1-2 — activation verified",
    );
  });

  it("treats a fresh non-pin applied id as a dev-head activation", async () => {
    const { buildVerdictBannerModel } = await loadUpgradeHelpers();

    const verdict = buildVerdictBannerModel({
      expected: { devHead: true, previousId: "2026.7.1" },
      channel: { installedVersion: "2026.8.0-dev", appliedId: "fff0000", isPin: false },
    });

    expect(verdict.ok).toBe(true);

    const failed = buildVerdictBannerModel({
      expected: { devHead: true, previousId: "2026.7.1" },
      channel: { installedVersion: "2026.7.1", appliedId: null, isPin: true },
    });
    expect(failed.ok).toBe(false);
  });

  it("returns null without a channel payload", async () => {
    const { buildVerdictBannerModel } = await loadUpgradeHelpers();
    expect(buildVerdictBannerModel({ expected: { version: "1" } })).toBeNull();
  });

  it("replaces the green success with a gateway-held WARNING when gatewayHold is set", async () => {
    const { buildVerdictBannerModel, kGatewayHeldVerdictMessage } =
      await loadUpgradeHelpers();

    const verdict = buildVerdictBannerModel({
      expected: { version: "2026.8.1-beta.3" },
      channel: {
        installedVersion: "2026.8.1-beta.3",
        appliedId: "2026.8.1-beta.3",
        isPin: false,
        gatewayHold: {
          reason: "config_reconcile_failed",
          at: kNow,
          operationId: "0b1c2d3e-0000-4000-8000-000000000009",
          blamedKeys: ["gateway.auth.mode"],
        },
      },
    });

    // Activation itself verified — ok stays true so the reconnect poller
    // finishes instead of timing out — but the banner must not read green.
    expect(verdict.ok).toBe(true);
    expect(verdict.tone).toBe("warning");
    expect(verdict.tone).not.toBe("success");
    expect(verdict.message).toBe(kGatewayHeldVerdictMessage);
    expect(verdict.message).toBe(
      "Activated, but settings migration failed — the gateway is held. Check the notification for the exact keys, then use Retry migration.",
    );
    expect(verdict.message).not.toContain("activation verified");

    // A hold must not mask a FAILED activation — the mismatch stays red.
    const mismatch = buildVerdictBannerModel({
      expected: { version: "2026.8.1-beta.3" },
      channel: {
        installedVersion: "2026.7.1",
        appliedId: null,
        isPin: true,
        gatewayHold: { reason: "x", at: kNow, operationId: null, blamedKeys: [] },
      },
    });
    expect(mismatch.ok).toBe(false);
    expect(mismatch.tone).toBe("danger");
  });

  it("keeps the green success banner when gatewayHold is null or absent", async () => {
    const { buildVerdictBannerModel } = await loadUpgradeHelpers();

    const explicitNull = buildVerdictBannerModel({
      expected: { version: "2026.7.2" },
      channel: {
        installedVersion: "2026.7.2",
        appliedId: "2026.7.2",
        isPin: false,
        gatewayHold: null,
      },
    });
    expect(explicitNull.ok).toBe(true);
    expect(explicitNull.tone).toBe("success");
    expect(explicitNull.message).toBe(
      "Now on OpenClaw 2026.7.2 — activation verified",
    );

    // Absent entirely (an older server without the field) reads the same.
    const absent = buildVerdictBannerModel({
      expected: { version: "2026.7.2" },
      channel: { installedVersion: "2026.7.2", appliedId: "2026.7.2", isPin: false },
    });
    expect(absent).toEqual(explicitNull);
  });
});

describe("frontend/upgrade-helpers status card", () => {
  it("arms the stabilization banner with the last-known-good target (U7)", async () => {
    const { buildStatusCardModel } = await loadUpgradeHelpers();

    const model = buildStatusCardModel({
      releaseChannel: "beta",
      installedVersion: "2026.7.3-beta.1",
      pinVersion: "2026.7.1-2",
      applied: { channel: "beta", version: "2026.7.3-beta.1" },
      appliedId: "2026.7.3-beta.1",
      isPin: false,
      acceptedAt: null,
      inStabilizationWindow: true,
      lastKnownGood: { package: "2026.7.2", dev: null },
      lastBoot: null,
    });

    expect(model.stabilization.badge).toBe("STABILIZING");
    expect(model.stabilization.line).toBe(
      "Post-upgrade monitoring period — auto-rollback armed → last known good: 2026.7.2",
    );
    expect(model.stabilization.caption).toContain("first 24h");
    expect(model.showStabilizationActions).toBe(true);
    expect(model.autoAcceptedNote).toBeNull();
    expect(model.bootCostNote).toBe(
      "Channel-applied versions add ~10-60s to the first restart after a version change (settings migration and install checks run once; later restarts are fast).",
    );
  });

  it("names channel-applied versions (not 'non-stable') in the boot-cost note", async () => {
    const { kBootCostNote } = await loadUpgradeHelpers();
    expect(kBootCostNote).toContain("Channel-applied versions add ~10-60s");
    expect(kBootCostNote).toContain("settings migration");
  });

  it("surfaces the settings-migration result in admin language (2.1/D1)", async () => {
    const { buildSettingsMigrationRow } = await loadUpgradeHelpers();

    expect(buildSettingsMigrationRow(null)).toBeNull();
    expect(buildSettingsMigrationRow({})).toBeNull();

    expect(
      buildSettingsMigrationRow({
        completedForVersion: "2026.8.1-beta.3",
        lastAttempt: { version: "2026.8.1-beta.3", at: 1, ok: true },
      }),
    ).toEqual({ ok: true, text: "Settings updated for 2026.8.1-beta.3" });

    const failed = buildSettingsMigrationRow({
      completedForVersion: "2026.7.1-2",
      lastAttempt: {
        version: "2026.8.1-beta.3",
        at: 2,
        ok: false,
        error: "doctor exited 1",
      },
    });
    expect(failed.ok).toBe(false);
    expect(failed.text).toContain("Settings update for 2026.8.1-beta.3 failed");
    expect(failed.text).toContain("retries at the next restart");
  });

  it("keeps the auto-accepted 24h note while the window stays armed (two-tier window)", async () => {
    const { buildStatusCardModel, kAutoAcceptedNote } = await loadUpgradeHelpers();

    const model = buildStatusCardModel({
      releaseChannel: "beta",
      installedVersion: "2026.7.3-beta.1",
      pinVersion: "2026.7.1-2",
      applied: {
        channel: "beta",
        version: "2026.7.3-beta.1",
        acceptedSource: "acceptance",
      },
      appliedId: "2026.7.3-beta.1",
      isPin: false,
      acceptedAt: kNow - 3_600_000,
      inStabilizationWindow: true,
      lastKnownGood: { package: "2026.7.2", dev: null },
      lastBoot: null,
    });

    // Auto-acceptance keeps the window armed but drops the STABILIZING block.
    expect(model.stabilization).toBeNull();
    // The window is still armed, so the actions the note references
    // ("Mark as good now" / "Roll back now") must stay available.
    expect(model.showStabilizationActions).toBe(true);
    expect(model.autoAcceptedNote).toBe(kAutoAcceptedNote);

    // D1: with the server-computed window end, the note shows remaining time.
    const timed = buildStatusCardModel(
      {
        releaseChannel: "beta",
        installedVersion: "2026.7.3-beta.1",
        pinVersion: "2026.7.1-2",
        applied: {
          channel: "beta",
          version: "2026.7.3-beta.1",
          acceptedSource: "acceptance",
        },
        appliedId: "2026.7.3-beta.1",
        isPin: false,
        acceptedAt: kNow - 3_600_000,
        inStabilizationWindow: true,
        stabilizationEndsAt: kNow + 23 * 3_600_000,
        lastKnownGood: { package: "2026.7.2", dev: null },
        lastBoot: null,
      },
      kNow,
    );
    expect(timed.autoAcceptedNote).toBe(`${kAutoAcceptedNote} ~23h left`);
    expect(kAutoAcceptedNote).toBe(
      "Auto-rollback stays armed for 24h after activation — 'Mark as good now' disarms it.",
    );
  });

  it("clears the stabilization banner once accepted and hides the boot note on pins", async () => {
    const { buildStatusCardModel } = await loadUpgradeHelpers();

    const model = buildStatusCardModel({
      releaseChannel: "stable",
      installedVersion: "2026.7.1-2",
      pinVersion: "2026.7.1-2",
      applied: null,
      isPin: true,
      acceptedAt: null,
      inStabilizationWindow: false,
    });

    expect(model.stabilization).toBeNull();
    expect(model.showStabilizationActions).toBe(false);
    expect(model.bootCostNote).toBeNull();
    expect(model.runningLabel).toBe("2026.7.1-2");
  });

  it("leads with the dev commit identity, keeping installedVersion as the dormant pin (U8)", async () => {
    const { buildStatusCardModel, kDriftNotice } = await loadUpgradeHelpers();

    const model = buildStatusCardModel({
      releaseChannel: "dev",
      installedVersion: "2026.7.1-2",
      pinVersion: "2026.7.1-2",
      applied: { channel: "dev", sha: "abc1234def5678" },
      appliedId: "abc1234def5678",
      isPin: false,
      acceptedAt: 123,
      inStabilizationWindow: false,
      lastBoot: { action: "drift_reverted", warnings: [] },
    });

    // "package … dormant", not "pin … dormant" — the adjacent "Pinned
    // fallback" row shows a different value, so "pin" here would collide.
    expect(model.runningLabel).toBe("dev abc1234 (package 2026.7.1-2 dormant)");
    expect(model.runningLabel).toContain("abc1234");
    expect(model.driftNotice).toBe(kDriftNotice);
    expect(kDriftNotice).toContain("possibly by your agent");
  });

  it("omits the dormant-pin parenthetical when no package version is installed", async () => {
    const { buildStatusCardModel } = await loadUpgradeHelpers();

    const model = buildStatusCardModel({
      releaseChannel: "dev",
      installedVersion: null,
      pinVersion: "2026.7.1-2",
      applied: { channel: "dev", sha: "abc1234def5678" },
      appliedId: "abc1234def5678",
      isPin: false,
      acceptedAt: null,
      inStabilizationWindow: true,
      lastBoot: null,
    });

    expect(model.runningLabel).toBe("dev abc1234");
  });

  it("summarizes the last update run", async () => {
    const { buildLastUpdateSummary } = await loadUpgradeHelpers();

    expect(
      buildLastUpdateSummary({
        target: { channel: "stable", version: "2026.7.2" },
        finishedAt: null,
      }),
    ).toEqual(expect.objectContaining({ inFlight: true }));
    expect(
      buildLastUpdateSummary({
        target: { channel: "dev", devHead: true },
        finishedAt: kNow,
        ok: false,
      }).text,
    ).toContain("Update to latest dev (main HEAD) failed");
  });
});

describe("frontend/upgrade-helpers confirm models (U1/U3/U9)", () => {
  it("states package time and blast radius before commitment", async () => {
    const { buildApplyConfirmModel } = await loadUpgradeHelpers();

    const model = buildApplyConfirmModel({
      payload: { channel: "stable", version: "2026.7.2" },
      label: "2026.7.2",
    });

    expect(model.title).toBe("Switch to 2026.7.2?");
    expect(model.lines[0]).toBe(
      "Impact: ~2 min, your agent will be briefly offline.",
    );
    expect(model.lines[1]).toContain(
      "Backup includes OpenClaw's config, sessions and pairings; your workspace repo is already safe in git.",
    );
    expect(model.tone).toBe("primary");
  });

  it("uses the dev impact estimate and untested caveat for pinned commits", async () => {
    const { buildApplyConfirmModel } = await loadUpgradeHelpers();

    const model = buildApplyConfirmModel({
      payload: { channel: "dev", sha: "abc1234" },
      label: "dev abc1234",
    });

    expect(model.lines[0]).toBe(
      "Impact: compiles from source, 20-35 minutes; your agent stays up until the final restart.",
    );
    expect(model.lines.join(" ")).toContain("untested snapshot");
  });

  it("marks downgrades amber with the downgrade-state warning", async () => {
    const { buildApplyConfirmModel } = await loadUpgradeHelpers();

    const model = buildApplyConfirmModel({
      payload: { channel: "stable", version: "2026.7.0" },
      label: "2026.7.0",
      isDowngrade: true,
    });

    expect(model.title).toBe("Downgrade to 2026.7.0?");
    expect(model.tone).toBe("warning");
    expect(model.confirmLabel).toBe("Downgrade");
    expect(model.lines.join(" ")).toContain("Downgrading can leave newer state formats behind");
  });

  it("adds the breaking-change framing when crossing stable→beta or applying a prerelease", async () => {
    const { buildApplyConfirmModel, kApplyStepPreview } =
      await loadUpgradeHelpers();

    const model = buildApplyConfirmModel({
      payload: { channel: "beta", version: "2026.8.1-beta.3" },
      label: "2026.8.1-beta.3",
      currentChannel: "stable",
      notesAvailable: true,
    });

    expect(model.isBreaking).toBe(true);
    const joined = model.lines.join(" ");
    expect(joined).toContain(
      "Release notes for 2026.8.1-beta.3 are on its catalog row.",
    );
    // The safety net, in plain words.
    expect(joined).toContain("Verified backup required and taken first");
    expect(joined).toContain("120s health check");
    expect(joined).toContain("auto-rollback stays armed for 24h");
    expect(joined).toContain("a failing version gets blocklisted");
    // The backend HARD-blocks cross-channel/prerelease applies on backup
    // failure — say so.
    expect(joined).toContain("If the backup fails, nothing is installed.");
    // The what-happens-next step list.
    expect(model.steps).toEqual(kApplyStepPreview);
    expect(model.steps.join(" → ")).toContain("Backup → Download → Verify");
  });

  it("states the gateway backup pause on breaking applies only", async () => {
    const { buildApplyConfirmModel, kBackupPauseNote } =
      await loadUpgradeHelpers();

    // Cross-channel (stable→beta): the pre-update backup quiesces the
    // gateway — the note lands right after the backup hard gate.
    const breaking = buildApplyConfirmModel({
      payload: { channel: "beta", version: "2026.8.1-beta.3" },
      label: "2026.8.1-beta.3",
      currentChannel: "stable",
      notesAvailable: true,
    });
    expect(kBackupPauseNote).toBe(
      "The gateway pauses briefly during the pre-update backup.",
    );
    const gateIndex = breaking.lines.indexOf(
      "If the backup fails, nothing is installed.",
    );
    expect(gateIndex).toBeGreaterThan(-1);
    expect(breaking.lines[gateIndex + 1]).toBe(kBackupPauseNote);

    // A same-channel non-prerelease apply never pauses the gateway — no note.
    const routine = buildApplyConfirmModel({
      payload: { channel: "stable", version: "2026.7.2" },
      label: "2026.7.2",
      currentChannel: "stable",
      notesAvailable: true,
    });
    expect(routine.lines.join(" ")).not.toContain(kBackupPauseNote);
  });

  it("marks degraded release-notes availability in the breaking confirm", async () => {
    const { buildApplyConfirmModel } = await loadUpgradeHelpers();

    const model = buildApplyConfirmModel({
      payload: { channel: "beta", version: "2026.8.1-beta.3" },
      label: "2026.8.1-beta.3",
      currentChannel: "stable",
      notesAvailable: false,
    });

    expect(model.lines.join(" ")).toContain(
      "Release notes are unavailable right now (source degraded).",
    );
  });

  it("treats a prerelease as breaking even within the beta channel", async () => {
    const { buildApplyConfirmModel } = await loadUpgradeHelpers();

    const model = buildApplyConfirmModel({
      payload: { channel: "beta", version: "2026.8.1-beta.4" },
      label: "2026.8.1-beta.4",
      currentChannel: "beta",
    });

    expect(model.isBreaking).toBe(true);
    expect(model.steps).not.toBeNull();
  });

  it("keeps stable→stable applies free of the breaking framing", async () => {
    const { buildApplyConfirmModel } = await loadUpgradeHelpers();

    const model = buildApplyConfirmModel({
      payload: { channel: "stable", version: "2026.7.2" },
      label: "2026.7.2",
      currentChannel: "stable",
      notesAvailable: true,
    });

    expect(model.isBreaking).toBe(false);
    expect(model.steps).toBeNull();
    expect(model.lines.join(" ")).not.toContain("Safety net");
  });

  it("carries curated security flips into the confirm model (D5)", async () => {
    const { buildApplyConfirmModel } = await loadUpgradeHelpers();

    const flips = [
      {
        key: "gateway.terminal.enabled",
        from: "off",
        to: "on",
        warning: "The dashboard gains a host terminal by default.",
      },
    ];
    const model = buildApplyConfirmModel({
      payload: { channel: "beta", version: "2026.8.1-beta.3" },
      label: "2026.8.1-beta.3",
      currentChannel: "stable",
      securityFlips: flips,
    });
    expect(model.securityFlips).toEqual(flips);

    // Defaults and malformed inputs collapse to an empty list.
    expect(
      buildApplyConfirmModel({
        payload: { channel: "stable", version: "2026.7.2" },
        label: "2026.7.2",
      }).securityFlips,
    ).toEqual([]);
    expect(
      buildApplyConfirmModel({
        payload: { channel: "beta", version: "2026.8.1-beta.3" },
        label: "2026.8.1-beta.3",
        securityFlips: "not-an-array",
      }).securityFlips,
    ).toEqual([]);
  });
});

describe("frontend/upgrade-helpers channel mismatch banner", () => {
  const makeInfo = (overrides = {}) => ({
    releaseChannel: "stable",
    installedVersion: "2026.7.1-2",
    pinVersion: "2026.7.1-2",
    applied: null,
    appliedId: null,
    isPin: true,
    ...overrides,
  });

  const makeCatalog = (overrides = {}) => ({
    degraded: { github: false, npm: false },
    stable: [
      { version: "2026.7.1-2", current: true, isDistTagLatest: false },
    ],
    beta: [
      {
        version: "2026.8.1-beta.3",
        prerelease: true,
        notes: "notes body",
        notesUnavailable: false,
        applyPayload: { channel: "beta", version: "2026.8.1-beta.3" },
        current: false,
        blocklisted: null,
      },
    ],
    dev: { commits: [] },
    ...overrides,
  });

  it("is null when the configured channel matches the running build", async () => {
    const { buildChannelMismatchModel } = await loadUpgradeHelpers();
    expect(
      buildChannelMismatchModel({
        catalog: makeCatalog({ beta: [] }),
        channelInfo: makeInfo(),
        releaseChannel: "stable",
      }),
    ).toBeNull();
    expect(buildChannelMismatchModel({ catalog: null, channelInfo: makeInfo() })).toBeNull();
    expect(buildChannelMismatchModel({ catalog: makeCatalog(), channelInfo: null })).toBeNull();
  });

  it("offers the Update/notes/back actions when the channel has a newer target", async () => {
    const { buildChannelMismatchModel } = await loadUpgradeHelpers();

    const model = buildChannelMismatchModel({
      catalog: makeCatalog(),
      channelInfo: makeInfo({ releaseChannel: "beta" }),
      releaseChannel: "beta",
    });

    expect(model.kind).toBe("update-available");
    expect(model.message).toBe(
      "Channel set to beta — still running stable 2026.7.1-2.",
    );
    expect(model.applyLabel).toBe("Update to 2026.8.1-beta.3");
    expect(model.applyTarget.applyPayload).toEqual({
      channel: "beta",
      version: "2026.8.1-beta.3",
    });
    expect(model.notesRowId).toBe("2026.8.1-beta.3");
    expect(model.backChannel).toBe("stable");
    expect(model.backLabel).toBe("Back to stable");
    expect(model.applyDisabled).toBe(false);
  });

  it("says 'No newer beta is published' when the beta dist-tag is older than stable", async () => {
    const { buildChannelMismatchModel } = await loadUpgradeHelpers();

    const model = buildChannelMismatchModel({
      catalog: makeCatalog({
        beta: [
          {
            version: "2026.6.9-beta.1",
            applyPayload: { channel: "beta", version: "2026.6.9-beta.1" },
            current: false,
            blocklisted: null,
          },
        ],
      }),
      channelInfo: makeInfo({ releaseChannel: "beta" }),
      releaseChannel: "beta",
    });

    expect(model.kind).toBe("no-newer");
    expect(model.message).toBe(
      "No newer beta is published — stable 2026.7.1-2 is current.",
    );
    expect(model.applyTarget).toBeNull();
    expect(model.applyLabel).toBeNull();
    expect(model.backChannel).toBe("stable");
  });

  it("distinguishes empty-because-degraded from genuinely current", async () => {
    const { buildChannelMismatchModel } = await loadUpgradeHelpers();

    const degraded = buildChannelMismatchModel({
      catalog: makeCatalog({ beta: [], degraded: { github: false, npm: true } }),
      channelInfo: makeInfo({ releaseChannel: "beta" }),
      releaseChannel: "beta",
    });
    expect(degraded.kind).toBe("degraded-unknown");
    expect(degraded.message).toContain("the catalog is degraded");
    expect(degraded.applyTarget).toBeNull();

    const genuinelyEmpty = buildChannelMismatchModel({
      catalog: makeCatalog({ beta: [] }),
      channelInfo: makeInfo({ releaseChannel: "beta" }),
      releaseChannel: "beta",
    });
    expect(genuinelyEmpty.kind).toBe("no-newer");
  });

  it("gates the banner's Apply on npm degradation but not GitHub-only degradation", async () => {
    const { buildChannelMismatchModel, kNpmDegradedApplyNote } =
      await loadUpgradeHelpers();

    const npmDown = buildChannelMismatchModel({
      catalog: makeCatalog({ degraded: { github: false, npm: true } }),
      channelInfo: makeInfo({ releaseChannel: "beta" }),
      releaseChannel: "beta",
    });
    expect(npmDown.kind).toBe("update-available");
    expect(npmDown.applyDisabled).toBe(true);
    expect(npmDown.applyDisabledReason).toBe(kNpmDegradedApplyNote);

    const githubDown = buildChannelMismatchModel({
      catalog: makeCatalog({ degraded: { github: true, npm: false } }),
      channelInfo: makeInfo({ releaseChannel: "beta" }),
      releaseChannel: "beta",
    });
    expect(githubDown.applyDisabled).toBe(false);
    expect(githubDown.applyDisabledReason).toBeNull();
  });

  it("skips the Release-notes action when the target row's notes are unavailable", async () => {
    const { buildChannelMismatchModel } = await loadUpgradeHelpers();

    const model = buildChannelMismatchModel({
      catalog: makeCatalog({
        beta: [
          {
            version: "2026.8.1-beta.3",
            notes: null,
            notesUnavailable: true,
            applyPayload: { channel: "beta", version: "2026.8.1-beta.3" },
            current: false,
            blocklisted: null,
          },
        ],
      }),
      channelInfo: makeInfo({ releaseChannel: "beta" }),
      releaseChannel: "beta",
    });

    expect(model.notesRowId).toBeNull();
  });

  it("announces a same-channel update without a back action", async () => {
    const { buildChannelMismatchModel } = await loadUpgradeHelpers();

    const model = buildChannelMismatchModel({
      catalog: makeCatalog({
        stable: [
          { version: "2026.7.1-2", current: true, isDistTagLatest: false },
          {
            version: "2026.7.2",
            isDistTagLatest: true,
            notes: "n",
            applyPayload: { channel: "stable", version: "2026.7.2" },
            current: false,
            blocklisted: null,
          },
        ],
      }),
      channelInfo: makeInfo(),
      releaseChannel: "stable",
    });

    expect(model.kind).toBe("update-available");
    expect(model.message).toBe(
      "A newer stable is available — still running 2026.7.1-2.",
    );
    expect(model.backChannel).toBeNull();
  });

  it("flags a dev channel preference while a package build runs, and never for a running dev build", async () => {
    const { buildChannelMismatchModel } = await loadUpgradeHelpers();

    const mismatch = buildChannelMismatchModel({
      catalog: makeCatalog(),
      channelInfo: makeInfo({ releaseChannel: "dev" }),
      releaseChannel: "dev",
    });
    expect(mismatch.kind).toBe("update-available");
    expect(mismatch.message).toBe(
      "Channel set to dev — still running stable 2026.7.1-2.",
    );
    expect(mismatch.applyTarget.applyPayload).toEqual({
      channel: "dev",
      devHead: true,
    });

    const runningDev = buildChannelMismatchModel({
      catalog: makeCatalog(),
      channelInfo: makeInfo({
        releaseChannel: "dev",
        applied: { channel: "dev", sha: "abc1234def5678" },
        appliedId: "abc1234def5678",
        isPin: false,
      }),
      releaseChannel: "dev",
    });
    expect(runningDev).toBeNull();
  });
});

describe("frontend/upgrade-helpers channel-save error chip", () => {
  it("names the attempted channel and where the selection reverted to", async () => {
    const { buildChannelSaveErrorModel } = await loadUpgradeHelpers();

    const model = buildChannelSaveErrorModel({
      attempted: "beta",
      activeChannel: "stable",
      error: Object.assign(new Error("disk full"), {
        code: "config_write_failed",
        hint: "Check disk space on the data volume.",
      }),
    });

    expect(model.message).toBe("Couldn't switch to beta — still on stable.");
    expect(model.detail).toBe("disk full");
    expect(model.hint).toBe("Check disk space on the data volume.");
  });
});

describe("frontend/upgrade-helpers degraded catalog gating", () => {
  it("gates installs on npm and notes on GitHub, independently", async () => {
    const {
      buildCatalogGatingModel,
      kNpmDegradedApplyNote,
      kGithubDegradedNotesNote,
    } = await loadUpgradeHelpers();

    const npmDown = buildCatalogGatingModel({
      degraded: { github: false, npm: true },
    });
    expect(npmDown.applyDisabled).toBe(true);
    expect(npmDown.applyDisabledReason).toBe(kNpmDegradedApplyNote);
    expect(npmDown.notesNote).toBeNull();

    const githubDown = buildCatalogGatingModel({
      degraded: { github: true, npm: false },
    });
    expect(githubDown.applyDisabled).toBe(false);
    expect(githubDown.notesNote).toBe(kGithubDegradedNotesNote);

    expect(buildCatalogGatingModel(null).applyDisabled).toBe(false);
  });

  it("tells empty-because-degraded apart from genuinely current in the availability line", async () => {
    const { buildAvailabilityLine, buildNoTargetNotice } =
      await loadUpgradeHelpers();

    const degradedEmpty = {
      degraded: { github: false, npm: true },
      stable: [],
      beta: [],
      dev: { commits: [] },
    };
    expect(
      buildAvailabilityLine({ catalog: degradedEmpty, releaseChannel: "beta" }),
    ).toBe("Catalog degraded — can't confirm the latest beta right now.");
    expect(
      buildNoTargetNotice({ catalog: degradedEmpty, releaseChannel: "beta" }),
    ).toBe("Catalog degraded — can't confirm the latest beta right now.");

    const healthyEmpty = {
      degraded: { github: false, npm: false },
      stable: [],
      beta: [],
      dev: { commits: [] },
    };
    expect(
      buildAvailabilityLine({ catalog: healthyEmpty, releaseChannel: "beta" }),
    ).toBe("No beta releases listed.");
    expect(
      buildNoTargetNotice({ catalog: healthyEmpty, releaseChannel: "beta" }),
    ).toBe("You're already on the latest beta.");

    const githubDegradedDev = {
      degraded: { github: true, npm: false },
      stable: [],
      beta: [],
      dev: { commits: [] },
    };
    expect(
      buildAvailabilityLine({ catalog: githubDegradedDev, releaseChannel: "dev" }),
    ).toBe("Catalog degraded — can't confirm the latest dev commit.");
  });
});

describe("frontend/upgrade-helpers run ledger models", () => {
  it("maps runs to compact timeline entries", async () => {
    const { buildRunTimelineModel } = await loadUpgradeHelpers();

    const entries = buildRunTimelineModel(
      [
        {
          operationId: "0b1c2d3e-0000-4000-8000-000000000001",
          target: { channel: "stable", version: "2026.7.2" },
          state: "activated",
          startedAt: kNow - 3_700_000,
          finishedAt: kNow - 3_600_000,
          hasLog: true,
        },
        {
          operationId: "0b1c2d3e-0000-4000-8000-000000000002",
          target: { channel: "dev", devHead: true },
          state: "interrupted",
          startedAt: kNow - 86_400_000,
          finishedAt: null,
          hasLog: false,
        },
        null,
        { state: "running" }, // no operationId → dropped
      ],
      kNow,
    );

    expect(entries).toEqual([
      {
        operationId: "0b1c2d3e-0000-4000-8000-000000000001",
        stateLabel: "activated",
        tone: "success",
        targetLabel: "2026.7.2",
        when: "1 hour ago",
        hasLog: true,
      },
      {
        operationId: "0b1c2d3e-0000-4000-8000-000000000002",
        stateLabel: "interrupted",
        tone: "danger",
        targetLabel: "latest dev (main HEAD)",
        when: "1 day ago",
        hasLog: false,
      },
    ]);
  });

  it("labels every ledger state", async () => {
    const { buildRunTimelineModel } = await loadUpgradeHelpers();
    const states = [
      ["running", "running", "info"],
      ["failed", "failed", "danger"],
      ["noop", "no change", "neutral"],
      ["restart_expected", "restarting", "info"],
      ["activated", "activated", "success"],
      ["activation_failed", "activation failed", "danger"],
      ["interrupted", "interrupted", "danger"],
    ];
    for (const [state, label, tone] of states) {
      const [entry] = buildRunTimelineModel(
        [{ operationId: "0b1c2d3e-0000-4000-8000-00000000000a", state }],
        kNow,
      );
      expect(entry.stateLabel).toBe(label);
      expect(entry.tone).toBe(tone);
    }
  });

  it("builds a failure model only for activation_failed and interrupted runs", async () => {
    const { buildRunFailureModel } = await loadUpgradeHelpers();

    const failed = buildRunFailureModel({
      operationId: "0b1c2d3e-0000-4000-8000-000000000001",
      state: "activation_failed",
      target: { channel: "beta", version: "2026.8.1-beta.3" },
      result: {
        ok: false,
        code: "activation_failed",
        message: "health check failed after restart",
        hint: "The previous version was restored.",
      },
      hasLog: true,
    });
    expect(failed.title).toBe(
      "Update to 2026.8.1-beta.3 did not activate",
    );
    expect(failed.error).toEqual(
      expect.objectContaining({
        message: "health check failed after restart",
        hint: "The previous version was restored.",
      }),
    );
    expect(failed.hasLog).toBe(true);

    const interrupted = buildRunFailureModel({
      operationId: "0b1c2d3e-0000-4000-8000-000000000002",
      state: "interrupted",
      target: { channel: "stable", version: "2026.7.2" },
      result: null,
      hasLog: false,
    });
    expect(interrupted.title).toBe("Update to 2026.7.2 was interrupted");
    expect(interrupted.error.message).toContain("interrupted");

    expect(buildRunFailureModel({ state: "activated" })).toBeNull();
    expect(buildRunFailureModel({ state: "failed" })).toBeNull();
    expect(buildRunFailureModel(null)).toBeNull();
  });
});

describe("frontend/upgrade-helpers misc models", () => {
  it("describes availability for package channels and dev", async () => {
    const { buildAvailabilityLine } = await loadUpgradeHelpers();
    const catalog = {
      stable: [{ version: "2026.7.2", current: false }],
      beta: [],
      dev: { commits: [{ sha: "abc1234def", shortSha: "abc1234", current: true }] },
    };

    // No installedVersion → the distance is unknown, so D13 states that
    // explicitly rather than silently implying "up to date".
    expect(buildAvailabilityLine({ catalog, releaseChannel: "stable" })).toBe(
      "Latest stable: 2026.7.2 — update status unavailable",
    );
    expect(
      buildAvailabilityLine({
        catalog,
        releaseChannel: "stable",
        installedVersion: "2026.7.2",
      }),
    ).toBe("Latest stable: 2026.7.2");
    expect(buildAvailabilityLine({ catalog, releaseChannel: "beta" })).toBe(
      "No beta releases listed.",
    );
    expect(buildAvailabilityLine({ catalog, releaseChannel: "dev" })).toBe(
      "You're on the latest dev commit.",
    );
    expect(buildAvailabilityLine({ catalog: null })).toBeNull();
  });

  it("keeps message, hint, and code from error envelopes (U12)", async () => {
    const { buildErrorEnvelopeModel } = await loadUpgradeHelpers();

    const error = new Error("Node 22.12+ is required");
    error.hint = "Install a newer Node with your platform's package manager.";
    error.code = "preflight_failed";

    expect(buildErrorEnvelopeModel(error)).toEqual({
      message: "Node 22.12+ is required",
      hint: "Install a newer Node with your platform's package manager.",
      code: "preflight_failed",
      docsUrl: null,
      repairApplicable: false,
    });
    expect(buildErrorEnvelopeModel(null)).toBeNull();
    expect(buildErrorEnvelopeModel("plain text").message).toBe("plain text");
  });

  it("passes repairApplicable through error envelopes", async () => {
    const { buildErrorEnvelopeModel } = await loadUpgradeHelpers();

    expect(
      buildErrorEnvelopeModel({
        message: "npm run build failed",
        code: "apply_failed",
        repairApplicable: true,
      }).repairApplicable,
    ).toBe(true);
    // Anything other than a literal true (absent, null, truthy strings)
    // must normalize to false so the repair caption stays hidden.
    expect(
      buildErrorEnvelopeModel({ message: "backup failed" }).repairApplicable,
    ).toBe(false);
    expect(
      buildErrorEnvelopeModel({ message: "x", repairApplicable: null })
        .repairApplicable,
    ).toBe(false);
    expect(
      buildErrorEnvelopeModel({ message: "x", repairApplicable: "yes" })
        .repairApplicable,
    ).toBe(false);
  });

  it("describes apply targets and last-known-good pairs", async () => {
    const { describeTarget, describeLastKnownGood } = await loadUpgradeHelpers();

    expect(describeTarget({ channel: "dev", devHead: true })).toBe(
      "latest dev (main HEAD)",
    );
    expect(describeTarget({ channel: "dev", sha: "abc1234def5678" })).toBe(
      "dev abc1234",
    );
    expect(describeTarget({ channel: "beta", version: "2026.7.3-beta.1" })).toBe(
      "2026.7.3-beta.1",
    );
    expect(describeTarget(null)).toBe("unknown target");

    expect(
      describeLastKnownGood({ package: "2026.7.2", dev: "abc1234def" }),
    ).toBe("2026.7.2 · dev abc1234");
    expect(describeLastKnownGood({ package: null, dev: null })).toBeNull();
  });

  // Regression tests from the live /devex-review drill: extended-stable
  // backports publish AFTER the dist-tag latest, so date order must never
  // decide labels or targets.
  it("ranks bare numeric suffixes as hotfixes above the base release", async () => {
    const { compareVersions } = await loadUpgradeHelpers();
    expect(compareVersions("2026.7.1-2", "2026.7.1")).toBe(1);
    expect(compareVersions("2026.7.1", "2026.7.1-2")).toBe(-1);
    expect(compareVersions("2026.7.1-2", "2026.7.1-1")).toBe(1);
    expect(compareVersions("2026.8.1-beta.3", "2026.8.1")).toBe(-1);
    expect(compareVersions("2026.6.34", "2026.7.1-2")).toBe(-1);
  });

  it("labels a later-published backport as Downgrade, not Upgrade", async () => {
    const { getRowActionModel } = await loadUpgradeHelpers();
    const rows = [
      { version: "2026.6.34", publishedAt: "2026-08-08" },
      { version: "2026.6.33", publishedAt: "2026-08-08" },
      { version: "2026.7.1-2", publishedAt: "2026-08-04", current: true, isDistTagLatest: true },
      { version: "2026.7.1-1", publishedAt: "2026-08-04" },
    ];
    expect(getRowActionModel({ row: rows[0], rows }).label).toBe("Downgrade");
    expect(getRowActionModel({ row: rows[0], rows }).isDowngrade).toBe(true);
    expect(getRowActionModel({ row: rows[3], rows }).label).toBe("Downgrade");
    expect(getRowActionModel({ row: rows[2], rows }).label).toBe("Current");
  });

  it("stable latest target honors the dist-tag over publish order", async () => {
    const { getLatestApplicableTarget, buildAvailabilityLine } =
      await loadUpgradeHelpers();
    const catalog = {
      stable: [
        { version: "2026.6.34", applyPayload: { channel: "stable", version: "2026.6.34" } },
        { version: "2026.7.1-2", isDistTagLatest: true, applyPayload: { channel: "stable", version: "2026.7.1-2" } },
      ],
    };
    const target = getLatestApplicableTarget({ catalog, releaseChannel: "stable" });
    expect(target.label).toBe("2026.7.1-2");
    const line = buildAvailabilityLine({ catalog, releaseChannel: "stable" });
    expect(line).toContain("2026.7.1-2");
    expect(line).not.toContain("2026.6.34");
  });

  it("treats numerically-equal hotfix suffixes as equal in both directions", async () => {
    const { compareVersions } = await loadUpgradeHelpers();
    // "-2" vs "-02" parse to the same hotfix number; returning -1 both ways
    // (the old behavior) made the comparator non-antisymmetric.
    expect(compareVersions("2026.7.1-2", "2026.7.1-02")).toBe(0);
    expect(compareVersions("2026.7.1-02", "2026.7.1-2")).toBe(0);
  });

  it("agrees with the server comparator's sign over a shared corpus", async () => {
    const { compareVersions } = await loadUpgradeHelpers();
    const { compareVersionParts } = require("../../lib/server/helpers");
    const corpus = [
      ["2026.7.1-2", "2026.7.1"],
      ["2026.8.1-beta.10", "2026.8.1-beta.9"],
      ["v2026.7.1", "2026.7.1"],
      ["2026.8.1-beta.3", "2026.7.1-2"],
      ["2026.7.1-2", "2026.7.1-02"],
      ["2026.8.0-beta.1", "2026.8.0-rc.1"],
    ];
    for (const [a, b] of corpus) {
      expect(
        Math.sign(compareVersions(a, b)),
        `compareVersions(${a}, ${b}) must match the server`,
      ).toBe(Math.sign(compareVersionParts(a, b)));
      expect(
        Math.sign(compareVersions(b, a)),
        `compareVersions(${b}, ${a}) must match the server`,
      ).toBe(Math.sign(compareVersionParts(b, a)));
    }
  });
  it("verdict: a dev-head rebuild resolving to the SAME sha is a success", async () => {
    const { buildVerdictBannerModel } = await loadUpgradeHelpers();
    const sha = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";
    const verdict = buildVerdictBannerModel({
      expected: { devHead: true, previousId: sha },
      channel: {
        isPin: false,
        appliedId: sha,
        installedVersion: "2026.7.1-2",
        pinVersion: "2026.7.1-2",
      },
    });
    // main was unchanged — the update completed on the same commit; requiring
    // a DIFFERENT sha made the UI report failure for a successful update.
    expect(verdict.ok).toBe(true);
  });

  describe("releases-behind indicator", () => {
    const catalog = {
      beta: [
        { version: "2026.8.1-beta.3" },
        { version: "2026.8.1-beta.2" },
        { version: "2026.8.1-beta.1" },
      ],
      stable: [{ version: "2026.7.1-2", isDistTagLatest: true }],
    };

    it("counts newer releases only when installed is on the selected channel", async () => {
      const { computeReleasesBehind, formatReleasesBehind } =
        await loadUpgradeHelpers();
      const result = computeReleasesBehind({
        catalog,
        releaseChannel: "beta",
        installedVersion: "2026.8.1-beta.1",
      });
      expect(result).toEqual({ status: "behind", count: 2 });
      expect(formatReleasesBehind(result, "beta")).toBe("2 beta releases behind");
    });

    it("uses the singular noun exactly one release behind (E2)", async () => {
      const { computeReleasesBehind, formatReleasesBehind } =
        await loadUpgradeHelpers();
      const result = computeReleasesBehind({
        catalog,
        releaseChannel: "beta",
        installedVersion: "2026.8.1-beta.2",
      });
      expect(result).toEqual({ status: "behind", count: 1 });
      expect(formatReleasesBehind(result, "beta")).toBe("1 beta release behind");
    });

    it("reports up-to-date on the newest release", async () => {
      const { computeReleasesBehind, formatReleasesBehind } =
        await loadUpgradeHelpers();
      const result = computeReleasesBehind({
        catalog,
        releaseChannel: "beta",
        installedVersion: "2026.8.1-beta.3",
      });
      expect(result.status).toBe("current");
      expect(formatReleasesBehind(result)).toBe("Up to date");
    });

    it("says not-on-channel when installed belongs to a different channel", async () => {
      const { computeReleasesBehind, formatReleasesBehind } =
        await loadUpgradeHelpers();
      const result = computeReleasesBehind({
        catalog,
        releaseChannel: "beta",
        installedVersion: "2026.7.1-2", // a stable version, browsing beta
      });
      expect(result.status).toBe("not-on-channel");
      expect(formatReleasesBehind(result)).toBe(
        "Not running the selected channel",
      );
    });

    it("appends distance/not-on-channel detail to the availability line", async () => {
      const { buildAvailabilityLine } = await loadUpgradeHelpers();
      expect(
        buildAvailabilityLine({
          catalog,
          releaseChannel: "beta",
          installedVersion: "2026.8.1-beta.1",
        }),
      ).toBe("Latest beta: 2026.8.1-beta.3 — 2 beta releases behind");
      expect(
        buildAvailabilityLine({
          catalog,
          releaseChannel: "beta",
          installedVersion: "2026.7.1-2",
        }),
      ).toBe("Latest beta: 2026.8.1-beta.3 — not running this channel yet");
    });

    it("says update status unavailable when the distance is unknown (D13)", async () => {
      const { buildAvailabilityLine } = await loadUpgradeHelpers();
      // We know the latest beta but not what's installed — the distance can't
      // be computed, so D13 says so instead of silently dropping the claim.
      expect(
        buildAvailabilityLine({
          catalog,
          releaseChannel: "beta",
          installedVersion: null,
        }),
      ).toBe("Latest beta: 2026.8.1-beta.3 — update status unavailable");
    });

    it("returns unknown for dev, empty catalog, or missing version", async () => {
      const { computeReleasesBehind, formatReleasesBehind } =
        await loadUpgradeHelpers();
      expect(
        computeReleasesBehind({ catalog, releaseChannel: "dev", installedVersion: "x" })
          .status,
      ).toBe("unknown");
      expect(
        computeReleasesBehind({ catalog: null, releaseChannel: "beta", installedVersion: "x" })
          .status,
      ).toBe("unknown");
      expect(formatReleasesBehind({ status: "unknown" })).toBeNull();
    });
  });
});

describe("frontend/upgrade-helpers gateway hold model", () => {
  it("returns null when there is no hold", async () => {
    const { buildGatewayHoldModel } = await loadUpgradeHelpers();
    expect(buildGatewayHoldModel(null)).toBeNull();
    expect(buildGatewayHoldModel({})).toBeNull();
    expect(buildGatewayHoldModel({ gatewayHold: null })).toBeNull();
    // Defensive: a non-object hold (older server, corrupted state) is no hold.
    expect(buildGatewayHoldModel({ gatewayHold: "held" })).toBeNull();
  });

  it("builds reason, sanitized string-only keys, and canStrip for a held gateway", async () => {
    const { buildGatewayHoldModel } = await loadUpgradeHelpers();
    const model = buildGatewayHoldModel({
      gatewayHold: {
        reason: "settings migration for 2026.8.1 failed: doctor exited 1",
        at: kNow,
        operationId: "op-hold-1",
        blamedKeys: ["gateway.oldKey", 42, "", null, "channels.legacy"],
      },
    });
    expect(model).toEqual({
      reason: "settings migration for 2026.8.1 failed: doctor exited 1",
      blamedKeys: ["gateway.oldKey", "channels.legacy"],
      keyCount: 2,
      canStrip: true,
    });
  });

  it("cannot strip when the validator parsed no keys, and a missing reason gets a fallback", async () => {
    const { buildGatewayHoldModel } = await loadUpgradeHelpers();
    const model = buildGatewayHoldModel({
      gatewayHold: { reason: null, at: kNow, operationId: null, blamedKeys: [] },
    });
    expect(model).toEqual({
      reason: "Settings migration failed.",
      blamedKeys: [],
      keyCount: 0,
      canStrip: false,
    });
  });

  it("caps the key display at 12 with a +N more suffix entry", async () => {
    const { buildGatewayHoldModel, kGatewayHoldKeyDisplayCap } =
      await loadUpgradeHelpers();
    expect(kGatewayHoldKeyDisplayCap).toBe(12);
    const keys = Array.from({ length: 15 }, (_, i) => `settings.key${i}`);
    const model = buildGatewayHoldModel({
      gatewayHold: { reason: "migration failed", blamedKeys: keys },
    });
    expect(model.blamedKeys).toHaveLength(13);
    expect(model.blamedKeys.slice(0, 12)).toEqual(keys.slice(0, 12));
    expect(model.blamedKeys[12]).toBe("+3 more");
    // canStrip and the confirm count follow the REAL key count, not the
    // capped display list.
    expect(model.keyCount).toBe(15);
    expect(model.canStrip).toBe(true);
  });

  it("spells out the strip consequences with the exact key count, properly pluralized", async () => {
    const { buildStripKeysConfirmMessage } = await loadUpgradeHelpers();
    expect(buildStripKeysConfirmMessage(3)).toBe(
      "Remove the 3 setting keys OpenClaw's validator rejected? A backup was saved before migration; protected security settings are never removable.",
    );
    expect(buildStripKeysConfirmMessage(1)).toBe(
      "Remove the 1 setting key OpenClaw's validator rejected? A backup was saved before migration; protected security settings are never removable.",
    );
  });

  it("names the verified pre-update backup in the rollback data-risk line, with a no-backup fallback", async () => {
    const { buildRollbackDataRiskLine } = await loadUpgradeHelpers();
    expect(buildRollbackDataRiskLine("backup-2026-08-29.tar.gz")).toBe(
      "Restore the verified pre-update backup first (backup-2026-08-29.tar.gz), or roll back anyway — data written by the newer version may be unreadable.",
    );
    expect(buildRollbackDataRiskLine(null)).toBe(
      "No verified pre-update backup is recorded — data written by the newer version may be unreadable if you roll back anyway.",
    );
  });

  // WI-4.1: the fence re-stats the recorded archive and qualifies it.
  it("renders the fence re-stat caveats: pruned → newest surviving archive, partial, reused loss window", async () => {
    const { buildRollbackDataRiskLine } = await loadUpgradeHelpers();
    const kNow = Date.parse("2026-09-02T12:00:00.000Z");

    // Object model without caveats === the legacy string line.
    expect(
      buildRollbackDataRiskLine({ backupFile: "b.tar.gz", backupFileExists: true }, kNow),
    ).toBe(buildRollbackDataRiskLine("b.tar.gz"));
    // Older servers omit backupFileExists — undefined is NOT "pruned".
    expect(buildRollbackDataRiskLine({ backupFile: "b.tar.gz" }, kNow)).toBe(
      buildRollbackDataRiskLine("b.tar.gz"),
    );

    const pruned = buildRollbackDataRiskLine(
      {
        backupFile: "/backups/openclaw-backup-old.tar.gz",
        backupFileExists: false,
        newestSurvivingBackup: {
          file: "/backups/openclaw-backup-new.alphaclaw.tar.gz",
          at: kNow - 3 * 3_600_000,
          producer: "alphaclaw-offline-copy",
        },
      },
      kNow,
    );
    expect(pruned).toContain("the original pre-migration backup was pruned");
    expect(pruned).toContain(
      "The newest surviving archive is /backups/openclaw-backup-new.alphaclaw.tar.gz (offline copy, 3 hours ago)",
    );
    expect(pruned).toContain("it may not predate the migration, so check its date before restoring");

    const prunedNoSurvivor = buildRollbackDataRiskLine(
      { backupFile: "/backups/old.tar.gz", backupFileExists: false, newestSurvivingBackup: null },
      kNow,
    );
    expect(prunedNoSurvivor).toContain("no other archive survives");

    const partial = buildRollbackDataRiskLine(
      { backupFile: "b.tar.gz", backupFileExists: true, backupPartial: true },
      kNow,
    );
    expect(partial).toContain("Note: workspace files were excluded from it.");

    const reused = buildRollbackDataRiskLine(
      {
        backupFile: "b.tar.gz",
        backupFileExists: true,
        backupReused: true,
        reusedAgeMs: 2 * 3_600_000,
      },
      kNow,
    );
    expect(reused).toContain(
      "it was taken 2 hours before this update — state written since is not in it",
    );

    // Both caveats join with "; " inside one Note.
    const both = buildRollbackDataRiskLine(
      {
        backupFile: "b.tar.gz",
        backupFileExists: true,
        backupPartial: true,
        backupReused: true,
        reusedAgeMs: 90_000,
      },
      kNow,
    );
    expect(both).toContain(
      "Note: workspace files were excluded from it; it was taken 1 minute before this update — state written since is not in it.",
    );
  });
});

describe("frontend/upgrade-helpers backup reuse consent (WI-4.4/4.5)", () => {
  const kNow = Date.parse("2026-09-02T12:00:00.000Z");
  const kSha = "a".repeat(64);
  const makeEntry = (overrides = {}) => ({
    file: "/backups/openclaw-backup-2026-09-02T09-00-00.tar.gz",
    name: "openclaw-backup-2026-09-02T09-00-00.tar.gz",
    producer: "openclaw",
    sizeBytes: 12_345_678,
    mtimeMs: kNow - 3 * 3_600_000,
    at: kNow - 3 * 3_600_000,
    verified: true,
    partial: false,
    reused: false,
    exists: true,
    operationId: "op-1",
    eligible: true,
    ineligibleReason: null,
    sha256: kSha,
    ...overrides,
  });

  it("downgrades carry the hard-gate and pause notes even within one channel (issue #54)", async () => {
    const { buildApplyConfirmModel, kBackupHardGateNote, kBackupPauseNote } =
      await loadUpgradeHelpers();
    const model = buildApplyConfirmModel({
      payload: { channel: "stable", version: "2026.8.2" },
      label: "2026.8.2",
      isDowngrade: true,
      currentChannel: "stable",
    });
    expect(model.isBreaking).toBe(false);
    expect(model.hardGate).toBe(true);
    const gateIndex = model.lines.indexOf(kBackupHardGateNote);
    expect(gateIndex).toBeGreaterThan(-1);
    expect(model.lines[gateIndex + 1]).toBe(kBackupPauseNote);
    // The two notes are the last TEXT lines; the consent checkbox follows.
    expect(model.lines[model.lines.length - 1]).toBe(kBackupPauseNote);
    expect(model.backupReuse).toEqual(
      expect.objectContaining({ available: false, reason: "No eligible backup to reuse" }),
    );
  });

  it("dev switches are hard-gated too; routine same-channel upgrades carry no consent line", async () => {
    const { buildApplyConfirmModel } = await loadUpgradeHelpers();
    const dev = buildApplyConfirmModel({
      payload: { channel: "dev", devHead: true },
      label: "latest dev (main HEAD)",
      currentChannel: "dev",
    });
    expect(dev.hardGate).toBe(true);
    expect(dev.backupReuse).not.toBeNull();

    const routine = buildApplyConfirmModel({
      payload: { channel: "stable", version: "2026.7.2" },
      label: "2026.7.2",
      currentChannel: "stable",
    });
    expect(routine.hardGate).toBe(false);
    expect(routine.backupReuse).toBeNull();
  });

  it("binds consent to the NEWEST eligible archive's sha256 with the loss-window sentence", async () => {
    const { buildBackupReuseConsentModel, buildBackupReuseConsent } =
      await loadUpgradeHelpers();
    const older = makeEntry({
      file: "/backups/older.tar.gz",
      name: "older.tar.gz",
      at: kNow - 26 * 3_600_000,
      sha256: "b".repeat(64),
    });
    // Sorted oldest-first on purpose: selection is by `at`, not position.
    const model = buildBackupReuseConsentModel({
      inventory: { entries: [older, makeEntry()] },
      nowMs: kNow,
    });
    expect(model.available).toBe(true);
    expect(model.sha256).toBe(kSha);
    expect(model.name).toBe("openclaw-backup-2026-09-02T09-00-00.tar.gz");
    expect(model.producerLabel).toBe("upstream");
    expect(model.lossWindowLine).toBe(
      "Taken 3 hours ago — state written since would not be in it.",
    );
    // The payload carries the digest ONLY — never a path or name.
    expect(buildBackupReuseConsent({ consentModel: model, checked: true })).toEqual({
      sha256: kSha,
    });
    expect(buildBackupReuseConsent({ consentModel: model, checked: false })).toBeNull();
  });

  it("skips partial, unverified, missing and ineligible entries; no candidate → disabled with the reason", async () => {
    const { buildBackupReuseConsentModel, buildBackupReuseConsent } =
      await loadUpgradeHelpers();
    const model = buildBackupReuseConsentModel({
      inventory: {
        entries: [
          makeEntry({ partial: true, eligible: false, ineligibleReason: "partial" }),
          makeEntry({ verified: false, eligible: false, ineligibleReason: "unverified" }),
          makeEntry({ exists: false, eligible: false, ineligibleReason: "missing" }),
          makeEntry({ eligible: false, ineligibleReason: "no_provenance" }),
        ],
      },
      nowMs: kNow,
    });
    expect(model).toEqual(
      expect.objectContaining({
        available: false,
        sha256: null,
        reason: "No eligible backup to reuse",
      }),
    );
    // Checked-but-unavailable never sends consent.
    expect(buildBackupReuseConsent({ consentModel: model, checked: true })).toBeNull();
    expect(
      buildBackupReuseConsentModel({ inventory: null, nowMs: kNow }).reason,
    ).toBe("No eligible backup to reuse");
  });

  it("R7: an archive older than 24 h is never offered for consent — disabled with the stale reason", async () => {
    const {
      buildBackupReuseConsentModel,
      buildBackupReuseConsent,
      kBackupReuseMaxAgeMs,
      kBackupReuseStaleReason,
    } = await loadUpgradeHelpers();
    expect(kBackupReuseMaxAgeMs).toBe(24 * 60 * 60 * 1000);
    const tooOld = makeEntry({ at: kNow - kBackupReuseMaxAgeMs - 1 });
    const model = buildBackupReuseConsentModel({
      inventory: { entries: [tooOld] },
      nowMs: kNow,
    });
    expect(model).toEqual(
      expect.objectContaining({ available: false, sha256: null, reason: kBackupReuseStaleReason }),
    );
    expect(buildBackupReuseConsent({ consentModel: model, checked: true })).toBeNull();
    // Exactly at the boundary the server still accepts it (<=), so do we.
    const atBoundary = buildBackupReuseConsentModel({
      inventory: { entries: [makeEntry({ at: kNow - kBackupReuseMaxAgeMs })] },
      nowMs: kNow,
    });
    expect(atBoundary.available).toBe(true);
    // Fresh AND stale archives: the stale one never wins even when newer-looking
    // entries are absent — selection runs on the survivors only.
    const mixed = buildBackupReuseConsentModel({
      inventory: {
        entries: [
          makeEntry({ at: kNow - 26 * 3_600_000, sha256: "b".repeat(64) }),
          makeEntry({ at: kNow - 3 * 3_600_000 }),
        ],
      },
      nowMs: kNow,
    });
    expect(mixed.sha256).toBe(kSha);
  });

  it("R7: an archive that predates the last successful apply / migration / run is never offered", async () => {
    const {
      buildBackupReuseConsentModel,
      buildBackupReuseWindowStartMs,
      kBackupReuseStaleReason,
    } = await loadUpgradeHelpers();
    const archiveAt = kNow - 3 * 3_600_000;
    const entry = makeEntry({ at: archiveAt });
    const laterAt = archiveAt + 60_000;
    const earlierAt = archiveAt - 60_000;

    // No channel info at all: the window is unbounded below (server: since=0).
    expect(buildBackupReuseWindowStartMs(null)).toBe(0);
    expect(
      buildBackupReuseConsentModel({ inventory: { entries: [entry] }, channelInfo: null, nowMs: kNow })
        .available,
    ).toBe(true);

    // Each of the server's three records bounds the window on its own.
    const cases = [
      { applied: { channel: "stable", version: "2026.8.2", at: laterAt } },
      { lastUpdateRun: { operationId: "op-9", ok: true, startedAt: laterAt } },
      { configMigration: { lastAttempt: { ok: true, at: laterAt } } },
    ];
    for (const channelInfo of cases) {
      expect(buildBackupReuseWindowStartMs(channelInfo)).toBe(laterAt);
      const model = buildBackupReuseConsentModel({
        inventory: { entries: [entry] },
        channelInfo,
        nowMs: kNow,
      });
      expect(model).toEqual(
        expect.objectContaining({ available: false, sha256: null, reason: kBackupReuseStaleReason }),
      );
    }

    // FAILED runs / migrations do not move the window (server: ok gates both),
    // and an archive taken AT the boundary is still accepted (>=).
    const failed = {
      applied: { at: earlierAt },
      lastUpdateRun: { operationId: "op-9", ok: false, startedAt: laterAt },
      configMigration: { lastAttempt: { ok: false, at: laterAt } },
    };
    expect(buildBackupReuseWindowStartMs(failed)).toBe(earlierAt);
    expect(
      buildBackupReuseConsentModel({ inventory: { entries: [entry] }, channelInfo: failed, nowMs: kNow })
        .available,
    ).toBe(true);
    expect(
      buildBackupReuseConsentModel({
        inventory: { entries: [entry] },
        channelInfo: { applied: { at: archiveAt } },
        nowMs: kNow,
      }).available,
    ).toBe(true);
    // The newest record wins (max), whichever field carries it; ISO strings
    // are accepted like the rest of the channel payload.
    expect(
      buildBackupReuseWindowStartMs({
        applied: { at: earlierAt },
        lastUpdateRun: { ok: true, startedAt: new Date(laterAt).toISOString() },
      }),
    ).toBe(laterAt);
  });

  it("R7: buildApplyConfirmModel threads channelInfo into the consent candidate", async () => {
    const { buildApplyConfirmModel, kBackupReuseStaleReason } = await loadUpgradeHelpers();
    const inventory = { entries: [makeEntry({ at: kNow - 3 * 3_600_000 })] };
    const without = buildApplyConfirmModel({
      payload: { channel: "stable", version: "2026.8.2" },
      label: "2026.8.2",
      isDowngrade: true,
      currentChannel: "stable",
      backupInventory: inventory,
      nowMs: kNow,
    });
    expect(without.backupReuse.available).toBe(true);
    const gated = buildApplyConfirmModel({
      payload: { channel: "stable", version: "2026.8.2" },
      label: "2026.8.2",
      isDowngrade: true,
      currentChannel: "stable",
      backupInventory: inventory,
      channelInfo: { applied: { channel: "stable", version: "2026.9.1", at: kNow - 3_600_000 } },
      nowMs: kNow,
    });
    expect(gated.backupReuse).toEqual(
      expect.objectContaining({ available: false, reason: kBackupReuseStaleReason }),
    );
  });

  it("an eligible archive without a recorded digest cannot bind consent — says so, never sends", async () => {
    const { buildBackupReuseConsentModel, buildBackupReuseConsent, kBackupReuseNoDigestReason } =
      await loadUpgradeHelpers();
    const model = buildBackupReuseConsentModel({
      inventory: { entries: [makeEntry({ sha256: null })] },
      nowMs: kNow,
    });
    expect(model.available).toBe(false);
    expect(model.reason).toBe(kBackupReuseNoDigestReason);
    // The loss window still renders so the operator knows what exists.
    expect(model.lossWindowLine).toContain("3 hours ago");
    expect(buildBackupReuseConsent({ consentModel: model, checked: true })).toBeNull();
    // A malformed digest is treated like no digest.
    expect(
      buildBackupReuseConsentModel({
        inventory: { entries: [makeEntry({ sha256: "not-hex" })] },
        nowMs: kNow,
      }).available,
    ).toBe(false);
  });

  it("builds the retry offer from a 409 backup_failed reusableBackup — sha256-bound, age-labelled", async () => {
    const { buildBackupReuseOfferModel } = await loadUpgradeHelpers();
    const error = Object.assign(new Error("Backup failed (lock_contention)"), {
      code: "backup_failed",
      reusableBackup: {
        file: "/backups/openclaw-backup-x.alphaclaw.tar.gz",
        at: kNow - 2 * 3_600_000,
        ageMs: 2 * 3_600_000,
        sha256: kSha,
        producer: "alphaclaw-offline-copy",
      },
    });
    const offer = buildBackupReuseOfferModel({
      error,
      target: { channel: "stable", version: "2026.8.2" },
      label: "2026.8.2",
      nowMs: kNow,
    });
    expect(offer).toEqual(
      expect.objectContaining({
        sha256: kSha,
        file: "/backups/openclaw-backup-x.alphaclaw.tar.gz",
        name: "openclaw-backup-x.alphaclaw.tar.gz",
        producerLabel: "offline copy",
        ageLabel: "2 hours ago",
        label: "2026.8.2",
        target: { channel: "stable", version: "2026.8.2" },
        ctaLabel: "Retry using the backup taken 2 hours ago",
      }),
    );
    expect(offer.lossWindowLine).toBe(
      "That backup was taken 2 hours ago — state written since would not be in it.",
    );

    // Age falls back to `at` when ageMs is absent.
    expect(
      buildBackupReuseOfferModel({
        error: {
          code: "backup_failed",
          reusableBackup: { file: "/b.tar.gz", at: kNow - 60_000, sha256: kSha },
        },
        target: { channel: "stable", version: "2026.8.2" },
        nowMs: kNow,
      }).ageLabel,
    ).toBe("1 minute ago");
  });

  it("offers nothing for other codes, a missing offer, or a malformed digest", async () => {
    const { buildBackupReuseOfferModel } = await loadUpgradeHelpers();
    const reusableBackup = { file: "/b.tar.gz", at: kNow, ageMs: 0, sha256: kSha };
    expect(
      buildBackupReuseOfferModel({ error: { code: "enospc", reusableBackup }, nowMs: kNow }),
    ).toBeNull();
    expect(
      buildBackupReuseOfferModel({ error: { code: "backup_failed" }, nowMs: kNow }),
    ).toBeNull();
    expect(
      buildBackupReuseOfferModel({
        error: { code: "backup_failed", reusableBackup: { ...reusableBackup, sha256: "abc" } },
        nowMs: kNow,
      }),
    ).toBeNull();
    expect(buildBackupReuseOfferModel({ error: null })).toBeNull();
  });

  it("builds inventory rows: age · size · producer · self-standing badges, newest highlighted", async () => {
    const { buildBackupInventoryRows } = await loadUpgradeHelpers();
    const rows = buildBackupInventoryRows(
      {
        entries: [
          makeEntry(),
          makeEntry({
            file: "/backups/openclaw-backup-offline.alphaclaw.tar.gz",
            name: "openclaw-backup-offline.alphaclaw.tar.gz",
            producer: "alphaclaw-offline-copy",
            at: kNow - 30 * 60_000,
            partial: true,
            eligible: false,
            ineligibleReason: "partial",
            sizeBytes: 512,
          }),
          makeEntry({
            file: "/backups/openclaw-backup-gone.tar.gz",
            name: "openclaw-backup-gone.tar.gz",
            exists: false,
            sizeBytes: null,
            at: kNow - 48 * 3_600_000,
            eligible: false,
            ineligibleReason: "missing",
          }),
          makeEntry({
            file: "/backups/openclaw-backup-stray.tar.gz",
            name: "openclaw-backup-stray.tar.gz",
            verified: false,
            at: kNow - 7 * 24 * 3_600_000,
            eligible: false,
            ineligibleReason: "no_provenance",
            reused: true,
          }),
        ],
      },
      kNow,
    );
    expect(rows.map((row) => row.name)).toEqual([
      "openclaw-backup-2026-09-02T09-00-00.tar.gz",
      "openclaw-backup-offline.alphaclaw.tar.gz",
      "openclaw-backup-gone.tar.gz",
      "openclaw-backup-stray.tar.gz",
    ]);
    // Newest ON DISK (by `at`) is the offline copy taken 30 min ago — not
    // list position, and never a missing archive.
    expect(rows.map((row) => row.newest)).toEqual([false, true, false, false]);
    expect(rows[0]).toEqual(
      expect.objectContaining({
        ageLabel: "3 hours ago",
        sizeLabel: "11.8 MB",
        producerLabel: "upstream",
        producerTone: "neutral",
        missing: false,
      }),
    );
    expect(rows[0].badges).toEqual([{ id: "verified", label: "verified", tone: "success" }]);
    expect(rows[1]).toEqual(
      expect.objectContaining({ producerLabel: "offline copy", producerTone: "cyan", sizeLabel: "512 B" }),
    );
    // Partial carries its own badge (reason visible) and is not repeated as
    // a second "not reusable" chip.
    expect(rows[1].badges.map((badge) => badge.label)).toEqual([
      "verified",
      "partial — workspace files excluded",
    ]);
    expect(rows[2]).toEqual(expect.objectContaining({ missing: true, sizeLabel: "—" }));
    expect(rows[2].badges.map((badge) => badge.label)).toEqual([
      "verified",
      "missing — no longer on disk",
    ]);
    expect(rows[3].badges).toEqual([
      { id: "unverified", label: "unverified", tone: "warning" },
      { id: "reused", label: "reused for a later update", tone: "info" },
      { id: "ineligible", label: "not reusable — no run record for it", tone: "warning" },
    ]);
    expect(buildBackupInventoryRows(null, kNow)).toEqual([]);
  });
});

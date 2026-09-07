// boot-report.json server phase (#76 A1 / A7 / CEO 8.1): the injected boot
// steps merge the state-DB / schema / config facts into the report the bin
// phase wrote (fixture), compute the verdict, pin the incident report, notify
// on INCONSISTENT and replay ONE `boot` watchdog event through the wrapped
// sink. Hermetic: real writer over a temp managed dir, fake channel service.
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  kBootVerdicts,
  kServerPhaseStatuses,
  kBinPhaseStatuses,
  buildBinPhaseReport,
  createBootReportWriter,
} = require("../../lib/server/boot-report");
const {
  kBootWatchdogEventType,
  kBootWatchdogEventSource,
  kNotOnboardedReason,
  createBootReportSteps,
} = require("../../lib/server/boot-report-steps");
const { kSqliteEra, kFileEra, kIndeterminate } = require("../../lib/server/openclaw-state-era");
const { utcDayBucket } = require("../../lib/server/notification-policy");

const kBootId = "40:1700000000000";
const kNow = 1_700_000_000_000;
const mkTemp = () => fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-boot-steps-"));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const silent = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

// The bin-phase report the way bin/alphaclaw.js leaves it after syncAtBoot.
// Like the sync, the fixture records the canonical installedDiverged predicate
// over resolvedForLaunch whenever both sides are known (no pinLag here); an
// explicit `installedDiverged` in `openclaw` overrides it.
const binReport = (openclaw = {}, extra = {}) => {
  const versions = { expected: "2026.9.2", installedAtBoot: "2026.9.2", resolvedForLaunch: "2026.9.2", ...openclaw };
  return buildBinPhaseReport({
    bootId: kBootId,
    at: kNow - 10_000,
    alphaclaw: { version: "0.9.77", commit: "abc123", previousVersion: "0.9.76", firstBootOfVersion: true },
    container: { pid1StartTicks: 3431, startMs: kNow - 20_000 },
    pidDecision: {
      evidence: null,
      decision: "proceed",
      reason: "absent",
      record: { raw: null, format: null, legacyClaim: false },
    },
    openclaw: {
      declaredPin: "2026.9.2",
      channelApplied: null,
      lastKnownGood: null,
      installedDiverged:
        versions.expected && versions.resolvedForLaunch ? versions.resolvedForLaunch !== versions.expected : null,
      overlayPresent: false,
      overlayComplete: false,
      sentinelMatches: true,
      ...versions,
    },
    bootSync: { action: "none", reason: null, warnings: [] },
    ...extra,
  });
};

const kSchema = {
  installedVersion: "2026.9.2",
  packageDir: "/app/node_modules/openclaw",
  stateDb: [
    { path: "/data/.openclaw/state/openclaw.sqlite", kind: "state", agentId: null, userVersion: 15, status: "ok" },
    { path: "/data/.openclaw/agents/main/agent/openclaw-agent.sqlite", kind: "agent", agentId: "main", userVersion: 19, status: "ok" },
  ],
  supportedSchema: { state: 15, agent: 19, source: { state: "declared", agent: "declared" } },
};

const createFixture = ({
  withBinPhase = true,
  openclaw = {},
  binExtra = {},
  schema = kSchema,
  channelInfo = { installedVersion: "2026.9.2", expectedVersion: "2026.9.2", installedDiverged: false },
  lastRestore = null,
  config = { agents: { list: [] }, meta: { lastTouchedVersion: "2026.9.2" } },
  legacyApprovalsFile = false,
  eraHint = kSqliteEra,
  withWriter = true,
  withWatchdogVerdict = true,
  notify = vi.fn(async () => ({ ok: true })),
} = {}) => {
  const root = mkTemp();
  const openclawDir = path.join(root, ".openclaw");
  const managedDir = path.join(openclawDir, ".alphaclaw");
  fs.mkdirSync(managedDir, { recursive: true });
  if (config) {
    fs.writeFileSync(path.join(openclawDir, "openclaw.json"), `${JSON.stringify(config, null, 2)}\n`);
  }
  if (legacyApprovalsFile) {
    fs.writeFileSync(path.join(openclawDir, "exec-approvals.json"), '{"version":1}\n');
  }
  const logger = silent();
  const bootReport = withWriter
    ? createBootReportWriter({ managedDir, bootId: kBootId, nowFn: () => kNow, logger })
    : null;
  if (withBinPhase && bootReport) bootReport.writeBinPhase(binReport(openclaw, binExtra));
  const service = {
    closeDanglingRecordsAtBoot: vi.fn(() => ({
      closedRuns: ["11111111-2222-4333-8444-555555555555"],
      closedLastUpdateRun: true,
      warnings: ["closed an update run interrupted by a restart"],
    })),
    describeStateDbSchema: vi.fn(async () => schema),
    postBootWebhook: vi.fn(),
    getChannelInfo: vi.fn(() => channelInfo),
    store: { readState: () => ({ configMigration: { lastRestore } }) },
  };
  const restartRequiredState = { reconcileOnBoot: vi.fn() };
  const insertWatchdogEvent = vi.fn();
  const watchdog = withWatchdogVerdict ? { setBootVerdict: vi.fn() } : {};
  const steps = createBootReportSteps({
    bootReport,
    openclawChannelService: service,
    restartRequiredState,
    insertWatchdogEvent,
    getWatchdog: () => watchdog,
    notify,
    openclawDir,
    readOpenclawConfig: require("../../lib/server/openclaw-config").readOpenclawConfig,
    resolveEraHint: vi.fn(async () => ({ hint: eraHint, signal: "gate" })),
    nowFn: () => kNow,
    logger,
  });
  return { steps, bootReport, service, restartRequiredState, insertWatchdogEvent, watchdog, notify, logger, openclawDir, managedDir };
};

const bootEvents = (insertWatchdogEvent) =>
  insertWatchdogEvent.mock.calls.map((call) => call[0]).filter((event) => event.eventType === kBootWatchdogEventType);

describe("boot-report-steps: closers", () => {
  it("closeDanglingRecordsAtBoot delegates to the channel service and logs what it closed; reconcileRestartOperationAtBoot calls reconcileOnBoot", () => {
    const { steps, service, restartRequiredState, logger } = createFixture();
    const result = steps.closeDanglingRecordsAtBoot();
    expect(service.closeDanglingRecordsAtBoot).toHaveBeenCalledTimes(1);
    expect(result.closedLastUpdateRun).toBe(true);
    expect(logger.log).toHaveBeenCalledWith(
      "[boot-report] closed dangling records at boot: runs [11111111-2222-4333-8444-555555555555] + lastUpdateRun",
    );
    steps.reconcileRestartOperationAtBoot();
    expect(restartRequiredState.reconcileOnBoot).toHaveBeenCalledTimes(1);
  });

  it("a service without the closer (older wiring) is a no-op, never a throw", () => {
    const { steps } = createFixture();
    const bare = createBootReportSteps({ openclawChannelService: {}, logger: silent() });
    expect(bare.closeDanglingRecordsAtBoot()).toBeNull();
    expect(() => bare.reconcileRestartOperationAtBoot()).not.toThrow();
    expect(steps.closeDanglingRecordsAtBoot()).not.toBeNull();
  });
});

describe("boot-report-steps: recordBootReportServerPhase", () => {
  it("merges stateDb, supportedSchema, config { sha256, lastTouchedVersion }, the channelInfo snapshot, legacyExecApprovalsPresent and the closer summary into the bin phase's report", async () => {
    const { steps, bootReport, openclawDir } = createFixture();
    steps.closeDanglingRecordsAtBoot();

    const merged = await steps.recordBootReportServerPhase();

    expect(merged).toEqual(readJson(bootReport.reportPath));
    // Bin half intact, status recorded, verdict derived (consistent).
    expect(merged.bootId).toBe(kBootId);
    expect(merged.binPhase).toEqual({ status: kBinPhaseStatuses.ok });
    expect(merged.openclaw.installedAtBoot).toBe("2026.9.2");
    const expectedSha = require("crypto")
      .createHash("sha256")
      .update(fs.readFileSync(path.join(openclawDir, "openclaw.json")))
      .digest("hex");
    expect(merged.serverPhase).toEqual({
      status: kServerPhaseStatuses.recorded,
      at: kNow,
      installedVersion: "2026.9.2",
      stateDb: kSchema.stateDb,
      supportedSchema: kSchema.supportedSchema,
      config: { sha256: expectedSha, lastTouchedVersion: "2026.9.2" },
      channelInfo: { installedVersion: "2026.9.2", expectedVersion: "2026.9.2", installedDiverged: false },
      legacyExecApprovalsPresent: false,
      danglingRecords: { closedRuns: ["11111111-2222-4333-8444-555555555555"], closedLastUpdateRun: true },
      verdict: [],
    });
  });

  it("serverPhase.danglingRecords is the UNION of the bin phase's closures and the server phase's (#76 A7: the bin-phase syncAtBoot closes first, so the server closer normally finds nothing)", async () => {
    const binClosed = "0f76b007-e2e0-4c0d-9a1e-000000000076";
    const { steps, service, bootReport } = createFixture({
      binExtra: {
        bootSync: {
          action: "none",
          reason: null,
          warnings: [],
          danglingRecords: { closedRuns: [binClosed], closedLastUpdateRun: false },
        },
      },
    });
    // The server-phase closer finds nothing left (the incident shape).
    service.closeDanglingRecordsAtBoot.mockImplementation(() => ({ closedRuns: [], closedLastUpdateRun: false, warnings: [] }));
    steps.closeDanglingRecordsAtBoot();
    const report = await steps.recordBootReportServerPhase();
    expect(report.serverPhase.danglingRecords).toEqual({ closedRuns: [binClosed], closedLastUpdateRun: false });
    expect(bootReport.readOwnReport().serverPhase.danglingRecords.closedRuns).toEqual([binClosed]);

    // Both phases closed something: ids are unioned (bin first, de-duplicated) and the flag ORed.
    service.closeDanglingRecordsAtBoot.mockImplementation(() => ({
      closedRuns: [binClosed, "11111111-2222-4333-8444-555555555555"],
      closedLastUpdateRun: true,
      warnings: [],
    }));
    steps.closeDanglingRecordsAtBoot();
    expect((await steps.recordBootReportServerPhase()).serverPhase.danglingRecords).toEqual({
      closedRuns: [binClosed, "11111111-2222-4333-8444-555555555555"],
      closedLastUpdateRun: true,
    });
  });

  it("with no bin-phase file the server phase's own closures are reported alone; a null-shaped bin bootSync never throws", async () => {
    const { steps } = createFixture({ withBinPhase: false });
    steps.closeDanglingRecordsAtBoot();
    expect((await steps.recordBootReportServerPhase()).serverPhase.danglingRecords).toEqual({
      closedRuns: ["11111111-2222-4333-8444-555555555555"],
      closedLastUpdateRun: true,
    });
  });

  it("the channelInfo snapshot is null-shaped when the service has no channel info (never a throw)", async () => {
    const { steps, service } = createFixture({ channelInfo: null });
    expect((await steps.recordBootReportServerPhase()).serverPhase.channelInfo).toBeNull();
    service.getChannelInfo.mockImplementation(() => {
      throw new Error("store unreadable");
    });
    expect((await steps.recordBootReportServerPhase()).serverPhase.channelInfo).toBeNull();
    service.getChannelInfo.mockImplementation(() => ({ installedVersion: "", expectedVersion: "2026.9.2", installedDiverged: "yes" }));
    expect((await steps.recordBootReportServerPhase()).serverPhase.channelInfo).toEqual({
      installedVersion: null,
      expectedVersion: "2026.9.2",
      installedDiverged: null,
    });
  });

  it("legacyExecApprovalsPresent: true on a sqlite-era box with the file, false on a file-era box, null when the era is indeterminate, false with no file", async () => {
    const cases = [
      [{ legacyApprovalsFile: true, eraHint: kSqliteEra }, true],
      [{ legacyApprovalsFile: true, eraHint: kFileEra }, false],
      [{ legacyApprovalsFile: true, eraHint: kIndeterminate }, null],
      [{ legacyApprovalsFile: false, eraHint: kSqliteEra }, false],
    ];
    for (const [options, expected] of cases) {
      const { steps } = createFixture(options);
      const merged = await steps.recordBootReportServerPhase();
      expect(merged.serverPhase.legacyExecApprovalsPresent).toBe(expected);
      expect(merged.serverPhase.verdict.includes(kBootVerdicts.legacyExecApprovalsPresent)).toBe(expected === true);
    }
  });

  it("a missing openclaw.json reads as sha256 null / lastTouchedVersion null without a warning; a missing bin phase creates the report (binPhase missing)", async () => {
    const { steps, bootReport, logger } = createFixture({ config: null, withBinPhase: false });
    const merged = await steps.recordBootReportServerPhase();
    expect(merged.serverPhase.config).toEqual({ sha256: null, lastTouchedVersion: null });
    expect(merged.binPhase).toEqual({ status: kBinPhaseStatuses.missing });
    expect(merged.openclaw).toBeNull();
    expect(readJson(bootReport.reportPath).serverPhase.status).toBe(kServerPhaseStatuses.recorded);
    // Only the writer's own "missing bin phase" warning, nothing about the config.
    expect(logger.warn.mock.calls.every((call) => !String(call[0]).includes("openclaw.json"))).toBe(true);
  });

  it("an onboarding-completed boot overrules the listening hook's not_reached marker with an explicit `recorded`", async () => {
    const { steps, bootReport } = createFixture();
    steps.onListeningNotOnboarded();
    expect(readJson(bootReport.reportPath).serverPhase).toEqual({
      status: kServerPhaseStatuses.notReached,
      reason: kNotOnboardedReason,
      at: kNow,
      verdict: [],
    });
    const merged = await steps.recordBootReportServerPhase();
    expect(merged.serverPhase.status).toBe(kServerPhaseStatuses.recorded);
    expect(merged.serverPhase.reason).toBe(kNotOnboardedReason);
  });

  it("with no writer every report step is a null no-op (the closers still run)", async () => {
    const { steps, service, insertWatchdogEvent } = createFixture({ withWriter: false });
    expect(await steps.recordBootReportServerPhase()).toBeNull();
    expect(await steps.finalizeBootReport({ reconcile: { status: "ok" } })).toBeNull();
    expect(steps.onListeningNotOnboarded()).toBeNull();
    expect(service.closeDanglingRecordsAtBoot).toHaveBeenCalledTimes(1);
    expect(insertWatchdogEvent).not.toHaveBeenCalled();
  });
});

describe("boot-report-steps: finalizeBootReport", () => {
  it("a consistent boot: logs `[boot-report] consistent`, threads the reconcile outcome + config gate facts, pins nothing, notifies nobody, replays exactly ONE ok `boot` event with the documented details, hands the report to watchdog.setBootVerdict", async () => {
    const { steps, bootReport, service, insertWatchdogEvent, watchdog, notify, logger } = createFixture();
    await steps.recordBootReportServerPhase();

    const outcome = await steps.finalizeBootReport({
      reconcile: { status: "ok", reason: "already-completed", warnings: [] },
      compat: null,
      gatewayHeld: false,
    });

    expect(outcome).toEqual(
      expect.objectContaining({ verdict: [], inconsistent: false, pinned: false }),
    );
    const report = readJson(bootReport.reportPath);
    expect(report.serverPhase).toEqual(
      expect.objectContaining({
        status: kServerPhaseStatuses.recorded,
        reconcile: { status: "ok", reason: "already-completed", hold: null },
        compat: null,
        gatewayHeld: false,
        config: expect.objectContaining({
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          sha256AfterReconcile: expect.stringMatching(/^[0-9a-f]{64}$/),
          lastTouchedVersion: "2026.9.2",
          migrationGate: { status: "ok", reason: "already-completed", hold: null },
          restoredFrom: null,
        }),
        // The record step's facts survive the finalize merge.
        stateDb: kSchema.stateDb,
        verdict: [],
      }),
    );
    expect(logger.log).toHaveBeenCalledWith("[boot-report] consistent");
    expect(logger.error).not.toHaveBeenCalled();
    expect(fs.existsSync(bootReport.incidentPath)).toBe(false);
    expect(service.postBootWebhook).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(bootEvents(insertWatchdogEvent)).toEqual([
      {
        eventType: kBootWatchdogEventType,
        source: kBootWatchdogEventSource,
        status: "ok",
        details: {
          bootId: kBootId,
          verdict: [],
          pidfile: { decision: "proceed", reason: "absent" },
          installed: "2026.9.2",
          expected: "2026.9.2",
        },
        correlationId: "",
      },
    ]);
    expect(watchdog.setBootVerdict).toHaveBeenCalledTimes(1);
    expect(watchdog.setBootVerdict).toHaveBeenCalledWith(report);
  });

  it("an INCONSISTENT boot (installed ≠ expected, legacy approvals): 🔴 error line, pinned incident report, pre-outbox webhook + ONE day-bucketed notification, ONE failed `boot` event naming the verdict", async () => {
    const { steps, bootReport, service, insertWatchdogEvent, notify, logger } = createFixture({
      openclaw: { installedAtBoot: "2026.7.1-2", expected: "2026.8.1", resolvedForLaunch: "2026.7.1-2" },
      legacyApprovalsFile: true,
      lastRestore: {
        at: kNow - 1000,
        from: "2026.8.1",
        source: "lastTransition",
        preRestorePath: "/data/.openclaw/openclaw.json.pre-restore-1.bak",
        bootId: kBootId,
      },
    });
    await steps.recordBootReportServerPhase();

    const outcome = await steps.finalizeBootReport({
      reconcile: { status: "ok", reason: "round-trip-restore", intent: "lastTransition" },
    });

    const verdict = [kBootVerdicts.installedNotExpected, kBootVerdicts.legacyExecApprovalsPresent];
    expect(outcome).toEqual(expect.objectContaining({ verdict, inconsistent: true, pinned: true }));
    expect(logger.error).toHaveBeenCalledWith(
      `🔴 [boot-report] INCONSISTENT: installed_not_expected, legacy_exec_approvals_present (installed 2026.7.1-2, expected 2026.8.1) — see ${bootReport.reportPath}`,
    );
    const pinned = readJson(bootReport.incidentPath);
    expect(pinned.pinnedAt).toBe(kNow);
    expect(pinned.serverPhase.verdict).toEqual(verdict);
    // The file was still there at finalize: present, not reaped.
    expect(pinned.serverPhase).toEqual(
      expect.objectContaining({ legacyExecApprovalsPresent: true, legacyExecApprovalsReaped: false }),
    );
    expect(pinned.serverPhase.config.restoredFrom).toEqual({
      from: "2026.8.1",
      source: "lastTransition",
      preRestorePath: "/data/.openclaw/openclaw.json.pre-restore-1.bak",
    });
    const message =
      "🔴 AlphaClaw boot report INCONSISTENT — `installed_not_expected`, `legacy_exec_approvals_present`. OpenClaw installed 2026.7.1-2, expected 2026.8.1. Run `alphaclaw diagnose` or open the Upgrade page.";
    expect(service.postBootWebhook).toHaveBeenCalledWith(message);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(message, {
      eventType: "health",
      // Stable signature key + UTC day bucket: a boot loop dedupes into one
      // alert, a fresh episode weeks later re-fires.
      id: `boot-report-inconsistent-installed_not_expected+legacy_exec_approvals_present-2026.7.1-2-${utcDayBucket(kNow)}`,
    });
    expect(bootEvents(insertWatchdogEvent)).toEqual([
      expect.objectContaining({
        status: "failed",
        details: {
          bootId: kBootId,
          verdict,
          pidfile: { decision: "proceed", reason: "absent" },
          installed: "2026.7.1-2",
          expected: "2026.8.1",
        },
      }),
    ]);
  });

  it("an ACTIVATION boot (installedAtBoot ≠ expected, resolvedForLaunch = expected) is consistent: no verdict, no notification, the `boot` event names the running tree", async () => {
    // The e2e's activated-boot shape: the container woke up on the pin, the
    // sync activated the applied build. installedAtBoot stays in the report as
    // evidence; the verdict and the event judge what the gateway runs.
    const { steps, insertWatchdogEvent, watchdog, notify, service, logger } = createFixture({
      openclaw: {
        declaredPin: "2026.9.1",
        channelApplied: "beta:2026.9.2",
        expected: "2026.9.2",
        installedAtBoot: "2026.9.1",
        resolvedForLaunch: "2026.9.2",
        installedDiverged: false,
        overlayPresent: true,
        overlayComplete: true,
      },
    });
    await steps.recordBootReportServerPhase();
    const outcome = await steps.finalizeBootReport({ reconcile: { status: "ok" } });
    expect(outcome).toEqual(expect.objectContaining({ verdict: [], inconsistent: false, pinned: false }));
    expect(logger.log).toHaveBeenCalledWith("[boot-report] consistent");
    expect(logger.error).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(service.postBootWebhook).not.toHaveBeenCalled();
    expect(bootEvents(insertWatchdogEvent)).toEqual([
      expect.objectContaining({
        status: "ok",
        details: expect.objectContaining({ verdict: [], installed: "2026.9.2", expected: "2026.9.2" }),
      }),
    ]);
    // What the watchdog latches on is this verdict — empty, so no
    // version_mismatch for a healthy activation.
    expect(watchdog.setBootVerdict.mock.calls[0][0].serverPhase.verdict).toEqual([]);
    expect(watchdog.setBootVerdict.mock.calls[0][0].openclaw.installedAtBoot).toBe("2026.9.1");
  });

  it("a legacy exec-approvals.json reaped between the record step and finalize (ensureManagedExecDefaults) is a self-healed boot: consistent, `legacyExecApprovalsReaped: true`", async () => {
    const { steps, bootReport, openclawDir, insertWatchdogEvent, notify, service } = createFixture({
      legacyApprovalsFile: true,
      eraHint: kSqliteEra,
    });
    const recorded = await steps.recordBootReportServerPhase();
    // The record step saw the finding…
    expect(recorded.serverPhase.legacyExecApprovalsPresent).toBe(true);
    expect(recorded.serverPhase.verdict).toEqual([kBootVerdicts.legacyExecApprovalsPresent]);
    // …then the reaper renamed the file (exec-defaults-config reapStrayLegacyExecApprovals).
    fs.renameSync(path.join(openclawDir, "exec-approvals.json"), path.join(openclawDir, `exec-approvals.json.stray-${kNow}`));

    const outcome = await steps.finalizeBootReport({ reconcile: { status: "ok" } });

    expect(outcome).toEqual(expect.objectContaining({ verdict: [], inconsistent: false, pinned: false }));
    expect(readJson(bootReport.reportPath).serverPhase).toEqual(
      expect.objectContaining({ legacyExecApprovalsPresent: false, legacyExecApprovalsReaped: true, verdict: [] }),
    );
    expect(fs.existsSync(bootReport.incidentPath)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(service.postBootWebhook).not.toHaveBeenCalled();
    expect(bootEvents(insertWatchdogEvent)).toEqual([expect.objectContaining({ status: "ok", details: expect.objectContaining({ verdict: [] }) })]);
  });

  it("legacyExecApprovalsReaped is false unless the record step saw the sqlite-era finding (an indeterminate era that resolves is not a reap)", async () => {
    const { steps, bootReport, openclawDir } = createFixture({ legacyApprovalsFile: true, eraHint: kIndeterminate });
    expect((await steps.recordBootReportServerPhase()).serverPhase.legacyExecApprovalsPresent).toBeNull();
    fs.rmSync(path.join(openclawDir, "exec-approvals.json"));
    await steps.finalizeBootReport({ reconcile: { status: "ok" } });
    expect(readJson(bootReport.reportPath).serverPhase).toEqual(
      expect.objectContaining({ legacyExecApprovalsPresent: false, legacyExecApprovalsReaped: false }),
    );
  });

  it("a restore recorded by ANOTHER boot is not this boot's restoredFrom", async () => {
    const { steps, bootReport } = createFixture({
      lastRestore: { at: 1, from: "2026.8.1", source: "lastTransition", bootId: "7:1699999000000" },
    });
    await steps.recordBootReportServerPhase();
    await steps.finalizeBootReport({ reconcile: { status: "ok" } });
    expect(readJson(bootReport.reportPath).serverPhase.config.restoredFrom).toBeNull();
  });

  it("pidfile_contradiction: a bin phase that SKIPPED for a live owner yet reached the server phase is INCONSISTENT; the event carries the pidfile decision", async () => {
    const skipDecision = {
      evidence: { pid: 21, corroborated: false },
      decision: "skip",
      reason: "legacy_argv_match",
      record: { raw: { pid: 21, at: 1 }, format: "legacy", legacyClaim: true },
    };
    const { steps, bootReport, insertWatchdogEvent } = createFixture();
    // The bin phase this boot wrote skipped the sync on a live-owner claim.
    bootReport.writeBinPhase(
      binReport({}, {
        pidDecision: skipDecision,
        bootSync: { action: "skipped_concurrent", reason: "pid_live", warnings: [] },
      }),
    );
    await steps.recordBootReportServerPhase();
    const outcome = await steps.finalizeBootReport({ reconcile: { status: "ok" } });
    expect(outcome.verdict).toEqual([kBootVerdicts.pidfileContradiction]);
    expect(bootEvents(insertWatchdogEvent)[0].details.pidfile).toEqual({
      decision: "skip",
      reason: "legacy_argv_match",
    });
  });

  it("a held or erroring reconcile is recorded verbatim ({ status, reason, hold }) and the compat verdict rides along", async () => {
    const { steps, bootReport } = createFixture();
    await steps.recordBootReportServerPhase();
    await steps.finalizeBootReport({
      reconcile: { status: "held", hold: { reason: "settings migration for 2026.9.2 failed: doctor exit 1" } },
      compat: { compatible: false, hold: { reason: "version_mismatch" } },
      gatewayHeld: true,
    });
    const server = readJson(bootReport.reportPath).serverPhase;
    expect(server.reconcile).toEqual({
      status: "held",
      reason: null,
      hold: "settings migration for 2026.9.2 failed: doctor exit 1",
    });
    expect(server.compat).toEqual({ compatible: false, hold: "version_mismatch" });
    expect(server.gatewayHeld).toBe(true);

    await steps.finalizeBootReport({ reconcile: { status: "error", reason: "reconcile machinery exploded" } });
    expect(readJson(bootReport.reportPath).serverPhase.reconcile).toEqual({
      status: "error",
      reason: "reconcile machinery exploded",
      hold: null,
    });
  });

  it("with no bin phase, a genuinely mismatched box is still INCONSISTENT: the channelInfo snapshot feeds the verdict, the failed `boot` event and the watchdog latch", async () => {
    const { steps, bootReport, insertWatchdogEvent, watchdog, notify } = createFixture({
      withBinPhase: false,
      schema: { ...kSchema, installedVersion: "2026.9.1" },
      channelInfo: { installedVersion: "2026.9.1", expectedVersion: "2026.9.2", installedDiverged: true },
    });
    await steps.recordBootReportServerPhase();
    const outcome = await steps.finalizeBootReport({ reconcile: null });
    expect(outcome).toEqual(expect.objectContaining({ verdict: [kBootVerdicts.installedNotExpected], inconsistent: true }));
    const report = readJson(bootReport.reportPath);
    expect(report.openclaw).toBeNull();
    expect(report.serverPhase.channelInfo).toEqual({ installedVersion: "2026.9.1", expectedVersion: "2026.9.2", installedDiverged: true });
    expect(bootEvents(insertWatchdogEvent)).toEqual([
      expect.objectContaining({
        status: "failed",
        details: expect.objectContaining({
          verdict: [kBootVerdicts.installedNotExpected],
          installed: "2026.9.1",
          expected: "2026.9.2",
          pidfile: { decision: null, reason: null },
        }),
      }),
    ]);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(watchdog.setBootVerdict).toHaveBeenCalledWith(report);
  });

  it("with no bin phase, a snapshot without the predicate compares versions; the live predicate excusing the pair (pinLag) keeps the boot consistent", async () => {
    const compared = createFixture({
      withBinPhase: false,
      schema: { ...kSchema, installedVersion: "2026.9.1" },
      channelInfo: { installedVersion: "2026.9.1", expectedVersion: "2026.9.2" },
    });
    await compared.steps.recordBootReportServerPhase();
    expect((await compared.steps.finalizeBootReport({ reconcile: null })).verdict).toEqual([kBootVerdicts.installedNotExpected]);

    const excused = createFixture({
      withBinPhase: false,
      schema: { ...kSchema, installedVersion: "2026.9.1" },
      channelInfo: { installedVersion: "2026.9.1", expectedVersion: "2026.9.2", installedDiverged: false },
    });
    await excused.steps.recordBootReportServerPhase();
    const outcome = await excused.steps.finalizeBootReport({ reconcile: null });
    expect(outcome).toEqual(expect.objectContaining({ verdict: [], inconsistent: false }));
    expect(bootEvents(excused.insertWatchdogEvent)[0]).toEqual(
      expect.objectContaining({ status: "ok", details: expect.objectContaining({ installed: "2026.9.1", expected: "2026.9.2" }) }),
    );
  });

  it("a watchdog without setBootVerdict (before the A4 leaf lands), a throwing notifier, a throwing webhook and a throwing sink each cost one warning and never the finalize", async () => {
    const { steps, service, insertWatchdogEvent, notify, logger } = createFixture({
      openclaw: { installedAtBoot: "2026.7.1-2", expected: "2026.8.1", resolvedForLaunch: "2026.7.1-2" },
      withWatchdogVerdict: false,
      notify: vi.fn(async () => {
        throw new Error("notifier down");
      }),
    });
    service.postBootWebhook.mockImplementation(() => {
      throw new Error("webhook down");
    });
    insertWatchdogEvent.mockImplementation(() => {
      throw new Error("db locked");
    });
    await steps.recordBootReportServerPhase();
    const outcome = await steps.finalizeBootReport({ reconcile: { status: "ok" } });
    expect(outcome.inconsistent).toBe(true);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("[boot-report] INCONSISTENT notification failed (notifier down)");
    expect(logger.warn).toHaveBeenCalledWith("[boot-report] boot event not recorded (db locked)");
  });

  it("finalize is per-boot idempotent on the pin: a restart loop keeps the first pinned report", async () => {
    const first = createFixture({
      openclaw: { installedAtBoot: "2026.7.1-2", expected: "2026.8.1", resolvedForLaunch: "2026.7.1-2" },
    });
    await first.steps.recordBootReportServerPhase();
    const a = await first.steps.finalizeBootReport({ reconcile: { status: "ok" } });
    expect(a.pinned).toBe(true);
    const pinnedAt = readJson(first.bootReport.incidentPath).pinnedAt;
    const b = await first.steps.finalizeBootReport({ reconcile: { status: "ok" } });
    expect(b.pinned).toBe(false);
    expect(readJson(first.bootReport.incidentPath).pinnedAt).toBe(pinnedAt);
  });
});

describe("boot-report-steps: onListeningNotOnboarded", () => {
  it("runs both closers and marks the server phase { status: not_reached, reason: not_onboarded }; a throwing closer is logged, the marker still lands", () => {
    const { steps, bootReport, service, restartRequiredState, logger } = createFixture();
    const report = steps.onListeningNotOnboarded();
    expect(service.closeDanglingRecordsAtBoot).toHaveBeenCalledTimes(1);
    expect(restartRequiredState.reconcileOnBoot).toHaveBeenCalledTimes(1);
    expect(report.serverPhase).toEqual({
      status: kServerPhaseStatuses.notReached,
      reason: kNotOnboardedReason,
      at: kNow,
      verdict: [],
    });
    expect(readJson(bootReport.reportPath).serverPhase.status).toBe(kServerPhaseStatuses.notReached);

    service.closeDanglingRecordsAtBoot.mockImplementation(() => {
      throw new Error("ledger unreadable");
    });
    restartRequiredState.reconcileOnBoot.mockImplementation(() => {
      throw new Error("record unreadable");
    });
    expect(steps.onListeningNotOnboarded().serverPhase.status).toBe(kServerPhaseStatuses.notReached);
    expect(logger.warn).toHaveBeenCalledWith("[boot-report] dangling-record close failed (ledger unreadable)");
    expect(logger.warn).toHaveBeenCalledWith("[boot-report] restart-operation reconcile failed (record unreadable)");
  });
});

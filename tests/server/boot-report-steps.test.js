// boot-report.json server phase (#76 A1 / A7 / CEO 8.1): the injected boot
// steps merge the state-DB / schema / config facts into the report the bin
// phase wrote (fixture), compute the verdict, pin the incident report, notify
// on INCONSISTENT and replay ONE `boot` watchdog event through the wrapped
// sink. Hermetic: real writer over a temp managed dir, fake OpenClaw runtime.
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

// The bin-phase report the way the boot instance guard leaves it. Like the
// guard, the fixture records installedDiverged whenever both sides are known;
// an explicit `installedDiverged` in `openclaw` overrides it.
const binReport = (openclaw = {}, extra = {}) => {
  const versions = { declaredPin: "2026.9.2", installedAtBoot: "2026.9.2", ...openclaw };
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
      installedDiverged:
        versions.declaredPin && versions.installedAtBoot ? versions.installedAtBoot !== versions.declaredPin : null,
      retiredChannel: null,
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
  runtimeInfo = { installedVersion: "2026.9.2", pinnedVersion: "2026.9.2", installedDiverged: false },
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
  const runtime = {
    describeStateDbSchema: vi.fn(async () => schema),
    getInfo: vi.fn(() => runtimeInfo),
  };
  const postBootWebhook = vi.fn();
  const restartRequiredState = { reconcileOnBoot: vi.fn() };
  const insertWatchdogEvent = vi.fn();
  const watchdog = withWatchdogVerdict ? { setBootVerdict: vi.fn() } : {};
  const steps = createBootReportSteps({
    bootReport,
    openclawRuntime: runtime,
    restartRequiredState,
    insertWatchdogEvent,
    getWatchdog: () => watchdog,
    notify,
    postBootWebhook,
    openclawDir,
    readOpenclawConfig: require("../../lib/server/openclaw-config").readOpenclawConfig,
    resolveEraHint: vi.fn(async () => ({ hint: eraHint, signal: "gate" })),
    nowFn: () => kNow,
    logger,
  });
  return { steps, bootReport, runtime, postBootWebhook, restartRequiredState, insertWatchdogEvent, watchdog, notify, logger, openclawDir, managedDir };
};

const bootEvents = (insertWatchdogEvent) =>
  insertWatchdogEvent.mock.calls.map((call) => call[0]).filter((event) => event.eventType === kBootWatchdogEventType);

describe("boot-report-steps: restart-operation closer", () => {
  it("reconcileRestartOperationAtBoot calls reconcileOnBoot; a bare composition is a no-op, never a throw", () => {
    const { steps, restartRequiredState } = createFixture();
    steps.reconcileRestartOperationAtBoot();
    expect(restartRequiredState.reconcileOnBoot).toHaveBeenCalledTimes(1);
    const bare = createBootReportSteps({ logger: silent() });
    expect(() => bare.reconcileRestartOperationAtBoot()).not.toThrow();
  });
});

describe("boot-report-steps: recordBootReportServerPhase", () => {
  it("merges stateDb, supportedSchema, config { sha256, lastTouchedVersion }, the installed/pinned versions and legacyExecApprovalsPresent into the bin phase's report", async () => {
    const { steps, bootReport, openclawDir } = createFixture();

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
      expectedVersion: "2026.9.2",
      stateDb: kSchema.stateDb,
      supportedSchema: kSchema.supportedSchema,
      config: { sha256: expectedSha, lastTouchedVersion: "2026.9.2" },
      legacyExecApprovalsPresent: false,
      verdict: [],
    });
  });

  it("the version snapshot degrades to null fields when the runtime has no info (never a throw); the schema read outranks it", async () => {
    const { steps, runtime } = createFixture({ runtimeInfo: null, schema: { ...kSchema, installedVersion: null } });
    let phase = (await steps.recordBootReportServerPhase()).serverPhase;
    expect(phase.installedVersion).toBeNull();
    expect(phase.expectedVersion).toBeUndefined();
    runtime.getInfo.mockImplementation(() => {
      throw new Error("package.json unreadable");
    });
    phase = (await steps.recordBootReportServerPhase()).serverPhase;
    expect(phase.installedVersion).toBeNull();
    runtime.getInfo.mockImplementation(() => ({ installedVersion: "", pinnedVersion: "2026.9.2" }));
    phase = (await steps.recordBootReportServerPhase()).serverPhase;
    expect(phase).toEqual(expect.objectContaining({ installedVersion: null, expectedVersion: "2026.9.2" }));
    runtime.getInfo.mockImplementation(() => ({ installedVersion: "2026.9.1", pinnedVersion: "2026.9.2" }));
    expect((await steps.recordBootReportServerPhase()).serverPhase.installedVersion).toBe("2026.9.1");
    const schemaWins = createFixture({ runtimeInfo: { installedVersion: "2026.9.1", pinnedVersion: "2026.9.2" } });
    expect((await schemaWins.steps.recordBootReportServerPhase()).serverPhase.installedVersion).toBe("2026.9.2");
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

  it("with no writer every report step is a null no-op (the closer still runs)", async () => {
    const { steps, restartRequiredState, insertWatchdogEvent } = createFixture({ withWriter: false });
    expect(await steps.recordBootReportServerPhase()).toBeNull();
    expect(await steps.finalizeBootReport({ migration: { status: "ok", ran: false } })).toBeNull();
    expect(steps.onListeningNotOnboarded()).toBeNull();
    expect(restartRequiredState.reconcileOnBoot).toHaveBeenCalledTimes(1);
    expect(insertWatchdogEvent).not.toHaveBeenCalled();
  });
});

describe("boot-report-steps: finalizeBootReport", () => {
  it("a consistent boot: logs `[boot-report] consistent`, threads the migration outcome + config facts, pins nothing, notifies nobody, replays exactly ONE ok `boot` event with the documented details, hands the report to watchdog.setBootVerdict", async () => {
    const { steps, bootReport, postBootWebhook, insertWatchdogEvent, watchdog, notify, logger } = createFixture();
    await steps.recordBootReportServerPhase();

    const outcome = await steps.finalizeBootReport({
      migration: { status: "ok", ran: true },
      gatewayHeld: false,
    });

    expect(outcome).toEqual(
      expect.objectContaining({ verdict: [], inconsistent: false, pinned: false }),
    );
    const report = readJson(bootReport.reportPath);
    expect(report.serverPhase).toEqual(
      expect.objectContaining({
        status: kServerPhaseStatuses.recorded,
        migration: { status: "ok", reason: null, ran: true },
        gatewayHeld: false,
        config: {
          sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          sha256AfterMigration: expect.stringMatching(/^[0-9a-f]{64}$/),
          lastTouchedVersion: "2026.9.2",
        },
        // The record step's facts survive the finalize merge.
        stateDb: kSchema.stateDb,
        verdict: [],
      }),
    );
    expect(logger.log).toHaveBeenCalledWith("[boot-report] consistent");
    expect(logger.error).not.toHaveBeenCalled();
    expect(fs.existsSync(bootReport.incidentPath)).toBe(false);
    expect(postBootWebhook).not.toHaveBeenCalled();
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

  it("an INCONSISTENT boot (installed ≠ pin, legacy approvals): 🔴 error line, pinned incident report, pre-outbox webhook + ONE day-bucketed notification, ONE failed `boot` event naming the verdict", async () => {
    const { steps, bootReport, postBootWebhook, insertWatchdogEvent, notify, logger } = createFixture({
      openclaw: { installedAtBoot: "2026.7.1-2", declaredPin: "2026.8.1" },
      legacyApprovalsFile: true,
    });
    await steps.recordBootReportServerPhase();

    const outcome = await steps.finalizeBootReport({ migration: { status: "ok", ran: true } });

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
    const message =
      "🔴 AlphaClaw boot report INCONSISTENT — `installed_not_expected`, `legacy_exec_approvals_present`. OpenClaw installed 2026.7.1-2, pinned 2026.8.1. Run `alphaclaw diagnose` for details.";
    expect(postBootWebhook).toHaveBeenCalledWith(message);
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

  it("a legacy exec-approvals.json reaped between the record step and finalize (ensureManagedExecDefaults) is a self-healed boot: consistent, `legacyExecApprovalsReaped: true`", async () => {
    const { steps, bootReport, openclawDir, insertWatchdogEvent, notify, postBootWebhook } = createFixture({
      legacyApprovalsFile: true,
      eraHint: kSqliteEra,
    });
    const recorded = await steps.recordBootReportServerPhase();
    // The record step saw the finding…
    expect(recorded.serverPhase.legacyExecApprovalsPresent).toBe(true);
    expect(recorded.serverPhase.verdict).toEqual([kBootVerdicts.legacyExecApprovalsPresent]);
    // …then the reaper renamed the file (exec-defaults-config reapStrayLegacyExecApprovals).
    fs.renameSync(path.join(openclawDir, "exec-approvals.json"), path.join(openclawDir, `exec-approvals.json.stray-${kNow}`));

    const outcome = await steps.finalizeBootReport({ migration: { status: "ok", ran: false } });

    expect(outcome).toEqual(expect.objectContaining({ verdict: [], inconsistent: false, pinned: false }));
    expect(readJson(bootReport.reportPath).serverPhase).toEqual(
      expect.objectContaining({ legacyExecApprovalsPresent: false, legacyExecApprovalsReaped: true, verdict: [] }),
    );
    expect(fs.existsSync(bootReport.incidentPath)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
    expect(postBootWebhook).not.toHaveBeenCalled();
    expect(bootEvents(insertWatchdogEvent)).toEqual([expect.objectContaining({ status: "ok", details: expect.objectContaining({ verdict: [] }) })]);
  });

  it("legacyExecApprovalsReaped is false unless the record step saw the sqlite-era finding (an indeterminate era that resolves is not a reap)", async () => {
    const { steps, bootReport, openclawDir } = createFixture({ legacyApprovalsFile: true, eraHint: kIndeterminate });
    expect((await steps.recordBootReportServerPhase()).serverPhase.legacyExecApprovalsPresent).toBeNull();
    fs.rmSync(path.join(openclawDir, "exec-approvals.json"));
    await steps.finalizeBootReport({ migration: { status: "ok", ran: false } });
    expect(readJson(bootReport.reportPath).serverPhase).toEqual(
      expect.objectContaining({ legacyExecApprovalsPresent: false, legacyExecApprovalsReaped: false }),
    );
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
    const outcome = await steps.finalizeBootReport({ migration: { status: "ok", ran: false } });
    expect(outcome.verdict).toEqual([kBootVerdicts.pidfileContradiction]);
    expect(bootEvents(insertWatchdogEvent)[0].details.pidfile).toEqual({
      decision: "skip",
      reason: "legacy_argv_match",
    });
  });

  it("a failed or erroring doctor migration is recorded verbatim ({ status, reason, ran }) with the gateway-held flag", async () => {
    const { steps, bootReport } = createFixture();
    await steps.recordBootReportServerPhase();
    await steps.finalizeBootReport({ migration: { status: "failed", ran: true, reason: "timed out" }, gatewayHeld: false });
    let server = readJson(bootReport.reportPath).serverPhase;
    expect(server.migration).toEqual({ status: "failed", reason: "timed out", ran: true });
    expect(server.gatewayHeld).toBe(false);

    await steps.finalizeBootReport({ migration: { status: "error", reason: "doctor exploded" }, gatewayHeld: true });
    server = readJson(bootReport.reportPath).serverPhase;
    expect(server.migration).toEqual({ status: "error", reason: "doctor exploded", ran: false });
    expect(server.gatewayHeld).toBe(true);

    await steps.finalizeBootReport({ migration: null });
    expect(readJson(bootReport.reportPath).serverPhase.migration).toBeNull();
  });

  it("with no bin phase, a genuinely mismatched box is still INCONSISTENT: the runtime's version snapshot feeds the verdict, the failed `boot` event and the watchdog latch", async () => {
    const { steps, bootReport, insertWatchdogEvent, watchdog, notify } = createFixture({
      withBinPhase: false,
      schema: { ...kSchema, installedVersion: "2026.9.1" },
      runtimeInfo: { installedVersion: "2026.9.1", pinnedVersion: "2026.9.2", installedDiverged: true },
    });
    await steps.recordBootReportServerPhase();
    const outcome = await steps.finalizeBootReport({ migration: null });
    expect(outcome).toEqual(expect.objectContaining({ verdict: [kBootVerdicts.installedNotExpected], inconsistent: true }));
    const report = readJson(bootReport.reportPath);
    expect(report.openclaw).toBeNull();
    expect(report.serverPhase).toEqual(expect.objectContaining({ installedVersion: "2026.9.1", expectedVersion: "2026.9.2" }));
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

  it("with no bin phase, a box running its pin is consistent", async () => {
    const { steps, insertWatchdogEvent } = createFixture({ withBinPhase: false });
    await steps.recordBootReportServerPhase();
    const outcome = await steps.finalizeBootReport({ migration: null });
    expect(outcome).toEqual(expect.objectContaining({ verdict: [], inconsistent: false }));
    expect(bootEvents(insertWatchdogEvent)[0]).toEqual(
      expect.objectContaining({ status: "ok", details: expect.objectContaining({ installed: "2026.9.2", expected: "2026.9.2" }) }),
    );
  });

  it("a watchdog without setBootVerdict (before the A4 leaf lands), a throwing notifier, a throwing webhook and a throwing sink each cost one warning and never the finalize", async () => {
    const { steps, postBootWebhook, insertWatchdogEvent, notify, logger } = createFixture({
      openclaw: { installedAtBoot: "2026.7.1-2", declaredPin: "2026.8.1" },
      withWatchdogVerdict: false,
      notify: vi.fn(async () => {
        throw new Error("notifier down");
      }),
    });
    postBootWebhook.mockImplementation(() => {
      throw new Error("webhook down");
    });
    insertWatchdogEvent.mockImplementation(() => {
      throw new Error("db locked");
    });
    await steps.recordBootReportServerPhase();
    const outcome = await steps.finalizeBootReport({ migration: { status: "ok", ran: false } });
    expect(outcome.inconsistent).toBe(true);
    expect(postBootWebhook).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith("[boot-report] INCONSISTENT notification failed (notifier down)");
    expect(logger.warn).toHaveBeenCalledWith("[boot-report] boot event not recorded (db locked)");
  });

  it("finalize is per-boot idempotent on the pin: a restart loop keeps the first pinned report", async () => {
    const first = createFixture({
      openclaw: { installedAtBoot: "2026.7.1-2", declaredPin: "2026.8.1" },
    });
    await first.steps.recordBootReportServerPhase();
    const a = await first.steps.finalizeBootReport({ migration: { status: "ok", ran: false } });
    expect(a.pinned).toBe(true);
    const pinnedAt = readJson(first.bootReport.incidentPath).pinnedAt;
    const b = await first.steps.finalizeBootReport({ migration: { status: "ok", ran: false } });
    expect(b.pinned).toBe(false);
    expect(readJson(first.bootReport.incidentPath).pinnedAt).toBe(pinnedAt);
  });
});

describe("boot-report-steps: onListeningNotOnboarded", () => {
  it("runs the closer and marks the server phase { status: not_reached, reason: not_onboarded }; a throwing closer is logged, the marker still lands", () => {
    const { steps, bootReport, restartRequiredState, logger } = createFixture();
    const report = steps.onListeningNotOnboarded();
    expect(restartRequiredState.reconcileOnBoot).toHaveBeenCalledTimes(1);
    expect(report.serverPhase).toEqual({
      status: kServerPhaseStatuses.notReached,
      reason: kNotOnboardedReason,
      at: kNow,
      verdict: [],
    });
    expect(readJson(bootReport.reportPath).serverPhase.status).toBe(kServerPhaseStatuses.notReached);

    restartRequiredState.reconcileOnBoot.mockImplementation(() => {
      throw new Error("record unreadable");
    });
    expect(steps.onListeningNotOnboarded().serverPhase.status).toBe(kServerPhaseStatuses.notReached);
    expect(logger.warn).toHaveBeenCalledWith("[boot-report] restart-operation reconcile failed (record unreadable)");
  });
});

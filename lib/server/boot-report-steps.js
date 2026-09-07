// The server half of boot-report.json and the listening-path record closers
// (issue #76 A1 / A7 / CEO 8.1), composed once in lib/server.js and threaded
// into runOnboardedBootSequence (and the not-onboarded listening hook) as
// injected steps. Every step is best-effort: a throw is logged by the boot
// sequence (F008) and never costs the gateway launch — this module only ever
// READS the box and writes the report / one watchdog event.
//
//   listening ──▶ closeDanglingRecordsAtBoot     ledger runs + lastUpdateRun
//             ──▶ reconcileRestartOperationAtBoot restart-op record (foreign bootId)
//             ──▶ recordBootReportServerPhase    stateDb, supportedSchema, config,
//                                                channelInfo snapshot,
//                                                legacyExecApprovalsPresent
//             …  (reconcileInstalled → compat gate → ensure steps → reconcileBootConfig)
//             ──▶ finalizeBootReport({ reconcile }) re-reads config sha256 + the
//                                                exec-approvals fact (the ensure
//                                                steps may have reaped the file)
//                                                → verdict → log → pin → webhook +
//                                                notification (INCONSISTENT) →
//                                                ONE `boot` watchdog event →
//                                                watchdog.setBootVerdict
//   not onboarded: onListeningNotOnboarded       the two closers + serverPhase
//                                                { status: "not_reached",
//                                                  reason: "not_onboarded" }
//
// Rule of record: boot-report.json is the diagnostic SUPERSET; the channel
// state's `lastBoot` stays the authority for boot ACTION.
const crypto = require("crypto");
const fs = require("fs");

const { normalizeVerdict, describeReportVersions } = require("./boot-report");
const { resolveExecApprovalsConfigPath } = require("./exec-defaults-config");
const { resolveOpenclawConfigPath } = require("./openclaw-config");
const { kSqliteEra, kFileEra } = require("./openclaw-state-era");
const { utcDayBucket } = require("./notification-policy");

// The one watchdog event type this module writes. Replayed through the
// WRAPPED incident sink so an open incident receives the verdict as context;
// its UI label is hand-pinned in watchdog-incidents-ui.test.js (the source
// drift pin only scans lib/server/watchdog.js logEvent literals).
const kBootWatchdogEventType = "boot";
const kBootWatchdogEventSource = "boot_report";
const kNotOnboardedReason = "not_onboarded";

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const nonEmptyString = (value) =>
  typeof value === "string" && value !== "" ? value : null;

const createBootReportSteps = ({
  // createBootReportWriter(...) for THIS process's bootId, or null when the
  // writer could not be constructed (every report step then no-ops).
  bootReport = null,
  // openclawChannelService: closeDanglingRecordsAtBoot, describeStateDbSchema,
  // postBootWebhook, getChannelInfo.
  openclawChannelService,
  // restartRequiredState: reconcileOnBoot.
  restartRequiredState = null,
  // The tracker-WRAPPED insertWatchdogEvent (the same sink createWatchdog
  // gets) — the `boot` event must reach the incident tracker.
  insertWatchdogEvent = null,
  // Late-bound: the watchdog is constructed after the sink; setBootVerdict
  // (Stage 2 A4, added by the watchdog leaf) is consulted by typeof.
  getWatchdog = () => null,
  // Durable notifier (message, opts) for the INCONSISTENT line; day-bucketed
  // id so a boot loop dedupes and a later episode re-fires.
  notify = null,
  openclawDir,
  fsModule = fs,
  readOpenclawConfig = null,
  // openclaw-state-era resolveEraHint: () => Promise<{ hint }>. A legacy
  // exec-approvals.json is only a finding on a sqlite-era box.
  resolveEraHint = null,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  const log = (message) => {
    try {
      logger.log(`[boot-report] ${message}`);
    } catch {}
  };
  const warn = (message) => {
    try {
      logger.warn(`[boot-report] ${message}`);
    } catch {}
  };

  // Evidence captured by earlier steps, merged by later ones (the writer's
  // serverPhase merge is shallow, so `config` is written whole each time).
  // `legacyExecApprovalsAtBoot` is the record step's read of the exec-approvals
  // fact; finalize re-reads it and reports a self-heal (see below).
  const captured = { danglingRecords: null, configAtBoot: null, legacyExecApprovalsAtBoot: null };

  const readConfigFacts = () => {
    const facts = { sha256: null, lastTouchedVersion: null };
    let configPath = null;
    try {
      configPath = resolveOpenclawConfigPath({ openclawDir });
      const bytes = fsModule.readFileSync(configPath);
      facts.sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
    } catch (error) {
      if (error?.code !== "ENOENT") warn(`could not hash ${configPath || "openclaw.json"} (${error?.message || error})`);
    }
    try {
      if (typeof readOpenclawConfig === "function") {
        const config = readOpenclawConfig({ openclawDir, fallback: {} });
        // Upstream stamps meta.lastTouchedVersion on every write of its own.
        facts.lastTouchedVersion = nonEmptyString(config?.meta?.lastTouchedVersion);
      }
    } catch (error) {
      warn(`could not read openclaw.json meta (${error?.message || error})`);
    }
    return facts;
  };

  // true  — the legacy file exists on a sqlite-era box (the gateway refuses
  //         to start; boot-report verdict legacy_exec_approvals_present)
  // false — no file, or a file-era box where the file is the live store
  // null  — file present, era indeterminate
  const readLegacyExecApprovalsPresent = async () => {
    let present = false;
    try {
      present = fsModule.existsSync(resolveExecApprovalsConfigPath({ openclawDir }));
    } catch {}
    if (!present) return false;
    if (typeof resolveEraHint !== "function") return null;
    try {
      const { hint } = (await resolveEraHint()) || {};
      if (hint === kSqliteEra) return true;
      if (hint === kFileEra) return false;
    } catch (error) {
      warn(`state-era hint unavailable for the exec-approvals check (${error?.message || error})`);
    }
    return null;
  };

  const channelInfo = () => {
    try {
      return openclawChannelService?.getChannelInfo?.() ?? null;
    } catch {
      return null;
    }
  };

  // The live channel service's view of the versions at the server phase —
  // installedDiverged is the canonical predicate (pinLag excuse included).
  // Recorded so a report with no usable bin phase (missing / mismatch /
  // unreadable, openclaw: null) still carries installed vs expected for the
  // verdict and the `boot` event; describeReportVersions prefers the bin
  // phase's own read when one exists.
  const channelInfoSnapshot = () => {
    const info = channelInfo();
    if (!isPlainObject(info)) return null;
    return {
      installedVersion: nonEmptyString(info.installedVersion),
      expectedVersion: nonEmptyString(info.expectedVersion),
      installedDiverged: typeof info.installedDiverged === "boolean" ? info.installedDiverged : null,
    };
  };

  // The bin phase's syncAtBoot already ran this closer (after the pidfile
  // decision proved no live sibling) and recorded what it closed under
  // bootSync.danglingRecords; by the time the server phase runs it again there
  // is normally nothing left. The report's serverPhase.danglingRecords is the
  // UNION of both phases, so a reader (or the container leg) sees every run
  // this boot closed without knowing which phase got there first.
  const binPhaseDanglingRecords = () => {
    try {
      const own = bootReport?.readOwnReport?.();
      const recorded = own?.openclaw?.bootSync?.danglingRecords;
      return isPlainObject(recorded)
        ? {
            closedRuns: Array.isArray(recorded.closedRuns) ? recorded.closedRuns.filter(Boolean) : [],
            closedLastUpdateRun: recorded.closedLastUpdateRun === true,
          }
        : null;
    } catch {
      return null;
    }
  };

  const closeDanglingRecordsAtBoot = () => {
    const result = openclawChannelService?.closeDanglingRecordsAtBoot?.() ?? null;
    const server = isPlainObject(result)
      ? {
          closedRuns: Array.isArray(result.closedRuns) ? result.closedRuns.filter(Boolean) : [],
          closedLastUpdateRun: result.closedLastUpdateRun === true,
        }
      : null;
    const bin = binPhaseDanglingRecords();
    captured.danglingRecords =
      server || bin
        ? {
            closedRuns: [...new Set([...(bin?.closedRuns ?? []), ...(server?.closedRuns ?? [])])],
            closedLastUpdateRun: bin?.closedLastUpdateRun === true || server?.closedLastUpdateRun === true,
          }
        : null;
    if (captured.danglingRecords?.closedRuns.length || captured.danglingRecords?.closedLastUpdateRun) {
      const byBin = bin?.closedRuns.length ?? 0;
      log(
        `closed dangling records at boot: runs [${captured.danglingRecords.closedRuns.join(", ")}]${captured.danglingRecords.closedLastUpdateRun ? " + lastUpdateRun" : ""}${byBin ? ` (${byBin} closed by the bin phase)` : ""}`,
      );
    }
    return result;
  };

  const reconcileRestartOperationAtBoot = () => {
    restartRequiredState?.reconcileOnBoot?.();
  };

  const recordBootReportServerPhase = async () => {
    if (!bootReport) return null;
    const schema = await openclawChannelService.describeStateDbSchema();
    captured.configAtBoot = readConfigFacts();
    captured.legacyExecApprovalsAtBoot = await readLegacyExecApprovalsPresent();
    // Explicit `recorded`: an onboarding-completed boot merges into a report
    // the listening hook marked not_reached, and the merge must overrule it.
    return bootReport.mergeServerPhase({
      status: "recorded",
      installedVersion: schema.installedVersion ?? null,
      stateDb: schema.stateDb,
      supportedSchema: schema.supportedSchema,
      config: { ...captured.configAtBoot },
      channelInfo: channelInfoSnapshot(),
      legacyExecApprovalsPresent: captured.legacyExecApprovalsAtBoot,
      danglingRecords: captured.danglingRecords,
    });
  };

  const describeReconcile = (reconcile) =>
    isPlainObject(reconcile)
      ? {
          status: nonEmptyString(reconcile.status),
          reason: nonEmptyString(reconcile.reason),
          hold: nonEmptyString(reconcile.hold?.reason),
        }
      : null;

  // Which whole-file restore (if any) shaped the config this boot runs on:
  // the config gate's lastRestore record, keyed to THIS boot's id.
  const restoredFromThisBoot = () => {
    try {
      const lastRestore = openclawChannelService?.store?.readState?.()?.configMigration?.lastRestore;
      if (!isPlainObject(lastRestore) || lastRestore.bootId !== bootReport?.bootId) return null;
      return {
        from: lastRestore.from ?? null,
        source: lastRestore.source ?? null,
        preRestorePath: lastRestore.preRestorePath ?? null,
      };
    } catch {
      return null;
    }
  };

  const inconsistentMessage = ({ verdict, installed, expected }) => {
    const findings = verdict.map((entry) => `\`${entry}\``).join(", ");
    const versions =
      installed || expected
        ? ` OpenClaw installed ${installed ?? "unknown"}, expected ${expected ?? "unknown"}.`
        : "";
    return `🔴 AlphaClaw boot report INCONSISTENT — ${findings}.${versions} Run \`alphaclaw diagnose\` or open the Upgrade page.`;
  };

  const finalizeBootReport = async ({ reconcile = null, compat = null, gatewayHeld = false } = {}) => {
    if (!bootReport) return null;
    const configAfter = readConfigFacts();
    // Re-read at finalize, like the config hash: the ensure steps between the
    // record step and here include ensureManagedExecDefaults, whose reaper
    // renames a stray legacy exec-approvals.json on a sqlite-era box. The
    // verdict must judge the box the gateway launches on, not the one the
    // record step saw — a boot that healed the condition is consistent.
    // `legacyExecApprovalsReaped` keeps the before-state as evidence: the
    // sqlite-era finding was present at the record step and gone now.
    const legacyExecApprovalsPresent = await readLegacyExecApprovalsPresent();
    const legacyExecApprovalsReaped =
      captured.legacyExecApprovalsAtBoot === true && legacyExecApprovalsPresent === false;
    const report = bootReport.mergeServerPhase({
      status: "recorded",
      reconcile: describeReconcile(reconcile),
      compat: isPlainObject(compat)
        ? { compatible: compat.compatible ?? null, hold: nonEmptyString(compat.hold?.reason) }
        : null,
      gatewayHeld: gatewayHeld === true,
      config: {
        ...(captured.configAtBoot || { sha256: null, lastTouchedVersion: null }),
        sha256AfterReconcile: configAfter.sha256,
        migrationGate: describeReconcile(reconcile),
        restoredFrom: restoredFromThisBoot(),
      },
      legacyExecApprovalsPresent,
      legacyExecApprovalsReaped,
    });
    if (!report) {
      warn("server phase not finalized (report write failed) — no verdict this boot");
      return null;
    }
    const verdict = normalizeVerdict(report.serverPhase?.verdict);
    // The same versions the verdict judged (the tree the gateway will RUN vs
    // the expected build); the live channel info only when the report knows
    // neither (no bin phase and no snapshot).
    const versions = describeReportVersions(report);
    const info = channelInfo();
    const installed = versions.running ?? nonEmptyString(info?.installedVersion);
    const expected = versions.expected ?? nonEmptyString(info?.expectedVersion);
    const inconsistent = verdict.length > 0;
    if (inconsistent) {
      logger.error(
        `🔴 [boot-report] INCONSISTENT: ${verdict.join(", ")} (installed ${installed ?? "unknown"}, expected ${expected ?? "unknown"}) — see ${bootReport.reportPath}`,
      );
    } else {
      log("consistent");
    }
    const pin = bootReport.pinIncidentReport(report);
    if (pin?.pinned) log(`incident report pinned (${pin.reason}) at ${bootReport.incidentPath}`);
    if (inconsistent) {
      const message = inconsistentMessage({ verdict, installed, expected });
      // Pre-outbox channel: a boot that never completes must still reach
      // somebody (the durable outbox drains only after the server is up).
      try {
        openclawChannelService?.postBootWebhook?.(message);
      } catch {}
      if (typeof notify === "function") {
        try {
          await notify(message, {
            eventType: "health",
            id: `boot-report-inconsistent-${verdict.join("+")}-${installed ?? "unknown"}-${utcDayBucket(nowFn())}`,
          });
        } catch (error) {
          warn(`INCONSISTENT notification failed (${error?.message || error})`);
        }
      }
    }
    // ONE `boot` event per boot, consistent or not (CEO 8.1): the incidents
    // timeline shows every boot's verdict without opening files.
    if (typeof insertWatchdogEvent === "function") {
      try {
        insertWatchdogEvent({
          eventType: kBootWatchdogEventType,
          source: kBootWatchdogEventSource,
          status: inconsistent ? "failed" : "ok",
          details: {
            bootId: bootReport.bootId,
            verdict,
            pidfile: {
              decision: report.pidfile?.decision ?? null,
              reason: report.pidfile?.reason ?? null,
            },
            installed,
            expected,
          },
          correlationId: "",
        });
      } catch (error) {
        warn(`boot event not recorded (${error?.message || error})`);
      }
    }
    const watchdog = getWatchdog();
    if (typeof watchdog?.setBootVerdict === "function") {
      try {
        watchdog.setBootVerdict(report);
      } catch (error) {
        warn(`watchdog.setBootVerdict failed (${error?.message || error})`);
      }
    }
    return { report, verdict, inconsistent, pinned: pin?.pinned === true };
  };

  // Non-onboarded boxes: the same closers (the port bind proved
  // single-instance) and a server phase that will never run.
  const onListeningNotOnboarded = () => {
    try {
      closeDanglingRecordsAtBoot();
    } catch (error) {
      warn(`dangling-record close failed (${error?.message || error})`);
    }
    try {
      reconcileRestartOperationAtBoot();
    } catch (error) {
      warn(`restart-operation reconcile failed (${error?.message || error})`);
    }
    return bootReport ? bootReport.markServerPhaseNotReached(kNotOnboardedReason) : null;
  };

  return {
    closeDanglingRecordsAtBoot,
    reconcileRestartOperationAtBoot,
    recordBootReportServerPhase,
    finalizeBootReport,
    onListeningNotOnboarded,
  };
};

module.exports = {
  kBootWatchdogEventType,
  kBootWatchdogEventSource,
  kNotOnboardedReason,
  createBootReportSteps,
};

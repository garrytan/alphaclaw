// The server half of boot-report.json and the listening-path record closers
// (issue #76 A1 / A7 / CEO 8.1), composed once in lib/server.js and threaded
// into runOnboardedBootSequence (and the not-onboarded listening hook) as
// injected steps. Every step is best-effort: a throw is logged by the boot
// sequence (F008) and never costs the gateway launch — this module only ever
// READS the box and writes the report / one watchdog event.
//
//   listening ──▶ reconcileRestartOperationAtBoot restart-op record (foreign bootId)
//             ──▶ recordBootReportServerPhase    stateDb, supportedSchema, config,
//                                                version snapshot,
//                                                legacyExecApprovalsPresent
//             …  (normalization → doctor migration → ensure steps)
//             ──▶ finalizeBootReport({ migration }) re-reads config sha256 + the
//                                                exec-approvals fact (the ensure
//                                                steps may have reaped the file)
//                                                → verdict → log → pin → webhook +
//                                                notification (INCONSISTENT) →
//                                                ONE `boot` watchdog event →
//                                                watchdog.setBootVerdict
//   not onboarded: onListeningNotOnboarded       the closer + serverPhase
//                                                { status: "not_reached",
//                                                  reason: "not_onboarded" }
const crypto = require("crypto");
const fs = require("fs");

const { normalizeVerdict, describeReportVersions } = require("./boot-report");
const { resolveExecApprovalsConfigPath } = require("./exec-defaults-config");
const { resolveOpenclawConfigPath } = require("./openclaw-config");
const { kSqliteEra, kFileEra } = require("./openclaw-state-era");
const { utcDayBucket } = require("./notification-policy");
const { postNotifyWebhookDirect } = require("./notify-webhook");

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
  // openclawRuntime: describeStateDbSchema, getInfo.
  openclawRuntime,
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
  // Pre-outbox channel (ALPHACLAW_NOTIFY_WEBHOOK_URL) for the INCONSISTENT
  // line: a boot that never completes must still reach somebody.
  postBootWebhook = (message) => postNotifyWebhookDirect(message),
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
  const captured = { configAtBoot: null, legacyExecApprovalsAtBoot: null };

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

  const openclawInfo = () => {
    try {
      return openclawRuntime?.getInfo?.() ?? null;
    } catch {
      return null;
    }
  };
  // The runtime's view of the versions at the server phase, so a report with
  // no usable bin phase still carries installed vs pinned for the verdict and
  // the `boot` event; describeReportVersions prefers the bin phase's read.
  const versionSnapshot = () => {
    const info = openclawInfo();
    if (!isPlainObject(info)) return {};
    return {
      installedVersion: nonEmptyString(info.installedVersion),
      expectedVersion: nonEmptyString(info.pinnedVersion),
    };
  };
  const reconcileRestartOperationAtBoot = () => {
    restartRequiredState?.reconcileOnBoot?.();
  };

  const recordBootReportServerPhase = async () => {
    if (!bootReport) return null;
    const schema = await openclawRuntime.describeStateDbSchema();
    captured.configAtBoot = readConfigFacts();
    captured.legacyExecApprovalsAtBoot = await readLegacyExecApprovalsPresent();
    const versions = versionSnapshot();
    // Explicit `recorded`: an onboarding-completed boot merges into a report
    // the listening hook marked not_reached, and the merge must overrule it.
    return bootReport.mergeServerPhase({
      status: "recorded",
      ...versions,
      installedVersion: schema.installedVersion ?? versions.installedVersion ?? null,
      stateDb: schema.stateDb,
      supportedSchema: schema.supportedSchema,
      config: { ...captured.configAtBoot },
      legacyExecApprovalsPresent: captured.legacyExecApprovalsAtBoot,
    });
  };

  const describeMigration = (migration) =>
    isPlainObject(migration)
      ? { status: nonEmptyString(migration.status), reason: nonEmptyString(migration.reason), ran: migration.ran === true }
      : null;
  const inconsistentMessage = ({ verdict, installed, expected }) => {
    const findings = verdict.map((entry) => `\`${entry}\``).join(", ");
    const versions =
      installed || expected
        ? ` OpenClaw installed ${installed ?? "unknown"}, pinned ${expected ?? "unknown"}.`
        : "";
    return `🔴 AlphaClaw boot report INCONSISTENT — ${findings}.${versions} Run \`alphaclaw diagnose\` for details.`;
  };

  const finalizeBootReport = async ({ migration = null, gatewayHeld = false } = {}) => {
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
      migration: describeMigration(migration),
      gatewayHeld: gatewayHeld === true,
      config: {
        ...(captured.configAtBoot || { sha256: null, lastTouchedVersion: null }),
        sha256AfterMigration: configAfter.sha256,
      },
      legacyExecApprovalsPresent,
      legacyExecApprovalsReaped,
    });
    if (!report) {
      warn("server phase not finalized (report write failed) — no verdict this boot");
      return null;
    }
    const verdict = normalizeVerdict(report.serverPhase?.verdict);
    // The same versions the verdict judged (installed vs the pin).
    const versions = describeReportVersions(report);
    const info = openclawInfo();
    const installed = versions.running ?? nonEmptyString(info?.installedVersion);
    const expected = versions.expected ?? nonEmptyString(info?.pinnedVersion);
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
        void Promise.resolve(postBootWebhook?.(message)).catch(() => {});
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

  // Non-onboarded boxes: the same closer (the port bind proved
  // single-instance) and a server phase that will never run.
  const onListeningNotOnboarded = () => {
    try {
      reconcileRestartOperationAtBoot();
    } catch (error) {
      warn(`restart-operation reconcile failed (${error?.message || error})`);
    }
    return bootReport ? bootReport.markServerPhaseNotReached(kNotOnboardedReason) : null;
  };

  return {
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

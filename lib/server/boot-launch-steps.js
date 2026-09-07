// Boot steps (3) and (4) of runOnboardedBootSequence (issue #76 C1 belt / C2),
// composed once in lib/server.js beside boot-report-steps.js and merged into
// the same `bootSteps` object register-server-routes.js threads into
// startup.js. The policy lives in openclaw-channel-sync.js
// (reconcileInstalled, assessLaunchCompatibilityAtBoot); this module is the
// boot-side glue that owns what the channel service cannot see:
//
//   reconcileInstalledAtBoot({ hold })   installedDiverged → reconcileInstalled
//                                       ({ hold: <the boot lease>, source:
//                                       "boot", relaunch: false }); logs the
//                                       outcome; never throws
//   assessLaunchCompatibilityAtBoot      the service's verdict, then a
//     ({ hold })                         `version_mismatch` event THROUGH THE
//                                       WRAPPED SINK for a refusal (the
//                                       watchdog's latch when it exposes one —
//                                       status line + incident — else the
//                                       sink directly); a throw propagates so
//                                       startup.js's runBootStep logs it and
//                                       fails OPEN (F008)
//   run ownership (Codex 7)              a boot reconcile leaves its ledger run
//                                       `running`; the boot books the relaunch
//                                       step: wrapStartGateway completes it
//                                       `activated` once startGateway resolves
//                                       (verdict "launched"), a launch throw or
//                                       a held boot (onBootReportFinalize)
//                                       completes it `failed` with the reason
//
// The lifecycle lock is not re-entrant (Codex 1): `hold` is the boot lease
// startup.js acquired and is passed through untouched — never re-acquired,
// never released here.
const kLaunchCompatGateEventSource = "launch_compat_gate";
const kVersionMismatchEventType = "version_mismatch";
const kBootRelaunchVerdict = "launched";

const nonEmptyString = (value) =>
  typeof value === "string" && value !== "" ? value : null;

const createBootLaunchSteps = ({
  // openclawChannelService: getChannelInfo, reconcileInstalled,
  // assessLaunchCompatibilityAtBoot, completeReconcileRun.
  openclawChannelService,
  // The tracker-WRAPPED insertWatchdogEvent (the sink createWatchdog gets):
  // a version_mismatch event must open or escalate an incident.
  insertWatchdogEvent = null,
  // Late-bound: latchVersionMismatch is consulted by typeof.
  getWatchdog = () => null,
  logger = console,
} = {}) => {
  const log = (message) => {
    try {
      logger.log(`[boot-launch] ${message}`);
    } catch {}
  };
  const warn = (message) => {
    try {
      logger.warn(`[boot-launch] ${message}`);
    } catch {}
  };

  // Reconcile runIds this boot activated and still owes a relaunch step.
  const pendingRuns = new Set();
  const bookReconcile = (result) => {
    if (result?.ok === true && result.action === "activated" && nonEmptyString(result.runId)) {
      pendingRuns.add(result.runId);
    }
  };
  const settleReconcileRuns = (relaunch) => {
    const settled = [...pendingRuns];
    pendingRuns.clear();
    for (const runId of settled) {
      try {
        openclawChannelService?.completeReconcileRun?.({ runId, relaunch });
      } catch (error) {
        warn(`reconcile run ${runId} could not be completed (${error?.message || error})`);
      }
    }
    return settled;
  };

  const channelInfo = () => {
    try {
      return openclawChannelService?.getChannelInfo?.() ?? null;
    } catch (error) {
      warn(`channel info unavailable (${error?.message || error})`);
      return null;
    }
  };

  const reconcileInstalledAtBoot = async ({ hold = null } = {}) => {
    const info = channelInfo();
    if (!info) return null;
    if (info.installedDiverged !== true) {
      return { ok: true, action: "none", reason: "not_diverged" };
    }
    log(
      `installed OpenClaw ${info.installedVersion ?? "unknown"} is not the recorded ${info.expectedVersion ?? "unknown"} — re-activating the recorded build before anything runs on this tree (C1 belt)`,
    );
    let result = null;
    try {
      result = await openclawChannelService.reconcileInstalled({
        hold,
        source: "boot",
        relaunch: false,
      });
    } catch (error) {
      const message = String(error?.message || error);
      warn(
        `installed-tree reconcile threw (${message}) — continuing; the compatibility gate judges the tree that is on disk`,
      );
      return { ok: false, action: "none", code: "reconcile_threw", error: message };
    }
    if (result?.ok === true && result.action === "activated") {
      bookReconcile(result);
      log(
        `re-activated OpenClaw ${result.to} (the tree on disk was ${result.from ?? "unknown"})${result.schemaRecovery ? " — schema recovery: the recorded build cannot read the databases" : ""}; run ${result.runId ?? "n/a"}`,
      );
    } else if (result?.ok === true) {
      log(`nothing to re-activate (${result.action ?? "none"})`);
    } else {
      warn(
        `re-activation refused: ${result?.code ?? "unknown"}${result?.message ? ` — ${result.message}` : ""}`,
      );
    }
    return result ?? null;
  };

  const emitVersionMismatch = ({ expected, running, details }) => {
    const watchdog = getWatchdog();
    if (typeof watchdog?.latchVersionMismatch === "function") {
      try {
        watchdog.latchVersionMismatch({
          expected,
          running,
          source: kLaunchCompatGateEventSource,
          details,
        });
        return true;
      } catch (error) {
        warn(`watchdog.latchVersionMismatch failed (${error?.message || error})`);
      }
    }
    if (typeof insertWatchdogEvent !== "function") return false;
    try {
      insertWatchdogEvent({
        eventType: kVersionMismatchEventType,
        source: kLaunchCompatGateEventSource,
        status: "failed",
        details: { expected, running, source: kLaunchCompatGateEventSource, ...details },
        correlationId: "",
      });
      return true;
    } catch (error) {
      warn(`version_mismatch event not recorded (${error?.message || error})`);
      return false;
    }
  };

  const assessLaunchCompatibilityAtBoot = async ({ hold = null } = {}) => {
    if (typeof openclawChannelService?.assessLaunchCompatibilityAtBoot !== "function") {
      return null;
    }
    // Deliberately un-caught: the gate's contract is that its RETURN decides
    // and a throw is "no verdict" — startup.js logs it and launches.
    const result = await openclawChannelService.assessLaunchCompatibilityAtBoot({ hold });
    if (result?.reconcile) bookReconcile(result.reconcile);
    if (result?.compatible === false) {
      emitVersionMismatch({
        expected: nonEmptyString(result.expected),
        running: nonEmptyString(result.installed),
        details: {
          reason: nonEmptyString(result.hold?.reason),
          reasons: Array.isArray(result.reasons) ? result.reasons : [],
          bootId: nonEmptyString(result.hold?.bootId),
          supported: result.supported ?? null,
        },
      });
    }
    return result;
  };

  // startup.js finalizes the report BEFORE the launch decision executes; a
  // held boot never reaches startGateway, so the owed relaunch step is
  // completed here with the hold's reason.
  const onBootReportFinalize = ({ gatewayHeld = false, compat = null, reconcile = null } = {}) => {
    if (gatewayHeld !== true || pendingRuns.size === 0) return [];
    const reason =
      nonEmptyString(compat?.hold?.reason) ||
      nonEmptyString(reconcile?.hold?.reason) ||
      nonEmptyString(reconcile?.reason) ||
      "gateway_held";
    return settleReconcileRuns({
      ok: false,
      error: `gateway held (${reason}) — no relaunch this boot`,
    });
  };

  const wrapStartGateway = (startGateway) => async () => {
    try {
      await startGateway();
    } catch (error) {
      settleReconcileRuns({ ok: false, error: String(error?.message || error) });
      throw error;
    }
    settleReconcileRuns({ ok: true, verdict: kBootRelaunchVerdict });
  };

  return {
    reconcileInstalledAtBoot,
    assessLaunchCompatibilityAtBoot,
    onBootReportFinalize,
    wrapStartGateway,
    // exported for tests
    pendingReconcileRuns: () => [...pendingRuns],
  };
};

module.exports = {
  kLaunchCompatGateEventSource,
  kVersionMismatchEventType,
  kBootRelaunchVerdict,
  createBootLaunchSteps,
};

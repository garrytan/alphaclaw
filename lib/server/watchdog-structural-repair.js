// Cause-keyed structural repair for the watchdog (issue #76 B1.1 / B1.3 /
// B1.6 / B1.7, CEO 5.2, Codex 11) + the scoped, persisted auto-repair pause.
//
// The legacy crash ladder relaunches the SAME binary (backoff → crash loop →
// `doctor --fix`) whatever the exit said. When the stderr classifier names a
// version-family cause AND an independent fact corroborates it (the build
// cannot use what is on disk: schema, legacy store, plugin API), relaunching
// that binary is provably wrong. This module owns the deterministic rungs
// that fix the STRUCTURE instead — DI'd into createWatchdog like the startup
// medic (the watchdog acquires the lifecycle lock, passes its hold, relaunches
// through its own runVerifiedRelaunch and books the events):
//
//   runStructuralRepair({ cause, fingerprint, corroboration, hold, relaunch, … })
//     ├─ disabled (OPENCLAW_CRASH_CAUSE_LADDER=off) ─▶ { skipped: "disabled" }
//     │    (classification and fingerprinting still record; the watchdog
//     │     keeps the legacy ladder)
//     ├─ legacy_exec_approvals ──▶ (2) rename exec-approvals.json → .stray-<ts>
//     ├─ schema / plugin / cli ─┬─ installedDiverged ▶ (1) reconcileInstalled
//     │                         │      activated ▶ undoLastConfigRestore (best effort)
//     │                         │      refused/failed ▶ fall through to (3)
//     │                         └─ (3) recoverBootable — reconcileInstalled in
//     │                                schema-recovery mode: chooser + activate a
//     │                                local build that CAN read the databases
//     │                                (applied.reason "schema_recovery")
//     ├─ a rung activated/renamed ▶ relaunch({ intent: "replace" }) — health is
//     │    verified by the watchdog's normal probe/verifier discipline; doctor
//     │    runs only later, through the crash-loop discipline, if the corrected
//     │    binary still crashes (Codex 11)
//     └─ nothing bootable / every rung refused ▶ { paused: "structural_repair_failed" }
//
// The lifecycle lock is NOT re-entrant (Codex 1): every rung receives the
// caller's `hold` and re-checks hold.isValid() after each await; a lapsed
// lease ends the plan with outcome lease_expired and never touches lifecycle.
//
// The pause (B1.3 / Codex 9 / Codex 10) is a scalar record the watchdog keeps in
// state.autoRepairPaused and persists to <managedDir>/auto-repair-pause.json
// (writeFileAtomic) so four platform reboots do not replay the ladder. It is
// keyed by { installedVersion, fingerprint }; the codec and file store live
// here so the watchdog only sees read()/write()/clear(). Clearing rules are
// the watchdog's (installedVersion change, the 120 s acceptance hold, one-shot
// operator resume) — see watchdog.js.
const fs = require("fs");
const { kVersionFamilyGatewayCrashCauses } = require("./gateway-crash-cause");
const { writeFileAtomic } = require("./utils/safe-file");

// Kill switch (CEO 1.3): deployment-only env (lib/server/deployment-only-env.js).
const kCrashCauseLadderEnvKey = "OPENCLAW_CRASH_CAUSE_LADDER";
// The boot gate's kill switch (openclaw-channel-sync.js kLaunchCompatGateEnvKey)
// also governs the runtime relaunch compat step; the literal is repeated here
// so the watchdog does not load the 11k-line channel module for one string —
// tests pin the two constants equal.
const kLaunchCompatGateEnvKey = "OPENCLAW_LAUNCH_COMPAT_GATE";
const kAutoRepairPauseFileName = "auto-repair-pause.json";

const isOff = (value) => String(value || "").trim().toLowerCase() === "off";
const crashCauseLadderDisabled = () => isOff(process.env[kCrashCauseLadderEnvKey]);
const launchCompatGateDisabled = () => isOff(process.env[kLaunchCompatGateEnvKey]);

// Ledger vocabulary. Rows are `repair/<kStructuralRepairSource>/<status>` so
// the incidents timeline needs no new label; the relaunch rows are
// `restart/<kStructuralRelaunchSource>/…` like every other relaunch site.
const kStructuralRepairSource = "structural";
const kStructuralRelaunchSource = "repair/structural";
const kStructuralRepairRungs = Object.freeze({
  RECONCILE_INSTALLED: "reconcile_installed",
  UNDO_CONFIG_RESTORE: "undo_config_restore",
  RENAME_EXEC_APPROVALS: "rename_exec_approvals",
  RECOVER_BOOTABLE: "recover_bootable",
  RELAUNCH: "relaunch",
});
const kAutoRepairPauseReasons = Object.freeze({
  // (a) a corroborated version-family cause whose structural repair failed
  STRUCTURAL_REPAIR_FAILED: "structural_repair_failed",
  // (b) a replacement_pending child that exited within the launch window
  //     twice with the same version-family fingerprint
  REPLACEMENT_EXITED_TWICE: "replacement_exited_twice",
});
// (b)'s launch window: "exits within 60 s of launch".
const kAutoRepairPauseReplacementWindowMs = 60 * 1000;
const kLegacyExecApprovalsCause = "legacy_exec_approvals";

const isVersionFamilyCause = (cause) =>
  typeof cause === "string" && kVersionFamilyGatewayCrashCauses.includes(cause);

// Relaunch verdicts that mean "a gateway is (or is about to be) on the port".
const kRelaunchOkVerdicts = new Set([
  "replacement_ready",
  "replacement_pending",
  "incumbent_adopted",
  "child_retained",
]);

const nonEmptyString = (value) =>
  typeof value === "string" && value !== "" ? value : null;

// ── pause codec ────────────────────────────────────────────────────────────
// Persisted shape (the C5 fixture tests/server/fixtures/persisted-formats/
// auto-repair-pause.json/v0.9.77.json is regenerated from THIS writer):
//   { at, cause, fingerprint, installedVersion, attempts, lastPlan: { rung,
//     outcome }, reason }
// `at` is epoch ms; a record without a cause or fingerprint is not a pause.
const normalizeAutoRepairPause = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const cause = nonEmptyString(raw.cause);
  const fingerprint = nonEmptyString(raw.fingerprint);
  if (!cause || !fingerprint) return null;
  const at = Number(raw.at);
  const attempts = Number(raw.attempts);
  const lastPlan =
    raw.lastPlan && typeof raw.lastPlan === "object" && !Array.isArray(raw.lastPlan)
      ? {
          rung: nonEmptyString(raw.lastPlan.rung),
          outcome: nonEmptyString(raw.lastPlan.outcome),
        }
      : null;
  return {
    at: Number.isFinite(at) && at > 0 ? at : 0,
    cause,
    fingerprint,
    installedVersion: nonEmptyString(raw.installedVersion),
    attempts: Number.isInteger(attempts) && attempts >= 0 ? attempts : 0,
    lastPlan,
    reason: nonEmptyString(raw.reason) || kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED,
  };
};
const serializeAutoRepairPause = (pause) => {
  const normalized = normalizeAutoRepairPause(pause);
  if (!normalized) return null;
  return `${JSON.stringify(
    {
      at: normalized.at,
      cause: normalized.cause,
      fingerprint: normalized.fingerprint,
      installedVersion: normalized.installedVersion,
      attempts: normalized.attempts,
      lastPlan: normalized.lastPlan,
      reason: normalized.reason,
    },
    null,
    2,
  )}\n`;
};

// read() → pause | null (a missing, torn or foreign file reads as "no pause"
// with one warning — the reader never throws into createWatchdog);
// write(pause) persists (writeFileAtomic) or unlinks on null; clear() unlinks.
const createAutoRepairPauseStore = ({ filePath, fsModule = fs, logger = console } = {}) => {
  if (!filePath) throw new TypeError("createAutoRepairPauseStore: filePath is required");
  const warn = (message) => {
    try {
      logger.warn(`[watchdog] ${message}`);
    } catch {}
  };
  const read = () => {
    let text;
    try {
      text = fsModule.readFileSync(filePath, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") {
        warn(`auto-repair pause file unreadable (${error?.message || error}) — treating as no pause`);
      }
      return null;
    }
    try {
      const pause = normalizeAutoRepairPause(JSON.parse(text));
      if (!pause) warn(`auto-repair pause file ${filePath} has no cause/fingerprint — ignored`);
      return pause;
    } catch (error) {
      warn(`auto-repair pause file ${filePath} is not valid JSON (${error?.message || error}) — ignored`);
      return null;
    }
  };
  const clear = () => {
    try {
      fsModule.unlinkSync(filePath);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") {
        warn(`auto-repair pause file could not be removed (${error?.message || error})`);
      }
      return false;
    }
  };
  const write = (pause) => {
    if (!pause) return clear();
    const text = serializeAutoRepairPause(pause);
    if (!text) return clear();
    try {
      writeFileAtomic(filePath, text, { fsModule });
      return true;
    } catch (error) {
      warn(`auto-repair pause could not be persisted (${error?.message || error})`);
      return false;
    }
  };
  return { read, write, clear, filePath };
};

// ── the repair ─────────────────────────────────────────────────────────────
//
// createStructuralRepair({
//   reconcileInstalled({ hold, source, relaunch })   rung (1) — the channel
//                          service's runtime reconcile ({ ok, action:
//                          "activated" | "none", code?, to, from, runId })
//   recoverBootable({ hold, source, relaunch })      rung (3) — the same
//                          envelope from reconcileInstalled in schema-recovery
//                          mode (recover: true); null = rung unavailable
//   renameStrayExecApprovals()                        rung (2) — exec-defaults'
//                          reapStrayLegacyExecApprovals with reapAllowed
//                          ({ reaped, strayPath?, error? }); null = unavailable
//   undoLastConfigRestore({ bootId })                 B1.5 — { ok, code }
//   completeReconcileRun({ runId, relaunch })          Codex 7 — the caller
//                          books the relaunch step
//   getChannelInfo()                                  installedDiverged +
//                          versions for the plan
//   isDisabled()                                      kill switch (CEO 1.3)
// })
//   → { isEnabled, runStructuralRepair }
//
// runStructuralRepair({ cause, fingerprint, corroboration, hold, correlationId,
//                       relaunch, logEvent, source })
//   relaunch({ source, intent, hold, correlationId }) → { verdict, … } — the
//     watchdog's runVerifiedRelaunch bound to its own state (passed per call:
//     the primitive lives inside the watchdog closure)
//   logEvent(eventType, source, status, details, correlationId) — the
//     watchdog's ledger writer (one `repair/structural/<status>` row per run)
//   → { ok, plan: [{ step, outcome, detail? }], paused: reason | null,
//       verdict, runId, skipped?, activated? }
const createStructuralRepair = ({
  reconcileInstalled,
  recoverBootable = null,
  renameStrayExecApprovals = null,
  undoLastConfigRestore = null,
  completeReconcileRun = null,
  getChannelInfo = () => null,
  isDisabled = crashCauseLadderDisabled,
  nowFn = Date.now,
  logger = console,
} = {}) => {
  if (typeof reconcileInstalled !== "function") {
    throw new TypeError("createStructuralRepair: reconcileInstalled is required");
  }
  const log = (message) => {
    try {
      logger.log(`[watchdog] structural repair: ${message}`);
    } catch {}
  };
  const holdValid = (hold) =>
    typeof hold?.isValid === "function" ? hold.isValid() : true;
  const channelInfo = () => {
    try {
      return getChannelInfo() || null;
    } catch {
      return null;
    }
  };
  const describeRefusal = (result) =>
    nonEmptyString(result?.code) ||
    (result?.ok === true ? nonEmptyString(result.reason) || result.action || "none" : "failed");

  const runStructuralRepair = async ({
    cause,
    fingerprint = null,
    corroboration = null,
    hold = null,
    correlationId = "",
    relaunch,
    logEvent = null,
    source = kStructuralRepairSource,
  } = {}) => {
    const plan = [];
    const step = (name, outcome, detail = null) => {
      plan.push({ step: name, outcome, ...(detail ? { detail } : {}) });
      log(`${name} → ${outcome}${detail ? ` (${detail})` : ""}`);
    };
    const event = (status, extra = {}) => {
      if (typeof logEvent !== "function") return;
      try {
        logEvent(
          "repair",
          source,
          status,
          {
            cause,
            fingerprint,
            corroborated: corroboration?.corroborated ?? null,
            by: corroboration?.by ?? null,
            plan,
            ...extra,
          },
          correlationId,
        );
      } catch {}
    };
    const finish = ({ ok, paused = null, verdict = null, runId = null, activated = false, skipped }) => {
      const result = { ok, plan, paused, verdict, runId, activated, ...(skipped ? { skipped } : {}) };
      event(skipped ? "skipped" : ok ? "ok" : "failed", {
        paused,
        verdict,
        runId,
        ...(skipped ? { reason: skipped } : {}),
      });
      return result;
    };

    if (isDisabled()) {
      step("ladder", "disabled", `${kCrashCauseLadderEnvKey}=off`);
      return finish({ ok: false, skipped: "disabled" });
    }
    if (typeof relaunch !== "function") {
      throw new TypeError("runStructuralRepair: relaunch is required");
    }
    if (!holdValid(hold)) {
      step("ladder", "lease_expired");
      return finish({ ok: false, skipped: "lease_expired" });
    }

    let runId = null;
    let activated = false;
    let installedVersionAfter = null;

    if (cause === kLegacyExecApprovalsCause) {
      // (2) The file is existence-fatal on the sqlite-era line (#23): the
      //     corroborator already proved the box IS sqlite-era, so renaming it
      //     is exactly what the boot reaper would do.
      if (typeof renameStrayExecApprovals !== "function") {
        step(kStructuralRepairRungs.RENAME_EXEC_APPROVALS, "unavailable");
        return finish({ ok: false, paused: kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED });
      }
      let reaped = null;
      try {
        reaped = renameStrayExecApprovals() || null;
      } catch (error) {
        reaped = { reaped: false, error: String(error?.message || error) };
      }
      if (reaped?.reaped !== true) {
        step(
          kStructuralRepairRungs.RENAME_EXEC_APPROVALS,
          reaped?.error ? "failed" : "not_found",
          reaped?.error ? String(reaped.error).slice(0, 200) : null,
        );
        return finish({ ok: false, paused: kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED });
      }
      step(kStructuralRepairRungs.RENAME_EXEC_APPROVALS, "renamed", reaped.strayPath || null);
      activated = true;
    } else if (isVersionFamilyCause(cause)) {
      const info = channelInfo();
      let reconciled = null;
      if (info?.installedDiverged === true) {
        // (1) The tree on disk is not the recorded build: re-activate the
        //     recorded build (non-destructive; the chooser inside handles a
        //     recorded build that itself cannot read the DBs).
        try {
          reconciled = await reconcileInstalled({ hold, source: "structural_repair", relaunch: true });
        } catch (error) {
          reconciled = { ok: false, code: "reconcile_threw", message: String(error?.message || error) };
        }
        if (!holdValid(hold)) {
          step(kStructuralRepairRungs.RECONCILE_INSTALLED, "lease_expired");
          return finish({ ok: false, skipped: "lease_expired" });
        }
        if (reconciled?.ok === true && reconciled.action === "activated") {
          step(
            kStructuralRepairRungs.RECONCILE_INSTALLED,
            "activated",
            `${reconciled.from ?? "unknown"} → ${reconciled.to}${reconciled.schemaRecovery ? " (schema recovery)" : ""}`,
          );
          runId = nonEmptyString(reconciled.runId);
          installedVersionAfter = reconciled.to ?? null;
          activated = true;
          // B1.5: a whole-file config restore THIS boot performed under the
          // wrong binary is undone before the corrected binary relaunches.
          if (typeof undoLastConfigRestore === "function") {
            let undo = null;
            try {
              undo = undoLastConfigRestore({}) || null;
            } catch (error) {
              undo = { ok: false, code: "undo_threw", error: String(error?.message || error) };
            }
            step(
              kStructuralRepairRungs.UNDO_CONFIG_RESTORE,
              undo?.ok === true ? "undone" : nonEmptyString(undo?.code) || "skipped",
            );
          }
        } else {
          step(kStructuralRepairRungs.RECONCILE_INSTALLED, describeRefusal(reconciled));
        }
      } else {
        step(kStructuralRepairRungs.RECONCILE_INSTALLED, "not_diverged");
      }
      if (!activated) {
        // (3) Nothing re-activated: find a local build that CAN read the
        //     databases (the recorded one cannot, or nothing diverged).
        if (typeof recoverBootable !== "function") {
          step(kStructuralRepairRungs.RECOVER_BOOTABLE, "unavailable");
          return finish({ ok: false, paused: kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED });
        }
        let recovered = null;
        try {
          recovered = await recoverBootable({ hold, source: "structural_repair", relaunch: true });
        } catch (error) {
          recovered = { ok: false, code: "recover_threw", message: String(error?.message || error) };
        }
        if (!holdValid(hold)) {
          step(kStructuralRepairRungs.RECOVER_BOOTABLE, "lease_expired");
          return finish({ ok: false, skipped: "lease_expired" });
        }
        if (recovered?.ok === true && recovered.action === "activated") {
          step(
            kStructuralRepairRungs.RECOVER_BOOTABLE,
            "activated",
            `${recovered.from ?? "unknown"} → ${recovered.to}`,
          );
          runId = nonEmptyString(recovered.runId);
          installedVersionAfter = recovered.to ?? null;
          activated = true;
        } else {
          step(kStructuralRepairRungs.RECOVER_BOOTABLE, describeRefusal(recovered));
          return finish({ ok: false, paused: kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED, runId });
        }
      }
    } else {
      step("ladder", "not_structural", String(cause || "unknown"));
      return finish({ ok: false, skipped: "not_structural" });
    }

    // Relaunch the corrected tree; health is verified by the watchdog's probe
    // + deferred verifier, never assumed here (Codex 11).
    let outcome = null;
    try {
      outcome = await relaunch({
        source: kStructuralRelaunchSource,
        intent: "replace",
        hold,
        correlationId,
      });
    } catch (error) {
      outcome = { verdict: "launch_failed", error };
    }
    const verdict = nonEmptyString(outcome?.verdict) || "launch_failed";
    const relaunched = kRelaunchOkVerdicts.has(verdict);
    step(kStructuralRepairRungs.RELAUNCH, verdict, installedVersionAfter ? `on ${installedVersionAfter}` : null);
    if (runId && typeof completeReconcileRun === "function") {
      try {
        completeReconcileRun({
          runId,
          relaunch: {
            ok: relaunched,
            verdict,
            ...(outcome?.error ? { error: String(outcome.error?.message || outcome.error) } : {}),
          },
        });
      } catch {}
    }
    if (relaunched) {
      return finish({ ok: true, verdict, runId, activated });
    }
    // The structure was fixed but the relaunch did not take: `version_mismatch`
    // from the relaunch's own compat step means the activated build STILL
    // cannot read the databases — that is a failed structural repair (pause);
    // any other relaunch failure is the legacy ladder's to escalate (the
    // activation itself stood).
    return finish({
      ok: false,
      verdict,
      runId,
      activated,
      paused:
        verdict === "version_mismatch" ? kAutoRepairPauseReasons.STRUCTURAL_REPAIR_FAILED : null,
    });
  };

  return {
    isEnabled: () => !isDisabled(),
    runStructuralRepair,
  };
};

module.exports = {
  kCrashCauseLadderEnvKey,
  kLaunchCompatGateEnvKey,
  kAutoRepairPauseFileName,
  kStructuralRepairSource,
  kStructuralRelaunchSource,
  kStructuralRepairRungs,
  kAutoRepairPauseReasons,
  kAutoRepairPauseReplacementWindowMs,
  crashCauseLadderDisabled,
  launchCompatGateDisabled,
  isVersionFamilyCause,
  normalizeAutoRepairPause,
  serializeAutoRepairPause,
  createAutoRepairPauseStore,
  createStructuralRepair,
};

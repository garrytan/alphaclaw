const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  OPENCLAW_DIR,
  kGatewayLifecycleLeaseMs,
  kGatewayRestartOperationBudgetMs,
  kRestartOperationRetentionMs,
} = require("./constants");
const { writeFileAtomic } = require("./utils/safe-file");
const { getProcessBootId } = require("./boot-id");
const { normalizeStateDbVersions } = require("./openclaw-schema-versions");

// Single source for user-facing restart-reason labels (banner, details list,
// notifications all read from here). Includes aliases for the raw codes
// existing callers already pass ("gmail-watch", "webhooks").
const kRestartReasonLabels = Object.freeze({
  channel_token_updated: "Channel token updated",
  env_vars_changed: "Environment variables changed",
  config_file_edited: "Configuration file edited",
  openai_compat_api_enabled: "OpenAI-compatible API toggled",
  gmail_watch_updated: "Gmail watch updated",
  "gmail-watch": "Gmail watch updated",
  webhook_mappings_changed: "Webhook mappings changed",
  webhooks: "Webhook mappings changed",
  telegram_actions_enabled: "Telegram actions enabled",
  config_changed: "Configuration changed",
});

// Unknown codes surface as-is: existing callers pass arbitrary strings and
// hiding them behind a generic label would lose information.
const restartReasonLabelFor = (code) =>
  kRestartReasonLabels[code] || String(code);

// Sibling state files next to the cross-process flag file. The flag file
// format is untouched (the CLI writes it from telegram-workspace.js); these
// two are owned exclusively by the server's store.
const kRestartReasonsFileName = "alphaclaw-restart-reasons.json";
const kRestartOperationFileName = "alphaclaw-restart-operation.json";
const kRestartReasonsFilePath = path.join(OPENCLAW_DIR, kRestartReasonsFileName);
const kRestartOperationFilePath = path.join(
  OPENCLAW_DIR,
  kRestartOperationFileName,
);

const kOperationKind = "gateway_restart";
// Retry upgrade (routes/gateway-operations.js): the same record, with the
// Doctor's verdict and where the card's Try again leads.
const kOperationKinds = new Set([kOperationKind, "openclaw_upgrade"]);
const kRetryTargets = new Set(["upgrade", "restart"]);
const kUpgradeDoctorVerdicts = new Set(["ok", "failed", "not_run"]);
const normalizeUpgradeOutcome = (value) => {
  if (!value || typeof value !== "object" || !kUpgradeDoctorVerdicts.has(value.doctor)) return null;
  return {
    doctor: value.doctor,
    reason: typeof value.reason === "string" && value.reason ? value.reason.slice(0, 64) : null,
    sentence: typeof value.sentence === "string" && value.sentence ? value.sentence.slice(0, 400) : null,
    durationMs: Number.isFinite(Number(value.durationMs)) && Number(value.durationMs) >= 0 ? Number(value.durationMs) : null,
    captureState: typeof value.captureState === "string" ? value.captureState.slice(0, 16) : null,
  };
};
const kOperationStatuses = new Set([
  "running",
  "succeeded",
  "failed",
  "interrupted",
]);
const kInterruptedErrorSummary =
  "AlphaClaw restarted before the operation finished";

// One id per process (shared with boot-report.json and
// configMigration.lastRestore through boot-id.js): an operation record whose
// bootId differs from ours was started by a previous AlphaClaw process and can
// never complete.
const kDefaultBootId = getProcessBootId();

const defaultFlagStore = () => {
  const flag = require("./restart-required-flag");
  return {
    read: () => flag.readRestartRequiredFlag(),
    write: (reason, source) =>
      flag.writeRestartRequiredFlag({ reason, source }),
    clear: () => flag.clearRestartRequiredFlag(),
  };
};

const normalizeReasonCode = (reason) =>
  String(reason || "config_changed").trim() || "config_changed";

const createRestartRequiredState = ({
  isGatewayRunning,
  flagStore,
  stateDir,
  reasonsFilePath,
  operationFilePath,
  now = () => Date.now(),
  getBootId = () => kDefaultBootId,
  // Issue #76 A2: async reader of the state DBs' PRAGMA user_version
  // ({ userVersion, agentUserVersions[] }), consulted ONCE per restart at
  // REQUEST time (beginRestart) so the record names the schema the restart
  // was asked to run against — never on a status tick. Optional; a missing
  // or throwing reader leaves the record without `stateDb`.
  readStateDbVersions = null,
  // Issue #76 A3: synchronous reader of the watchdog's last crash cause
  // (getStatus().lastExit.cause) — consulted by completeRestart for a FAILED
  // restart when the caller did not pass `cause` itself, so the record names
  // why the gateway did not come back. Optional; missing/throwing → null.
  readLastExitCause = null,
} = {}) => {
  const flags = flagStore || defaultFlagStore();
  const reasonsPath =
    reasonsFilePath ||
    (stateDir ? path.join(stateDir, kRestartReasonsFileName) : kRestartReasonsFilePath);
  const operationPath =
    operationFilePath ||
    (stateDir
      ? path.join(stateDir, kRestartOperationFileName)
      : kRestartOperationFilePath);
  const bootId = String(getBootId());

  const state = {
    restartRequired: false,
    restartInProgress: false,
    sawGatewayDownSincePending: false,
    updatedAt: Date.now(),
    reason: "",
    reasons: [],
    operation: null,
    activeOperationId: null,
  };
  let booted = false;

  const touch = () => {
    state.updatedAt = Date.now();
  };

  const latestReasonCode = () => {
    let latest = null;
    for (const entry of state.reasons) {
      if (!latest || entry.addedAt >= latest.addedAt) latest = entry;
    }
    return latest ? latest.code : "";
  };

  // --- persistence ---------------------------------------------------------

  const persistReasons = () => {
    try {
      if (!state.reasons.length) {
        try {
          fs.unlinkSync(reasonsPath);
        } catch {}
        return;
      }
      writeFileAtomic(
        reasonsPath,
        JSON.stringify({ reasons: state.reasons }, null, 2),
      );
    } catch {}
  };

  const loadPersistedReasons = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(reasonsPath, "utf8"));
      if (!parsed || !Array.isArray(parsed.reasons)) return [];
      return parsed.reasons
        .filter((entry) => entry && typeof entry === "object")
        .map((entry) => {
          const code = String(entry.code || "").trim();
          return {
            code,
            label:
              String(entry.label || "").trim() || restartReasonLabelFor(code),
            addedAt: Number(entry.addedAt) || 0,
          };
        })
        .filter((entry) => entry.code);
    } catch {
      return [];
    }
  };

  let warnedPersistOperationId = null;
  const persistOperation = () => {
    try {
      if (!state.operation) {
        try {
          fs.unlinkSync(operationPath);
        } catch {}
        return;
      }
      // 0600: the record now carries the redacted failure-evidence tail; the
      // file lives in the gateway-readable state dir, so tighten it to the
      // supervisor user only. Redaction is best-effort — this is a layer.
      writeFileAtomic(operationPath, JSON.stringify(state.operation, null, 2), {
        mode: 0o600,
      });
    } catch (error) {
      // The persisted record is the ONLY post-restart carrier of failure
      // evidence — a silent write failure here surfaces later as "evidence
      // expired" with no clue why. Warn once per operation, not per write.
      const opId = state.operation?.operationId || null;
      if (opId !== warnedPersistOperationId) {
        warnedPersistOperationId = opId;
        console.warn(
          `[alphaclaw] failed to persist restart-operation record (${error?.code || error?.message || error})`,
        );
      }
    }
  };

  // { stepName: epochMs } — slug keys, finite positive timestamps, capped.
  const normalizePhaseAt = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out = {};
    for (const [key, at] of Object.entries(value).slice(0, 16)) {
      if (!/^[a-z_]{1,32}$/.test(key)) continue;
      const ms = Number(at);
      if (Number.isFinite(ms) && ms > 0) out[key] = ms;
    }
    return out;
  };

  // Step timeline (bug #137 PR 2): what the restart did and when, in order,
  // bounded structurally — at most kTimelineCap entries (the head is kept,
  // `timelineOmitted` counts the rest), every string clamped, details
  // limited to the small set the ladder reports (phase/how/reason/signal).
  const kTimelineCap = 32;
  const kTimelineDetailKeys = ["phase", "how", "reason", "signal", "graceSeconds", "status"];
  const normalizeTimelineEntry = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    const at = Number(entry.at);
    const step = typeof entry.step === "string" ? entry.step.slice(0, 32) : "";
    if (!Number.isFinite(at) || at <= 0 || !step) return null;
    const out = { at, step, status: typeof entry.status === "string" ? entry.status.slice(0, 16) : "running" };
    const detail = entry.detail && typeof entry.detail === "object" ? entry.detail : null;
    if (detail) {
      const picked = {};
      for (const key of kTimelineDetailKeys) {
        const value = detail[key];
        if (typeof value === "string" && value) picked[key] = value.slice(0, 80);
        else if (typeof value === "number" && Number.isFinite(value)) picked[key] = value;
      }
      if (Object.keys(picked).length) out.detail = picked;
    }
    return out;
  };
  const normalizeTimeline = (value) =>
    Array.isArray(value) ? value.slice(0, kTimelineCap).map(normalizeTimelineEntry).filter(Boolean) : [];
  const kRecoveredBy = new Set(["watchdog_repair", "restart_child", "unknown"]);
  // Who brought up the gateway that applied a launch clear (markAppliedByLaunch),
  // in markRecovered's words: `boot_launch` is the first gateway this AlphaClaw
  // process brought to ready, `gateway_launch` any later managed launch.
  const kLaunchAppliedBy = new Set(["boot_launch", "gateway_launch"]);
  const normalizeRecovered = (value) => {
    if (!value || typeof value !== "object") return null;
    const at = Number(value.at);
    if (!Number.isFinite(at) || at <= 0) return null;
    return {
      by: kRecoveredBy.has(value.by) ? value.by : "unknown",
      at,
      ...(Number.isFinite(Number(value.launchedAt)) && Number(value.launchedAt) > 0 ? { launchedAt: Number(value.launchedAt) } : {}),
      changesLive: value.changesLive === true,
    };
  };

  const loadPersistedOperation = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(operationPath, "utf8"));
      if (!parsed || typeof parsed !== "object") return null;
      const operationId = String(parsed.operationId || "").trim();
      if (!operationId || !kOperationStatuses.has(parsed.status)) return null;
      return {
        operationId,
        kind: kOperationKinds.has(parsed.kind) ? parsed.kind : kOperationKind,
        ...(normalizeUpgradeOutcome(parsed.upgrade) ? { upgrade: normalizeUpgradeOutcome(parsed.upgrade) } : {}),
        ...(kRetryTargets.has(parsed.retryTarget) ? { retryTarget: parsed.retryTarget } : {}),
        startedAt: Number(parsed.startedAt) || 0,
        bootId: String(parsed.bootId || ""),
        expiresAt: Number(parsed.expiresAt) || 0,
        status: parsed.status,
        lastStep: parsed.lastStep == null ? null : String(parsed.lastStep),
        errorSummary:
          parsed.errorSummary == null ? null : String(parsed.errorSummary),
        completedAt: Number(parsed.completedAt) || null,
        // Policy-refusal code must survive an AlphaClaw restart too: the
        // client's "never resurrect a refusal as a failed restart" guard reads
        // it from the reloaded record.
        code: typeof parsed.code === "string" && parsed.code ? parsed.code : null,
        // Operator-outcome metrics must survive an AlphaClaw restart — the UI
        // reads them from the reloaded record (previously dropped here).
        durationMs: Number.isFinite(Number(parsed.durationMs))
          ? Number(parsed.durationMs)
          : undefined,
        downtimeMs: Number.isFinite(Number(parsed.downtimeMs))
          ? Number(parsed.downtimeMs)
          : undefined,
        // Reload trusts prior redaction (this module never redacts; callers
        // persist already-redacted text). Guarded against hand-edited or
        // corrupted files: strings only, tail-keeping cap like the write path.
        evidenceTail:
          typeof parsed.evidenceTail === "string" && parsed.evidenceTail
            ? parsed.evidenceTail.slice(-4000)
            : undefined,
        reasonsSnapshot: Array.isArray(parsed.reasonsSnapshot)
          ? parsed.reasonsSnapshot.map(String)
          : [],
        // Schema evidence captured at request time (#76 A2); absent on
        // pre-0.9.77 records and when the reader gave nothing.
        ...(normalizeStateDbVersions(parsed.stateDb)
          ? { stateDb: normalizeStateDbVersions(parsed.stateDb) }
          : {}),
        // Crash cause stamped at completion (#76 A3): string or absent.
        ...(typeof parsed.cause === "string" && parsed.cause
          ? { cause: parsed.cause.slice(0, 64) }
          : {}),
        // Card contract (v0.10.0): the one-line hint, how the old gateway
        // went away, the ready budget, and per-step server timestamps so a
        // reload renders the same line and timer.
        hint: typeof parsed.hint === "string" && parsed.hint ? parsed.hint.slice(0, 400) : null,
        how: typeof parsed.how === "string" && parsed.how ? parsed.how.slice(0, 32) : null,
        budgetMs: Number.isFinite(Number(parsed.budgetMs)) ? Number(parsed.budgetMs) : null,
        phaseAt: normalizePhaseAt(parsed.phaseAt),
        // v0.10.2 (bug #137 PR 2): the step timeline and the recovery stamp;
        // absent on older records ("not recorded").
        timeline: normalizeTimeline(parsed.timeline),
        ...(Number.isInteger(parsed.timelineOmitted) && parsed.timelineOmitted > 0 ? { timelineOmitted: parsed.timelineOmitted } : {}),
        ...(normalizeRecovered(parsed.recovered) ? { recovered: normalizeRecovered(parsed.recovered) } : {}),
      };
    } catch {
      return null;
    }
  };

  // Attach { userVersion, agentUserVersions } to the record the restart was
  // requested for. Asynchronous and detached: beginRestart stays synchronous
  // for its route callers, the read resolves within milliseconds, and the
  // evidence is stamped onto the record whether it is still running or
  // already completed (it is evidence, not status) — but never onto a
  // DIFFERENT operation that replaced it.
  const captureStateDb = (operationId) => {
    if (typeof readStateDbVersions !== "function") return;
    let pending;
    try {
      pending = Promise.resolve(readStateDbVersions());
    } catch {
      return;
    }
    pending
      .then((raw) => {
        const stateDb = normalizeStateDbVersions(raw);
        const record = state.operation;
        if (!stateDb || !record || record.operationId !== operationId) return;
        record.stateDb = stateDb;
        persistOperation();
      })
      .catch(() => {});
  };

  const copyOperation = (record) =>
    record ? { ...record, reasonsSnapshot: [...record.reasonsSnapshot] } : null;

  // Stop evidence (bug #137) is bounded STRUCTURALLY, never by slicing JSON:
  // counts, verdicts and reasons first, at most kEvidenceSampleCap process
  // samples per list plus an `omitted` count, every string clamped. The
  // caller passes already-redacted strings (this module never redacts).
  const kEvidenceSampleCap = 8;
  const sampleProcesses = (list) => {
    if (!Array.isArray(list)) return { items: [], omitted: 0 };
    const items = list.slice(0, kEvidenceSampleCap).map((entry) => ({
      pid: Number.isInteger(entry?.pid) ? entry.pid : null,
      cmd: String(entry?.cmd ?? "").slice(0, 80),
      ...(entry?.verdict ? { verdict: String(entry.verdict).slice(0, 16) } : {}),
      ...(entry?.reason ? { reason: String(entry.reason).slice(0, 40) } : {}),
    }));
    return { items, omitted: Math.max(0, list.length - items.length) };
  };
  const normalizeStopEvidence = (evidence) => {
    if (!evidence || typeof evidence !== "object") return null;
    const identity = evidence.identity && typeof evidence.identity === "object" ? evidence.identity : null;
    return {
      how: typeof evidence.how === "string" ? evidence.how.slice(0, 32) : null,
      askSkippedReason: typeof evidence.askSkippedReason === "string" ? evidence.askSkippedReason.slice(0, 40) : null,
      askRefusedLine: typeof evidence.askRefusedLine === "string" && evidence.askRefusedLine
        ? evidence.askRefusedLine.slice(0, 240)
        : null,
      askExit: evidence.askExit == null ? null : String(evidence.askExit).slice(0, 24),
      observedExits: {
        helpers: Number.isInteger(evidence.observedExits?.helpers) ? evidence.observedExits.helpers : 0,
        other: sampleProcesses(evidence.observedExits?.other),
      },
      stillRunning: sampleProcesses(evidence.stillRunning),
      survivors: sampleProcesses(evidence.survivors),
      identity: identity
        ? {
            owner: typeof identity.owner === "string" ? identity.owner.slice(0, 16) : null,
            rootPid: Number.isInteger(identity.rootPid) ? identity.rootPid : null,
            workerPid: Number.isInteger(identity.workerPid) ? identity.workerPid : null,
            pgid: Number.isInteger(identity.pgid) ? identity.pgid : null,
            gateway: sampleProcesses(identity.gateway),
            helpers: Number.isInteger(identity.helpers) ? identity.helpers : 0,
            other: sampleProcesses(identity.other),
          }
        : null,
    };
  };

  // Best-effort: the reader is the watchdog's in-memory status; a missing or
  // throwing reader must never fail the completion.
  const readLastExitCauseSafe = () => {
    if (typeof readLastExitCause !== "function") return null;
    try {
      const value = readLastExitCause();
      return typeof value === "string" && value ? value : null;
    } catch {
      return null;
    }
  };

  // --- boot reconciliation ---------------------------------------------------

  const closeAsInterrupted = (record) => {
    record.status = "interrupted";
    record.errorSummary = kInterruptedErrorSummary;
    record.completedAt = now();
    persistOperation();
  };

  const pastRetention = (record) =>
    record.status !== "running" &&
    now() - (record.completedAt || record.startedAt) >
      kRestartOperationRetentionMs;

  // Idempotent: explicit server call and the lazy first-use path share it.
  // Re-running after boot would clobber in-memory reasons with stale disk
  // state, hence the guard.
  const reconcileOnBoot = () => {
    if (booted) return;
    booted = true;
    state.reasons = loadPersistedReasons();
    state.restartRequired = state.reasons.length > 0;
    state.reason = latestReasonCode();
    state.operation = loadPersistedOperation();
    const record = state.operation;
    if (
      record &&
      record.status === "running" &&
      (record.bootId !== bootId || now() >= record.expiresAt)
    ) {
      closeAsInterrupted(record);
    }
    if (record && pastRetention(record)) {
      state.operation = null;
      persistOperation();
    }
  };

  const ensureBooted = () => {
    if (!booted) reconcileOnBoot();
  };

  // --- reasons --------------------------------------------------------------

  const markRequired = (reason = "config_changed", { source = "server" } = {}) => {
    ensureBooted();
    const code = normalizeReasonCode(reason);
    const existing = state.reasons.find((entry) => entry.code === code);
    if (existing) {
      existing.addedAt = now();
    } else {
      state.reasons.push({
        code,
        label: restartReasonLabelFor(code),
        addedAt: now(),
      });
    }
    state.restartRequired = true;
    state.reason = code;
    state.sawGatewayDownSincePending = false;
    touch();
    persistReasons();
    try {
      flags.write(code, source);
    } catch {}
  };

  // The CLI marks restarts by writing the persisted flag file from its own
  // process; fold it into the reasons list whenever we take a snapshot. A
  // legacy flag (no reasons array) becomes one reason entry with its code.
  const adoptPersistedFlag = () => {
    let persisted = null;
    try {
      persisted = flags.read();
    } catch {}
    if (!persisted) return;
    const code = normalizeReasonCode(persisted.reason);
    const markedAt = Number(persisted.markedAt) || 0;
    const existing = state.reasons.find((entry) => entry.code === code);
    if (existing) {
      // Re-adopting our own write echo (or a CLI rewrite of the same code)
      // only refreshes the timestamp; the entry is already surfaced.
      if (markedAt > existing.addedAt) {
        existing.addedAt = markedAt;
        persistReasons();
        touch();
      }
      return;
    }
    state.reasons.push({
      code,
      label: restartReasonLabelFor(code),
      addedAt: markedAt || now(),
    });
    state.restartRequired = true;
    state.reason = code;
    state.sawGatewayDownSincePending = false;
    persistReasons();
    touch();
  };

  const clearReasonCodes = (codes) => {
    const clearSet = new Set(codes);
    if (!clearSet.size) return;
    state.reasons = state.reasons.filter((entry) => !clearSet.has(entry.code));
    state.restartRequired = state.reasons.length > 0;
    state.reason = latestReasonCode();
    if (!state.restartRequired) state.sawGatewayDownSincePending = false;
    persistReasons();
    // Drop the cross-process flag only when its code was part of this clear;
    // a flag written mid-restart with a new code must survive re-adoption.
    try {
      const persisted = flags.read();
      if (persisted && clearSet.has(normalizeReasonCode(persisted.reason))) {
        flags.clear();
      }
    } catch {}
  };

  const hasReason = (code) => {
    ensureBooted();
    return state.reasons.some((entry) => entry.code === code);
  };

  const clearRequired = () => {
    ensureBooted();
    state.restartRequired = false;
    state.reason = "";
    state.reasons = [];
    state.sawGatewayDownSincePending = false;
    touch();
    persistReasons();
    try {
      flags.clear();
    } catch {}
  };

  // --- legacy in-progress toggles (routes/system.js still calls these) ------

  const markRestartInProgress = () => {
    ensureBooted();
    state.restartInProgress = true;
    touch();
  };

  const markRestartComplete = () => {
    ensureBooted();
    state.restartInProgress = false;
    touch();
  };

  // --- restart operation record ----------------------------------------------

  // Internal: closes a running record the moment we observe it expired, so
  // readers always get a terminal answer (boot reconciliation covers records
  // from previous processes; this covers same-process lease expiry).
  const readActiveOperation = () => {
    const record = state.operation;
    if (!record || record.status !== "running") return null;
    if (record.bootId !== bootId || now() >= record.expiresAt) {
      closeAsInterrupted(record);
      return null;
    }
    return copyOperation(record);
  };

  const beginRestart = ({ kind = kOperationKind, budgetMs = kGatewayRestartOperationBudgetMs } = {}) => {
    ensureBooted();
    const active = readActiveOperation();
    if (active) {
      // One active restart at a time: concurrent begins attach to it.
      state.restartInProgress = true;
      state.activeOperationId = active.operationId;
      touch();
      return {
        operationId: active.operationId,
        reasonsSnapshot: [...active.reasonsSnapshot],
      };
    }
    // Fold in any CLI-written flag first so it is captured by the snapshot
    // and cleared when this restart succeeds.
    adoptPersistedFlag();
    const startedAt = now();
    const record = {
      operationId: crypto.randomUUID(),
      kind: kOperationKinds.has(kind) ? kind : kOperationKind,
      startedAt,
      bootId,
      // Initial lifetime = one full operation budget. The route refreshes
      // expiresAt while queued behind the lifecycle lock, at lock-acquire,
      // and on each step (updateRestartOperation) — so expiry-reaping only
      // ever catches records whose owning process died mid-operation.
      expiresAt: startedAt + budgetMs,
      status: "running",
      lastStep: null,
      errorSummary: null,
      completedAt: null,
      reasonsSnapshot: state.reasons.map((entry) => entry.code),
    };
    state.operation = record;
    persistOperation();
    state.restartInProgress = true;
    state.activeOperationId = record.operationId;
    touch();
    captureStateDb(record.operationId);
    return {
      operationId: record.operationId,
      reasonsSnapshot: [...record.reasonsSnapshot],
    };
  };

  const updateRestartOperation = ({ operationId, lastStep, expiresAt, phaseAt, budgetMs, timelineEntry } = {}) => {
    ensureBooted();
    const record = state.operation;
    if (
      !record ||
      record.status !== "running" ||
      record.operationId !== operationId
    ) {
      return null;
    }
    if (lastStep !== undefined) {
      record.lastStep = lastStep == null ? null : String(lastStep);
    }
    const stamped = normalizePhaseAt(phaseAt);
    if (Object.keys(stamped).length > 0) {
      record.phaseAt = { ...(record.phaseAt || {}), ...stamped };
    }
    const entry = normalizeTimelineEntry(timelineEntry);
    if (entry) {
      if (!Array.isArray(record.timeline)) record.timeline = [];
      if (record.timeline.length < kTimelineCap) record.timeline.push(entry);
      else record.timelineOmitted = (record.timelineOmitted || 0) + 1;
    }
    if (Number.isFinite(budgetMs) && budgetMs > 0) record.budgetMs = budgetMs;
    // Keepalive/deadline refresh: the route extends the record's lifetime
    // while it waits for the lifecycle lock and re-anchors it at acquire.
    // Guarded to running records with a matching operationId (above), and to
    // finite timestamps, so a stray caller can never resurrect a closed record.
    if (expiresAt !== undefined && Number.isFinite(expiresAt)) {
      record.expiresAt = expiresAt;
    }
    persistOperation();
    touch();
    return copyOperation(record);
  };

  const completeRestart = ({
    operationId,
    ok,
    errorSummary,
    durationMs = null,
    downtimeMs = null,
    evidenceTail = null,
    // Policy-refusal code (e.g. booting): the record closes not-ok but the client must
    // not resurrect it as a failed restart — nothing ran.
    code = null,
    // Crash cause (#76 A3, kGatewayCrashCauses vocabulary). Explicit wins;
    // undefined → a FAILED restart reads the watchdog's lastExit.cause through
    // the injected reader (a succeeded restart has no crash to explain, and a
    // policy refusal ran nothing).
    cause = undefined,
    hint = null,
    how = null,
    budgetMs = null,
    // What the stop touched (bug #137): the ladder's evidence, bounded here.
    stopEvidence = null,
    // Which ladder phase a failure happened in (asking/stopping/forcing/
    // starting), for the record's one-line story.
    failedPhase = null,
    // Retry upgrade: the Doctor's verdict and the card's Try again target.
    upgrade = null,
    retryTarget = null,
  } = {}) => {
    ensureBooted();
    // In-progress state is cleared for this operation regardless of record
    // status, so a failed/expired record never wedges the banner.
    if (state.activeOperationId === operationId) {
      state.restartInProgress = false;
      state.activeOperationId = null;
      touch();
    }
    const record = state.operation;
    if (
      !record ||
      record.operationId !== operationId ||
      record.status !== "running"
    ) {
      return null;
    }
    record.status = ok ? "succeeded" : "failed";
    record.errorSummary = errorSummary == null ? null : String(errorSummary);
    record.code = typeof code === "string" && code ? code : null;
    record.hint = typeof hint === "string" && hint ? hint.slice(0, 400) : null;
    if (typeof how === "string" && how) record.how = how.slice(0, 32);
    if (Number.isFinite(budgetMs) && budgetMs > 0) record.budgetMs = budgetMs;
    const boundedEvidence = normalizeStopEvidence(stopEvidence);
    if (boundedEvidence) record.stopEvidence = boundedEvidence;
    if (typeof failedPhase === "string" && failedPhase) record.failedPhase = failedPhase.slice(0, 32);
    const upgradeOutcome = normalizeUpgradeOutcome(upgrade);
    if (upgradeOutcome) record.upgrade = upgradeOutcome;
    if (kRetryTargets.has(retryTarget)) record.retryTarget = retryTarget;
    record.completedAt = now();
    // Operator-outcome metrics: total operation time and measured gateway
    // downtime (stop → ready). Shown in the success line and incident details.
    if (Number.isFinite(durationMs)) record.durationMs = durationMs;
    if (Number.isFinite(downtimeMs)) record.downtimeMs = downtimeMs;
    // Failure evidence: the caller passes ALREADY-REDACTED text (this module
    // never redacts). Non-empty strings only; tail-keeping cap — the cause
    // line lives at the end.
    if (typeof evidenceTail === "string" && evidenceTail) {
      record.evidenceTail = evidenceTail.slice(-4000);
    }
    const resolvedCause =
      cause !== undefined
        ? cause
        : !ok && record.code === null
          ? readLastExitCauseSafe()
          : null;
    if (typeof resolvedCause === "string" && resolvedCause) {
      record.cause = resolvedCause.slice(0, 64);
    } else {
      delete record.cause;
    }
    persistOperation();
    // Clear only the reasons captured when the restart began: reasons added
    // mid-restart still need a future restart and must survive.
    if (ok) clearReasonCodes(record.reasonsSnapshot);
    touch();
    return copyOperation(record);
  };

  // Post-completion patch for a CLOSED record: the recovery clause the route
  // learns from the watchdog AFTER the lock is released and the record is
  // already `failed` (bug #137 D). Only the named fields, only on a closed
  // record with a matching id — never a status change.
  const patchRestartOperation = ({ operationId, recovery } = {}) => {
    ensureBooted();
    const record = state.operation;
    if (!record || record.operationId !== operationId || record.status === "running") return null;
    if (recovery && typeof recovery === "object") {
      record.recovery = {
        status: String(recovery.status ?? "").slice(0, 32) || null,
        reason: recovery.reason == null ? null : String(recovery.reason).slice(0, 64),
        at: now(),
      };
    }
    persistOperation();
    touch();
    return copyOperation(record);
  };

  // The watchdog's verdict that the port answered ready again after a FAILED
  // restart (bug #137 PR 2): stamps the closed record and, when the recovery
  // is attributable (`watchdog_repair` relaunched from the current config,
  // or the failed restart's own child came up — `restart_child`), clears the
  // reasons the failed restart had snapshotted — but only those added at or
  // before the recovering gateway's launch, so a same-code edit made after
  // the spawn still asks for a restart. `unknown` stamps and clears nothing:
  // the banner stays until the user restarts.
  const markRecovered = ({ operationId = null, by = "unknown", launchedAt = null, at = null } = {}) => {
    ensureBooted();
    const record = state.operation;
    if (!record || record.status !== "failed") return null;
    if (operationId != null && record.operationId !== operationId) return null;
    if (record.recovered) return copyOperation(record);
    const recoveredAt = Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : now();
    const attributable = by === "watchdog_repair" || by === "restart_child";
    const launchFloor = Number.isFinite(Number(launchedAt)) && Number(launchedAt) > 0 ? Number(launchedAt) : recoveredAt;
    record.recovered = {
      by: kRecoveredBy.has(by) ? by : "unknown",
      at: recoveredAt,
      ...(Number.isFinite(Number(launchedAt)) && Number(launchedAt) > 0 ? { launchedAt: Number(launchedAt) } : {}),
      changesLive: attributable,
    };
    // A recovery outranks whatever the recovery clause settled on before.
    record.recovery = { status: "recovered", reason: null, at: recoveredAt };
    if (attributable) {
      const snapshot = new Set(record.reasonsSnapshot);
      const stale = state.reasons
        .filter((entry) => snapshot.has(entry.code) && Number(entry.addedAt) <= launchFloor)
        .map((entry) => entry.code);
      clearReasonCodes(stale);
    }
    persistOperation();
    touch();
    return copyOperation(record);
  };

  // A managed gateway spawned at `launchedAt` reached ready: it started from
  // the config and env as they were at its spawn, so every reason recorded
  // before that spawn is live (a same-millisecond one waits for the next). This is the clear a fresh AlphaClaw process
  // needs: boot reloads the persisted reasons, and the down→up heuristic never
  // sees its first launch unless a client polled during it. A reason recorded
  // after the spawn survives. A running restart (completeRestart decides) and a
  // fresh failed one of this process (markRecovered decides) are left alone; a
  // failed restart persisted by an earlier process has no watchdog note left
  // to recover it, and this process's own launch supersedes it.
  const markAppliedByLaunch = ({ by = "gateway_launch", launchedAt = null, at = null } = {}) => {
    ensureBooted();
    const launchFloor = Number(launchedAt);
    if (!Number.isFinite(launchFloor) || launchFloor <= 0) return null;
    if (state.restartInProgress) return null;
    if (failedRestartHoldsHeuristic() && state.operation.bootId === bootId) return null;
    adoptPersistedFlag();
    const codes = state.reasons
      .filter((entry) => Number(entry.addedAt) < launchFloor)
      .map((entry) => entry.code);
    if (!codes.length) return null;
    clearReasonCodes(codes);
    touch();
    return {
      by: kLaunchAppliedBy.has(by) ? by : "gateway_launch",
      at: Number.isFinite(Number(at)) && Number(at) > 0 ? Number(at) : now(),
      launchedAt: launchFloor,
      codes,
    };
  };

  const getActiveRestartOperation = () => {
    ensureBooted();
    return readActiveOperation();
  };

  const getLastRestartOperation = () => {
    ensureBooted();
    const record = state.operation;
    if (!record) return null;
    if (pastRetention(record)) {
      state.operation = null;
      persistOperation();
      return null;
    }
    return copyOperation(record);
  };

  // --- snapshot / recovery heuristic -----------------------------------------

  // A failed operation-owned restart holds the down→up heuristic (bug #137
  // PR 2): the port going down and coming back is exactly what a failed stop
  // plus the watchdog's relaunch looks like, and whether THAT relaunch
  // carried the user's changes is markRecovered's verdict, not this guess.
  // Bounded: once the failure is older than kFailedRestartHoldMs the legacy
  // heuristic resumes (a note that expired unrecovered must not pin the
  // banner forever).
  const kFailedRestartHoldMs = 15 * 60 * 1000;
  const failedRestartHoldsHeuristic = () => {
    const record = state.operation;
    if (!record || record.status !== "failed" || record.recovered) return false;
    const completedAt = Number(record.completedAt);
    return Number.isFinite(completedAt) && now() - completedAt < kFailedRestartHoldMs;
  };

  const checkAndClearIfRecovered = async () => {
    ensureBooted();
    adoptPersistedFlag();
    const gatewayRunning = await isGatewayRunning();
    if (state.restartRequired && !state.restartInProgress) {
      if (!gatewayRunning) {
        state.sawGatewayDownSincePending = true;
        touch();
      } else if (state.sawGatewayDownSincePending && !failedRestartHoldsHeuristic()) {
        clearRequired();
      }
    }
    return gatewayRunning;
  };

  const getSnapshot = async () => {
    ensureBooted();
    const gatewayRunning = await checkAndClearIfRecovered();
    return {
      restartRequired: state.restartRequired,
      restartInProgress: state.restartInProgress,
      gatewayRunning,
      updatedAt: state.updatedAt,
      reason: state.reason,
      reasons: state.reasons.map((entry) => ({ ...entry })),
      activeOperation: readActiveOperation(),
    };
  };

  return {
    markRequired,
    markRestartInProgress,
    markRestartComplete,
    clearRequired,
    hasReason,
    getSnapshot,
    reconcileOnBoot,
    beginRestart,
    updateRestartOperation,
    completeRestart,
    patchRestartOperation,
    markRecovered,
    markAppliedByLaunch,
    getActiveRestartOperation,
    getLastRestartOperation,
  };
};

module.exports = {
  createRestartRequiredState,
  kRestartReasonLabels,
  restartReasonLabelFor,
  kRestartReasonsFilePath,
  kRestartOperationFilePath,
};

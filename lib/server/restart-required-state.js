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

// Single source for user-facing restart-reason labels (banner, details list,
// notifications all read from here). Includes aliases for the raw codes
// existing callers already pass ("gmail-watch", "webhooks").
const kRestartReasonLabels = Object.freeze({
  channel_token_updated: "Channel token updated",
  env_vars_changed: "Environment variables changed",
  config_file_edited: "Configuration file edited",
  openclaw_release_channel_changed: "OpenClaw release channel changed",
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
const kOperationStatuses = new Set([
  "running",
  "succeeded",
  "failed",
  "interrupted",
]);
const kInterruptedErrorSummary =
  "AlphaClaw restarted before the operation finished";

// One id per process load: an operation record whose bootId differs from ours
// was started by a previous AlphaClaw process and can never complete.
const kDefaultBootId = `${process.pid}:${Date.now()}`;

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

  const loadPersistedOperation = () => {
    try {
      const parsed = JSON.parse(fs.readFileSync(operationPath, "utf8"));
      if (!parsed || typeof parsed !== "object") return null;
      const operationId = String(parsed.operationId || "").trim();
      if (!operationId || !kOperationStatuses.has(parsed.status)) return null;
      return {
        operationId,
        kind: String(parsed.kind || kOperationKind),
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
      };
    } catch {
      return null;
    }
  };

  const copyOperation = (record) =>
    record ? { ...record, reasonsSnapshot: [...record.reasonsSnapshot] } : null;

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

  const beginRestart = () => {
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
      kind: kOperationKind,
      startedAt,
      bootId,
      // Initial lifetime = one full operation budget. The route refreshes
      // expiresAt while queued behind the lifecycle lock, at lock-acquire,
      // and on each step (updateRestartOperation) — so expiry-reaping only
      // ever catches records whose owning process died mid-operation.
      expiresAt: startedAt + kGatewayRestartOperationBudgetMs,
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
    return {
      operationId: record.operationId,
      reasonsSnapshot: [...record.reasonsSnapshot],
    };
  };

  const updateRestartOperation = ({ operationId, lastStep, expiresAt } = {}) => {
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
    // Policy-refusal code (gateway_held / apply_in_progress / booting /
    // gateway_hold_unreadable): the record closes not-ok but the client must
    // not resurrect it as a failed restart — nothing ran.
    code = null,
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
    persistOperation();
    // Clear only the reasons captured when the restart began: reasons added
    // mid-restart still need a future restart and must survive.
    if (ok) clearReasonCodes(record.reasonsSnapshot);
    touch();
    return copyOperation(record);
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

  const checkAndClearIfRecovered = async () => {
    ensureBooted();
    adoptPersistedFlag();
    const gatewayRunning = await isGatewayRunning();
    if (state.restartRequired && !state.restartInProgress) {
      if (!gatewayRunning) {
        state.sawGatewayDownSincePending = true;
        touch();
      } else if (state.sawGatewayDownSincePending) {
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
    getSnapshot,
    reconcileOnBoot,
    beginRestart,
    updateRestartOperation,
    completeRestart,
    getActiveRestartOperation,
    getLastRestartOperation,
  };
};

const waitForGatewayRunning = async ({
  isGatewayRunning,
  timeoutMs = 25000,
  intervalMs = 400,
}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isGatewayRunning()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return isGatewayRunning();
};

module.exports = {
  createRestartRequiredState,
  waitForGatewayRunning,
  kRestartReasonLabels,
  restartReasonLabelFor,
  kRestartReasonsFilePath,
  kRestartOperationFilePath,
};

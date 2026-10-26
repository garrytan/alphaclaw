// Server-owned, in-memory boot timeline (honest boot status, PR 3).
//
// The real server creates ONE timeline at listen for its own bootId and is
// its only writer: there is no shared progress file and no write from
// bin/alphaclaw.js. The pre-listen work is the "Preparing" stage, started at
// the process start. boot-phase.js stays the authority for admission and for
// the reducer's precedence; this timeline is presentation, plus the one
// persisted fact (boot-history.json) written once at its terminal outcome.
//
// Stage transitions come from real evidence only:
//   step(id)            a startup.js step started (steps.js maps it to its stage)
//   noteDoctorStart()   the version-change Doctor started → "Upgrading OpenClaw data"
//                       and the boot kind is promoted to "Upgrading OpenClaw"
//   noteDoctorProgress() the Doctor heartbeat's phase in plain words
//                       (doctor-progress.js); a change counts as activity
//   noteGatewayOutput() gateway stdout/stderr; OpenClaw's "startup phase:" trace
//                       becomes detail text, http.bound/ready → "Connecting channels"
//   observe(sources)    the watchdog's view of the launched gateway (below)
//
// Terminal table (first match wins, evaluated by observe()):
//   bootPhase failed                                  → failed  boot_failed
//   watchdog lifecycle configuration_error            → failed  config_error
//   a crash booked / crash loop / crashed lifecycle   → failed  gateway_exited
//   the watchdog waits out a transient ownership
//     conflict (owner heartbeat, state writer)        → not terminal: step lock_wait
//   health degraded|unhealthy (readiness refused or
//     its transitional budget expired)                → failed  readiness_failed
//   another lifecycle operation holds the lock (user
//     Restart, Retry upgrade, repair, medic …)        → superseded
//   boot finished without launching (lease lost)      → superseded gateway_held
//   health healthy + readiness ready + identity
//     verified (no pending replacement)               → ready   (the ONLY success)
//   readiness unknown after a fail-open probe for
//     kUnverifiedAfterMs with liveness green          → unverified readiness_unknown
//   no verdict kReadyBackstopMs past the launch        → failed  ready_timeout
// plus abort() on shutdown (aborted) and markNotOnboarded() for a box with no
// gateway to launch (terminal at listen, no card, no history row).
// bootPhase "ready" is NOT success: it flips right after the launch request
// (the probe measured it 22 s before native readiness).
const crypto = require("crypto");
const { kBootSteps, kBootKinds, kBootStages, kStageOrder, kStageLabels, parseStartupTraceLine, stageIndex } = require("./steps");

const kStalledAfterMs = 2 * 60 * 1000;
// Same window as the placeholder's stuck flip (lib/boot-placeholder.js).
const kStuckAfterMs = 15 * 60 * 1000;
const kUnverifiedAfterMs = 30 * 1000;
const kReadyBackstopGraceMs = 60 * 1000;
const kMaxSteps = 40;

const kFailedOutcomes = new Set(["failed"]);
// The watchdog's transient conflict kinds (openclaw-lock-contention.js
// kTransientConflictKinds): it relaunches on its own once the holder lapses or
// releases, under its relaunch budget, so the boot is waiting, not failed.
const kLockWaitConflictKinds = new Set(["owner_lease_held", "state_writer_conflict"]);

const publicBootIdFor = (bootId) =>
  crypto.createHash("sha256").update(String(bootId)).digest("hex").slice(0, 12);

const createBootTimeline = ({
  bootId,
  startedAtMs,
  kind = "restarting",
  readVersions = () => ({ alphaclaw: null, openclaw: null }),
  estimateFor = () => null,
  recordHistory = () => {},
  readyBudgetMs = 5 * 60 * 1000,
  now = Date.now,
  logger = console,
} = {}) => {
  const createdAt = now();
  const state = {
    bootId: String(bootId || ""),
    publicId: publicBootIdFor(bootId),
    kind: kBootKinds[kind] ? kind : "restarting",
    startedAt: Number.isFinite(startedAtMs) ? Math.min(startedAtMs, createdAt) : createdAt,
    stages: Object.fromEntries(kStageOrder.map((id) => [id, { status: "pending", startedAt: null, endedAt: null }])),
    stage: null,
    step: null,
    steps: [],
    trace: null,
    activitySeq: 0,
    lastActivityAt: createdAt,
    launchAt: null,
    doctor: { ran: false, fromVersion: null, toVersion: null },
    doctorProgress: null,
    unverifiedSince: null,
    lockWait: null,
    outcome: null,
    reason: null,
    failedStage: null,
    endedAt: null,
    estimate: null,
  };
  const listeners = new Set();

  const isTerminal = () => state.outcome !== null;

  const noteActivity = () => {
    if (isTerminal()) return;
    state.activitySeq += 1;
    state.lastActivityAt = now();
  };

  const refreshEstimate = () => {
    try {
      state.estimate = estimateFor({ kind: state.kind, openclawVersion: readVersions()?.openclaw || null }) || null;
    } catch {
      state.estimate = null;
    }
  };

  // Stages only move forward: entering a later stage closes the running one;
  // an evidence line for an earlier stage never reopens it.
  const enterStage = (stageId, at = now()) => {
    if (isTerminal() || !kStageLabels[stageId]) return false;
    if (state.stage && stageIndex(stageId) <= stageIndex(state.stage)) return false;
    if (state.stage) {
      const previous = state.stages[state.stage];
      previous.status = "done";
      previous.endedAt = at;
    }
    state.stage = stageId;
    state.stages[stageId] = { status: "running", startedAt: at, endedAt: null };
    noteActivity();
    return true;
  };

  const step = (stepId) => {
    if (isTerminal()) return;
    const def = kBootSteps[stepId];
    if (!def) return;
    const at = now();
    enterStage(def.stage, at);
    if (state.step && state.step.endedAt == null) state.step.endedAt = at;
    const entry = { id: stepId, label: def.label, stage: state.stage, startedAt: at, endedAt: null };
    state.step = entry;
    state.steps = [...state.steps, entry].slice(-kMaxSteps);
    if (stepId === "gateway_launch" && state.launchAt == null) state.launchAt = at;
    noteActivity();
  };

  const noteDoctorStart = ({ fromVersion = null, toVersion = null } = {}) => {
    if (isTerminal()) return;
    state.doctor = { ran: true, fromVersion: fromVersion || null, toVersion: toVersion || null };
    if (kBootKinds.upgrading_openclaw.rank > (kBootKinds[state.kind]?.rank || 0)) {
      state.kind = "upgrading_openclaw";
      refreshEstimate();
    }
    step("doctor");
  };

  // OpenClaw prints nothing during its recovery copy and the per-database
  // backups; bytes those copies wrote since the last heartbeat are the only
  // proof of life, so a changed progress is activity and an unchanged one
  // is not.
  const noteDoctorProgress = (progress) => {
    if (isTerminal() || state.stage !== "upgrading" || !progress?.words) return;
    const changed = progress.words !== state.doctorProgress?.words;
    state.doctorProgress = { phase: progress.phase || null, words: String(progress.words), at: now() };
    if (changed) noteActivity();
  };

  const noteGatewayOutput = (text) => {
    if (isTerminal() || state.launchAt == null) return;
    noteActivity();
    for (const line of String(text ?? "").split("\n")) {
      const trace = parseStartupTraceLine(line);
      if (!trace) continue;
      if (trace.words) state.trace = { name: trace.name, words: trace.words, at: now() };
      if (trace.channels) {
        enterStage("channels");
        if (state.step?.id !== "readiness") step("readiness");
      }
    }
  };

  const finish = (outcome, { reason = null } = {}) => {
    if (isTerminal()) return false;
    const at = now();
    state.outcome = outcome;
    state.reason = reason;
    state.endedAt = at;
    if (state.step && state.step.endedAt == null) state.step.endedAt = at;
    if (state.stage) {
      const current = state.stages[state.stage];
      if (kFailedOutcomes.has(outcome)) {
        current.status = "failed";
        state.failedStage = state.stage;
      } else {
        current.status = outcome === "ready" ? "done" : current.status === "running" ? "stopped" : current.status;
      }
      current.endedAt = at;
    }
    if (outcome !== "not_onboarded") {
      const stageMs = {};
      for (const id of kStageOrder) {
        const entry = state.stages[id];
        if (entry.startedAt != null && entry.endedAt != null) stageMs[id] = Math.max(0, entry.endedAt - entry.startedAt);
      }
      const versions = readVersions() || {};
      try {
        recordHistory({
          v: 1,
          bootId: state.publicId,
          kind: state.kind,
          outcome,
          complete: outcome === "ready" && kStageOrder.every((id) => state.stages[id].status !== "running"),
          failedStage: state.failedStage,
          reason,
          startedAt: state.startedAt,
          endedAt: at,
          totalMs: Math.max(0, at - state.startedAt),
          stageMs,
          alphaclawVersion: versions.alphaclaw || null,
          openclawVersion: versions.openclaw || null,
          ...(state.doctor.ran ? { fromOpenclawVersion: state.doctor.fromVersion } : {}),
        });
      } catch (error) {
        logger.warn?.(`[alphaclaw] could not record the boot outcome: ${error?.message || error}`);
      }
      logger.log?.(
        `[alphaclaw] boot timeline ended: ${outcome}${reason ? ` (${reason})` : ""} after ${Math.round((at - state.startedAt) / 1000)}s`,
      );
    }
    for (const listener of [...listeners]) {
      try {
        listener(outcome);
      } catch {}
    }
    return true;
  };

  const observe = ({ bootPhase = null, watchdog = null, activeOperation = null } = {}) => {
    if (isTerminal()) return state.outcome;
    const t = now();
    if (bootPhase?.phase === "failed") {
      finish("failed", { reason: "boot_failed" });
      return state.outcome;
    }
    if (state.launchAt == null) {
      if (bootPhase?.phase === "ready") finish("superseded", { reason: "gateway_held" });
      return state.outcome;
    }
    const wd = watchdog || {};
    const lockWaitKind =
      wd.lifecycle === "running" && wd.health === "degraded" && kLockWaitConflictKinds.has(wd.incumbentConflict?.kind)
        ? wd.incumbentConflict.kind
        : null;
    if (!lockWaitKind && state.lockWait) {
      state.lockWait = null;
      if (state.step?.id === "lock_wait") step("gateway_launch");
    }
    if (wd.lifecycle === "configuration_error") {
      finish("failed", { reason: "config_error" });
    } else if ((wd.crashCountInWindow || 0) > 0 || wd.lifecycle === "crash_loop" || wd.lifecycle === "crashed") {
      finish("failed", { reason: "gateway_exited" });
    } else if (lockWaitKind) {
      const untilMs = Date.parse(wd.incumbentGraceUntil || "");
      state.lockWait = { kind: lockWaitKind, untilMs: Number.isFinite(untilMs) ? untilMs : null };
      if (state.step?.id !== "lock_wait") step("lock_wait");
    } else if (wd.health === "degraded" || wd.health === "unhealthy") {
      finish("failed", { reason: "readiness_failed" });
    } else if (activeOperation && activeOperation.kind && activeOperation.kind !== "boot") {
      finish("superseded", { reason: String(activeOperation.kind) });
    } else if (wd.health === "healthy" && wd.readiness === "ready" && !wd.replacementPending) {
      finish("ready");
    } else {
      if (wd.health === "healthy" && wd.readiness === "not_ready" && wd.readinessStatus === "starting") {
        enterStage("channels");
        if (state.step?.id !== "readiness") step("readiness");
      }
      const failOpen = wd.health === "healthy" && !wd.replacementPending && wd.readiness === "unknown" &&
        typeof wd.readinessProbe === "string" && wd.readinessProbe !== "ok";
      if (!failOpen) state.unverifiedSince = null;
      else if (state.unverifiedSince == null) state.unverifiedSince = t;
      if (failOpen && t - state.unverifiedSince >= kUnverifiedAfterMs) {
        finish("unverified", { reason: "readiness_unknown" });
      } else if (t - state.launchAt > readyBudgetMs + kReadyBackstopGraceMs) {
        finish("failed", { reason: "ready_timeout" });
      }
    }
    return state.outcome;
  };

  const abort = (reason = "shutdown") => finish("aborted", { reason });
  const markNotOnboarded = () => finish("not_onboarded");

  // Plain-data copy for the projections; verdicts that depend on the clock
  // (stalled, stuck) are computed there against the caller's now.
  const snapshot = () => ({
    bootId: state.bootId,
    publicId: state.publicId,
    kind: state.kind,
    kindLabel: kBootKinds[state.kind].label,
    headline: kBootKinds[state.kind].headline,
    startedAt: state.startedAt,
    stage: state.stage,
    stageLabel: state.stage ? kStageLabels[state.stage] : null,
    stages: kBootStages
      .filter((stage) => !stage.optional || state.stages[stage.id].status !== "pending")
      .map((stage) => ({ id: stage.id, label: stage.label, ...state.stages[stage.id] })),
    step: state.step ? { ...state.step } : null,
    steps: state.steps.map((entry) => ({ ...entry })),
    trace: state.trace ? { ...state.trace } : null,
    activitySeq: state.activitySeq,
    lastActivityAt: state.lastActivityAt,
    launchAt: state.launchAt,
    doctor: { ...state.doctor },
    doctorProgress: state.doctorProgress ? { ...state.doctorProgress } : null,
    lockWait: state.outcome === null && state.lockWait ? { ...state.lockWait } : null,
    versions: { ...(readVersions() || {}) },
    estimate: state.estimate ? { ...state.estimate } : null,
    outcome: state.outcome,
    reason: state.reason,
    failedStage: state.failedStage,
    endedAt: state.endedAt,
  });

  refreshEstimate();
  enterStage("preparing", state.startedAt);
  step("server_start");

  return {
    bootId: state.bootId,
    publicId: state.publicId,
    step,
    noteActivity,
    noteDoctorStart,
    noteDoctorProgress,
    noteGatewayOutput,
    observe,
    abort,
    markNotOnboarded,
    isTerminal,
    onTerminal: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot,
  };
};

module.exports = {
  createBootTimeline,
  publicBootIdFor,
  kStalledAfterMs,
  kStuckAfterMs,
  kUnverifiedAfterMs,
  kReadyBackstopGraceMs,
};

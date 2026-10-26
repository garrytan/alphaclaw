import { formatDurationLongMs } from "../../lib/format.js";
import { useNowMs } from "../../hooks/use-now-ms.js";

// The boot card's model (honest boot status, PR 3). Pure: the card and the
// tests call it with a server-anchored clock. Time is proof of life, never
// fake progress — there is no percentage and no bar.
//
//   running   "Usually about 1m 25s — 42s so far" (three comparable
//             successful boots), "Taking longer than usual (about 1m 25s) —
//             2m 3s so far" past it, or just "42s so far"
//   success   "Ready in 1m 25s" for kSuccessLineMs, then the card collapses
//   unverified the gateway is up but readiness could not be confirmed
//   failed    "Last boot stopped at <stage>: <sentence>" until the Gateway
//             card's own state takes over (it reads Running again, or the
//             reducer already names the failure: boot_failed/down/config_error)
export const kSuccessLineMs = 10_000;
export const kUnverifiedLineMs = 60_000;

const kFailureSentences = {
  boot_failed: "AlphaClaw's startup sequence hit an error.",
  config_error: "OpenClaw rejected its configuration.",
  gateway_exited: "The gateway exited before it was ready.",
  readiness_failed: "The gateway started, but its readiness checks failed.",
  ready_timeout: "The gateway didn't become ready in time.",
};
// Reducer states that already say the failure themselves.
const kReducerOwnsFailure = new Set(["boot_failed", "down", "config_error"]);

const kStageStatusText = {
  done: "done",
  running: "in progress",
  failed: "stopped here",
  stopped: "stopped",
  pending: "not started",
};

export const buildBootCardModel = ({ bootProgress = null, serverState = null, nowMs = Date.now(), offsetMs = 0, frozenAtMs = 0 } = {}) => {
  if (!bootProgress || !Array.isArray(bootProgress.stages) || !bootProgress.stages.length) return null;
  const serverNow = (frozenAtMs > 0 ? frozenAtMs : nowMs + offsetMs);
  const startedAt = Number(bootProgress.startedAt) || serverNow;
  const stages = bootProgress.stages.map((stage) => ({
    id: stage.id,
    label: stage.label,
    status: stage.status,
    statusText: kStageStatusText[stage.status] || stage.status,
    current: stage.id === bootProgress.stage && bootProgress.outcome === null,
    durationLabel: Number.isFinite(stage.startedAt) && Number.isFinite(stage.endedAt)
      ? formatDurationLongMs(Math.max(0, stage.endedAt - stage.startedAt))
      : null,
  }));
  const outcome = bootProgress.outcome;
  if (outcome === null) {
    const elapsedMs = Math.max(0, serverNow - startedAt);
    const estimateMs = Number(bootProgress.estimateMs);
    const soFar = `${formatDurationLongMs(elapsedMs)} so far`;
    const timing = Number.isFinite(estimateMs) && estimateMs > 0
      ? elapsedMs <= estimateMs
        ? `Usually about ${formatDurationLongMs(estimateMs)} — ${soFar}`
        : `Taking longer than usual (about ${formatDurationLongMs(estimateMs)}) — ${soFar}`
      : soFar;
    const lockWaitUntil = Number(bootProgress.lockWait?.untilMs);
    const lockWaitLeftMs = Number.isFinite(lockWaitUntil) ? lockWaitUntil - serverNow : NaN;
    const lockWait = !bootProgress.lockWait
      ? null
      : bootProgress.lockWait.kind === "owner_lease_held"
        ? `The previous gateway's OpenClaw state ownership has not lapsed yet (OpenClaw allows a takeover 90 s after its last heartbeat) — ${
            lockWaitLeftMs > 0 ? `retrying in about ${formatDurationLongMs(Math.ceil(lockWaitLeftMs / 1000) * 1000)}` : "retrying now"
          }`
        : "Another OpenClaw process holds the state database — retrying once it releases";
    const lastActivityAt = Number(bootProgress.lastActivityAt);
    const quietMs = Number.isFinite(lastActivityAt) ? Math.max(0, serverNow - lastActivityAt) : 0;
    return {
      kind: "running",
      frozen: frozenAtMs > 0,
      headline: bootProgress.headline || bootProgress.label || null,
      stageLabel: bootProgress.stageLabel || null,
      timing,
      // Doctor's phase while OpenClaw's data upgrade runs: measured bytes of
      // its recovery copy and backups, or the agent databases migrated.
      doctorProgress: bootProgress.stage === "upgrading" ? bootProgress.doctorProgress?.words || null : null,
      // The watchdog is waiting out a transient ownership conflict before it
      // relaunches (boot-progress/timeline.js lock_wait).
      lockWait,
      quiet: bootProgress.stalled ? `No output for ${formatDurationLongMs(quietMs)} — still running` : null,
      stages,
    };
  }
  const endedAt = Number(bootProgress.endedAt) || serverNow;
  if (outcome === "ready") {
    return serverNow - endedAt < kSuccessLineMs
      ? { kind: "success", text: `Ready in ${formatDurationLongMs(Math.max(0, endedAt - startedAt))}`, stages }
      : null;
  }
  if (outcome === "unverified") {
    return serverNow - endedAt < kUnverifiedLineMs
      ? { kind: "unverified", text: "The gateway is up, but AlphaClaw couldn't confirm that its channels finished starting.", stages }
      : null;
  }
  if (outcome === "failed") {
    const state = serverState?.state || null;
    if (state === "running" || kReducerOwnsFailure.has(state)) return null;
    const failed = stages.find((stage) => stage.status === "failed");
    return {
      kind: "failed",
      text: `Last boot stopped at ${failed?.label || "startup"}: ${kFailureSentences[bootProgress.reason] || "it did not finish."}`,
      stages,
    };
  }
  return null;
};

// Server-anchored clock for the card: the frame's compute time against its
// receipt, frozen at the last observation while the status feed is stale.
export const useBootProgress = (shell) => {
  const bootProgress = shell?.bootProgress || null;
  const live = !!bootProgress && (bootProgress.outcome === null || bootProgress.outcome === "ready" || bootProgress.outcome === "unverified");
  const nowMs = useNowMs(1000, { enabled: live });
  const freshness = shell?.statusFreshness || null;
  const offsetMs = freshness?.observedAtMs && freshness?.receivedAtMs ? freshness.observedAtMs - freshness.receivedAtMs : 0;
  const frozen = freshness?.mode === "stale" || (shell?.connectivityMode && shell.connectivityMode !== "online");
  return buildBootCardModel({
    bootProgress,
    serverState: shell?.statusState || null,
    nowMs,
    offsetMs,
    frozenAtMs: frozen ? Number(freshness?.observedAtMs) || 0 : 0,
  });
};

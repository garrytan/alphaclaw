// One timeline, three audiences (honest boot status, PR 3).
//
//   public  GET /boot-progress.json (unauthenticated, beside /health) and the
//           agent actor's status frames: identity, kind label, stage ids,
//           statuses and timestamps, a genuine-activity sequence, the
//           stalled/stuck verdicts and the estimate. NO versions, paths,
//           Doctor or trace text, step names, reasons or errors — built from
//           a whitelist, never by deleting fields from the human shape.
//   human   authenticated human sessions (/api/status, status SSE): the
//           public shape plus versions, the step list, OpenClaw's trace in
//           plain words and liveness.
//   agent   the public shape (the agent decides from the stage and the
//           verdicts; detail text is operator material).
const { kStalledAfterMs, kStuckAfterMs } = require("./timeline");

const kPublicFrameVersion = 1;

const verdictsFor = (snapshot, now) => {
  const quietMs = Math.max(0, now - (snapshot.lastActivityAt || now));
  const live = snapshot.outcome === null;
  return {
    lastActivityAgeMs: quietMs,
    stalled: live && quietMs >= kStalledAfterMs,
    stuck: live && quietMs >= kStuckAfterMs,
  };
};

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

const projectBootProgressPublic = (snapshot, { now = Date.now() } = {}) => {
  if (!snapshot) return null;
  const { stalled, stuck } = verdictsFor(snapshot, now);
  return {
    v: kPublicFrameVersion,
    bootId: String(snapshot.publicId || ""),
    kind: String(snapshot.kind || "restarting"),
    label: String(snapshot.kindLabel || ""),
    stage: snapshot.stage || null,
    stages: (Array.isArray(snapshot.stages) ? snapshot.stages : []).map((stage) => ({
      id: String(stage.id),
      label: String(stage.label),
      status: String(stage.status),
      startedAt: finiteOrNull(stage.startedAt),
      endedAt: finiteOrNull(stage.endedAt),
    })),
    startedAt: finiteOrNull(snapshot.startedAt),
    activitySeq: Number(snapshot.activitySeq) || 0,
    stalled,
    stuck,
    estimateMs: finiteOrNull(snapshot.estimate?.estimateMs),
    outcome: snapshot.outcome || null,
    endedAt: finiteOrNull(snapshot.endedAt),
  };
};

const projectBootProgressHuman = (snapshot, { now = Date.now() } = {}) => {
  const base = projectBootProgressPublic(snapshot, { now });
  if (!base) return null;
  const { lastActivityAgeMs } = verdictsFor(snapshot, now);
  return {
    ...base,
    headline: snapshot.headline || null,
    stageLabel: snapshot.stageLabel || null,
    step: snapshot.step ? { id: snapshot.step.id, label: snapshot.step.label, startedAt: snapshot.step.startedAt } : null,
    steps: (snapshot.steps || []).map((entry) => ({
      id: entry.id,
      label: entry.label,
      stage: entry.stage,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
    })),
    trace: snapshot.trace ? { words: snapshot.trace.words, at: snapshot.trace.at } : null,
    lastActivityAt: finiteOrNull(snapshot.lastActivityAt),
    lastActivityAgeMs,
    estimate: snapshot.estimate || null,
    doctor: snapshot.doctor || null,
    versions: snapshot.versions || null,
    reason: snapshot.reason || null,
    failedStage: snapshot.failedStage || null,
  };
};

const projectBootProgressForActor = (snapshot, { actor = null, now = Date.now() } = {}) =>
  actor?.type === "agent"
    ? projectBootProgressPublic(snapshot, { now })
    : projectBootProgressHuman(snapshot, { now });

// The agent actor's view of a status frame's bootProgress: the human shape
// cut back to the public whitelist (the human shape is a superset of it).
const kPublicFrameKeys = Object.freeze([
  "v", "bootId", "kind", "label", "stage", "stages", "startedAt", "activitySeq",
  "stalled", "stuck", "estimateMs", "outcome", "endedAt",
]);
const pickPublicFrame = (frame) =>
  frame && typeof frame === "object"
    ? Object.fromEntries(kPublicFrameKeys.filter((key) => key in frame).map((key) => [key, frame[key]]))
    : null;

// /health's boot field while bootPhase is not ready: { stage, since }.
const projectHealthBoot = (snapshot) => {
  if (!snapshot?.stage) return null;
  const stage = (snapshot.stages || []).find((entry) => entry.id === snapshot.stage);
  return {
    stage: snapshot.stage,
    since: Number.isFinite(stage?.startedAt) ? new Date(stage.startedAt).toISOString() : null,
  };
};

// The reducer overlay (gateway-state.js): only a non-terminal timeline
// covers the Gateway card.
const projectBootOverlay = (snapshot) =>
  snapshot && snapshot.outcome === null && snapshot.stage
    ? { active: true, kind: snapshot.kind, headline: snapshot.headline, stage: snapshot.stage, stageLabel: snapshot.stageLabel }
    : null;

module.exports = {
  kPublicFrameVersion,
  projectBootProgressPublic,
  projectBootProgressHuman,
  projectBootProgressForActor,
  kPublicFrameKeys,
  pickPublicFrame,
  projectHealthBoot,
  projectBootOverlay,
};

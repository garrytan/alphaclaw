// Automatic-review admission (#87): a settled incident older than this is a
// recap, not a review — it is marked `skipped` (reason `stale`) instead of
// spawning a model call and paging the operator hours after the fact.
// Critical-class incidents (isCriticalClassIncident) ignore the bound.
const kAutoReviewMaxAgeMs = 60 * 60 * 1000;

// --- admission + notification class (#87, one predicate for both) -----------
//
// "Critical class" is decided ONCE here and used by admission
// (classifyAutoReviewEligibility) and by the quiet-mode split at notify time,
// so an incident admitted as critical can never be silenced as informational.
// Reads slim list rows (lib/server/db/watchdog/index.js mapIncidentRow) and
// pre-column fixtures that only carry `summary.severity` / `summary.cause`.
// Incident keys mirror kCriticalEventTypes in watchdog-incidents.js — every
// critical event type that OPENS an incident (has a kIncidentKeyByTrigger
// entry) is listed here, and the overseer test pins that. `auto_repair_paused`
// is deliberately absent: it never opens an incident of its own, it escalates
// the open incident's severity to critical, which the first clause of
// isCriticalClassIncident already catches.
const kCriticalClassIncidentKeys = new Set([
  "crash_loop",
  "config_error",
  "version_mismatch",
]);

const summaryOf = (incident) =>
  incident?.summary && typeof incident.summary === "object" ? incident.summary : null;

const isCriticalClassIncident = (incident) => {
  if (!incident || typeof incident !== "object") return false;
  const summary = summaryOf(incident);
  if ((incident.severity ?? summary?.severity) === "critical") return true;
  if (kCriticalClassIncidentKeys.has(incident.incidentKey)) return true;
  return (incident.cause?.cause ?? summary?.cause?.cause) === "oom";
};

// "Actionable" verdict content (#87 C3/Y3, one predicate for the quiet-mode
// class and the mid-outage delivery gate): the model asked for action, or
// named a concrete one. The label alone ("resolved" vs "monitoring") never
// decides anything.
const isActionableVerdict = (parsed) =>
  !!parsed &&
  (parsed.verdict === "action_needed" ||
    (typeof parsed.action === "string" && parsed.action !== "none"));

// Deterministic admission gate evaluated BEFORE any model call. Pure over a
// settled incident row: { eligible, reason } with reason one of
//   recovered_no_action — resolved, outcome recovered, an EXPLICIT empty
//                         `actions` array (the watchdog did nothing; there
//                         is nothing to review)
//   invalid_resolved_at — the settle time cannot be parsed (age unknowable)
//   stale               — settled more than maxAgeMs ago (a recap, not a review)
// A null/absent summary cannot prove "no action" → eligible unless stale; nor
// can a summary whose `actions` is missing or not an array (#87 G7) — absent
// history is not proof of no action.
// Critical-class incidents are always eligible. `abandoned` rows follow the
// same rules (their outcome is never `recovered`).
// The skip-reason vocabulary is exported: the overseer card's
// kOverseerSkipReasonCopy must carry a line for every reason (drift-guarded
// in tests/frontend/watchdog-overseer-card.test.js).
// Bound of the failed-skip-write memory (markSkipped, #87 G8).
const kSkipMarkedMaxEntries = 500;
const kAutoReviewSkipReasons = Object.freeze([
  "recovered_no_action",
  "invalid_resolved_at",
  "stale",
]);
const [kSkipRecoveredNoAction, kSkipInvalidResolvedAt, kSkipStale] = kAutoReviewSkipReasons;
const classifyAutoReviewEligibility = (
  incident,
  nowMs,
  { maxAgeMs = kAutoReviewMaxAgeMs } = {},
) => {
  if (isCriticalClassIncident(incident)) return { eligible: true, reason: null };
  const summary = summaryOf(incident);
  if (
    incident?.status === "resolved" &&
    summary?.outcome === "recovered" &&
    Array.isArray(summary.actions) &&
    summary.actions.length === 0
  ) {
    return { eligible: false, reason: kSkipRecoveredNoAction };
  }
  const resolvedAtMs = Date.parse(incident?.resolvedAt || "");
  if (!Number.isFinite(resolvedAtMs)) return { eligible: false, reason: kSkipInvalidResolvedAt };
  if (nowMs - resolvedAtMs > maxAgeMs) return { eligible: false, reason: kSkipStale };
  return { eligible: true, reason: null };
};

module.exports = {
  kAutoReviewMaxAgeMs,
  kCriticalClassIncidentKeys,
  isCriticalClassIncident,
  isActionableVerdict,
  kSkipMarkedMaxEntries,
  kAutoReviewSkipReasons,
  classifyAutoReviewEligibility,
};

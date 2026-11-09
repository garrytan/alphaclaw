// Pure pieces of the gateway restart operation (use-restart-operation.js):
// its timings, the policy refusal codes and the persisted record's mapping.

export const kSuccessCollapseMs = 8000;
// A policy refusal is an info line, not an outcome: it clears on its own.
export const kRefusalNoticeMs = 10000;
// A failed outcome retires once the gateway has been observed Running for
// this long — the user can see for themselves that the box recovered.
export const kFailedOutcomeRetireAfterRunningMs = 60000;

// Policy refusals from the restart route (fast gate OR post-lock re-check):
// nothing ran, so there is no failed restart to show — clear the card and
// say why. These codes come from the route's readRestartBlocker. The
// server books them as "skipped" in the incident ledger
// and stamps the record with the code so a reload never resurrects them.
const kRestartPolicyRefusalCodes = new Set([
  "booting",
  "operation_in_progress",
  "relaunch_in_progress",
  "not_onboarded",
]);
export const isPolicyRefusalCode = (code) =>
  typeof code === "string" && kRestartPolicyRefusalCodes.has(code);

// The persisted record carries the same failure fields the SSE error event
// does, so a reload renders the identical sentence.
export const failureFromRecord = (last = {}) => ({
  message: last.errorSummary || "Gateway restart failed",
  hint: last.hint || null,
  code: last.code || null,
  budgetMs: Number.isFinite(Number(last.budgetMs)) ? Number(last.budgetMs) : null,
  how: last.how || null,
  phase: last.failedPhase || null,
  recovery: last.recovery && typeof last.recovery === "object" ? last.recovery : null,
  ...(last.upgrade && typeof last.upgrade === "object" ? { upgrade: last.upgrade } : {}),
  ...(last.retryTarget ? { retryTarget: last.retryTarget } : {}),
});

// The persisted record's phase timestamps seed the status line (phase +
// server-anchored elapsed time) before the SSE replay lands.
export const stepsFromPhaseAt = (phaseAt) =>
  Object.entries(phaseAt && typeof phaseAt === "object" ? phaseAt : {})
    .map(([name, at]) => ({ name, status: "running", at: Number(at) }))
    .filter((step) => Number.isFinite(step.at))
    .sort((a, b) => a.at - b.at);

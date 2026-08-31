// Shared model for a failed Codex status CHECK: a failed check keeps the
// last-known status and never claims "last known" data that doesn't exist —
// pass a real prior status object only when a check has actually succeeded,
// else null so the headline says the status is unknown. Consumed by both
// Codex status render sites (providers tab, models-tab provider auth card)
// so the wording can never drift apart.
export const buildCodexStatusErrorModel = (lastKnownStatus, errorMessage) => ({
  headline: lastKnownStatus
    ? "Status check failed — showing the last known Codex status"
    : "Status check failed — Codex status unknown",
  error: typeof errorMessage === "string" ? errorMessage : "",
});

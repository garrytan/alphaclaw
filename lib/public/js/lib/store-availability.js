// Quiet-period marker on the credential-store reads (GET /api/models/config,
// GET /api/models/auth, GET /api/codex/status): while the state-DB backup
// barrier is held the server answers `{ unavailable: true, reason:
// "backup_in_progress" }` ADDITIVELY beside the usual fields — the configured
// credentials are unreadable for a moment, not removed. Every consumer keeps
// its last-known values and says so, instead of rendering an empty profile
// list or "Not connected" over a live auth.
export const kStoreUnavailableReasonBackup = "backup_in_progress";

export const isStoreUnavailable = (payload) => payload?.unavailable === true;

const kStoreUnavailableWhy = {
  [kStoreUnavailableReasonBackup]: "during a backup",
};

// One sentence for every surface: what is unavailable, why, and whether what
// is on screen is last-known data or nothing at all — never an implied
// "removed"/"disconnected".
export const buildStoreUnavailableLine = ({
  payload = null,
  hasLastKnown = false,
  subject = "Credential store",
  lastKnownLabel = "showing the last known credentials",
  nothingLabel = "nothing to show until it finishes",
} = {}) => {
  const why = kStoreUnavailableWhy[payload?.reason] || "right now";
  return `${subject} unavailable ${why} — ${hasLastKnown ? lastKnownLabel : nothingLabel}.`;
};

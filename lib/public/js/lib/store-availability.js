// Quiet-period marker on the credential-store reads (GET /api/models/config,
// GET /api/models/auth, GET /api/codex/status): while the state-DB backup
// barrier is held the server answers `{ unavailable: true, reason:
// "backup_in_progress" }` ADDITIVELY beside the usual fields — the configured
// credentials are unreadable for a moment, not removed. Every consumer keeps
// its last-known values and says so, instead of rendering an empty profile
// list or "Not connected" over a live auth.
export const kStoreUnavailableReasonBackup = "backup_in_progress";

export const isStoreUnavailable = (payload) => payload?.unavailable === true;

// While a read is unavailable nothing else re-reads the store (the status
// reads are mount-only; the 2 s deferred-save recheck arms only after a
// READABLE read), so the "unavailable during a backup" line would outlive the
// barrier until the operator acted. Each adoption site arms ONE bounded timer
// per unavailable read — re-armed while the next read is still unavailable,
// dropped once a readable read lands, cleared on unmount. 30 s keeps the
// ~120 s barrier to a handful of extra reads and never polls a healthy store.
export const kStoreUnavailableRecheckMs = 30000;

// `ref` is the site's `useRef(null)` timer slot; `recheck` issues the site's
// own status read. Returns true when a timer was armed by this call.
export const armStoreUnavailableRecheck = (ref, recheck) => {
  if (!ref || ref.current) return false;
  ref.current = setTimeout(() => {
    ref.current = null;
    recheck();
  }, kStoreUnavailableRecheckMs);
  return true;
};

export const cancelStoreUnavailableRecheck = (ref) => {
  if (!ref?.current) return;
  clearTimeout(ref.current);
  ref.current = null;
};

// One call per adopted read: arm while unavailable, stop once readable.
export const settleStoreUnavailableRecheck = (ref, { unavailable, recheck }) => {
  if (unavailable) return armStoreUnavailableRecheck(ref, recheck);
  cancelStoreUnavailableRecheck(ref);
  return false;
};

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

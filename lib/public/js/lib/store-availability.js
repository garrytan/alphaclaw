// "Store unavailable" marker on the credential-store reads (GET
// /api/models/config, GET /api/models/auth, GET /api/codex/status): when the
// auth store cannot be read the server answers `{ unavailable: true, reason:
// "AUTH_STORE_UNREADABLE" }` ADDITIVELY beside the usual fields — the
// configured credentials are unreadable, not removed. Every consumer keeps
// its last-known values and says so, instead of rendering an empty profile
// list or "Not connected" over a live auth.

export const isStoreUnavailable = (payload) => payload?.unavailable === true;

// While a read is unavailable nothing else re-reads the store (the status
// reads are mount-only), so the "unavailable" line would outlive a transient
// failure (a busy state db) until the operator acted. Each adoption site arms
// ONE bounded timer per unavailable read — re-armed while the next read is
// still unavailable, dropped once a readable read lands, cleared on unmount.
// 30 s keeps the extra reads few and never polls a healthy store.
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

// One sentence for every surface: what is unavailable, why, and whether what
// is on screen is last-known data or nothing at all — never an implied
// "removed"/"disconnected".
export const buildStoreUnavailableLine = ({
  payload = null,
  hasLastKnown = false,
  subject = "Credential store",
  lastKnownLabel = "showing the last known credentials",
  nothingLabel = "nothing to show",
} = {}) => {
  if (payload?.reason === "AUTH_STORE_UNREADABLE") {
    return `${subject} unavailable — ${hasLastKnown ? lastKnownLabel : "credentials have not been checked"}. Retry shortly. If this persists, use Doctor to diagnose the auth store or restore a verified backup.`;
  }
  return `${subject} unavailable right now — ${hasLastKnown ? lastKnownLabel : nothingLabel}.`;
};

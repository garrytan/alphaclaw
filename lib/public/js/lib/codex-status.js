import {
  buildStoreUnavailableLine,
  isStoreUnavailable,
  kStoreUnavailableReasonBackup,
} from "./store-availability.js";

// Re-exported so the Codex render sites import one module for all of it.
export { isStoreUnavailable };

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

// A status READ that came back `unavailable` (state-DB quiet period): the
// server could not open the auth store, so `connected: false` in that payload
// is a placeholder, not a checked status. Keep the last-known status (when one
// was ever checked) and overlay the marker so render sites can say
// "unavailable during a backup" — `known` does not advance, because nothing
// about the connection was learned. Every other read is adopted as-is and
// marks the status as checked.
export const applyCodexStatusRead = ({
  previous = null,
  previousKnown = false,
  next = null,
} = {}) => {
  if (isStoreUnavailable(next)) {
    const base =
      previousKnown && previous && typeof previous === "object"
        ? previous
        : { connected: false };
    return {
      status: {
        ...base,
        unavailable: true,
        reason: next.reason || kStoreUnavailableReasonBackup,
      },
      known: previousKnown,
    };
  }
  return {
    status: next && typeof next === "object" ? next : { connected: false },
    known: true,
  };
};

// The OAuth callback / manual exchange answer `deferred: true` when the
// tokens were exchanged but the profile write is held until the backup
// barrier lifts: the connection succeeded, the save has not happened yet.
export const isCodexDeferredSuccess = (payload) => payload?.deferred === true;
export const kCodexConnectedMessage = "Codex connected";
export const kCodexConnectedDeferredMessage =
  "Codex connected — saved after the backup finishes";
export const buildCodexConnectedMessage = (payload = null) =>
  isCodexDeferredSuccess(payload)
    ? kCodexConnectedDeferredMessage
    : kCodexConnectedMessage;

// Badge copy for every Codex status render site (providers tab, models-tab
// auth card, onboarding step). Precedence: a deferred save that the store
// has not confirmed yet > store unavailable > checked connected / not
// connected > never checked.
export const kCodexStatusBadges = {
  connected: { id: "connected", label: "Connected", tone: "success" },
  notConnected: { id: "not-connected", label: "Not connected", tone: "warning" },
  unknown: { id: "unknown", label: "Status unknown", tone: "neutral" },
  unavailable: {
    id: "unavailable",
    label: "Unavailable during backup",
    tone: "warning",
  },
  deferredSave: {
    id: "deferred-save",
    label: kCodexConnectedDeferredMessage.replace(/^Codex connected/, "Connected"),
    tone: "info",
  },
};

export const buildCodexStatusBadgeModel = ({
  codexStatus = null,
  codexStatusKnown = false,
  deferredSavePending = false,
} = {}) => {
  const unavailable = isStoreUnavailable(codexStatus);
  const connected = codexStatus?.connected === true;
  if (deferredSavePending && (unavailable || !connected)) {
    return kCodexStatusBadges.deferredSave;
  }
  if (unavailable) return kCodexStatusBadges.unavailable;
  if (connected) return kCodexStatusBadges.connected;
  if (codexStatusKnown) return kCodexStatusBadges.notConnected;
  return kCodexStatusBadges.unknown;
};

// The explanatory line under an "Unavailable during backup" badge; null when
// the store is readable so render sites can inline it unconditionally.
export const buildCodexStoreUnavailableLine = ({
  codexStatus = null,
  codexStatusKnown = false,
} = {}) =>
  isStoreUnavailable(codexStatus)
    ? buildStoreUnavailableLine({
        payload: codexStatus,
        hasLastKnown: codexStatusKnown,
        subject: "Credential store",
        lastKnownLabel: `showing the last known Codex status (${
          codexStatus.connected ? "connected" : "not connected"
        })`,
        nothingLabel: "Codex status unknown until it finishes",
      })
    : null;

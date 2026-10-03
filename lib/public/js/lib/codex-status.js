import {
  buildStoreUnavailableLine,
  isStoreUnavailable,
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

// A status READ that came back `unavailable`: the server could not open the
// auth store, so `connected: false` in that payload is a placeholder, not a
// checked status. Keep the last-known status (when one was ever checked) and
// overlay the marker so render sites can say the store is unavailable —
// `known` does not advance, because nothing about the connection was
// learned. Every other read is adopted as-is and marks the status as checked.
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
        reason: next.reason || null,
      },
      known: previousKnown,
    };
  }
  return {
    status: next && typeof next === "object" ? next : { connected: false },
    known: true,
  };
};

export const kCodexConnectedMessage = "Codex connected";
export const buildCodexConnectedMessage = (payload = null) =>
  payload?.restartRequired
    ? "Codex credentials saved — restart the gateway to apply the change"
    : kCodexConnectedMessage;

// Badge copy for every Codex status render site (providers tab, models-tab
// auth card, onboarding step). Precedence: store unavailable > checked
// connected / not connected > never checked.
export const kCodexStatusBadges = {
  connected: { id: "connected", label: "Connected", tone: "success" },
  notConnected: { id: "not-connected", label: "Not connected", tone: "warning" },
  unknown: { id: "unknown", label: "Status unknown", tone: "neutral" },
  unreadable: { id: "unreadable", label: "Auth store unavailable", tone: "warning" },
};

export const buildCodexStatusBadgeModel = ({
  codexStatus = null,
  codexStatusKnown = false,
} = {}) => {
  if (isStoreUnavailable(codexStatus)) return kCodexStatusBadges.unreadable;
  if (codexStatus?.connected === true) return kCodexStatusBadges.connected;
  if (codexStatusKnown) return kCodexStatusBadges.notConnected;
  return kCodexStatusBadges.unknown;
};

// The explanatory line under an "Auth store unavailable" badge; null when
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
        nothingLabel: "Codex status unknown",
      })
    : null;

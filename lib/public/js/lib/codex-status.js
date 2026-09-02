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
        // The fate of a held profile write is server truth even while the
        // store is closed — never masked by the last-known overlay.
        ...(next.deferredWrite && typeof next.deferredWrite === "object"
          ? { deferredWrite: next.deferredWrite }
          : {}),
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

// Deferred-save tracking, shared by the three Codex render sites. The
// "Connected — saved after the backup finishes" badge is a CLAIM about a
// write that has not happened yet, so it must be able to end three ways —
// saved, failed, or never seen — never only on `connected: true` (a lost
// write would otherwise leave the UI asserting a save forever).
//
// GET /api/codex/status publishes the server's own verdict when it has one:
// `deferredWrite: { state: "pending" | "saved" | "failed", reason }`. That
// verdict wins. Servers without the field fall back to the read count: a
// READABLE status (the barrier has lifted) that still says connected:false
// on `kCodexDeferredSaveDisconnectedReadLimit` consecutive reads means the
// held write never landed — the first such read schedules ONE follow-up
// read `kCodexDeferredSaveRecheckMs` later so the verdict does not wait on
// the operator (the status is not otherwise polled).
export const kCodexDeferredWriteStates = Object.freeze({
  pending: "pending",
  saved: "saved",
  failed: "failed",
});
export const kCodexDeferredSaveIdle = Object.freeze({
  pending: false,
  disconnectedReads: 0,
  failedReason: null,
});
export const kCodexDeferredSaveDisconnectedReadLimit = 2;
export const kCodexDeferredSaveRecheckMs = 2000;
export const kCodexDeferredSaveNotFoundReason =
  "the saved connection did not appear after the backup";
export const kCodexDeferredSaveUnknownReason = "unknown error";

export const beginCodexDeferredSave = () => ({
  pending: true,
  disconnectedReads: 0,
  failedReason: null,
});

// The deferred-save state right after an exchange succeeded: a deferred
// answer opens the pending claim; a direct save retires any earlier failure
// (the operator just reconnected — the "was not saved" line is stale).
export const applyCodexExchangeOutcome = (payload = null) =>
  isCodexDeferredSuccess(payload)
    ? beginCodexDeferredSave()
    : kCodexDeferredSaveIdle;

const readDeferredWriteState = (status) => {
  const write = status?.deferredWrite;
  return write && typeof write === "object" && typeof write.state === "string"
    ? write.state
    : null;
};

// One status READ folded into the deferred-save state. Pure; returns the
// same object when nothing changed so callers can compare by identity.
export const applyCodexDeferredSaveRead = (previous = null, status = null) => {
  const state =
    previous && typeof previous === "object" ? previous : kCodexDeferredSaveIdle;
  const writeState = readDeferredWriteState(status);
  const unavailable = isStoreUnavailable(status);
  const connected = status?.connected === true;
  if (writeState === kCodexDeferredWriteStates.failed) {
    // Server verdict — surfaced whether or not THIS client saw the deferred
    // answer (another tab, or a reload, may have started the exchange).
    const reason = String(status.deferredWrite.reason || "").trim();
    return {
      pending: false,
      disconnectedReads: 0,
      failedReason: reason || kCodexDeferredSaveUnknownReason,
    };
  }
  if (!state.pending) {
    // A shown failure stands until the store proves a connection again.
    return state.failedReason && connected && !unavailable
      ? kCodexDeferredSaveIdle
      : state;
  }
  // Barrier still held, or the server says it is still holding the write:
  // nothing was learned, so no strike either.
  if (unavailable || writeState === kCodexDeferredWriteStates.pending) {
    return state;
  }
  if (connected || writeState === kCodexDeferredWriteStates.saved) {
    return kCodexDeferredSaveIdle;
  }
  const disconnectedReads = state.disconnectedReads + 1;
  if (disconnectedReads >= kCodexDeferredSaveDisconnectedReadLimit) {
    return {
      pending: false,
      disconnectedReads: 0,
      failedReason: kCodexDeferredSaveNotFoundReason,
    };
  }
  return { ...state, disconnectedReads };
};

// True exactly when a read just scored a strike that has not yet decided
// the claim — the caller schedules the follow-up read that will.
export const needsCodexDeferredSaveRecheck = (before, after) =>
  after?.pending === true &&
  after.disconnectedReads > (before?.disconnectedReads || 0) &&
  after.disconnectedReads < kCodexDeferredSaveDisconnectedReadLimit;

// The line under the badge once the claim ended in failure; null otherwise.
export const buildCodexDeferredSaveFailedLine = (failedReason = null) =>
  typeof failedReason === "string" && failedReason
    ? `Codex connection was not saved (${failedReason}) — reconnect`
    : null;

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

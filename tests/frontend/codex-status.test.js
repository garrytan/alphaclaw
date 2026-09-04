import { describe, expect, it } from "vitest";
import {
  applyCodexDeferredSaveRead,
  applyCodexExchangeOutcome,
  applyCodexStatusRead,
  beginCodexDeferredSave,
  buildCodexConnectedMessage,
  buildCodexDeferredSaveFailedLine,
  buildCodexStatusBadgeModel,
  buildCodexStatusErrorModel,
  buildCodexStoreUnavailableLine,
  isCodexDeferredSuccess,
  kCodexConnectedDeferredMessage,
  kCodexDeferredSaveDisconnectedReadLimit,
  kCodexDeferredSaveIdle,
  kCodexDeferredSaveNotFoundReason,
  kCodexDeferredSaveRecheckMs,
  kCodexStatusBadges,
  needsCodexDeferredSaveRecheck,
} from "../../lib/public/js/lib/codex-status.js";
import {
  buildStoreUnavailableLine,
  isStoreUnavailable,
} from "../../lib/public/js/lib/store-availability.js";

const kUnavailable = { connected: false, unavailable: true, reason: "backup_in_progress" };

describe("frontend/codex-status quiet-period reads (store unavailable)", () => {
  it("an unavailable read keeps the last-known status under the marker and does not advance `known`", () => {
    const read = applyCodexStatusRead({
      previous: { connected: true, profileId: "openai-codex:default" },
      previousKnown: true,
      next: kUnavailable,
    });
    expect(read).toEqual({
      status: {
        connected: true,
        profileId: "openai-codex:default",
        unavailable: true,
        reason: "backup_in_progress",
      },
      known: true,
    });
    expect(isStoreUnavailable(read.status)).toBe(true);
  });

  it("a FIRST read that is unavailable is not a checked status — connected:false stays a placeholder", () => {
    const read = applyCodexStatusRead({ previous: { connected: false }, previousKnown: false, next: kUnavailable });
    expect(read.known).toBe(false);
    expect(read.status).toEqual(kUnavailable);
    // A missing reason still names the quiet period.
    expect(
      applyCodexStatusRead({ next: { unavailable: true } }).status.reason,
    ).toBe("backup_in_progress");
  });

  it("a readable status is adopted as-is and counts as checked; a bare/absent payload reads as not connected", () => {
    expect(
      applyCodexStatusRead({ previous: kUnavailable, previousKnown: false, next: { connected: true } }),
    ).toEqual({ status: { connected: true }, known: true });
    expect(applyCodexStatusRead({ next: null })).toEqual({
      status: { connected: false },
      known: true,
    });
  });

  it("badge precedence: deferred save > unavailable > connected > not connected > unknown", () => {
    expect(
      buildCodexStatusBadgeModel({ codexStatus: kUnavailable, codexStatusKnown: false, deferredSavePending: true }),
    ).toBe(kCodexStatusBadges.deferredSave);
    expect(kCodexStatusBadges.deferredSave.label).toBe("Connected — saved after the backup finishes");
    // Once the store confirms the saved connection the deferred badge yields.
    expect(
      buildCodexStatusBadgeModel({ codexStatus: { connected: true }, codexStatusKnown: true, deferredSavePending: true }),
    ).toBe(kCodexStatusBadges.connected);
    expect(buildCodexStatusBadgeModel({ codexStatus: kUnavailable, codexStatusKnown: true })).toBe(
      kCodexStatusBadges.unavailable,
    );
    expect(kCodexStatusBadges.unavailable).toEqual(
      expect.objectContaining({ label: "Unavailable during backup", tone: "warning" }),
    );
    expect(buildCodexStatusBadgeModel({ codexStatus: { connected: true } })).toBe(kCodexStatusBadges.connected);
    expect(buildCodexStatusBadgeModel({ codexStatus: { connected: false }, codexStatusKnown: true })).toBe(
      kCodexStatusBadges.notConnected,
    );
    expect(buildCodexStatusBadgeModel({ codexStatus: { connected: false }, codexStatusKnown: false })).toBe(
      kCodexStatusBadges.unknown,
    );
    expect(buildCodexStatusBadgeModel()).toBe(kCodexStatusBadges.unknown);
  });

  it("the unavailable line says last-known vs nothing, and is null when the store is readable", () => {
    expect(
      buildCodexStoreUnavailableLine({
        codexStatus: { ...kUnavailable, connected: true },
        codexStatusKnown: true,
      }),
    ).toBe(
      "Credential store unavailable during a backup — showing the last known Codex status (connected).",
    );
    expect(buildCodexStoreUnavailableLine({ codexStatus: kUnavailable, codexStatusKnown: false })).toBe(
      "Credential store unavailable during a backup — Codex status unknown until it finishes.",
    );
    expect(buildCodexStoreUnavailableLine({ codexStatus: { connected: true }, codexStatusKnown: true })).toBeNull();
    // The generic store line (models config / auth) shares the same shape.
    expect(buildStoreUnavailableLine({ payload: kUnavailable, hasLastKnown: true })).toBe(
      "Credential store unavailable during a backup — showing the last known credentials.",
    );
    expect(buildStoreUnavailableLine({ payload: kUnavailable, hasLastKnown: false })).toBe(
      "Credential store unavailable during a backup — nothing to show until it finishes.",
    );
    // An unrecognised reason never claims "during a backup".
    expect(buildStoreUnavailableLine({ payload: { unavailable: true, reason: "x" } })).toContain(
      "unavailable right now",
    );
  });

  it("a deferred success (202 / postMessage deferred:true) gets the honest connected message", () => {
    expect(isCodexDeferredSuccess({ ok: true, deferred: true })).toBe(true);
    expect(isCodexDeferredSuccess({ codex: "success" })).toBe(false);
    expect(buildCodexConnectedMessage({ ok: true, deferred: true, reason: "backup_in_progress" })).toBe(
      kCodexConnectedDeferredMessage,
    );
    expect(kCodexConnectedDeferredMessage).toBe("Codex connected — saved after the backup finishes");
    expect(buildCodexConnectedMessage({ ok: true })).toBe("Codex connected");
    expect(buildCodexConnectedMessage(null)).toBe("Codex connected");
  });
});

describe("frontend/codex-status error model", () => {
  it("claims 'last known' only when a checked prior status exists", () => {
    const model = buildCodexStatusErrorModel(
      { connected: true },
      "status endpoint down",
    );
    expect(model.headline).toBe(
      "Status check failed — showing the last known Codex status",
    );
    expect(model.error).toBe("status endpoint down");
  });

  it("says the status is unknown when the FIRST check fails (no prior data)", () => {
    const model = buildCodexStatusErrorModel(null, "boom");
    expect(model.headline).toBe("Status check failed — Codex status unknown");
    expect(model.error).toBe("boom");
  });

  it("a genuinely-checked disconnected status still counts as last-known", () => {
    expect(
      buildCodexStatusErrorModel({ connected: false }, "boom").headline,
    ).toContain("showing the last known");
  });

  it("normalizes a missing or non-string message to an empty string", () => {
    expect(buildCodexStatusErrorModel(null, undefined).error).toBe("");
    expect(buildCodexStatusErrorModel({ connected: true }, true).error).toBe(
      "",
    );
  });
});

// X7: the "saved after the backup finishes" badge is a claim about a write
// that has not happened — it must end as saved, failed, or never seen; a lost
// write must never leave the UI asserting a save forever.
describe("frontend/codex-status deferred-save claim (server deferredWrite verdict + read count)", () => {
  const pending = () => beginCodexDeferredSave();

  it("an exchange outcome opens the claim only for deferred:true; a direct save retires an earlier failure", () => {
    expect(applyCodexExchangeOutcome({ ok: true, deferred: true })).toEqual({
      pending: true,
      disconnectedReads: 0,
      failedReason: null,
    });
    expect(applyCodexExchangeOutcome({ ok: true })).toBe(kCodexDeferredSaveIdle);
    expect(applyCodexExchangeOutcome({ codex: "success", deferred: true }).pending).toBe(true);
  });

  it("server verdicts: pending keeps the badge, saved clears it, failed clears it and names the reason", () => {
    const p = pending();
    expect(
      applyCodexDeferredSaveRead(p, { connected: false, deferredWrite: { state: "pending" } }),
    ).toBe(p);
    expect(
      applyCodexDeferredSaveRead(p, { connected: true, deferredWrite: { state: "saved" } }),
    ).toBe(kCodexDeferredSaveIdle);
    // `saved` is trusted even if the profile read is momentarily disconnected.
    expect(
      applyCodexDeferredSaveRead(p, { connected: false, deferredWrite: { state: "saved" } }),
    ).toBe(kCodexDeferredSaveIdle);
    const failed = applyCodexDeferredSaveRead(p, {
      connected: false,
      deferredWrite: { state: "failed", reason: "store closed for a second backup" },
    });
    expect(failed).toEqual({
      pending: false,
      disconnectedReads: 0,
      failedReason: "store closed for a second backup",
    });
    expect(buildCodexDeferredSaveFailedLine(failed.failedReason)).toBe(
      "Codex connection was not saved (store closed for a second backup) — reconnect",
    );
    // A failed verdict without a reason still says why in words.
    expect(
      applyCodexDeferredSaveRead(p, { connected: false, deferredWrite: { state: "failed" } })
        .failedReason,
    ).toBe("unknown error");
    expect(buildCodexDeferredSaveFailedLine(null)).toBeNull();
    expect(buildCodexDeferredSaveFailedLine("")).toBeNull();
  });

  it("a failed verdict is surfaced even when THIS client never saw the deferred answer (reload / other tab)", () => {
    const failed = applyCodexDeferredSaveRead(kCodexDeferredSaveIdle, {
      connected: false,
      deferredWrite: { state: "failed", reason: "x" },
    });
    expect(failed.failedReason).toBe("x");
    // …and it stands until the store proves a connection again.
    expect(applyCodexDeferredSaveRead(failed, { connected: false })).toBe(failed);
    expect(applyCodexDeferredSaveRead(failed, kUnavailable)).toBe(failed);
    expect(applyCodexDeferredSaveRead(failed, { connected: true })).toBe(kCodexDeferredSaveIdle);
    // Idle stays idle by identity on ordinary reads.
    expect(applyCodexDeferredSaveRead(kCodexDeferredSaveIdle, { connected: false })).toBe(
      kCodexDeferredSaveIdle,
    );
    expect(applyCodexDeferredSaveRead(null, { connected: true })).toBe(kCodexDeferredSaveIdle);
  });

  it("without a server verdict: unavailable reads teach nothing; connected clears; the SECOND readable disconnected read fails the claim", () => {
    const p = pending();
    expect(applyCodexDeferredSaveRead(p, kUnavailable)).toBe(p);
    expect(applyCodexDeferredSaveRead(p, { connected: true })).toBe(kCodexDeferredSaveIdle);

    const strike1 = applyCodexDeferredSaveRead(p, { connected: false });
    expect(strike1).toEqual({ pending: true, disconnectedReads: 1, failedReason: null });
    // The first strike is what schedules the follow-up read.
    expect(needsCodexDeferredSaveRecheck(p, strike1)).toBe(true);
    expect(needsCodexDeferredSaveRecheck(p, p)).toBe(false);
    expect(needsCodexDeferredSaveRecheck(strike1, strike1)).toBe(false);
    expect(kCodexDeferredSaveRecheckMs).toBe(2000);
    // The badge still says pending after one strike.
    expect(
      buildCodexStatusBadgeModel({
        codexStatus: { connected: false },
        codexStatusKnown: true,
        deferredSavePending: strike1.pending,
      }),
    ).toBe(kCodexStatusBadges.deferredSave);
    // An unavailable read in between does not reset or add strikes.
    expect(applyCodexDeferredSaveRead(strike1, kUnavailable)).toBe(strike1);

    const strike2 = applyCodexDeferredSaveRead(strike1, { connected: false });
    expect(kCodexDeferredSaveDisconnectedReadLimit).toBe(2);
    expect(strike2).toEqual({
      pending: false,
      disconnectedReads: 0,
      failedReason: kCodexDeferredSaveNotFoundReason,
    });
    expect(needsCodexDeferredSaveRecheck(strike1, strike2)).toBe(false);
    expect(buildCodexDeferredSaveFailedLine(strike2.failedReason)).toBe(
      "Codex connection was not saved (the saved connection did not appear after the backup) — reconnect",
    );
    expect(
      buildCodexStatusBadgeModel({
        codexStatus: { connected: false },
        codexStatusKnown: true,
        deferredSavePending: strike2.pending,
      }),
    ).toBe(kCodexStatusBadges.notConnected);
  });

  it("applyCodexStatusRead carries the server's deferredWrite verdict through the unavailable overlay", () => {
    const read = applyCodexStatusRead({
      previous: { connected: true },
      previousKnown: true,
      next: { ...kUnavailable, deferredWrite: { state: "failed", reason: "x" } },
    });
    expect(read.status).toEqual({
      connected: true,
      unavailable: true,
      reason: "backup_in_progress",
      deferredWrite: { state: "failed", reason: "x" },
    });
    // No verdict → no field invented.
    expect("deferredWrite" in applyCodexStatusRead({ next: kUnavailable }).status).toBe(false);
  });
});

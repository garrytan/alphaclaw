import { describe, expect, it } from "vitest";
import {
  applyCodexStatusRead,
  buildCodexConnectedMessage,
  buildCodexStatusBadgeModel,
  buildCodexStatusErrorModel,
  buildCodexStoreUnavailableLine,
  kCodexStatusBadges,
} from "../../lib/public/js/lib/codex-status.js";
import {
  buildStoreUnavailableLine,
  isStoreUnavailable,
} from "../../lib/public/js/lib/store-availability.js";

const kUnavailable = { connected: false, unavailable: true, reason: "AUTH_STORE_UNREADABLE" };

describe("frontend/codex-status unavailable reads (store unreadable)", () => {
  it("does not describe an unreadable auth store as a disconnected account", () => {
    const badge = buildCodexStatusBadgeModel({ codexStatus: kUnavailable });
    expect(badge).toEqual({ id: "unreadable", label: "Auth store unavailable", tone: "warning" });
    expect(buildCodexConnectedMessage({ restartRequired: true })).toBe("Codex credentials saved — restart the gateway to apply the change");
  });

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
        reason: "AUTH_STORE_UNREADABLE",
      },
      known: true,
    });
    expect(isStoreUnavailable(read.status)).toBe(true);
  });

  it("a FIRST read that is unavailable is not a checked status — connected:false stays a placeholder", () => {
    const read = applyCodexStatusRead({ previous: { connected: false }, previousKnown: false, next: kUnavailable });
    expect(read.known).toBe(false);
    expect(read.status).toEqual(kUnavailable);
    // A missing reason is not invented.
    expect(
      applyCodexStatusRead({ next: { unavailable: true } }).status.reason,
    ).toBeNull();
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

  it("badge precedence: unavailable > connected > not connected > unknown", () => {
    expect(buildCodexStatusBadgeModel({ codexStatus: { ...kUnavailable, connected: true }, codexStatusKnown: true })).toBe(
      kCodexStatusBadges.unreadable,
    );
    expect(buildCodexStatusBadgeModel({ codexStatus: { unavailable: true, reason: null } })).toBe(
      kCodexStatusBadges.unreadable,
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
      "Credential store unavailable — showing the last known Codex status (connected). Retry shortly. If this persists, use Doctor to diagnose the auth store or restore a verified backup.",
    );
    expect(buildCodexStoreUnavailableLine({ codexStatus: kUnavailable, codexStatusKnown: false })).toContain(
      "credentials have not been checked",
    );
    expect(buildCodexStoreUnavailableLine({ codexStatus: { connected: true }, codexStatusKnown: true })).toBeNull();
    // Without a recognised reason the generic line keeps the same shape.
    const generic = { unavailable: true, reason: null };
    expect(buildStoreUnavailableLine({ payload: generic, hasLastKnown: true })).toBe(
      "Credential store unavailable right now — showing the last known credentials.",
    );
    expect(buildStoreUnavailableLine({ payload: generic, hasLastKnown: false })).toBe(
      "Credential store unavailable right now — nothing to show.",
    );
    expect(buildCodexStoreUnavailableLine({ codexStatus: generic, codexStatusKnown: false })).toBe(
      "Credential store unavailable right now — Codex status unknown.",
    );
  });

  it("a successful exchange gets the connected message", () => {
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

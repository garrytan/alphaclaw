import { describe, expect, it } from "vitest";

import {
  buildChannelDeletePairingRowsFailedMessage,
  describeChannelDeleteOutcome,
  kChannelDeletePairingRowsDeferredMessage,
  kChannelDeleteRestartFailedSentence,
  kChannelDeletedMessage,
} from "../../lib/public/js/lib/channel-delete-outcome.js";

// DELETE /api/channels/accounts rides additive outcome flags beside `ok:true`
// (lib/server/agents/channels.js pairingRowsOutcomeFields). AGENTS.md: a
// failed pairing-row clear after a channel delete is reported, never a clean
// delete — both UI callers read the result through this one helper.
describe("frontend/channel-delete-outcome", () => {
  it("a bare ok:true (or no body at all) is a clean success", () => {
    expect(describeChannelDeleteOutcome({ ok: true })).toEqual({
      message: kChannelDeletedMessage,
      level: "success",
      restartRequired: false,
    });
    expect(describeChannelDeleteOutcome(undefined)).toEqual({
      message: kChannelDeletedMessage,
      level: "success",
      restartRequired: false,
    });
    expect(describeChannelDeleteOutcome({})).toEqual(
      expect.objectContaining({ level: "success" }),
    );
  });

  it("pairingRowsCleanupFailed is an ERROR that names the reason and the real remedy (re-add then delete, or clear by hand) — never 're-run the delete'", () => {
    const outcome = describeChannelDeleteOutcome({
      ok: true,
      pairingRowsCleanupFailed: true,
      pairingRowsCleanupError: "no such table: channel_pairings",
    });
    expect(outcome.level).toBe("error");
    expect(outcome.restartRequired).toBe(false);
    expect(outcome.message).toBe(
      buildChannelDeletePairingRowsFailedMessage("no such table: channel_pairings"),
    );
    expect(outcome.message).toContain("STILL authorized");
    expect(outcome.message).toContain("no such table: channel_pairings");
    expect(outcome.message).toContain("Re-add the account and delete it again");
    expect(outcome.message).toContain("clear the rows by hand");
    // The account is already gone from config, so a repeat delete would 404.
    expect(outcome.message).not.toMatch(/re-run the delete/i);
    expect(outcome.message).not.toBe(kChannelDeletedMessage);
    // A missing reason is still an honest error, never an empty parenthesis.
    expect(
      describeChannelDeleteOutcome({ ok: true, pairingRowsCleanupFailed: true }).message,
    ).toContain("(unknown error)");
  });

  it("pairingRowsCleanupDeferred is a WARNING saying the paired users stay authorized until the backup finishes", () => {
    const outcome = describeChannelDeleteOutcome({
      ok: true,
      pairingRowsCleanupDeferred: true,
    });
    expect(outcome).toEqual({
      message: kChannelDeletePairingRowsDeferredMessage,
      level: "warning",
      restartRequired: false,
    });
    expect(outcome.message).toContain("stay authorized until the running backup finishes");
  });

  it("gatewayRestartFailed raises the restart banner and is appended to whichever pairing verdict applies", () => {
    const restartOnly = describeChannelDeleteOutcome({ ok: true, gatewayRestartFailed: true });
    expect(restartOnly.restartRequired).toBe(true);
    expect(restartOnly.level).toBe("warning");
    expect(restartOnly.message).toBe(
      `${kChannelDeletedMessage}. ${kChannelDeleteRestartFailedSentence}`,
    );

    // Combined with a failed clear the level stays ERROR and both facts are
    // in the message — the more severe verdict is never masked.
    const both = describeChannelDeleteOutcome({
      ok: true,
      gatewayRestartFailed: true,
      pairingRowsCleanupFailed: true,
      pairingRowsCleanupError: "disk I/O error",
    });
    expect(both.level).toBe("error");
    expect(both.restartRequired).toBe(true);
    expect(both.message).toContain("disk I/O error");
    expect(both.message).toContain(kChannelDeleteRestartFailedSentence);

    const deferredAndRestart = describeChannelDeleteOutcome({
      ok: true,
      gatewayRestartFailed: true,
      pairingRowsCleanupDeferred: true,
    });
    expect(deferredAndRestart.level).toBe("warning");
    expect(deferredAndRestart.message).toContain("until the running backup finishes");
    expect(deferredAndRestart.message).toContain(kChannelDeleteRestartFailedSentence);
  });

  it("only literal `true` flags count — a truthy string or the pairing error alone never changes the verdict", () => {
    expect(
      describeChannelDeleteOutcome({ ok: true, pairingRowsCleanupFailed: "yes" }).level,
    ).toBe("success");
    expect(
      describeChannelDeleteOutcome({ ok: true, pairingRowsCleanupError: "stale" }).level,
    ).toBe("success");
  });
});

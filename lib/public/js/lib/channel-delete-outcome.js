// DELETE /api/channels/accounts answers `ok: true` for the delete itself and
// rides ADDITIVE outcome flags beside it (lib/server/agents/channels.js
// `pairingRowsOutcomeFields`): the account is gone from openclaw.json/.env,
// but its pairing rows — the allow entries that authorize the paired users —
// may still be in the state DB, and the gateway restart may have failed.
// Both delete callers (the Channels tab and the agent bindings section) read
// the result through this ONE helper so a flagged delete is never toasted as
// a clean "Channel deleted" (AGENTS.md: "a failed pairing-row clear after a
// channel delete is reported, never a clean delete").
export const kChannelDeletedMessage = "Channel deleted";
export const kChannelDeleteRestartFailedSentence =
  "The gateway restart also failed — restart it to apply the change.";

// The delete already removed the account from config, so "re-run the delete"
// would 404: the honest remedies are re-adding the account and deleting it
// again (which clears the rows on the way out) or clearing the rows by hand.
export const buildChannelDeletePairingRowsFailedMessage = (reason) =>
  `Channel deleted, but its paired users are STILL authorized — could not clear its pairing rows (${
    String(reason || "").trim() || "unknown error"
  }). Re-add the account and delete it again, or clear the rows by hand.`;
export const kChannelDeletePairingRowsDeferredMessage =
  "Channel deleted — its paired users stay authorized until the running backup finishes, then the clear completes.";

// `{ message, level, restartRequired }` for the toast + restart banner. The
// pairing-row verdict decides the level (failed → error, deferred → warning);
// a failed restart is appended, never silently dropped, and always raises the
// restart banner.
export const describeChannelDeleteOutcome = (result = null) => {
  const flags = result && typeof result === "object" ? result : {};
  const restartRequired = flags.gatewayRestartFailed === true;
  let message = kChannelDeletedMessage;
  let level = "success";
  if (flags.pairingRowsCleanupFailed === true) {
    message = buildChannelDeletePairingRowsFailedMessage(flags.pairingRowsCleanupError);
    level = "error";
  } else if (flags.pairingRowsCleanupDeferred === true) {
    message = kChannelDeletePairingRowsDeferredMessage;
    level = "warning";
  }
  if (restartRequired) {
    message = `${message.replace(/\.$/, "")}. ${kChannelDeleteRestartFailedSentence}`;
    if (level === "success") level = "warning";
  }
  return { message, level, restartRequired };
};

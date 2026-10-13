// OpenClaw 2026.10.2 runs `pairing list|approve` and `approvals get|set`
// through the live Gateway that owns the state directory, or under exclusive
// offline ownership when no Gateway holds it (dist/local-state-owner-*.mjs
// runWithLocalStateOwner; docs/gateway/protocol/versioning.md "Local state
// owner routing"). A failure is a LocalStateOwnerError with code
// OWNER_UNAVAILABLE | OWNER_REFUSED | OUTCOME_UNKNOWN, but the code never
// reaches the CLI output: stderr and the --json failure envelope
// (`{"ok":false,"error":{"type":"cli_error","message":…}}`) carry only the
// message. The code is recovered from the message's fixed sentences:
//
//   OWNER_UNAVAILABLE  "Cannot admit <method> for <target> in state root <dir>: …"
//                      or "Selected state root changed; rerun the command."
//   OWNER_REFUSED      "Gateway owning <dir> on local port <port> could not
//                      complete <method> for <target>: … No local mutation was
//                      attempted. …"
//   OUTCOME_UNKNOWN    same prefix, then "The outcome may be partial; inspect …
//                      before retrying. No local fallback was attempted."
//
// The upstream guidance appended to the first two ("stop the Gateway through
// its service owner") is wrong under AlphaClaw, which IS the gateway's
// service owner, so callers answer with AlphaClaw copy and log the raw text.
const kOutcomeUnknownPattern =
  /Gateway owning [\s\S]+? could not complete [\s\S]+?The outcome may be partial; inspect /;
const kOwnerRefusedPattern = /Gateway owning [\s\S]+? on local port \d+ could not complete /;
const kOwnerUnavailablePattern =
  /Cannot admit \S+ for [\s\S]+? in state root |Selected state root changed; rerun the command\./;

const kOwnerBusyMessage =
  "The gateway is starting or restarting; try again in a few seconds.";

const classifyLocalStateOwnerFailure = (result) => {
  const text = `${result?.stdout || ""}\n${result?.stderr || ""}`;
  if (kOutcomeUnknownPattern.test(text)) return "OUTCOME_UNKNOWN";
  if (kOwnerRefusedPattern.test(text)) return "OWNER_REFUSED";
  if (kOwnerUnavailablePattern.test(text)) return "OWNER_UNAVAILABLE";
  return null;
};

// OWNER_UNAVAILABLE / OWNER_REFUSED: nothing was dispatched or the gateway
// refused before any effect, so the request is safe to repeat — 503,
// retryable. OUTCOME_UNKNOWN after a mutation: the change may have landed, so
// it is never retried; the caller must re-read first (409). A read that
// initializes state (`approvals get`) passes `mutation: false` and stays a
// retryable 503 even on OUTCOME_UNKNOWN.
const sendLocalStateOwnerFailure = (
  res,
  { ownerCode, result, operation, mutation = false, recheckHint = "" },
) => {
  const detail = String(result?.stderr || result?.stdout || "").trim().slice(0, 500);
  console.warn(
    `[alphaclaw] ${operation} could not reach the OpenClaw state owner (${ownerCode}): ${detail}`,
  );
  if (ownerCode === "OUTCOME_UNKNOWN" && mutation) {
    return res.status(409).json({
      ok: false,
      code: "outcome_unknown",
      ownerCode,
      retryable: false,
      error: `The gateway may have applied this change but did not confirm it. ${recheckHint}`.trim(),
    });
  }
  return res.status(503).json({
    ok: false,
    code: "gateway_state_owner_unavailable",
    ownerCode,
    retryable: true,
    error: kOwnerBusyMessage,
  });
};

module.exports = {
  classifyLocalStateOwnerFailure,
  sendLocalStateOwnerFailure,
  kOwnerBusyMessage,
};

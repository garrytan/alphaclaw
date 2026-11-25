// Every refusal and failure is a tool result with isError true, a stable
// code, one line on what happened, the fix and the next step. Fixed text
// only: never the token, the arguments or anything the broker sent, except
// Google's own message on a tool_error (the caller already holds the
// arguments it echoes).
const kErrors = Object.freeze({
  gw_not_owner: ["Google Workspace tools run only on the owner's own turns.", "None from this conversation.", "Do not retry; tell the person asking that only the owner can use the Google account."],
  gw_not_configured: ["No Google account is configured for this plugin.", "The box operator names it in ALPHACLAW_GOOGLE_WORKSPACE_ACCOUNTS (deployment env).", "Do not retry until it is configured."],
  gw_bad_account: ["That account is not one this plugin is configured for.", "Leave out account to use the default one, or pick a configured account.", "Retry with a configured account."],
  gw_unknown_tool: ["There is no Google Workspace tool by that name.", "Use gw_describe to list the tools of a product.", "Retry with a listed tool."],
  gw_broker_down: ["GBrain's Google broker is not answering on its socket.", "The broker runs inside gbrain serve with google.mint_socket on, or as gbrain google mint serve.", "Nothing was sent to Google; retry once the broker is up."],
  gw_journal_failed: ["The plugin could not save this write's request id, so it did not send it.", "The box operator frees disk space or fixes the permissions of <root>/google-workspace/.", "Nothing was sent to Google; retry once it is fixed."],
  gw_read_unanswered: ["The broker did not answer this read in time.", "None needed; a read changes nothing in Google.", "Retry once."],
  gw_outcome_unknown: ["The broker or Google did not confirm whether this call happened.", "Check first: read the item back, or call gw_check_outcome with this ref.", "Do not repeat the call until the check shows it did not happen."],
  gw_not_connected: ["The Google account is not connected to GBrain.", "The owner connects it with GBrain's Google connect step.", "Do not retry until it is connected."],
  gw_revoked: ["Google access for this account was revoked.", "The owner reconnects the account with GBrain's Google connect step.", "Do not retry until it is reconnected."],
  gw_insufficient_scope: ["The account was not given the access this tool needs.", "The owner grants it with GBrain's Google connect step (one consent covers every scope).", "Do not retry until access is granted."],
  gw_client_not_agent: ["GBrain's Google client for this account is not an agent client.", "The owner recreates it through GBrain's one-click Personal-mode setup.", "Do not retry until it is fixed."],
  gw_client_user_mismatch: ["GBrain's Google client belongs to a different user than this account.", "The owner recreates the client from this account through GBrain's setup.", "Do not retry until it is fixed."],
  gw_rate_limited: ["Too many Google calls in a short time.", "Wait a minute.", "Retry once, later; do not loop."],
  gw_turn_cap: ["This turn reached its limit of Google calls.", "Finish with what you have.", "Do not retry in this turn."],
  gw_quota_stopped: ["Today's Google calls for this product reached the daily limit.", "It resets at midnight UTC.", "Do not retry today; tell the owner."],
  gw_unsupported_version: ["GBrain's broker speaks a different protocol version than this plugin.", "Update GBrain or AlphaClaw so both speak protocol v4.", "Do not retry until they match."],
  gw_broker_internal: ["GBrain's broker failed on its side.", "The broker's own log says why.", "Retry once; if it fails again, tell the owner."],
  gw_tool_not_allowed: ["GBrain's broker does not allow this tool.", "Use another tool for the same job.", "Do not retry this tool."],
  gw_verdict_expired: ["The approval for this call expired before it was used.", "Call the tool again for a fresh approval.", "Retry once."],
  gw_args_refused: ["GBrain's broker refused these arguments under its rules (for example notifications to attendees).", "Change the arguments: for calendar writes leave notificationLevel out or set it to NONE.", "Retry with changed arguments."],
  gw_not_switched_on: ["Google writes are not switched on for this box yet.", "The box operator switches them on after the box's guards are proven.", "Do not retry; tell the owner it is not live yet."],
  gw_owner_confirm: ["This call is held by a safety pause: a second outside invite or share, or more than 10 trashes, in one turn.", "The owner confirms it with gbrain google approvals on the box, or through the confirm link GBrain sent.", "Once the owner confirms, call the same tool with the same arguments within 10 minutes; do not change them."],
  gw_held_needs_owner: ["Google asked for an approval this turn cannot give (it offered no one-time approval).", "The owner answers it with gbrain google approvals on the box.", "Do not retry until the owner has answered."],
  gw_user_denied: ["Google reports the approval was declined.", "None.", "Stop; do not retry this action."],
  gw_admin_policy: ["The account's administrator does not allow this action.", "None from here.", "Stop; do not retry this action."],
  gw_challenge_pending: ["Google is waiting for an approval it already asked for.", "The owner answers it with gbrain google approvals on the box.", "Do not retry until it is answered."],
  gw_tool_failed: ["Google could not do this call.", "Read Google's message below and fix the arguments.", "Retry once with fixed arguments."],
});

const kBrokerCodes = Object.freeze({
  not_connected: "gw_not_connected",
  revoked: "gw_revoked",
  insufficient_scope: "gw_insufficient_scope",
  client_not_agent: "gw_client_not_agent",
  client_user_mismatch: "gw_client_user_mismatch",
  rate_limited: "gw_rate_limited",
  turn_cap: "gw_turn_cap",
  day_cap: "gw_quota_stopped",
  unsupported_version: "gw_unsupported_version",
  internal: "gw_broker_internal",
  tool_not_allowed: "gw_tool_not_allowed",
  outcome_unknown: "gw_outcome_unknown",
  verdict_expired: "gw_verdict_expired",
  broker_args_refused: "gw_args_refused",
  broker_precondition_unmet: "gw_not_switched_on",
  owner_confirm_required: "gw_owner_confirm",
  input_required: "gw_held_needs_owner",
});

const kToolErrorReasons = Object.freeze({
  user_denied: "gw_user_denied",
  admin_policy: "gw_admin_policy",
  challenge_pending: "gw_challenge_pending",
  tool_failed: "gw_tool_failed",
});

const kGoogleMessageMax = 1000;

// { content, isError: true, details } for one of kErrors' codes. extra:
// { ref } (an outcome_unknown or held call's intent id), { googleMessage }.
const errorResult = (code, { ref = null, googleMessage = null, notice = null } = {}) => {
  const [what, fix, next] = kErrors[code] || kErrors.gw_broker_internal;
  const lines = [code + ": " + what, "Fix: " + fix, "Next: " + next];
  if (ref) lines.push("Ref: " + ref);
  if (googleMessage) lines.push("Google says: " + String(googleMessage).slice(0, kGoogleMessageMax));
  const content = [{ type: "text", text: lines.join("\n") }];
  if (notice) content.push({ type: "text", text: notice });
  return { content, isError: true, details: { status: "error", code: kErrors[code] ? code : "gw_broker_internal", ...(ref ? { ref } : {}) } };
};

const codeOfBroker = (code) => kBrokerCodes[String(code || "")] || "gw_broker_internal";
const codeOfToolError = (reason) => kToolErrorReasons[String(reason || "")] || "gw_tool_failed";

module.exports = { kErrors, kBrokerCodes, kToolErrorReasons, errorResult, codeOfBroker, codeOfToolError };

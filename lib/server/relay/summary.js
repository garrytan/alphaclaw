const { redactSecretText } = require("../utils/redact");
const { kRelayWithheldText } = require("./constants");

// The one-line summary a remote agent may give with relay_send or relay_reply
// (GST-2304): what it is asking the box to do, for the owner's narration
// notice (narration.js). It is the sender's own words, so it is cleaned the
// same way where AlphaClaw takes it (remote-tools.js, before it reaches the
// engine's metadata) and again where the bridge stores it: line breaks and
// control characters become spaces, secrets are redacted (a disguised one
// withholds the whole summary), backticks become quotes so the notice's code
// span holds, and it is cut to kSummaryMaxChars. The body is never read for
// it.
const kSummaryMaxChars = 120;
const kSummaryInputChars = 1000;
const kSummaryRule =
  "summary must be one line of plain text, at most " +
  kSummaryMaxChars +
  " characters, saying what you are asking the box to do, with no secrets; for example \"re-import yesterday's meeting notes into gbrain\". " +
  "Send a short one-line summary, or leave summary out.";

const kControlPattern = /[\p{Cc}\p{Cf}\u2028\u2029]+/gu;

// { ok: false, reason } for a summary that is not a string or is empty once
// cleaned; { ok: true, summary: null, withheld: true } when it looked like it
// carried a secret; else { ok: true, summary, truncated }.
const cleanRelaySummary = (value, { maskText = redactSecretText } = {}) => {
  if (typeof value !== "string") return { ok: false, reason: "not_string" };
  const flat = value.slice(0, kSummaryInputChars).replace(kControlPattern, " ").replace(/\s+/g, " ").trim();
  if (!flat) return { ok: false, reason: "empty" };
  const masked = String(maskText(redactSecretText(flat)) ?? "");
  if (masked === kRelayWithheldText) return { ok: true, summary: null, withheld: true, truncated: false };
  const quoted = masked.replace(/`/g, "'").replace(/\s+/g, " ").trim();
  if (!quoted) return { ok: false, reason: "empty" };
  const truncated = quoted.length > kSummaryMaxChars;
  return { ok: true, summary: truncated ? quoted.slice(0, kSummaryMaxChars).trimEnd() : quoted, truncated, withheld: false };
};

// An acknowledgment that gets no narration line, decided from the body alone
// (a summary never makes an ask an ack): at most kAckMaxChars characters and
// one of the fixed phrases, ignoring case and trailing punctuation.
const kAckMaxChars = 40;
const kAckBodies = new Set(["thanks", "thank you", "ok", "okay", "got it", "ack", "acknowledged", "received", "👍", "✅"]);

const isAckBody = (text) => {
  const body = String(text ?? "").trim();
  if (!body || body.length > kAckMaxChars) return false;
  return kAckBodies.has(body.toLowerCase().replace(/[\s.!]+$/u, ""));
};

module.exports = { cleanRelaySummary, isAckBody, kSummaryMaxChars, kSummaryRule, kAckMaxChars };

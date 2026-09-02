// Pure view model for the Settings → "Test" notification outcome. Free of
// Preact so it can be tested directly in node.
//
// Server contract (WI-3.5, POST /api/watchdog/test-notification):
//   200 { ok:true,  result }                — at least one channel delivered
//   502 { ok:false, error, result }         — every channel failed; the api
//                                             helper rethrows with `.result`
// `result.failures[]` = { channel, target, reason, errorCode, deterministic }
// per failed target; `result.channels[<name>]` = { sent, failed, skipped }.

export const kTestNotificationChannels = [
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "webhook",
];

export const kTestNotificationNoChannelsMessage = "No channels configured";

const toFailureRow = (failure = {}) => ({
  channel: String(failure?.channel || "unknown"),
  target: failure?.target != null && failure.target !== "" ? String(failure.target) : null,
  reason: String(failure?.reason || "delivery failed"),
  errorCode: failure?.errorCode != null ? String(failure.errorCode) : null,
});

export const formatTestNotificationFailure = (row = {}) =>
  `${row.channel}${row.target ? ` (${row.target})` : ""}: ${row.reason}${
    row.errorCode ? ` [${row.errorCode}]` : ""
  }`;

// Summarises per-channel counts for the success toast ("telegram: 1 sent").
const summarizeChannels = (result = null) => {
  const channels = result?.channels || {};
  const parts = [];
  for (const channel of kTestNotificationChannels) {
    const entry = channels[channel];
    if (!entry || entry.skipped) continue;
    if (entry.sent > 0) parts.push(`${channel}: ${entry.sent} sent`);
    if (entry.failed > 0) parts.push(`${channel}: ${entry.failed} failed`);
  }
  return parts;
};

// Either `data` (a resolved 200 body) or `error` (the rejection, carrying the
// preserved 502 body's `result`) — never both.
export const buildTestNotificationOutcome = ({ data = null, error = null } = {}) => {
  if (error) {
    const result = error.result && typeof error.result === "object" ? error.result : null;
    const failures = (Array.isArray(result?.failures) ? result.failures : []).map(
      toFailureRow,
    );
    return {
      ok: false,
      message: String(error.message || "Test notification failed"),
      failures,
      parts: summarizeChannels(result),
    };
  }
  const result = data?.result && typeof data.result === "object" ? data.result : null;
  const failures = (Array.isArray(result?.failures) ? result.failures : []).map(
    toFailureRow,
  );
  const parts = summarizeChannels(result);
  if (parts.length === 0) {
    return {
      ok: true,
      noChannels: true,
      message: kTestNotificationNoChannelsMessage,
      failures,
      parts,
    };
  }
  const hasFailures = failures.length > 0 || parts.some((part) => part.includes("failed"));
  return {
    ok: true,
    noChannels: false,
    hasFailures,
    message: hasFailures
      ? `Test notification partially delivered — ${parts.join(", ")}`
      : `Test notification sent: ${parts.join(", ")}`,
    failures,
    parts,
  };
};

// Pure view model for the Settings → "Test" notification outcome. Free of
// Preact so it can be tested directly in node.
//
// Server contract (WI-3.5, POST /api/watchdog/test-notification):
//   200 { ok:true,  result }                — at least one channel delivered
//   502 { ok:false, error, result }         — every channel failed; the api
//                                             helper rethrows with `.result`
// `result.failures[]` = { channel, target, reason, errorCode, deterministic }
// per failed target; `result.channels[<name>]` = { sent, failed, skipped }.
// "Nothing configured" is a 502 too (the notifier's verdict is `ok: sent > 0`,
// reason `no_channels_delivered`, no failures) — the server's own message
// renders through the error branch; a 200 always carries a delivered channel.

export const kTestNotificationChannels = [
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "webhook",
];

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
  const hasFailures = failures.length > 0 || parts.some((part) => part.includes("failed"));
  // `parts` is non-empty on every real 200; the bare fallback only guards a
  // body without per-channel counts — the server's ok:true still stands.
  return {
    ok: true,
    hasFailures,
    message: hasFailures
      ? `Test notification partially delivered — ${parts.join(", ")}`
      : parts.length > 0
        ? `Test notification sent: ${parts.join(", ")}`
        : "Test notification sent",
    failures,
    parts,
  };
};

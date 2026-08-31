// Error classification for the chat bridge. Replaces the old sanitizeError
// (chat-ws.js) — same canned, safe copy, plus a machine-readable `code` and a
// `retryable` hint the client outbox uses to decide auto-retry vs park.
//
// The raw message goes to the server log only; browsers get the classified
// copy. Socket-close reasons ("Gateway disconnected (code 1006)") map to
// gateway_unavailable rather than falling through to the generic bucket.

const kMaxStoredErrorLength = 500;

const classifyError = (error) => {
  const message = error instanceof Error ? error.message : String(error || "");
  const lower = message.toLowerCase();
  console.error(`[alphaclaw] chat websocket handler error: ${message}`);
  if (lower.includes("not connected") || lower.includes("gateway disconnected")) {
    return {
      code: "gateway_unavailable",
      retryable: true,
      message: "Agent runtime is not connected right now.",
    };
  }
  if (
    lower.includes("gateway is not connected") ||
    lower.includes("econnrefused") ||
    lower.includes("connect failed") ||
    lower.includes("backing off") ||
    lower.includes("websocket failed")
  ) {
    return {
      code: "gateway_unavailable",
      retryable: true,
      message:
        "Could not connect to the OpenClaw gateway. Check that the gateway is running and reachable.",
    };
  }
  if (lower.includes("timed out") || lower.includes("timeout")) {
    return {
      code: "gateway_timeout",
      retryable: true,
      message:
        "The gateway did not respond in time. Try again after the gateway finishes starting.",
    };
  }
  if (
    lower.includes("auth") ||
    lower.includes("token") ||
    lower.includes("unauthorized") ||
    lower.includes("forbidden")
  ) {
    return {
      code: "gateway_auth",
      retryable: false,
      message:
        "Gateway authentication failed. Verify OPENCLAW_GATEWAY_TOKEN matches the gateway.",
    };
  }
  if (lower.includes("protocol mismatch")) {
    return {
      code: "protocol_mismatch",
      retryable: false,
      message:
        "Chat cannot connect to the gateway (protocol version mismatch). Update AlphaClaw to match your OpenClaw version.",
    };
  }
  if (lower.includes("method not found") || lower.includes("unknown method")) {
    return {
      code: "unsupported",
      retryable: false,
      message: "This gateway build does not support chat APIs. Update OpenClaw.",
    };
  }
  if (lower.includes("gateway request failed")) {
    return {
      code: "run_failed",
      retryable: false,
      message: "The gateway could not start this chat run. Check gateway logs.",
    };
  }
  return {
    code: "unknown",
    retryable: false,
    message: "Something went wrong. Please try again.",
  };
};

// Store rows persist the CLASSIFIED message only (never raw gateway text,
// which can carry prompts/paths/tokens), length-capped.
const toStoredErrorText = (classified) =>
  String(classified?.message || "").slice(0, kMaxStoredErrorLength);

module.exports = { classifyError, toStoredErrorText, kMaxStoredErrorLength };

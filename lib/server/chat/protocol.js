// Chat bridge protocol v2 — shared constants and frame validators.
//
// The browser mirror lives at lib/public/js/components/chat/chat-protocol.js;
// tests/frontend/chat-protocol-sync.test.js pins the two frame-type lists so
// they cannot drift apart silently.
//
// Ordering invariants (enforced by run-registry.finalizeRun):
//   ack → started → chunk/tool (monotonic per-run `seq`) → exactly ONE
//   terminal `done` per started run — including on gateway disconnect, stall
//   timeout, and stop.
// STREAM frames (started/chunk/tool/done) carry `seq`; control frames do not.

const kProtocolVersion = 2;

// Content is measured in UTF-8 BYTES (Buffer.byteLength server-side,
// TextEncoder client-side). The WSS maxPayload (2MB) covers JSON envelope
// overhead on top of the 1MB content cap.
const kMaxContentBytes = 1 * 1024 * 1024;
const kMaxPayloadBytes = 2 * 1024 * 1024;
const kMaxIdLength = 128;

// Registry caps: one ACTIVE run per session (D7 — excess sends get
// `session_busy` and the client outbox holds them queued), and a per-browser
// live-record bound so a misbehaving authenticated client cannot grow the
// registry maps without limit.
const kMaxLiveRecordsPerBrowser = 32;

// Per-socket inbound flood cap: frames per rolling 10s window. Legit traffic
// (history on switch, outbox flush bursts, pings) stays far below this.
const kMaxInboundFramesPerWindow = 60;
const kInboundFloodWindowMs = 10_000;

// Outbound backpressure: skip relaying stream frames to a socket whose
// bufferedAmount exceeds this; a `desync` frame on drain tells the client to
// refetch history — dropped deltas are never silent.
const kMaxBufferedAmountBytes = 4 * 1024 * 1024;

// Run liveness bounds.
const kStopConfirmTimeoutMs = 10_000;
const kRunStallMs = 5 * 60 * 1000;
const kRunStallSweepIntervalMs = 30_000;

// Resume (Phase 5): per-run replay buffer for registry-tracked (browser-
// initiated) runs — foreign cron/Telegram runs are not registry-tracked and
// not resumable. Grace window starts when a run's attached-socket set
// empties; expiry drops the buffer ONLY (never synthesizes a terminal).
const kReplayBufferMaxBytes = 256 * 1024;
const kResumeGraceMs = 120_000;

// Browser keepalive: WS-protocol ping every interval, terminate after two
// missed pongs. App-level {type:"ping"} → {type:"pong"} drives the client's
// own staleness detection (browsers cannot observe protocol pings).
const kBrowserPingIntervalMs = 30_000;

// Dedupe window: a terminal store row younger than this re-acks + replays its
// terminal frame instead of dispatching a second chat.send.
const kDedupeTerminalWindowMs = 10 * 60 * 1000;

const kBrowserFrameTypes = ["message", "stop", "history", "resume", "ping"];
const kServerFrameTypes = [
  "hello",
  "ack",
  "started",
  "chunk",
  "tool",
  "done",
  "stopping",
  "stop-failed",
  "send-failed",
  "history",
  "resumed",
  "resume-failed",
  "desync",
  "error",
  "pong",
];

// Store-status vocabularies (single source — the db store's SQL filters and
// history.js's wire mapping import these; drift = markers silently disagree).
const kTerminalStatuses = ["done", "stopped", "interrupted", "error", "unknown"];
const kMarkerStatuses = ["stopped", "interrupted", "error", "unknown"];

// Control characters are rejected outright: the registry's composite key is
// newline-delimited (an id containing \n could collide two records) and ids
// are echoed into structured log lines.
const kControlCharPattern = /[\u0000-\u001F\u007F]/;
const isValidId = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= kMaxIdLength &&
  !kControlCharPattern.test(value);

// Optional ids may be absent/empty but must not be junk when present.
const isValidOptionalId = (value) =>
  value === undefined || value === null || value === "" || isValidId(value);

const contentByteLength = (value) => Buffer.byteLength(String(value || ""), "utf8");

/**
 * Validate an inbound {type:"message"} frame. Returns { ok:true } or
 * { ok:false, message } with a human-readable reason. Old-bundle frames carry
 * no clientMsgId — that is valid (the bridge mints one).
 */
const validateMessageFrame = (payload = {}) => {
  const sessionKey = String(payload?.sessionKey || "").trim();
  const content = String(payload?.content || "").trim();
  if (!sessionKey || !content) {
    return { ok: false, message: "sessionKey and content are required" };
  }
  if (!isValidId(sessionKey)) {
    return { ok: false, message: "sessionKey is invalid" };
  }
  if (!isValidOptionalId(payload?.clientMsgId)) {
    return { ok: false, message: "clientMsgId is invalid" };
  }
  if (contentByteLength(content) > kMaxContentBytes) {
    return { ok: false, message: "message is too large", code: "payload_too_large" };
  }
  return { ok: true };
};

module.exports = {
  kProtocolVersion,
  kMaxContentBytes,
  kMaxPayloadBytes,
  kMaxIdLength,
  kMaxLiveRecordsPerBrowser,
  kMaxInboundFramesPerWindow,
  kInboundFloodWindowMs,
  kMaxBufferedAmountBytes,
  kStopConfirmTimeoutMs,
  kRunStallMs,
  kRunStallSweepIntervalMs,
  kReplayBufferMaxBytes,
  kResumeGraceMs,
  kBrowserPingIntervalMs,
  kDedupeTerminalWindowMs,
  kBrowserFrameTypes,
  kServerFrameTypes,
  kTerminalStatuses,
  kMarkerStatuses,
  isValidId,
  isValidOptionalId,
  contentByteLength,
  validateMessageFrame,
};

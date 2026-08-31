// Browser mirror of the chat bridge protocol v2 constants
// (lib/server/chat/protocol.js). tests/frontend/chat-protocol-sync.test.js
// pins the frame-type lists against the server module so they cannot drift.
export const kProtocolVersion = 2;

export const kBrowserFrameTypes = ["message", "stop", "history", "resume", "ping"];
export const kServerFrameTypes = [
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

// Fallback until the server's hello advertises its real cap.
export const kDefaultMaxContentBytes = 1 * 1024 * 1024;

export const contentByteLength = (value = "") => {
  try {
    return new TextEncoder().encode(String(value || "")).length;
  } catch {
    return String(value || "").length;
  }
};

export const buildMessageFrame = ({ clientMsgId, sessionKey, content, now }) => ({
  type: "message",
  clientMsgId,
  sessionKey,
  content,
  sentAt: Number(now) || Date.now(),
});

export const buildStopFrame = ({ sessionKey, runId = "" }) => ({
  type: "stop",
  sessionKey,
  ...(runId ? { runId } : {}),
});

export const buildHistoryFrame = ({ sessionKey, reqId }) => ({
  type: "history",
  sessionKey,
  reqId,
});

export const buildPingFrame = ({ now }) => ({
  type: "ping",
  ts: Number(now) || Date.now(),
});

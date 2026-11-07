// History normalization for the chat bridge. The transcript-shape tolerance
// here (three payload shapes, unknown-block scrapers) is the de-facto version
// adaptation across OpenClaw releases — moved verbatim from the old
// chat-ws.js; only the stable-id minting and marker mapping are new.
const nodeCrypto = require("node:crypto");
const { kMarkerStatuses } = require("./protocol");

// Typed parts whose payload is never transcript text (fix wave F116).
const kBinaryPartTypes = new Set([
  "image",
  "image_url",
  "input_image",
  "audio",
  "input_audio",
  "video",
  "file",
  "document",
  "binary",
  "attachment",
]);

const collectHistoryTextFragments = (value) => {
  if (typeof value === "string") {
    return value.length > 0 ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectHistoryTextFragments(entry));
  }
  if (!value || typeof value !== "object") return [];

  if (typeof value.type === "string") {
    const partType = String(value.type || "").toLowerCase();
    if (partType === "text") {
      return collectHistoryTextFragments(value.text);
    }
    if (
      partType === "thinking" ||
      partType === "toolcall" ||
      partType === "tool_call" ||
      partType === "toolresult" ||
      partType === "tool_result" ||
      kBinaryPartTypes.has(partType)
    ) {
      return [];
    }
    // Any OTHER typed part (fix wave F116): read its text-ish fields only.
    // The Object.values fallback below exists for UNTYPED unknown block
    // shapes; on a typed part it scraped the `type` literal, mime types and
    // base64 payloads into the transcript row.
    return [value.text, value.message, value.content, value.parts, value.value]
      .flatMap((entry) => collectHistoryTextFragments(entry));
  }

  const textFields = [
    value.text,
    value.message,
    value.content,
    value.parts,
    value.value,
    value.output,
    value.input,
  ];

  const fragments = textFields.flatMap((entry) => collectHistoryTextFragments(entry));

  if (fragments.length > 0) return fragments;

  // Fallback: scan object values to catch unknown transcript block shapes.
  return Object.values(value).flatMap((entry) => collectHistoryTextFragments(entry));
};

const normalizeHistoryContent = (rawContent) => {
  const parts = collectHistoryTextFragments(rawContent);
  return parts
    .join("")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

const normalizeHistoryRole = (rawRole = "") => {
  const role = String(rawRole || "").toLowerCase();
  if (
    role === "user" ||
    role === "human" ||
    role === "client" ||
    role === "input" ||
    role.includes("user")
  ) {
    return "user";
  }
  return "assistant";
};

const normalizeHistoryTimestamp = (messageRow = {}) => {
  const numericCandidate =
    Number(messageRow?.timestamp) || Number(messageRow?.createdAt) || 0;
  if (numericCandidate > 0) return numericCandidate;
  const parsedDateMs = Date.parse(
    String(messageRow?.timestamp || messageRow?.createdAt || ""),
  );
  return Number.isFinite(parsedDateMs) && parsedDateMs > 0
    ? parsedDateMs
    : Date.now();
};

const extractToolCalls = (messageRow = {}) => {
  const contentParts = Array.isArray(messageRow?.content) ? messageRow.content : [];
  return contentParts
    .filter((part) => String(part?.type || "").toLowerCase() === "toolcall")
    .map((part) => ({
      id: String(part?.id || ""),
      name: String(part?.name || ""),
      arguments: part?.arguments || null,
      partialJson: String(part?.partialJson || ""),
    }))
    .filter((toolCall) => toolCall.name || toolCall.id);
};

const extractHistoryMetadata = (messageRow = {}) => {
  const metadata = {};
  const assign = (key, value) => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" && !value.trim()) return;
    metadata[key] = value;
  };
  assign("api", messageRow?.api);
  assign("provider", messageRow?.provider);
  assign("model", messageRow?.model);
  assign("stopReason", messageRow?.stopReason);
  assign("thinkingLevel", messageRow?.thinkingLevel);
  assign("senderLabel", messageRow?.senderLabel);
  assign("runId", messageRow?.runId);
  assign("inputTokens", Number(messageRow?.inputTokens) || undefined);
  assign("outputTokens", Number(messageRow?.outputTokens) || undefined);
  assign("totalTokens", Number(messageRow?.totalTokens) || undefined);
  assign(
    "cacheCreationInputTokens",
    Number(messageRow?.cacheCreationInputTokens) || undefined,
  );
  assign(
    "cacheReadInputTokens",
    Number(messageRow?.cacheReadInputTokens) || undefined,
  );
  return Object.keys(metadata).length > 0 ? metadata : null;
};

const normalizePartType = (value = "") =>
  String(value || "")
    .toLowerCase()
    .replaceAll("_", "")
    .replaceAll("-", "");

const collectTextFromUnknownShape = (value) =>
  normalizeHistoryContent(value?.content ?? value?.result ?? value?.text ?? value?.message);

const extractToolCallFromUnknownShape = (value) => {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = extractToolCallFromUnknownShape(entry);
      if (match) return match;
    }
    return null;
  }
  const partType = normalizePartType(value?.type);
  if (partType === "toolcall") {
    const normalized = {
      id: String(value?.id || value?.toolCallId || value?.callId || ""),
      name: String(value?.name || value?.toolName || ""),
      arguments: value?.arguments || value?.args || null,
      partialJson: String(value?.partialJson || ""),
    };
    return normalized.name || normalized.id ? normalized : null;
  }
  const nestedCandidates = [
    value?.part,
    value?.delta,
    value?.item,
    value?.message,
    value?.payload,
    value?.data,
    value?.value,
    value?.content,
  ];
  for (const candidate of nestedCandidates) {
    const match = extractToolCallFromUnknownShape(candidate);
    if (match) return match;
  }
  return null;
};

const extractToolResultFromUnknownShape = (value) => {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const match = extractToolResultFromUnknownShape(entry);
      if (match) return match;
    }
    return null;
  }
  const partType = normalizePartType(value?.type);
  const rawRole = normalizePartType(value?.role);
  const looksLikeToolResult =
    partType === "toolresult" ||
    rawRole === "toolresult" ||
    (String(value?.toolCallId || value?.callId || "").trim().length > 0 &&
      (value?.isError !== undefined ||
        value?.status !== undefined ||
        value?.content !== undefined ||
        value?.result !== undefined ||
        value?.text !== undefined));
  if (looksLikeToolResult) {
    const text = collectTextFromUnknownShape(value);
    const content =
      Array.isArray(value?.content) && value.content.length > 0
        ? value.content
        : text
          ? [{ type: "text", text }]
          : [];
    return {
      role: "toolResult",
      toolCallId: String(value?.toolCallId || value?.callId || value?.id || ""),
      toolName: String(value?.toolName || value?.name || ""),
      content,
      isError:
        value?.isError === true ||
        String(value?.status || "").toLowerCase() === "error",
      timestamp: normalizeHistoryTimestamp(value),
    };
  }
  const nestedCandidates = [
    value?.part,
    value?.delta,
    value?.item,
    value?.message,
    value?.payload,
    value?.data,
    value?.value,
    value?.content,
    value?.result,
  ];
  for (const candidate of nestedCandidates) {
    const match = extractToolResultFromUnknownShape(candidate);
    if (match) return match;
  }
  return null;
};

const readTranscriptMeta = (rawMessage) =>
  rawMessage && typeof rawMessage.__openclaw === "object" && rawMessage.__openclaw
    ? rawMessage.__openclaw
    : {};

// The ONE row identity for history pages, older pages and live session rows
// (d7): the transcript record id OpenClaw stamps in __openclaw.id, then the
// transcript sequence (messageSeq / __openclaw.seq), then a content hash.
const resolveNativeRowId = (rawMessage) => {
  const meta = readTranscriptMeta(rawMessage);
  const recordId = String(meta.id || rawMessage?.id || "").trim();
  if (recordId) return recordId;
  const seq = Number(meta.seq ?? rawMessage?.messageSeq);
  return Number.isSafeInteger(seq) && seq > 0 ? `seq-${seq}` : "";
};

// Stable message identity (D2): deterministic across refetches so the client
// merges instead of remounting. The occurrence counter disambiguates rows
// whose (timestamp, role, content-prefix, toolCallId) collide — NOT the
// absolute row index, so ids survive the 200-row window sliding.
const mintStableId = ({ sessionKey, row, occurrenceCounts }) => {
  const nativeId = resolveNativeRowId(row?.rawMessage);
  if (nativeId) {
    // One gateway message splits into a text row plus one row per tool call —
    // the native id alone would mint DUPLICATE keys across those rows.
    const nativeToolId = String(row?.toolCalls?.[0]?.id || "");
    const nativeKey = `native|${nativeId}|${row?.role}|${nativeToolId}`;
    const occurrence = occurrenceCounts.get(nativeKey) || 0;
    occurrenceCounts.set(nativeKey, occurrence + 1);
    return `h:${nativeId}:${String(row?.role || "")}${
      nativeToolId ? `:${nativeToolId}` : ""
    }${occurrence ? `:${occurrence}` : ""}`;
  }
  const toolCallId = String(row?.toolCalls?.[0]?.id || "");
  const key = [
    String(sessionKey || ""),
    String(row?.timestamp || 0),
    String(row?.role || ""),
    toolCallId,
    String(row?.content || "").slice(0, 64),
  ].join("|");
  const occurrence = occurrenceCounts.get(key) || 0;
  occurrenceCounts.set(key, occurrence + 1);
  return `h:${nodeCrypto
    .createHash("sha1")
    .update(`${key}|${occurrence}`)
    .digest("hex")
    .slice(0, 20)}`;
};

// The bridge's relay envelope (lib/server/relay/bridge.js
// buildInjectedMessage): a "[Agent Relay message from @peer]" label, the
// "(ref relay:<id>, hop N)" marker, the read-only policy lines, a blank line,
// then the peer's own text.
const kRelayLabelPattern = /^Agent Relay message from @([A-Za-z0-9][A-Za-z0-9_.-]{0,63})$/;
const kRelayRefLinePattern = /^\(ref relay:([^,\s)]+), hop (\d+)\)$/;

const parseRelayEnvelope = (label, content) => {
  const labelMatch = String(label || "").match(kRelayLabelPattern);
  if (!labelMatch) return null;
  const lines = String(content || "").split("\n");
  const refMatch = String(lines[0] || "").match(kRelayRefLinePattern);
  if (!refMatch) return null;
  const blank = lines.indexOf("", 1);
  return {
    sender: labelMatch[1],
    ref: refMatch[1],
    hop: Number(refMatch[2]) || 0,
    policy: (blank > 0 ? lines.slice(1, blank) : lines.slice(1)).join("\n").trim(),
    body: blank > 0 ? lines.slice(blank + 1).join("\n").trim() : "",
  };
};

// Who wrote a user row. Rows OpenClaw stamps with a channel sender
// (Telegram and other channels) name that sender; rows the operator sent from
// this page or the Control UI carry no sender and are "You".
const resolveUserSpeaker = (rawMessage, relay) => {
  if (relay) return { kind: "relay", label: `@${relay.sender}` };
  const meta = readTranscriptMeta(rawMessage);
  const name = String(meta.senderName || "").trim();
  const username = String(meta.senderUsername || "").trim();
  const channel = String(meta.transport?.channel || meta.senderIdentity?.pluginId || "").trim();
  if (!name && !username && !channel) return { kind: "operator", label: "You" };
  const label = name && username ? `${name} (@${username})` : name || (username ? `@${username}` : "");
  return {
    kind: "channel",
    label: label || String(meta.senderId || "") || "Channel user",
    ...(channel ? { channel } : {}),
    ...(meta.senderIsOwner === true ? { owner: true } : {}),
  };
};

/**
 * Normalize a raw gateway chat.history payload into transcript rows.
 * Moved verbatim from the old fetchHistory body, plus stable-id minting and
 * honest truncation: callers fetch limit+1 rows; a row beyond `limit` PROVES
 * older history exists (exactly `limit` rows does not), and the oldest
 * overflow rows are trimmed.
 */
const buildHistoryMessages = ({ history, sessionKey = "", limit = 0 }) => {
  let rawMessages = Array.isArray(history?.messages)
    ? history.messages
    : Array.isArray(history?.history)
      ? history.history
      : Array.isArray(history?.items)
        ? history.items
        : [];
  let truncated = false;
  if (limit > 0 && rawMessages.length > limit) {
    truncated = true;
    rawMessages = rawMessages.slice(rawMessages.length - limit);
  }
  const toolResultsByCallId = {};
  for (const messageRow of rawMessages) {
    if (String(messageRow?.role || "").toLowerCase() !== "toolresult") continue;
    const toolCallId = String(messageRow?.toolCallId || "");
    if (!toolCallId) continue;
    toolResultsByCallId[toolCallId] = messageRow;
  }

  const occurrenceCounts = new Map();
  const messages = rawMessages
    .flatMap((messageRow) => {
      const rawRole = String(messageRow?.role || "").toLowerCase();
      if (rawRole === "toolresult") return [];
      let content = normalizeHistoryContent(
        messageRow?.content ?? messageRow?.text ?? messageRow?.message,
      );
      const role = normalizeHistoryRole(messageRow?.role ?? messageRow?.author);
      let speaker = null;
      let relay = null;
      if (role === "user") {
        const label = content.match(/^\[(.*?)\]\s*/);
        content = content.replace(/^\[.*?\]\s*/, "");
        relay = parseRelayEnvelope(label?.[1], content);
        speaker = resolveUserSpeaker(messageRow, relay);
      }
      const toolCalls = extractToolCalls(messageRow);
      const normalizedContent = String(content || "").trim();
      const timestamp = normalizeHistoryTimestamp(messageRow);
      const metadata = extractHistoryMetadata(messageRow);
      const basePayload = {
        timestamp,
        metadata,
        rawMessage: messageRow || null,
        ...(speaker ? { speaker } : {}),
        ...(relay ? { relay } : {}),
      };
      const rows = [];
      if (normalizedContent) {
        rows.push({
          role,
          content: normalizedContent,
          ...basePayload,
          toolCalls: [],
          toolResult: null,
        });
      }
      for (const toolCall of toolCalls) {
        const toolCallId = String(toolCall?.id || "");
        rows.push({
          role: "tool",
          content: `Tool call: ${String(toolCall?.name || "unknown")}`,
          ...basePayload,
          toolCalls: [toolCall],
          toolResult: toolCallId ? toolResultsByCallId[toolCallId] || null : null,
        });
      }
      return rows;
    })
    .filter(
      (messageRow) =>
        String(messageRow.content || "").trim() ||
        (Array.isArray(messageRow.toolCalls) && messageRow.toolCalls.length > 0),
    );
  for (const row of messages) {
    row.id = mintStableId({ sessionKey, row, occurrenceCounts });
  }
  return { messages, truncated };
};

// Map chat-runs store rows into wire markers. Only terminal, user-visible
// outcomes surface: stopped / interrupted / error / unknown — a clean `done`
// needs no marker.
const kMarkerStatusSet = new Set(kMarkerStatuses);
const toMarkers = (storeRows = []) =>
  (Array.isArray(storeRows) ? storeRows : [])
    .filter((row) => kMarkerStatusSet.has(String(row?.status || "")))
    .map((row) => ({
      kind: String(row.status),
      runId: String(row.runId || ""),
      clientMsgId: String(row.clientMsgId || ""),
      at: Number(row.endedAtMs) || Number(row.createdAtMs) || 0,
      detail: String(row.error || ""),
      confidence: String(row.confidence || "") || undefined,
      stopConfirmed:
        row.stopConfirmed === 1 || row.stopConfirmed === true ? true : undefined,
    }));

module.exports = {
  normalizeHistoryContent,
  normalizeHistoryRole,
  normalizeHistoryTimestamp,
  extractToolCalls,
  extractHistoryMetadata,
  normalizePartType,
  collectTextFromUnknownShape,
  extractToolCallFromUnknownShape,
  extractToolResultFromUnknownShape,
  resolveNativeRowId,
  parseRelayEnvelope,
  buildHistoryMessages,
  toMarkers,
};

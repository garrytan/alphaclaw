// History normalization for the chat bridge. The transcript-shape tolerance
// here (three payload shapes, unknown-block scrapers) is the de-facto version
// adaptation across OpenClaw releases — moved verbatim from the old
// chat-ws.js; only the stable-id minting and marker mapping are new.
const nodeCrypto = require("node:crypto");
const { kMarkerStatuses } = require("./protocol");

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
      partType === "tool_result"
    ) {
      return [];
    }
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

// Stable message identity (D2): deterministic across refetches so the client
// merges instead of remounting. The occurrence counter disambiguates rows
// whose (timestamp, role, content-prefix, toolCallId) collide — NOT the
// absolute row index, so ids survive the 200-row window sliding.
//
// Preferred over the synthetic hash: a native per-row id when the gateway
// exposes one (probed at runtime — some OpenClaw lines stamp `id` on rows).
const mintStableId = ({ sessionKey, row, occurrenceCounts }) => {
  const nativeId = String(row?.rawMessage?.id || "").trim();
  if (nativeId) return `h:${nativeId}`;
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
      if (role === "user") {
        content = content.replace(/^\[.*?\]\s*/, "");
      }
      const toolCalls = extractToolCalls(messageRow);
      const normalizedContent = String(content || "").trim();
      const timestamp = normalizeHistoryTimestamp(messageRow);
      const metadata = extractHistoryMetadata(messageRow);
      const basePayload = {
        timestamp,
        metadata,
        rawMessage: messageRow || null,
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
  buildHistoryMessages,
  toMarkers,
};

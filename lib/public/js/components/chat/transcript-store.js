import { randomUuid } from "../../lib/random-uuid.js";
// Pure transcript-state functions: history merging (never wholesale replace —
// the old chat-route's history handler wiped optimistic messages on every
// done/reconnect/switch), streaming chunk application (match by id ANYWHERE,
// not "last message" — a tool card between chunks must not split the bubble),
// and tool-card application (dedupe ONLY by toolCallId — id-less calls are
// real calls, never name-deduped away).
//
// Message model (render-compatible with the old chat-route):
//   { id, role: user|assistant|tool|system, content, createdAt,
//     debugPayload: { timestamp, metadata, rawMessage, toolCalls, toolResult, rawEvent },
//     clientMsgId?, live?, runId?, kind? (system markers), pendingState? }
// Pure module: no preact, injectable now/uuid.

const kConfirmSkewBeforeMs = 60_000;
const kConfirmSkewAfterMs = 30_000;
const kErrorMarkerWindowMs = 120_000;

export const extractToolCallsFromPayload = (payload = null) => {
  const normalizedPayload = payload && typeof payload === "object" ? payload : {};
  if (
    Array.isArray(normalizedPayload?.toolCalls) &&
    normalizedPayload.toolCalls.length > 0
  ) {
    return normalizedPayload.toolCalls;
  }
  const rawParts = Array.isArray(normalizedPayload?.rawMessage?.content)
    ? normalizedPayload.rawMessage.content
    : [];
  return rawParts
    .filter((part) => String(part?.type || "").toLowerCase() === "toolcall")
    .map((part) => ({
      id: String(part?.id || ""),
      name: String(part?.name || ""),
      arguments: part?.arguments || null,
      partialJson: String(part?.partialJson || ""),
    }))
    .filter((toolCall) => toolCall.name || toolCall.id);
};

export const normalizeToolResult = (toolResult = null) => {
  if (!toolResult || typeof toolResult !== "object") return null;
  const rawMessage = toolResult?.rawMessage || toolResult;
  if (!rawMessage || typeof rawMessage !== "object") return null;
  const contentParts = Array.isArray(rawMessage?.content) ? rawMessage.content : [];
  const text = contentParts
    .map((part) => String(part?.text || ""))
    .filter((value) => value.length > 0)
    .join("\n")
    .trim();
  return {
    toolCallId: String(rawMessage?.toolCallId || toolResult?.toolCallId || ""),
    toolName: String(rawMessage?.toolName || toolResult?.toolName || ""),
    text,
    isError: Boolean(
      rawMessage?.isError === true ||
        toolResult?.isError === true ||
        String(rawMessage?.status || "").toLowerCase() === "error",
    ),
    rawMessage,
  };
};

export const markerCopy = (marker = {}) => {
  const kind = String(marker?.kind || "");
  if (kind === "stopped") return "You stopped this response";
  if (kind === "interrupted") {
    return (
      String(marker?.detail || "") ||
      "Interrupted — connection to the agent was lost; the agent may have kept working"
    );
  }
  if (kind === "unknown") {
    return (
      String(marker?.detail || "") ||
      "This message may have been sent — check the transcript"
    );
  }
  return String(marker?.detail || "") || "This message failed";
};

const markerToMessage = (marker = {}) => ({
  id: `marker:${marker.clientMsgId || marker.runId || marker.at}:${marker.kind}`,
  role: "system",
  kind: String(marker.kind || ""),
  confidence: String(marker.confidence || ""),
  content: markerCopy(marker),
  createdAt: Number(marker.at) || 0,
  debugPayload: { marker },
});

export const createOptimisticUserMessage = ({ item }) => ({
  id: `c:${item.clientMsgId}`,
  role: "user",
  content: String(item.content || ""),
  createdAt: Number(item.createdAt) || 0,
  clientMsgId: item.clientMsgId,
  pendingState: String(item.status || "queued"),
  lastError: item.lastError || null,
  debugPayload: {
    source: "outbox",
    clientMsgId: item.clientMsgId,
    status: item.status,
  },
});

const historyRowToMessage = (row = {}) => ({
  id: String(row.id || ""),
  role: String(row.role || "assistant"),
  content: String(row.content || ""),
  createdAt: Number(row.timestamp) || 0,
  ...(row.speaker ? { speaker: row.speaker } : {}),
  ...(row.relay ? { relay: row.relay } : {}),
  debugPayload: {
    timestamp: row.timestamp,
    metadata: row.metadata || null,
    rawMessage: row.rawMessage || null,
    toolCalls: Array.isArray(row.toolCalls) ? row.toolCalls : [],
    toolResult: row.toolResult || null,
  },
});

/**
 * Once older pages are loaded, rows that slide out of the front of the newest
 * window (new messages pushed them out) sit between the two: keep them at the
 * end of the older rows, or the transcript gets a silent gap (ALPH-68).
 */
export const keepSlidRows = ({ olderRows = [], previousRows = [], nextRows = [] }) => {
  if (olderRows.length === 0) return olderRows;
  const kept = new Set([...olderRows, ...nextRows].map((row) => String(row.id || "")));
  const slid = previousRows.filter((row) => !kept.has(String(row.id || "")));
  return slid.length > 0 ? [...olderRows, ...slid] : olderRows;
};

/**
 * Merge a fresh history payload into the current transcript. NEVER drops:
 *  (a) unconfirmed outbox items (rendered as user bubbles with state chips) —
 *      a history user row matching content within
 *      [createdAt − 60s, (ackedAt || createdAt) + 30s] CONFIRMS one item
 *      (oldest-first, one-shot consumption — identical texts can't
 *      cross-confirm) via onConfirmed(clientMsgId);
 *  (b) the active run's live streaming message and live tool cards;
 *  (c) a finished run's live rows until history contains their content
 *      (the gateway can persist a beat after `done` — never blank shown text).
 * Object identity is reused for unchanged rows so the list does not remount
 * (stable ids come from the server).
 */
export const mergeHistory = ({
  current = [],
  rows = [],
  olderRows = [],
  markers = [],
  outboxItems = [],
  activeMessageId = "",
  onConfirmed = () => {},
}) => {
  const previousById = new Map();
  for (const message of current) previousById.set(message.id, message);

  // Older pages the user loaded stay above the newest window (ALPH-68).
  const tailIds = new Set(rows.map((row) => String(row.id || "")));
  const allRows = [
    ...(Array.isArray(olderRows) ? olderRows : []).filter((row) => !tailIds.has(String(row.id || ""))),
    ...rows,
  ];

  const merged = allRows.map((row) => {
    const next = historyRowToMessage(row);
    const previous = previousById.get(next.id);
    if (
      previous &&
      previous.content === next.content &&
      Boolean(previous.debugPayload?.toolResult) ===
        Boolean(next.debugPayload?.toolResult)
    ) {
      return previous;
    }
    return next;
  });

  // Interleave markers by timestamp without disturbing history's own order.
  // A run whose error the transcript already shows gets no second, generic
  // error marker.
  const errorRowTimes = merged
    .filter((row) => row.role === "assistant" && row.debugPayload?.metadata?.stopReason === "error")
    .map((row) => row.createdAt || 0);
  for (const marker of Array.isArray(markers) ? markers : []) {
    if (
      String(marker?.kind || "") === "error" &&
      errorRowTimes.some((at) => Math.abs(at - (Number(marker.at) || 0)) <= kErrorMarkerWindowMs)
    ) {
      continue;
    }
    const message = markerToMessage(marker);
    const previous = previousById.get(message.id);
    const insert = previous || message;
    let index = merged.findIndex(
      (row) => (row.createdAt || 0) > (message.createdAt || 0),
    );
    if (index < 0) index = merged.length;
    merged.splice(index, 0, insert);
  }

  // Confirm outbox items against history user rows (bounded window, one-shot).
  // The server strips a leading "[sender] " label from user history rows
  // (history.js) — strip BOTH sides identically or a message that itself
  // starts with "[...]" never confirms and duplicates forever.
  const consumedRowIds = new Set();
  const historyText = (value) =>
    String(value || "").trim().replace(/^\[.*?\]\s*/, "");
  for (const item of outboxItems) {
    // Only items that were actually SENT can be confirmed (fix wave F122): a
    // queued item that never left the outbox matched an older identical user
    // row inside the skew window and was deleted unsent.
    if (!Number(item.sentAt) && !Number(item.ackedAt)) continue;
    const ackedAt = Number(item.ackedAt) || Number(item.createdAt) || 0;
    const match = merged.find(
      (row) =>
        row.role === "user" &&
        !row.clientMsgId &&
        !consumedRowIds.has(row.id) &&
        historyText(row.content) === historyText(item.content) &&
        (row.createdAt || 0) >= (item.createdAt || 0) - kConfirmSkewBeforeMs &&
        (row.createdAt || 0) <= ackedAt + kConfirmSkewAfterMs,
    );
    if (match) {
      consumedRowIds.add(match.id);
      onConfirmed(item.clientMsgId);
    }
    // Unconfirmed items are NOT copied into the merged list: the render layer
    // composes them from the outbox directly (single source of truth), so a
    // history refetch can never wipe an optimistic bubble.
  }

  // Rows a session event delivered after this history read was taken stay
  // until a later read contains them.
  const mergedIds = new Set(merged.map((row) => row.id));
  const newestAt = merged.reduce((latest, row) => Math.max(latest, row.createdAt || 0), 0);
  for (const message of current) {
    if (!message.fromSession || mergedIds.has(message.id)) continue;
    if ((message.createdAt || 0) >= newestAt) merged.push(message);
  }

  // Keep live rows (streaming assistant text + tool cards) that history does
  // not cover yet.
  for (const message of current) {
    if (!message.live) continue;
    const stillActive =
      activeMessageId && String(message.streamMessageId || "") === activeMessageId;
    if (stillActive) {
      merged.push(message);
      continue;
    }
    if (message.role === "assistant") {
      const covered = merged.some(
        (row) =>
          row.role === "assistant" &&
          !row.live &&
          historyText(row.content) === historyText(message.content),
      );
      // Self-heal: a finished run's live row with a stream hole (dropped
      // chunk, desync, resume overlap) never content-matches — once history
      // shows ANY newer persisted assistant row, history is authoritative for
      // this turn; keeping the holey live copy would duplicate the bubble for
      // the rest of the tab's lifetime.
      const superseded =
        !covered &&
        merged.some(
          (row) =>
            row.role === "assistant" &&
            !row.live &&
            (row.createdAt || 0) >= (message.createdAt || 0),
        );
      if (!covered && !superseded) merged.push(message);
      continue;
    }
    if (message.role === "tool") {
      const toolCall = extractToolCallsFromPayload(message.debugPayload)[0] || null;
      const covered = merged.some((row) => {
        if (row.role !== "tool" || row.live) return false;
        const rowCall = extractToolCallsFromPayload(row.debugPayload)[0] || null;
        if (toolCall?.id && rowCall?.id) return rowCall.id === toolCall.id;
        return Boolean(rowCall?.name) && rowCall?.name === toolCall?.name;
      });
      if (!covered) merged.push(message);
    }
  }

  return merged;
};

/**
 * Compose the render list: merged transcript + the session's unconfirmed
 * outbox items as user bubbles (appended in creation order — they are always
 * the newest user activity).
 */
export const composeVisibleMessages = ({ messages = [], outboxItems = [] }) => {
  if (!outboxItems.length) return messages;
  const sorted = outboxItems
    .slice()
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
    .map((item) => createOptimisticUserMessage({ item }));
  // Items whose send is in flight/acked started the run whose LIVE rows are
  // streaming — they belong above those rows (fix wave F123); unsent items
  // are newer activity and stay at the bottom.
  const firstLive = messages.findIndex((message) => message?.live);
  if (firstLive < 0) return [...messages, ...sorted];
  const sent = sorted.filter((m) => m.pendingState === "acked" || m.pendingState === "inflight");
  const unsent = sorted.filter((m) => m.pendingState !== "acked" && m.pendingState !== "inflight");
  return [...messages.slice(0, firstLive), ...sent, ...messages.slice(firstLive), ...unsent];
};

/**
 * Apply a streaming chunk: append to the assistant message with this
 * streamMessageId WHEREVER it is in the list (a tool card between two chunks
 * must not split the bubble into duplicate-id fragments).
 */
export const applyChunk = ({ messages = [], messageId, content, runId, now }) => {
  const streamId = String(messageId || "");
  const chunkText = String(content || "");
  if (!streamId || !chunkText) return messages;
  const index = messages.findIndex(
    (message) =>
      message.role === "assistant" &&
      String(message.streamMessageId || "") === streamId,
  );
  if (index >= 0) {
    const existing = messages[index];
    const next = messages.slice();
    next[index] = {
      ...existing,
      content: `${String(existing.content || "")}${chunkText}`,
      debugPayload: {
        ...(existing.debugPayload || {}),
        source: "stream",
        chunkCount: Number(existing.debugPayload?.chunkCount || 1) + 1,
        lastChunk: chunkText,
      },
    };
    return next;
  }
  return [
    ...messages,
    {
      id: `live:${streamId}`,
      streamMessageId: streamId,
      live: true,
      runId: String(runId || ""),
      role: "assistant",
      content: chunkText,
      createdAt: Number(now) || Date.now(),
      debugPayload: { source: "stream", messageId: streamId, chunkCount: 1 },
    },
  ];
};

const buildLiveToolMessage = ({ toolCall, toolResult, timestamp, rawEvent, runId, uuid }) => ({
  id: `live-tool:${uuid()}`,
  live: true,
  runId: String(runId || ""),
  role: "tool",
  content: `Tool call: ${String(toolCall?.name || toolResult?.toolName || "unknown")}`,
  createdAt: Number(timestamp) || Date.now(),
  debugPayload: {
    timestamp,
    metadata: null,
    rawMessage: null,
    toolCalls: toolCall && (toolCall.name || toolCall.id) ? [toolCall] : [],
    toolResult: toolResult || null,
    rawEvent: rawEvent || null,
  },
});

/**
 * Apply a live tool event. Calls dedupe ONLY by toolCallId (an id-less call
 * is a real, distinct call). Results attach by toolCallId, or to the NEWEST
 * unresolved same-name card when both ids are missing; orphan results get a
 * synthetic card.
 */
export const applyTool = ({
  messages = [],
  payload = {},
  runId,
  uuid = () => randomUuid(),
}) => {
  const toolPhase = String(payload.phase || "").toLowerCase();
  const toolCall =
    payload?.toolCall && typeof payload.toolCall === "object" ? payload.toolCall : null;
  const toolResult =
    payload?.toolResult && typeof payload.toolResult === "object"
      ? payload.toolResult
      : null;
  const toolCallId = String(
    toolCall?.id || toolResult?.toolCallId || payload?.toolCallId || "",
  );
  const toolTimestamp = Number(payload.timestamp) || Date.now();

  if (toolPhase === "call" && toolCall) {
    if (toolCallId) {
      const duplicate = messages.some((message) => {
        if (message.role !== "tool") return false;
        const existingCall = extractToolCallsFromPayload(message.debugPayload)[0];
        return Boolean(existingCall?.id) && existingCall.id === toolCallId;
      });
      if (duplicate) return messages;
    }
    return [
      ...messages,
      buildLiveToolMessage({
        toolCall,
        toolResult: null,
        timestamp: toolTimestamp,
        rawEvent: payload?.rawEvent || null,
        runId,
        uuid,
      }),
    ];
  }

  if (toolPhase === "result" && (toolResult || toolCall)) {
    const resultToolName = String(toolResult?.toolName || "");
    let matchIndex = -1;
    if (toolCallId) {
      matchIndex = messages.findIndex((message) => {
        if (message.role !== "tool") return false;
        const existingCall = extractToolCallsFromPayload(message.debugPayload)[0];
        return String(existingCall?.id || "") === toolCallId;
      });
    } else if (resultToolName) {
      // Newest unresolved same-name card.
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== "tool") continue;
        const existingCall = extractToolCallsFromPayload(message.debugPayload)[0];
        if (String(existingCall?.id || "")) continue;
        if (String(existingCall?.name || "") !== resultToolName) continue;
        if (normalizeToolResult(message?.debugPayload?.toolResult)) continue;
        matchIndex = index;
        break;
      }
    }
    if (matchIndex >= 0) {
      const next = messages.slice();
      next[matchIndex] = {
        ...next[matchIndex],
        debugPayload: {
          ...(next[matchIndex].debugPayload || {}),
          toolResult: toolResult || null,
          rawEvent: payload?.rawEvent || null,
        },
      };
      return next;
    }
    return [
      ...messages,
      buildLiveToolMessage({
        toolCall:
          toolCall || {
            id: String(toolResult?.toolCallId || ""),
            name: String(toolResult?.toolName || "unknown"),
            arguments: null,
            partialJson: "",
          },
        toolResult,
        timestamp: toolTimestamp,
        rawEvent: payload?.rawEvent || null,
        runId,
        uuid,
      }),
    ];
  }

  return messages;
};

// Session events (ALPH-68, d4): persisted rows from any source (Telegram,
// relay, cron, another tab) for the session this tab watches. Rows merge by
// their stable id; a persisted assistant row ends its run's live preview.
export const appendSessionRows = ({ current = [], rows = [], runId = "" }) => {
  let next = current.slice();
  let sawAssistant = false;
  for (const row of Array.isArray(rows) ? rows : []) {
    const message = { ...historyRowToMessage(row), fromSession: true };
    if (!message.id) continue;
    if (message.role === "assistant") sawAssistant = true;
    const index = next.findIndex((existing) => existing.id === message.id);
    if (index >= 0) {
      if (next[index].content !== message.content) next[index] = message;
      continue;
    }
    next.push(message);
  }
  if (sawAssistant) {
    next = next.filter(
      (message) => !(message.live && message.foreign && (!runId || message.runId === runId)),
    );
  }
  return next;
};

// A tool result row arrives on its own after its call row.
export const attachSessionToolResult = ({ messages = [], toolCallId = "", toolResult = null }) => {
  const id = String(toolCallId || "");
  if (!id || !toolResult) return messages;
  const index = messages.findIndex((message) => {
    if (message.role !== "tool") return false;
    return String(extractToolCallsFromPayload(message.debugPayload)[0]?.id || "") === id;
  });
  if (index < 0) return messages;
  const next = messages.slice();
  next[index] = {
    ...next[index],
    debugPayload: { ...(next[index].debugPayload || {}), toolResult },
  };
  return next;
};

// Live text of a run this tab did not start, shown until its row persists.
export const applyForeignChunk = ({ messages = [], runId = "", content = "", now }) => {
  const text = String(content || "");
  if (!text) return messages;
  const index = messages.findIndex(
    (message) => message.live && message.foreign && message.runId === String(runId || ""),
  );
  if (index >= 0) {
    const next = messages.slice();
    next[index] = { ...next[index], content: `${next[index].content}${text}` };
    return next;
  }
  const createdAt = Number(now) || Date.now();
  return [
    ...messages,
    {
      id: `foreign:${String(runId || "")}:${createdAt}`,
      streamMessageId: `foreign:${String(runId || "")}`,
      live: true,
      foreign: true,
      runId: String(runId || ""),
      role: "assistant",
      content: text,
      createdAt,
      debugPayload: { source: "session-event", runId: String(runId || "") },
    },
  ];
};


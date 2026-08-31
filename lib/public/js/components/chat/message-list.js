import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { MessageBubble } from "./message-bubble.js";
import { ToolCard } from "./tool-card.js";
import { SystemMarker } from "./system-marker.js";
import { isRunActive } from "./run-state.js";

const html = htm.bind(h);
const kAutoscrollBottomThresholdPx = 40;
const kJumpPillThresholdPx = 150;

// The transcript. Stable message ids keep <details> open state and scroll
// position across the merge-refetch after every turn (the old wholesale
// replace remounted the entire list). Auto-scroll disengages when the user
// scrolls up; a "Jump to latest" pill appears during active streams.
export const MessageList = ({
  messages = [],
  runState,
  historyMeta = {},
  selectedSessionKey = "",
  chatDebugEnabled = false,
  rawHistory = null,
  debugEvents = [],
  onRetryItem,
  onDiscardItem,
  onCancelQueued,
  onRetryHistory,
  stalledHint = false,
}) => {
  const threadRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const [showJumpPill, setShowJumpPill] = useState(false);

  const isStreamingPhase = isRunActive(runState);

  const handleThreadScroll = useCallback(() => {
    const threadElement = threadRef.current;
    if (!threadElement) return;
    const distanceFromBottom =
      threadElement.scrollHeight -
      threadElement.scrollTop -
      threadElement.clientHeight;
    shouldAutoScrollRef.current =
      distanceFromBottom <= kAutoscrollBottomThresholdPx;
    setShowJumpPill(distanceFromBottom > kJumpPillThresholdPx);
  }, []);

  const jumpToLatest = useCallback(() => {
    const threadElement = threadRef.current;
    if (!threadElement) return;
    shouldAutoScrollRef.current = true;
    threadElement.scrollTop = threadElement.scrollHeight;
    setShowJumpPill(false);
  }, []);

  useEffect(() => {
    const threadElement = threadRef.current;
    if (!threadElement) return;
    if (!shouldAutoScrollRef.current) return;
    threadElement.scrollTop = threadElement.scrollHeight;
  }, [messages, isStreamingPhase]);

  const historyLoading = historyMeta?.loading === true;
  const historyError = String(historyMeta?.error || "");
  const showTypingIndicator =
    Boolean(selectedSessionKey) &&
    isStreamingPhase &&
    !runState?.assistantStreamStarted;

  return html`
    <div class="chat-thread-wrap">
      <div class="chat-thread" ref=${threadRef} onscroll=${handleThreadScroll}>
        ${historyMeta?.truncated
          ? html`<div class="chat-truncated-note">
              Older messages aren't shown
            </div>`
          : null}
        ${historyLoading
          ? html`<div class="chat-history-loading" role="status">
              Refreshing history…
            </div>`
          : null}
        ${historyError
          ? html`<div class="chat-history-error" role="status">
              <span>${historyError}</span>
              ${onRetryHistory
                ? html`<button
                    type="button"
                    class="ac-btn-secondary"
                    onclick=${onRetryHistory}
                  >
                    Retry
                  </button>`
                : null}
            </div>`
          : null}
        ${!selectedSessionKey
          ? html`<div class="chat-empty-state">
              Select a session to begin chatting.
            </div>`
          : messages.length === 0 && !historyLoading && !historyError
            ? html`<div class="chat-empty-state">
                Start a message in this session.
              </div>`
            : messages.map((message) => {
                if (message.role === "system") {
                  return html`<${SystemMarker}
                    key=${message.id}
                    message=${message}
                  />`;
                }
                if (message.role === "tool") {
                  return html`<${ToolCard} key=${message.id} message=${message} />`;
                }
                return html`<${MessageBubble}
                  key=${message.id}
                  message=${message}
                  chatDebugEnabled=${chatDebugEnabled}
                  onRetryItem=${onRetryItem}
                  onDiscardItem=${onDiscardItem}
                  onCancelQueued=${onCancelQueued}
                />`;
              })}
        ${stalledHint
          ? html`<div class="chat-stalled-note" role="status">
              Still working — no output for a couple of minutes…
            </div>`
          : null}
        ${showTypingIndicator
          ? html`
              <div
                class="chat-bubble is-assistant chat-typing-indicator"
                aria-live="polite"
                aria-label="Agent is working"
              >
                <div class="chat-typing-dots" aria-hidden="true">
                  <span></span><span></span><span></span>
                </div>
              </div>
            `
          : null}
        ${selectedSessionKey && chatDebugEnabled
          ? html`
              <details class="chat-raw-debug">
                <summary>Raw history JSON</summary>
                <pre>${JSON.stringify(rawHistory || null, null, 2)}</pre>
              </details>
              <details class="chat-raw-debug">
                <summary>Inbound event log</summary>
                <pre>${JSON.stringify(debugEvents, null, 2)}</pre>
              </details>
            `
          : null}
      </div>
      ${showJumpPill && isStreamingPhase
        ? html`
            <button
              type="button"
              class="chat-jump-pill"
              onclick=${jumpToLatest}
            >
              ↓ Jump to latest
            </button>
          `
        : null}
    </div>
  `;
};

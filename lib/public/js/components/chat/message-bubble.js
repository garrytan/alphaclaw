import { h } from "preact";
import { memo } from "preact/compat";
import { useMemo } from "preact/hooks";
import htm from "htm";
import { formatLocaleTime } from "../../lib/format.js";
import { renderMarkdownHtml, parseJsonMessage } from "./markdown.js";
import { InlineErrorChip } from "../inline-error-chip.js";

const html = htm.bind(h);

const copyMessage = async (content) => {
  try {
    // Copies the RAW markdown source, not rendered HTML.
    await navigator.clipboard.writeText(String(content || ""));
  } catch {}
};

const pendingLabel = (pendingState) => {
  if (pendingState === "queued") return "Queued";
  if (pendingState === "inflight") return "Sending…";
  return "";
};

// A user/assistant bubble. Outbox-backed user bubbles carry pendingState and
// their failure affordances (Retry/Discard — never a silent snap-back).
// memo'd: chunk frames re-render only the streaming bubble, not the whole
// transcript (stable ids + stable action callbacks make identity hold).
const MessageBubbleImpl = ({
  message,
  chatDebugEnabled = false,
  onRetryItem,
  onDiscardItem,
  onCancelQueued,
}) => {
  const isUser = message.role === "user";
  const pendingState = String(message.pendingState || "");
  const isPending = pendingState === "queued" || pendingState === "inflight";
  const isFailed = pendingState === "failed";
  const isUnknown = pendingState === "unknown";
  const stateChip = pendingLabel(pendingState);
  const parsedJson = useMemo(
    () => parseJsonMessage(message.content),
    [message.content],
  );
  const markdownHtml = useMemo(
    () => (parsedJson ? "" : renderMarkdownHtml(message.content)),
    [parsedJson, message.content],
  );

  return html`
    <div
      class=${`chat-bubble ${isUser ? "is-user" : "is-assistant"} ${
        isPending ? "is-pending" : ""
      } ${isFailed || isUnknown ? "is-failed" : ""}`}
      aria-live=${message.live ? "polite" : undefined}
    >
      <div class="chat-bubble-meta">
        <span>${isUser ? "You" : "Agent"}</span>
        ${stateChip
          ? html`<span class="chat-bubble-state-chip">${stateChip}</span>`
          : html`<span
              >${formatLocaleTime(message.createdAt, {
                valueIsEpochMs: true,
                fallback: "",
              })}</span
            >`}
        <button
          type="button"
          class="chat-bubble-copy"
          title="Copy message"
          aria-label="Copy message"
          onclick=${() => copyMessage(message.content)}
        >
          ⧉
        </button>
      </div>
      ${parsedJson
        ? html`<pre class="chat-bubble-content chat-bubble-json">
${JSON.stringify(parsedJson, null, 2)}</pre
          >`
        : html`
            <div
              class="chat-bubble-content chat-bubble-markdown"
              dangerouslySetInnerHTML=${{ __html: markdownHtml }}
            ></div>
          `}
      ${isPending && pendingState === "queued" && onCancelQueued
        ? html`
            <div class="chat-bubble-actions">
              <button
                type="button"
                class="ac-btn-secondary chat-bubble-action"
                onclick=${() => onCancelQueued(message.clientMsgId)}
              >
                Cancel
              </button>
            </div>
          `
        : null}
      ${isFailed || isUnknown
        ? html`
            <div class="chat-bubble-failure">
              <${InlineErrorChip}
                headline=${isUnknown
                  ? "This message may have been sent — check the transcript before retrying."
                  : String(message.lastError?.message || "Not sent.")}
                error=${null}
                onRetry=${onRetryItem
                  ? () => onRetryItem(message.clientMsgId)
                  : null}
                retryLabel="Retry"
              />
              ${onDiscardItem
                ? html`
                    <button
                      type="button"
                      class="ac-btn-secondary chat-bubble-action"
                      onclick=${() => onDiscardItem(message.clientMsgId)}
                    >
                      Discard
                    </button>
                  `
                : null}
            </div>
          `
        : null}
      ${chatDebugEnabled
        ? html`
            <details class="chat-message-json">
              <summary>JSON</summary>
              <pre>
${JSON.stringify(
                  message.debugPayload || {
                    role: message.role,
                    content: message.content,
                    createdAt: message.createdAt,
                  },
                  null,
                  2,
                )}</pre
              >
            </details>
          `
        : null}
    </div>
  `;
};

export const MessageBubble = memo(MessageBubbleImpl);

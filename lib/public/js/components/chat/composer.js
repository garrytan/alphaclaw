import { h } from "preact";
import { useCallback, useLayoutEffect, useRef } from "preact/hooks";
import htm from "htm";
import { contentByteLength, kDefaultMaxContentBytes } from "./chat-protocol.js";
import { isRunActive, kStopping } from "./run-state.js";

const html = htm.bind(h);

const kComposerMaxLines = 5;
const kComposerFontSizePx = 12;
const kComposerLineHeight = 1.4;
const kComposerPaddingYPx = 20;

const resizeComposerTextarea = (element) => {
  if (!element) return;
  const linePx = kComposerFontSizePx * kComposerLineHeight;
  const minH = linePx + kComposerPaddingYPx;
  const maxH = linePx * kComposerMaxLines + kComposerPaddingYPx;
  element.style.height = "auto";
  const next = Math.min(Math.max(element.scrollHeight, minH), maxH);
  element.style.height = `${next}px`;
};

// The composer is NEVER disabled while a session is selected — typing during
// streaming or while disconnected queues instead of silently eating the
// message (the original "eats messages" bug). Enter sends/queues,
// Shift+Enter newline, Escape stops the active run.
export const Composer = ({
  selectedSessionKey = "",
  draft = "",
  onDraftInput,
  onSend,
  onStop,
  runState,
  connectionMode = "online",
  legacy = false,
  maxContentBytes = kDefaultMaxContentBytes,
  stopError = "",
  holdFlush = false,
  onConfirmFlush,
  queuedCount = 0,
  onFlushDraftPersist,
  focusNonce = 0,
}) => {
  const composerRef = useRef(null);

  useLayoutEffect(() => {
    resizeComposerTextarea(composerRef.current);
  }, [draft, selectedSessionKey]);

  // Autofocus on session switch and after Retry/Discard — keyboard flow
  // returns to typing immediately.
  useLayoutEffect(() => {
    if (selectedSessionKey) composerRef.current?.focus();
  }, [selectedSessionKey, focusNonce]);

  const runActive = isRunActive(runState);
  const stopping = runState?.phase === kStopping;
  // Legacy servers handle stop frames fine — only a genuinely unusable
  // socket disables the button (keeps parity with the Escape-key path).
  const socketUnusable =
    connectionMode === "offline" ||
    connectionMode === "httpFallback" ||
    connectionMode === "connecting" ||
    connectionMode === "reconnecting";
  // Measure the JSON-SERIALIZED content, not the raw text: escaping inflates
  // control characters ~6x, and a draft that passes a raw-bytes check can
  // serialize past the server's frame cap — the socket then dies with a 1009
  // instead of showing this chip.
  const draftBytes = Math.max(
    0,
    contentByteLength(JSON.stringify(String(draft || ""))) - 2,
  );
  const oversized = draftBytes > maxContentBytes;
  const sendDisabled = !selectedSessionKey || !String(draft || "").trim() || oversized;
  const willQueue = runActive || connectionMode !== "online";

  const handleKeyDown = useCallback(
    (event) => {
      if (event.key === "Escape" && runActive) {
        event.preventDefault();
        onStop?.();
        return;
      }
      if (event.key !== "Enter") return;
      if (event.shiftKey) return;
      if (event.isComposing) return;
      event.preventDefault();
      if (!sendDisabled) onSend?.();
    },
    [onSend, onStop, runActive, sendDisabled],
  );

  return html`
    <div class="chat-composer">
      ${oversized
        ? html`<div class="chat-composer-warning" role="status">
            Message too large to send (max
            ${Math.round(maxContentBytes / 1024 / 1024)}MB).
          </div>`
        : null}
      ${stopError
        ? html`<div class="chat-composer-warning" role="status">
            ${stopError}
          </div>`
        : null}
      ${holdFlush && queuedCount > 0
        ? html`<div class="chat-composer-hold" role="status">
            <span>
              The last run was interrupted — the agent may still be working.
              Send the queued message${queuedCount > 1 ? "s" : ""}?
            </span>
            <button
              type="button"
              class="ac-btn-cyan chat-composer-hold-send"
              onclick=${onConfirmFlush}
            >
              Send queued
            </button>
          </div>`
        : null}
      <textarea
        class="chat-composer-input"
        ref=${composerRef}
        rows=${1}
        placeholder=${selectedSessionKey
          ? "Message… (Enter to send, Shift+Enter for newline)"
          : "Select a session to start"}
        value=${draft}
        disabled=${!selectedSessionKey}
        oninput=${(event) => onDraftInput?.(String(event?.target?.value || ""))}
        onkeydown=${handleKeyDown}
        onblur=${() => onFlushDraftPersist?.()}
      ></textarea>
      <div class="chat-composer-actions">
        ${runActive
          ? html`
              <button
                type="button"
                class="ac-btn-secondary chat-composer-stop"
                disabled=${stopping || socketUnusable}
                onclick=${onStop}
                title=${stopping ? "Waiting for the agent to stop" : "Stop (Esc)"}
              >
                ${stopping ? "Stopping…" : "Stop"}
              </button>
            `
          : null}
        <button
          type="button"
          class="ac-btn-cyan chat-composer-send"
          disabled=${sendDisabled}
          onclick=${onSend}
          title=${willQueue
            ? "Queued — sends when the agent is free and connected"
            : legacy
              ? "Limited mode: sends once, no automatic retry"
              : "Send (Enter)"}
        >
          ${willQueue ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  `;
};

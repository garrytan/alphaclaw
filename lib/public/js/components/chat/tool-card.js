import { h } from "preact";
import { memo } from "preact/compat";
import { useMemo } from "preact/hooks";
import htm from "htm";
import { formatLocaleTime } from "../../lib/format.js";
import {
  extractToolCallsFromPayload,
  normalizeToolResult,
} from "./transcript-store.js";

const html = htm.bind(h);

// Collapsible inline tool-call card (payload + result), same information as
// the old chat-route's <details> block.
const ToolCardImpl = ({ message }) => {
  const toolCalls = extractToolCallsFromPayload(message.debugPayload);
  const primaryToolCall = toolCalls[0] || null;
  const matchedResult = normalizeToolResult(
    message?.debugPayload?.toolResult || null,
  );
  // Pretty-printing a large tool result at token rate for a collapsed card is
  // pure waste — memoize on the payload identity.
  const payloadJson = useMemo(
    () =>
      JSON.stringify(
        {
          id: String(primaryToolCall?.id || "") || null,
          name: String(primaryToolCall?.name || "") || null,
          arguments: primaryToolCall?.arguments || null,
          partialJson: String(primaryToolCall?.partialJson || "") || null,
        },
        null,
        2,
      ),
    [primaryToolCall],
  );
  const resultJson = useMemo(
    () =>
      matchedResult
        ? JSON.stringify(
            {
              toolCallId: matchedResult.toolCallId,
              toolName: matchedResult.toolName,
              text: matchedResult.text || "",
              isError: matchedResult.isError,
              rawMessage: matchedResult.rawMessage || null,
            },
            null,
            2,
          )
        : "",
    [matchedResult],
  );
  if (!primaryToolCall) return null;
  return html`
    <div class="chat-bubble is-assistant chat-tool-bubble">
      <details class="chat-tool-inline-message">
        <summary>
          <span class="chat-tool-inline-icon">🛠️</span>
          <span class="chat-tool-inline-title"
            >${String(primaryToolCall?.name || "unknown")}</span
          >
          <span class="chat-tool-inline-time"
            >${formatLocaleTime(message.createdAt, {
              valueIsEpochMs: true,
              fallback: "",
            })}</span
          >
        </summary>
        <div class="chat-tool-inline-body">
          <div class="chat-tool-inline-label">Payload</div>
          <pre>${payloadJson}</pre>
          ${matchedResult
            ? html`
                <div class="chat-tool-inline-label">
                  Result${matchedResult.isError ? " (error)" : ""}
                </div>
                <pre>${resultJson}</pre>
              `
            : null}
        </div>
      </details>
    </div>
  `;
};

export const ToolCard = memo(ToolCardImpl);

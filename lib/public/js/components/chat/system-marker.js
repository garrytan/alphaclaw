import { h } from "preact";
import htm from "htm";
import { formatLocaleTime } from "../../lib/format.js";

const html = htm.bind(h);

// Inline system marker: the visible record of a stop / interruption / unknown
// outcome, persisted server-side (db/chat-runs) so it survives reloads.
export const SystemMarker = ({ message }) => html`
  <div
    class=${`chat-system-marker is-${String(message.kind || "info")}`}
    role="status"
    aria-live="polite"
  >
    <span class="chat-system-marker-text">${message.content}</span>
    ${message.createdAt
      ? html`<span class="chat-system-marker-time"
          >${formatLocaleTime(message.createdAt, {
            valueIsEpochMs: true,
            fallback: "",
          })}</span
        >`
      : null}
  </div>
`;

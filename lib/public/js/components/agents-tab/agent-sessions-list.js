import { h } from "preact";
import htm from "htm";
import { getChatSessionLabel, getSessionRowKey } from "../../lib/session-keys.js";
import { formatRelativeTime } from "../../lib/format.js";
import { canOpenSessionInChat } from "./agent-detail-model.js";

const html = htm.bind(h);

const sessionTime = (row) => row?.lastActivityAt || row?.updatedAt || null;

// This agent's sessions from the shell's one session list (no new poller).
// A row links into Chat when Chat accepts that session key, else plain text.
export const AgentSessionsList = ({ sessions = [], limit = 0 }) => {
  const rows = limit > 0 ? sessions.slice(0, limit) : sessions;
  if (rows.length === 0) {
    return html`<p class="text-sm text-fg-muted">No sessions for this agent yet.</p>`;
  }
  return html`
    <ul class="agents-session-list">
      ${rows.map((row) => {
        const key = getSessionRowKey(row);
        const label = getChatSessionLabel(row);
        const at = sessionTime(row);
        return html`
          <li key=${key} class="agents-session-row">
            ${canOpenSessionInChat(key)
              ? html`<a class="agents-session-link" href=${"#/chat/" + encodeURIComponent(key)}>${label}</a>`
              : html`<span class="text-body">${label}</span>`}
            <span class="agents-session-time">${at ? formatRelativeTime(at, { style: "long" }) : ""}</span>
          </li>
        `;
      })}
    </ul>
  `;
};

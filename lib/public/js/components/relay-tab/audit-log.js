import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { Badge } from "../badge.js";
import { formatRelativeTime } from "../../lib/format.js";
import { kRunStateCopy } from "./model.js";

const html = htm.bind(h);

// The relay message log. Bodies are what other agents and threads said to
// this box; they stay collapsed until the operator opens one.
const LogRow = ({ message }) => {
  const [open, setOpen] = useState(false);
  const status = message.relayStatus ? kRunStateCopy[message.relayStatus] : null;
  return html`
    <li class="py-2 border-t border-border first:border-t-0">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <span class="font-medium">@${message.from || "?"}</span>
        <span class="text-fg-muted">→</span>
        <span class="font-medium">${message.to ? "@" + message.to : message.kind || "thread"}</span>
        ${status ? html`<${Badge} tone=${status.tone}>${message.relayCode || status.label}</${Badge}>` : null}
        <span class="text-xs text-fg-muted ml-auto" title=${message.createdAt || ""}>
          ${formatRelativeTime(message.createdAt, { style: "compact" })}
        </span>
        <button
          type="button"
          class="text-xs text-fg-muted hover:text-body underline"
          aria-expanded=${open ? "true" : "false"}
          onclick=${() => setOpen(!open)}
        >
          ${open ? "Hide" : "Show message"}
        </button>
      </div>
      ${open
        ? html`<pre class="mt-2 text-xs whitespace-pre-wrap break-words bg-field rounded-lg p-2 max-h-64 overflow-auto">${message.text || "(empty)"}</pre>`
        : null}
    </li>
  `;
};

export const RelayAuditLog = ({ messages = [], error = null, ready = false }) => html`
  <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
    <h3 class="font-semibold text-sm">Message log</h3>
    <p class="text-xs text-fg-muted">
      Every relay message, kept for the retention period. Message text is shown only to signed-in people.
    </p>
    ${error
      ? html`<p class="text-sm text-status-error-muted">${String(error?.message || error)}</p>`
      : !ready
        ? html`<p class="text-sm text-fg-muted">The log appears once the relay is ready.</p>`
        : messages.length === 0
          ? html`<p class="text-sm text-fg-muted">No relay messages yet.</p>`
          : html`<ul>${messages.map((message) => html`<${LogRow} key=${message.id} message=${message} />`)}</ul>`}
  </div>
`;

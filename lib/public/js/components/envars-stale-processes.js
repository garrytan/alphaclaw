import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

const kStateLabels = {
  differs: "old value",
  still_set: "still set",
  missing: "not set yet",
};

const describeProcess = (proc) =>
  `${proc.gateway ? "gateway " : ""}${proc.command} (pid ${proc.pid}, ${kStateLabels[proc.state] || proc.state})`;

// What a save left behind: processes started before it still run with the
// old value (read from /proc by hash; no value ever reaches the browser).
export const EnvarsStaleProcesses = ({ report, onDismiss }) => {
  const stale = report?.available ? report.stale || [] : [];
  if (!stale.length) return null;
  return html`
    <div class="bg-surface border border-border rounded-xl px-4 py-3 text-sm">
      <div class="flex items-start justify-between gap-3">
        <div>
          <h3 class="card-label text-xs">Still running with the previous environment</h3>
          <p class="text-xs text-fg-muted mt-1">
            These processes started before the save and keep their environment until they restart.
            Gateway processes restart with the gateway; restart the others where they are managed.
          </p>
        </div>
        <button
          onclick=${onDismiss}
          class="text-xs text-fg-muted hover:text-body shrink-0"
        >
          Dismiss
        </button>
      </div>
      <ul class="mt-2 space-y-1">
        ${stale.map(
          ({ key, processes }) => html`
            <li key=${key} class="text-xs">
              <span class="font-mono text-body">${key}</span>
              <span class="text-fg-muted">: ${processes.map(describeProcess).join(", ")}</span>
            </li>
          `,
        )}
      </ul>
    </div>
  `;
};

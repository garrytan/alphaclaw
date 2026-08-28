import { h } from "preact";
import htm from "htm";
import { LoadingSpinner } from "../loading-spinner.js";
import { buildRunTimelineModel } from "./helpers.js";

const html = htm.bind(h);

const kDotClassByTone = {
  success: "bg-green-500/90",
  danger: "bg-red-500/90",
  info: "bg-cyan-400/90",
  neutral: "bg-gray-500/60",
};

// Durable run-log viewer (same visual pattern as the progress card's raw-log
// pane) — works for finished runs after a reload, not just live SSE.
export const RunLogViewer = ({ runLog = null, onCloseRunLog = () => {} }) => {
  if (!runLog) return null;
  return html`
    <div class="ac-surface-inset border border-border rounded-lg p-3 space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-fg-muted min-w-0 break-all">
          Update log — run ${runLog.operationId}
        </p>
        <button
          type="button"
          class="text-xs text-fg-muted hover:text-body shrink-0"
          onclick=${onCloseRunLog}
        >
          Close
        </button>
      </div>
      ${runLog.loading
        ? html`
            <div class="flex items-center gap-2 text-xs text-fg-muted">
              <${LoadingSpinner} className="h-4 w-4" />
              Loading log...
            </div>
          `
        : null}
      ${runLog.error
        ? html`<p class="text-xs text-status-error">${runLog.error.message}</p>`
        : null}
      ${!runLog.loading && !runLog.error
        ? html`<pre
            class="bg-field rounded p-2 text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto"
          >
${runLog.text}</pre
          >`
        : null}
    </div>
  `;
};

// Compact timeline of recent update runs from the run ledger. Rollback and
// blocklist events keep their own surface (incident card / row badges).
export const UpgradeTimelineCard = ({
  runs = [],
  nowMs = Date.now(),
  onViewRunLog = () => {},
  runLog = null,
  onCloseRunLog = () => {},
}) => {
  const entries = buildRunTimelineModel(runs, nowMs);
  if (entries.length === 0) return null;
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <h2 class="card-label">Update history</h2>
      <ul class="space-y-1.5">
        ${entries.map(
          (entry) => html`
            <li
              key=${entry.operationId}
              class="flex flex-wrap items-center gap-2 min-w-0"
            >
              <span
                class=${`h-2 w-2 shrink-0 rounded-full ${
                  kDotClassByTone[entry.tone] || kDotClassByTone.neutral
                }`}
                aria-hidden="true"
              ></span>
              <span class="text-sm text-body min-w-0 break-words"
                >${entry.targetLabel}</span
              >
              <span
                class=${`text-xs ${
                  entry.tone === "danger"
                    ? "text-status-error-muted"
                    : "text-fg-muted"
                }`}
                >${entry.stateLabel}</span
              >
              ${entry.when
                ? html`<span class="text-xs text-fg-muted">${entry.when}</span>`
                : null}
              ${entry.hasLog
                ? html`
                    <button
                      type="button"
                      class="text-xs text-fg-muted hover:text-body"
                      onclick=${() => onViewRunLog(entry.operationId)}
                    >
                      View log
                    </button>
                  `
                : null}
            </li>
          `,
        )}
      </ul>
      <${RunLogViewer} runLog=${runLog} onCloseRunLog=${onCloseRunLog} />
    </div>
  `;
};

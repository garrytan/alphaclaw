import { h } from "preact";
import htm from "htm";
import { LoadingSpinner } from "../loading-spinner.js";
import {
  OperationStepList,
  getCurrentStepName,
} from "../restart-progress-card.js";
import {
  buildStepListModel,
  formatElapsed,
  formatHeartbeat,
  kRepairCaption,
  kRestartingMessage,
} from "./helpers.js";

const html = htm.bind(h);

export const UpgradeProgressCard = ({
  operation = null,
  nowMs = Date.now(),
  logOpen = false,
  onToggleLog = () => {},
}) => {
  if (!operation) return null;
  const stepList = buildStepListModel(operation.steps);
  const elapsedLabel = formatElapsed(operation.startedAt, nowMs);
  const heartbeatLabel = formatHeartbeat(operation.lastOutputAt, nowMs);
  const isRestarting = operation.phase === "restarting";
  const isFailed = operation.phase === "failed";
  return html`
    <div
      class=${`bg-surface border rounded-xl p-4 space-y-3 ${
        isFailed ? "border-red-500/40" : "border-border"
      }`}
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          ${!isFailed ? html`<${LoadingSpinner} className="h-4 w-4" />` : null}
          <h2 class="card-label">
            ${isFailed
              ? `Update to ${operation.label || "target"} failed`
              : `Updating to ${operation.label || "target"}`}
          </h2>
        </div>
        <span class="text-xs text-fg-muted">elapsed ${elapsedLabel}</span>
      </div>

      ${isRestarting
        ? html`
            <div
              class="ac-surface-inset border border-border rounded-lg p-3 flex items-center gap-2"
            >
              <${LoadingSpinner} className="h-4 w-4" />
              <p class="text-sm text-body">${kRestartingMessage}</p>
            </div>
          `
        : null}

      ${stepList.length > 0
        ? html`<${OperationStepList}
            steps=${stepList}
            currentName=${isRestarting || isFailed
              ? null
              : getCurrentStepName(stepList)}
          />`
        : html`<p class="text-sm text-fg-muted">Starting update...</p>`}

      ${heartbeatLabel
        ? html`<p class="text-xs text-fg-muted">${heartbeatLabel}</p>`
        : null}

      ${isFailed && operation.error
        ? html`
            <div class="ac-surface-inset border border-border rounded-lg p-3 space-y-1">
              <p class="text-sm text-status-error">${operation.error.message}</p>
              ${operation.error.hint
                ? html`<p class="text-xs text-fg-muted">${operation.error.hint}</p>`
                : null}
              ${typeof operation.error.docsUrl === "string" &&
              operation.error.docsUrl
                ? html`<a
                    class="ac-tip-link text-xs"
                    href=${operation.error.docsUrl}
                    target="_blank"
                    rel="noreferrer"
                    >Learn more</a
                  >`
                : null}
              <p class="text-xs text-fg-muted">
                Repair (run <code>openclaw update repair</code> from the
                Watchdog terminal): ${kRepairCaption}.
              </p>
            </div>
          `
        : null}

      ${operation.output
        ? html`
            <div>
              <button
                type="button"
                class="text-xs text-fg-muted hover:text-body"
                onclick=${onToggleLog}
                aria-expanded=${logOpen ? "true" : "false"}
              >
                ${logOpen ? "▾ Hide raw log" : "▸ Show raw log"}
              </button>
              ${logOpen
                ? html`<pre
                    class="mt-2 bg-field rounded p-2 text-xs whitespace-pre-wrap break-words max-h-64 overflow-auto"
                  >
${operation.output}</pre
                  >`
                : null}
            </div>
          `
        : null}
    </div>
  `;
};

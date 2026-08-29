import { h } from "preact";
import htm from "htm";
import { LoadingSpinner } from "../loading-spinner.js";
import {
  buildStepListModel,
  formatElapsed,
  formatHeartbeat,
  kRepairCaption,
  kRestartingMessage,
} from "./helpers.js";

const html = htm.bind(h);

const kStepDotClassByStatus = {
  running: "bg-cyan-400/90 animate-pulse",
  completed: "bg-green-500/90",
  failed: "bg-red-500/90",
  warning: "bg-yellow-400/90",
};

const StepRow = ({ step = {} }) => html`
  <li class="flex items-start gap-2">
    <span
      class=${`mt-1 h-2 w-2 shrink-0 rounded-full ${
        kStepDotClassByStatus[step.status] || "bg-gray-500/60"
      }`}
      aria-hidden="true"
    ></span>
    <span class="min-w-0">
      <span
        class=${`text-sm ${
          step.status === "failed" ? "text-status-error" : "text-body"
        }`}
        >${step.label}</span
      >
      ${step.detail
        ? html`<span class="ml-2 text-xs text-fg-muted">${step.detail}</span>`
        : null}
      ${step.error
        ? html`<span class="ml-2 text-xs text-status-error-muted"
            >${step.error}</span
          >`
        : null}
    </span>
  </li>
`;

export const UpgradeProgressCard = ({
  operation = null,
  nowMs = Date.now(),
  logOpen = false,
  onToggleLog = () => {},
  onDismissOperation = () => {},
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
        <div class="flex items-center gap-3">
          <span class="text-xs text-fg-muted">elapsed ${elapsedLabel}</span>
          ${isFailed
            ? html`<button
                type="button"
                class="text-xs text-fg-muted hover:text-body"
                onclick=${onDismissOperation}
              >
                Dismiss
              </button>`
            : null}
        </div>
      </div>

      ${isFailed
        ? html`<p class="text-xs text-fg-muted">
            Dismiss to re-enable the page — you can retry from the catalog or
            roll back below.
          </p>`
        : null}

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
        ? html`
            <ul class="space-y-1.5">
              ${stepList.map(
                (step) => html`<${StepRow} key=${step.name} step=${step} />`,
              )}
            </ul>
          `
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

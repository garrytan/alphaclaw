import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
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
  repairAvailable = false,
  onRunRepair = () => {},
  onRetryApply = () => {},
  onDismissOperation = () => {},
}) => {
  if (!operation) return null;
  const stepList = buildStepListModel(operation.steps);
  const elapsedLabel = formatElapsed(
    operation.startedAt,
    operation.finishedAt ?? nowMs,
  );
  const heartbeatLabel = formatHeartbeat(operation.lastOutputAt, nowMs);
  const isRestarting = operation.phase === "restarting";
  const isFailed = operation.phase === "failed";
  const isRepairOp = Boolean(operation.target?.repair);
  const heading = isRepairOp
    ? isFailed
      ? "Repair failed"
      : "Repairing the dev build"
    : isFailed
      ? `Update to ${operation.label || "target"} failed`
      : `Updating to ${operation.label || "target"}`;
  return html`
    <div
      class=${`bg-surface border rounded-xl p-4 space-y-3 ${
        isFailed ? "border-red-500/40" : "border-border"
      }`}
    >
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          ${!isFailed ? html`<${LoadingSpinner} className="h-4 w-4" />` : null}
          <h2 class="card-label">${heading}</h2>
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
              <div class="flex flex-wrap items-center gap-2 pt-1">
                ${repairAvailable
                  ? html`
                      <${ActionButton}
                        onClick=${onRunRepair}
                        tone="warning"
                        idleLabel="Run repair"
                        loadingLabel="Starting repair..."
                      />
                    `
                  : !isRepairOp && operation.target
                    ? html`
                        <${ActionButton}
                          onClick=${onRetryApply}
                          tone="warning"
                          idleLabel="Re-stage version"
                          loadingLabel="Starting..."
                        />
                      `
                    : null}
                <button
                  type="button"
                  class="text-xs text-fg-muted hover:text-body"
                  onclick=${onDismissOperation}
                >
                  Dismiss
                </button>
              </div>
              <p class="text-xs text-fg-muted">
                ${repairAvailable
                  ? `Repair: ${kRepairCaption}.`
                  : "Re-staging downloads and installs the same version again from scratch; it doesn't touch your data."}
              </p>
            </div>
          `
        : null}

      ${operation.output
        ? html`
            <div>
              <button
                type="button"
                class="text-xs text-fg-muted hover:text-body ac-touch"
                onclick=${onToggleLog}
                aria-expanded=${logOpen ? "true" : "false"}
              >
                ${logOpen ? "▾ Technical details" : "▸ Technical details"}
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

import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { LoadingSpinner } from "../loading-spinner.js";
import {
  OperationStepList,
  getCurrentStepName,
} from "../restart-progress-card.js";
import {
  buildBackupReuseOfferLabels,
  buildStepListModel,
  formatElapsed,
  formatHeartbeat,
  kNoBackupConsentCaption,
  kNoBackupConsentCtaLabel,
  kRepairCaption,
  kRestartingMessage,
  buildFailureCtaModel,
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
  // v0.9.81 (C4): backup-class failures retry the BACKUP, a completed repair
  // backup offers the original update again.
  onRetryBackup = () => {},
  onRetryUpdate = () => {},
  onDismissOperation = () => {},
  // 409 backup_failed + reusableBackup (WI-4.5): the offer to retry with the
  // named verified archive — opens the second-stage consent dialog.
  backupReuseOffer = null,
  onRequestBackupReuseRetry = () => {},
  // 409 backup_required_for_migration (#79 (b)): the offer to continue the
  // migrating update without a backup — opens the second-stage consent
  // dialog (checkbox + confirm); never shown for backup_failed.
  noBackupConsentOffer = null,
  onRequestNoBackupConsent = () => {},
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
  const isCompleted = operation.phase === "completed";
  const isRepairOp = Boolean(operation.target?.repair);
  const isBackupOp = operation.target?.kind === "backup";
  const cta = buildFailureCtaModel(operation);
  // The offer's age reads against the live clock — the failed card can stay
  // up for hours and the loss window it states must not lag `nowMs`.
  const offerLabels = backupReuseOffer
    ? buildBackupReuseOfferLabels(backupReuseOffer, nowMs)
    : null;
  const heading = isRepairOp
    ? isFailed
      ? "Repair failed"
      : "Repairing the dev build"
    : isBackupOp
      ? isFailed
        ? "Backup failed"
        : isCompleted
          ? "Backup completed"
          : "Backing up OpenClaw"
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
          ${!isFailed && !isCompleted ? html`<${LoadingSpinner} className="h-4 w-4" />` : null}
          <h2 class="card-label">${heading}</h2>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs text-fg-muted">elapsed ${elapsedLabel}</span>
          ${isFailed || isCompleted
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
            ${isBackupOp
              ? "Dismiss to re-enable updates — fix the cause above, then retry the backup. Checking for new versions stays available."
              : "Dismiss to re-enable updates — you can retry from the catalog or roll back below. Checking for new versions stays available."}
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
        ? html`<${OperationStepList}
            steps=${stepList}
            currentName=${isRestarting || isFailed
              ? null
              : getCurrentStepName(stepList)}
          />`
        : isCompleted
          ? null
          : html`<p class="text-sm text-fg-muted">${isBackupOp ? "Starting backup..." : "Starting update..."}</p>`}

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
                ${backupReuseOffer
                  ? html`
                      <${ActionButton}
                        onClick=${onRequestBackupReuseRetry}
                        tone="warning"
                        idleLabel=${offerLabels.ctaLabel}
                        loadingLabel="Starting..."
                      />
                    `
                  : null}
                ${noBackupConsentOffer
                  ? html`
                      <${ActionButton}
                        onClick=${onRequestNoBackupConsent}
                        tone="warning"
                        idleLabel=${kNoBackupConsentCtaLabel}
                        loadingLabel="Starting..."
                      />
                    `
                  : null}
                ${repairAvailable
                  ? html`
                      <${ActionButton}
                        onClick=${onRunRepair}
                        tone="warning"
                        idleLabel="Run repair"
                        loadingLabel="Starting repair..."
                      />
                    `
                  : cta.retryBackup
                    ? html`
                        <${ActionButton}
                          onClick=${onRetryBackup}
                          tone="warning"
                          idleLabel="Retry backup"
                          loadingLabel="Starting backup..."
                        />
                      `
                    : cta.restage
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
              ${backupReuseOffer
                ? html`<p class="text-xs text-status-warning-muted">
                    A fresh backup could not be made. ${offerLabels.lossWindowLine}
                  </p>`
                : null}
              ${noBackupConsentOffer
                ? html`<p class="text-xs text-status-warning-muted">
                    ${kNoBackupConsentCaption}
                  </p>`
                : null}
              <p class="text-xs text-fg-muted">
                ${repairAvailable
                  ? `Repair: ${kRepairCaption}.`
                  : cta.hint
                    ? cta.hint
                    : "Re-staging downloads and installs the same version again from scratch; it doesn't touch your data."}
              </p>
            </div>
          `
        : null}

      ${isCompleted && isBackupOp
        ? html`
            <div class="space-y-2">
              <p class="text-sm text-status-success">
                ${operation.result?.archive?.file
                  ? `Archive written: ${String(operation.result.archive.file).split("/").pop()}${
                      operation.result.archive.verified === true ? " — verified" : ""
                    }`
                  : operation.result?.noBackup
                    ? "Nothing to back up yet — this OpenClaw has no state a backup could lose."
                    : "Backup finished."}
              </p>
              <div class="flex flex-wrap items-center gap-2 pt-1">
                ${cta.retryUpdate
                  ? html`
                      <${ActionButton}
                        onClick=${onRetryUpdate}
                        tone="primary"
                        idleLabel=${`Retry update to ${cta.retryUpdate.label || "target"}`}
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
              ${cta.hint ? html`<p class="text-xs text-fg-muted">${cta.hint}</p>` : null}
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

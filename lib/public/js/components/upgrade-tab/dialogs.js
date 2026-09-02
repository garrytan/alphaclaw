import { h } from "preact";
import htm from "htm";
import { ConfirmDialog } from "../confirm-dialog.js";
import { ToggleSwitch } from "../toggle-switch.js";
import {
  buildBackupReuseOfferLabels,
  buildRollbackDataRiskLine,
  buildStripKeysConfirmMessage,
  kBackupReuseCandidateChangedNotice,
  kBackupReuseConsentLabel,
} from "./helpers.js";

const html = htm.bind(h);

export const kBackupReuseRetryInventoryLabel = "Retry reading backups";

// Reuse consent (WI-4.4/4.5): the LAST line of a hard-gated apply confirm.
// Default OFF and never read from storage — `checked` is dialog-local state
// owned by the hook. Disabled (with the visible reason) when no eligible
// archive carries a digest to bind the consent to; a list that could not be
// read says so and offers the same re-read as the Backups card. `revoked`
// = the hook un-checked a consent because the live re-read changed the
// archive it was bound to; the notice says so until the operator decides
// again.
const BackupReuseConsent = ({
  model = null,
  checked = false,
  revoked = false,
  onToggle = () => {},
  onRetryInventory = () => {},
}) => {
  if (!model) return null;
  return html`
    <div class="pt-2 border-t border-border space-y-1">
      <${ToggleSwitch}
        checked=${checked === true}
        disabled=${model.available !== true}
        onChange=${onToggle}
        label=${kBackupReuseConsentLabel}
      />
      ${revoked === true
        ? html`<p class="text-xs text-status-warning-muted" role="status">
            ${kBackupReuseCandidateChangedNotice}
          </p>`
        : null}
      ${model.available
        ? html`<p class="text-xs text-fg-muted">
            <span class="font-mono break-all">${model.name}</span>
            ${" "}(${model.producerLabel}) — ${model.lossWindowLine}
          </p>`
        : html`<p class="text-xs text-fg-dim">${model.reason}</p>`}
      ${model.retryable === true
        ? html`<button
            type="button"
            class="text-xs text-fg-muted hover:text-body"
            onclick=${onRetryInventory}
          >
            ${kBackupReuseRetryInventoryLabel}
          </button>`
        : null}
    </div>
  `;
};

// U3/U9: apply confirmation stating time and blast radius before commitment.
// Breaking targets (stable→beta/dev, prereleases) also carry the safety-net
// lines and a "what happens next" step list from buildApplyConfirmModel.
export const ApplyConfirmDialog = ({
  pendingApply = null,
  onConfirm = () => {},
  onCancel = () => {},
  onToggleReuseConsent = () => {},
  onRetryBackups = () => {},
}) => {
  if (!pendingApply) return null;
  const model = pendingApply.confirm || {};
  const lines = Array.isArray(model.lines) ? model.lines : [];
  const steps = Array.isArray(model.steps) ? model.steps : [];
  const securityFlips = Array.isArray(model.securityFlips)
    ? model.securityFlips
    : [];
  return html`
    <${ConfirmDialog}
      visible=${true}
      title=${model.title || "Apply this version?"}
      message=${lines[0] || ""}
      details=${html`
        <div class="space-y-1">
          ${lines.slice(1).map(
            (line) => html`<p class="text-xs text-fg-muted">${line}</p>`,
          )}
          ${securityFlips.length > 0
            ? html`
                <div class="ac-surface-inset border border-yellow-500/35 rounded-lg p-3 space-y-1.5">
                  <p class="text-xs font-medium text-status-warning-muted">
                    Security changes to review
                  </p>
                  <ul class="space-y-1">
                    ${securityFlips.map(
                      (flip) => html`
                        <li class="text-xs text-fg-muted">
                          <span class="text-body">${flip.key}</span>
                          ${" "}${flip.from} → ${flip.to}
                          ${flip.warning
                            ? html`<p class="mt-0.5">${flip.warning}</p>`
                            : null}
                        </li>
                      `,
                    )}
                  </ul>
                </div>
              `
            : null}
          ${steps.length > 0
            ? html`
                <div class="pt-1">
                  <p class="text-xs text-fg-muted">What happens next:</p>
                  <ol class="mt-0.5 text-xs text-fg-muted list-decimal list-inside space-y-0.5">
                    ${steps.map((step) => html`<li>${step}</li>`)}
                  </ol>
                </div>
              `
            : null}
          <${BackupReuseConsent}
            model=${model.backupReuse || null}
            checked=${pendingApply.reuseConsent === true}
            revoked=${pendingApply.reuseConsentReset === true}
            onToggle=${onToggleReuseConsent}
            onRetryInventory=${onRetryBackups}
          />
        </div>
      `}
      confirmLabel=${model.confirmLabel || "Apply"}
      confirmLoadingLabel="Starting..."
      confirmTone=${model.tone === "warning" ? "warning" : "primary"}
      onConfirm=${onConfirm}
      onCancel=${onCancel}
    />
  `;
};

// Second-stage backup-reuse confirm (WI-4.5): the apply stopped at 409
// backup_failed with ONE verified archive on offer. Confirming resends the
// apply with allowBackupReuse:{ sha256 } — and the copy is explicit that the
// FULL ladder re-runs first (the gateway pauses again) before that archive is
// used, with the exact loss window.
export const BackupReuseRetryConfirmDialog = ({
  model = null,
  starting = false,
  nowMs = Date.now(),
  onConfirm = () => {},
  onCancel = () => {},
}) => {
  if (!model) return null;
  // Age derived against the live clock, not frozen at the 409.
  const { lossWindowLine } = buildBackupReuseOfferLabels(model, nowMs);
  return html`
    <${ConfirmDialog}
      visible=${true}
      title="Retry using the older backup?"
      message=${`The update to ${model.label} first re-runs the full backup ladder — the gateway pauses again while a fresh backup is attempted. Only if that fails again does it proceed with the backup below.`}
      details=${html`
        <div class="space-y-1">
          <p class="text-xs text-body">
            <span class="font-mono break-all">${model.name}</span>
            ${" "}(${model.producerLabel})
          </p>
          <p class="text-xs text-status-warning-muted">${lossWindowLine}</p>
        </div>
      `}
      confirmLabel="Retry with backup fallback"
      confirmLoadingLabel="Starting..."
      confirmTone="warning"
      confirmLoading=${starting}
      onConfirm=${onConfirm}
      onCancel=${onCancel}
    />
  `;
};

// Strip-and-retry confirmation: deleting settings keys needs explicit consent
// — states the exact count, the pre-migration backup, and the protected-keys
// guarantee before anything is removed.
export const StripBlamedKeysConfirmDialog = ({
  visible = false,
  keyCount = 0,
  retrying = false,
  onConfirm = () => {},
  onCancel = () => {},
}) => {
  if (!visible) return null;
  return html`
    <${ConfirmDialog}
      visible=${true}
      title="Strip blamed keys and retry?"
      message=${buildStripKeysConfirmMessage(keyCount)}
      confirmLabel="Strip and retry"
      confirmLoadingLabel="Retrying..."
      confirmTone="danger"
      confirmLoading=${retrying}
      onConfirm=${onConfirm}
      onCancel=${onCancel}
    />
  `;
};

// Rollback confirmation: states the target and the blocklist side effect
// before anything restarts.
export const RollbackConfirmDialog = ({
  visible = false,
  rollingBack = false,
  onConfirm = () => {},
  onCancel = () => {},
}) => {
  if (!visible) return null;
  return html`
    <${ConfirmDialog}
      visible=${true}
      title="Roll back OpenClaw?"
      message="Roll back to the last known good version now? The current version will be blocklisted. The older version usually cannot verify state written by this one — if anything looks wrong afterwards, the backup taken before the update is the recovery path."
      confirmLabel="Roll back anyway"
      confirmLoadingLabel="Rolling back..."
      confirmTone="danger"
      confirmLoading=${rollingBack}
      onConfirm=${onConfirm}
      onCancel=${onCancel}
    />
  `;
};

// Second-stage rollback fence (issue #20 / WI-4.1): the server answered 409
// rollback_requires_confirmation — this update migrated the state DBs, so the
// rollback target may not be able to read them. The body renders the server's
// message verbatim and the guidance line names the verified pre-update backup
// with its re-stat caveats (pruned → newest surviving archive, partial,
// reused loss window); confirming resends the rollback with confirmDataRisk.
export const RollbackDataRiskConfirmDialog = ({
  model = null,
  rollingBack = false,
  nowMs = Date.now(),
  onConfirm = () => {},
  onCancel = () => {},
}) => {
  if (!model) return null;
  return html`
    <${ConfirmDialog}
      visible=${true}
      title="Roll back despite migrated data?"
      message=${model.message ||
      "This update migrated your state databases — the rollback target may not be able to read them."}
      details=${html`<p class="text-xs text-fg-muted">
        ${buildRollbackDataRiskLine(model, nowMs)}
      </p>`}
      confirmLabel="Roll back anyway"
      confirmLoadingLabel="Rolling back..."
      confirmTone="danger"
      confirmLoading=${rollingBack}
      onConfirm=${onConfirm}
      onCancel=${onCancel}
    />
  `;
};

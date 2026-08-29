import { h } from "preact";
import htm from "htm";
import { ConfirmDialog } from "../confirm-dialog.js";
import {
  buildRollbackDataRiskLine,
  buildStripKeysConfirmMessage,
} from "./helpers.js";

const html = htm.bind(h);

// U3/U9: apply confirmation stating time and blast radius before commitment.
// Breaking targets (stable→beta/dev, prereleases) also carry the safety-net
// lines and a "what happens next" step list from buildApplyConfirmModel.
export const ApplyConfirmDialog = ({
  pendingApply = null,
  onConfirm = () => {},
  onCancel = () => {},
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

// Second-stage rollback fence (issue #20): the server answered 409
// rollback_requires_confirmation — this update migrated the state DBs, so the
// rollback target may not be able to read them. The body renders the server's
// message verbatim and names the verified pre-update backup when one is
// recorded; confirming resends the rollback with confirmDataRisk consent.
export const RollbackDataRiskConfirmDialog = ({
  model = null,
  rollingBack = false,
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
        ${buildRollbackDataRiskLine(model.backupFile)}
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

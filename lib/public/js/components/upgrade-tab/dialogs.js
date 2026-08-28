import { h } from "preact";
import htm from "htm";
import { ConfirmDialog } from "../confirm-dialog.js";

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
      message="Roll back to the last known good version now? The current version will be blocklisted."
      confirmLabel="Roll back"
      confirmLoadingLabel="Rolling back..."
      confirmTone="warning"
      confirmLoading=${rollingBack}
      onConfirm=${onConfirm}
      onCancel=${onCancel}
    />
  `;
};

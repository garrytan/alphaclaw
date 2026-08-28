import { h } from "preact";
import { useEffect } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { ConfirmDialog } from "../confirm-dialog.js";

const html = htm.bind(h);

// U1: guided confirm flow for a channel-segment change. Two explicit choices:
// apply the latest of the new channel now, or persist the channel and browse.
export const ChannelSwitchDialog = ({
  prompt = null,
  saving = false,
  onApplyNow = () => {},
  onBrowseOnly = () => {},
  onCancel = () => {},
}) => {
  const visible = Boolean(prompt);

  useEffect(() => {
    if (!visible) return;

    const handleKeydown = (event) => {
      if (event.key === "Escape" && !saving) {
        onCancel?.();
      }
    };

    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  }, [visible, saving, onCancel]);

  if (!prompt) return null;
  const model = prompt.model || {};
  return html`
    <div
      class="fixed inset-0 bg-overlay flex items-center justify-center p-4 z-50"
      onclick=${(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <div class="bg-modal border border-border rounded-xl p-5 max-w-md w-full space-y-3">
        <h2 class="text-base font-semibold">${model.title}</h2>
        ${model.tooltip
          ? html`<p class="text-xs text-fg-muted">${model.tooltip}</p>`
          : null}
        ${Array.isArray(model.securityFlips) && model.securityFlips.length > 0
          ? html`
              <div class="ac-surface-inset border border-yellow-500/35 rounded-lg p-3 space-y-1.5">
                <p class="text-xs font-medium text-status-warning-muted">
                  Security defaults that change on this channel
                </p>
                <ul class="space-y-1">
                  ${model.securityFlips.map(
                    (flip) => html`
                      <li class="text-xs text-fg-muted">
                        <span class="text-body">${flip.key}</span>
                        ${" "}${flip.from} → ${flip.to}
                      </li>
                    `,
                  )}
                </ul>
              </div>
            `
          : null}
        <div class="space-y-2">
          <button
            type="button"
            class="w-full text-left ac-surface-inset border border-border rounded-lg p-3 hover:border-fg-muted transition-colors disabled:opacity-60"
            onclick=${onApplyNow}
            disabled=${saving}
          >
            <span class="block text-sm font-medium text-body">
              ${model.applyLabel}
            </span>
            <span class="block mt-0.5 text-xs text-fg-muted">
              ${model.applyCaption}
            </span>
          </button>
          <button
            type="button"
            class="w-full text-left ac-surface-inset border border-border rounded-lg p-3 hover:border-fg-muted transition-colors disabled:opacity-60"
            onclick=${onBrowseOnly}
            disabled=${saving}
          >
            <span class="block text-sm font-medium text-body">
              ${model.browseLabel}
            </span>
            <span class="block mt-0.5 text-xs text-fg-muted">
              ${model.browseCaption}
            </span>
          </button>
        </div>
        <div class="pt-1 flex items-center justify-end">
          <${ActionButton}
            onClick=${onCancel}
            disabled=${saving}
            tone="secondary"
            size="md"
            idleLabel="Cancel"
            className="px-4 py-2 rounded-lg text-sm"
          />
        </div>
      </div>
    </div>
  `;
};

// U3/U9: apply confirmation stating time and blast radius before commitment.
export const ApplyConfirmDialog = ({
  pendingApply = null,
  onConfirm = () => {},
  onCancel = () => {},
}) => {
  if (!pendingApply) return null;
  const model = pendingApply.confirm || {};
  const lines = Array.isArray(model.lines) ? model.lines : [];
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

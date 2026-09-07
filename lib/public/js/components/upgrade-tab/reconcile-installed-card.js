import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { InlineErrorChip } from "../inline-error-chip.js";

const html = htm.bind(h);

// Installed-tree reconcile (#76 B1.2 / CEO 11.1): the live OpenClaw tree is
// not the build this box recorded. Renders only with a model (the helper
// returns null unless installedDiverged and the server advertises the
// action). States: idle → loading (ActionButton) → success (the hook toasts
// and reloads the channel, so the card leaves) or error (persistent
// InlineErrorChip with the envelope helper); blocked renders the server's
// disabledReason beside a disabled button. All copy is the server's catalog
// entry — nothing here is inlined.
export const ReconcileInstalledCard = ({
  model = null,
  reconcilingInstalled = false,
  reconcileInstalledError = null,
  actionsDisabled = false,
  onReconcileInstalled = () => {},
  onDismissReconcileInstalledError = () => {},
}) => {
  if (!model) return null;
  const blocked = Boolean(model.disabledReason);
  return html`
    <div class="bg-surface border border-yellow-500/40 rounded-xl p-4 space-y-2">
      <div class="flex items-center gap-2 min-w-0">
        <span class="w-2 h-2 rounded-full bg-yellow-500 shrink-0"></span>
        <p class="text-sm font-medium text-body">${model.title}</p>
      </div>
      ${model.installed || model.expected
        ? html`
            <p class="text-xs text-fg-muted min-w-0 break-words">
              Installed${" "}
              <code class="font-mono text-body">${model.installed || "unknown"}</code>
              ${" "}· recorded${" "}
              <code class="font-mono text-body">${model.expected || "unknown"}</code>
            </p>
          `
        : null}
      <p class="text-sm text-body min-w-0 break-words">${model.description}</p>
      <div class="flex flex-wrap items-center gap-2">
        <${ActionButton}
          onClick=${onReconcileInstalled}
          tone="primary"
          idleLabel=${model.actionLabel}
          loadingLabel=${model.loadingLabel}
          loading=${reconcilingInstalled}
          disabled=${blocked || (actionsDisabled && !reconcilingInstalled)}
          title=${model.disabledReason || ""}
        />
        ${blocked
          ? html`<span
              class="text-xs text-status-warning-muted ac-surface-inset border border-yellow-500/35 rounded px-1.5 py-0.5"
              >${model.disabledReason}</span
            >`
          : null}
      </div>
      ${reconcileInstalledError
        ? html`
            <div class="flex items-start gap-2">
              <div class="flex-1 min-w-0">
                <${InlineErrorChip}
                  headline=${reconcileInstalledError.headline}
                  error=${reconcileInstalledError.error}
                />
              </div>
              <button
                type="button"
                class="text-xs text-fg-muted hover:text-body shrink-0"
                onclick=${onDismissReconcileInstalledError}
              >
                Dismiss
              </button>
            </div>
          `
        : null}
    </div>
  `;
};

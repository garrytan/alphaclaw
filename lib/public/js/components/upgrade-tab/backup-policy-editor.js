import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { useBackupPolicy } from "./use-backup-policy.js";

const html = htm.bind(h);
const kInputClass = "w-full bg-field border border-border rounded-lg px-3 py-2 text-body outline-none focus:border-fg-muted mt-1 font-mono text-xs";

export const BackupPolicyEditorView = ({ model }) => {
  const disabled = !model.hydrated || Boolean(model.loadError) || model.saving;
  const error = model.saveError?.error || model.loadError;
  return html`
    <details class="border-t border-border pt-3">
      <summary class="text-sm text-body cursor-pointer">Backup exclusions</summary>
      <div class="space-y-3 pt-3">
        <p class="text-xs text-fg-muted">One pattern per line. Changes apply to the next backup. Databases, configuration, credentials, and identity remain protected.</p>
        ${!model.hydrated ? html`<p class="text-xs text-fg-muted">Loading backup exclusions...</p>` : null}
        <label class="block text-xs text-fg-muted">
          Workspace exclusions
          <textarea class=${kInputClass} rows="4" value=${model.draft.excludes}
            disabled=${disabled} onInput=${(event) => model.edit("excludes", event.currentTarget.value)} />
          <span class="block mt-1">Relative to each workspace. An empty field disables the default workspace exclusions.</span>
        </label>
        <label class="block text-xs text-fg-muted">
          State-root exclusions
          <textarea class=${kInputClass} rows="3" value=${model.draft.rootExcludes}
            disabled=${disabled} onInput=${(event) => model.edit("rootExcludes", event.currentTarget.value)} />
          <span class="block mt-1">Relative to the OpenClaw state root, for example state/security-planning/stronghold-*.</span>
        </label>
        ${error ? html`<p role="alert" class="text-xs text-status-error">${error.message}${error.hint ? ` ${error.hint}` : ""}</p>` : null}
        ${model.refusedExcludes.length ? html`<ul class="text-xs text-status-warning-muted list-disc pl-4">
          ${model.refusedExcludes.map((rule, index) => html`<li key=${index}>${rule.scope === "root" ? "State root" : "Workspace"}: ${rule.pattern} — ${rule.reason}</li>`)}
        </ul>` : null}
        <div class="flex flex-wrap items-center gap-3">
          <${ActionButton} idleLabel="Save exclusions" loadingLabel="Saving..." loading=${model.saving}
            disabled=${disabled || !model.dirty} onClick=${model.save} tone="secondary" />
          <button type="button" class="text-xs text-fg-muted hover:text-body" disabled=${disabled}
            onClick=${model.restoreDefaults}>Restore defaults</button>
          ${model.loadError ? html`<button type="button" class="text-xs text-fg-muted" onClick=${model.retryLoad}>Retry</button>` : null}
          ${model.saved ? html`<span role="status" class="text-xs text-status-success-muted">Saved for the next backup.</span>` : model.dirty ? html`<span class="text-xs text-fg-muted">Unsaved changes</span>` : null}
        </div>
      </div>
    </details>
  `;
};

export const BackupPolicyEditor = () => html`<${BackupPolicyEditorView} model=${useBackupPolicy()} />`;

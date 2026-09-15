import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "./action-button.js";
import { ConfirmDialog } from "./confirm-dialog.js";

const html = htm.bind(h);

export const ManagedUpdateAttemptCard = ({ managedUpdate = null }) => {
  const [confirm, setConfirm] = useState(null);
  const [checked, setChecked] = useState(false);
  const attempt = managedUpdate?.attempt;
  useEffect(() => { setConfirm(null); setChecked(false); }, [attempt?.id]);
  if (!managedUpdate || (!managedUpdate.blocked && !managedUpdate.error)) return null;
  const unknown = attempt?.state === "unknown";
  const canResolve = managedUpdate.isAdmin && ["accepted", "unknown"].includes(attempt?.state);
  return html`<div class="ac-surface-inset border border-border rounded-lg p-3 space-y-2" role="status">
    ${managedUpdate.blocked ? html`
      <p class="text-sm font-semibold">${unknown ? "Deployment status unknown" : "Deployment request pending"}</p>
      <p class="text-sm text-fg-muted">${unknown
        ? "The provider may have accepted this request. Check its deployment history before allowing another update."
        : "The deployment request has been recorded. The running server does not confirm that the provider has finished."}</p>
      <p class="text-xs text-fg-muted">Requested AlphaClaw ${attempt?.target?.alphaclawVersion || "update"}${attempt?.target?.ref ? ` from ${attempt.target.ref}` : ""}.</p>
    ` : null}
    ${managedUpdate.error ? html`<div class="space-y-1">
      <p class="text-sm text-status-error">${managedUpdate.error.message || "Could not load deployment status."}</p>
      ${managedUpdate.error.code === "config_unreadable" ? html`<p class="text-xs text-fg-muted">Updates are disabled until the saved deployment state can be read. Open Doctor to inspect the recovery guidance.</p>` : null}
      ${managedUpdate.error.hint ? html`<p class="text-xs text-fg-muted">${managedUpdate.error.hint}</p>` : null}
    </div>` : null}
    <div class="flex flex-wrap gap-2">
      <${ActionButton} onClick=${managedUpdate.retry} idleLabel="Retry status check" tone="secondary" />
      ${canResolve ? [
        ["deployed", "Provider finished the deployment"],
        ["not_deployed", "Provider cancelled or did not deploy"],
      ].map(([outcome, label]) => html`<${ActionButton} key=${outcome} onClick=${() => { setChecked(false); setConfirm({ id: attempt.id, outcome }); }} idleLabel=${label} disabled=${managedUpdate.resolving} tone="secondary" />`) : null}
    </div>
    ${managedUpdate.blocked && !managedUpdate.isAdmin ? html`<p class="text-xs text-fg-muted">An administrator must check the provider and resolve this request.</p>` : null}
    <${ConfirmDialog}
      visible=${Boolean(confirm)} title="Confirm provider status"
      message="Confirm that you checked the deployment provider and it has finished or cancelled this request, with no deployment still pending. This allows a future update request."
      details=${html`<label class="flex items-start gap-2 text-sm"><input type="checkbox" checked=${checked} onchange=${(event) => setChecked(event.currentTarget.checked)} /> I checked the provider: no deployment is pending.</label>`}
      confirmLabel="Resolve this request" confirmDisabled=${!checked || confirm?.id !== attempt?.id || !canResolve}
      confirmLoading=${managedUpdate.resolving}
      onCancel=${() => { if (!managedUpdate.resolving) setConfirm(null); }}
      onConfirm=${async () => {
        if (!checked || !canResolve || confirm?.id !== attempt?.id) return;
        if (await managedUpdate.resolve(confirm.id, confirm.outcome)) setConfirm(null);
      }}
    />
  </div>`;
};

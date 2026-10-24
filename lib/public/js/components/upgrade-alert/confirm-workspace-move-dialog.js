import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { ConfirmDialog } from "../confirm-dialog.js";
import { describeRetryDowntime } from "./model.js";

const html = htm.bind(h);

// "Confirm the workspace moved": names both paths, the exact command and
// everything --force unlocks in that Doctor run, before the operator agrees.
export const ConfirmWorkspaceMoveDialog = ({ visible = false, move = null, retry = null, onConfirm, onCancel }) => {
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState(null);
  useEffect(() => {
    if (!visible) return;
    setSubmitting(false);
    setRefusal(null);
  }, [visible]);
  if (!move) return null;

  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setRefusal(null);
    const result = await onConfirm?.({ from: move.from, to: move.to });
    setSubmitting(false);
    if (result?.notStarted) {
      setRefusal(result.hint || result.error || "The workspace move didn't start.");
      return;
    }
    onCancel?.();
  };

  return html`<${ConfirmDialog}
    visible=${visible}
    title="Confirm the workspace folder moved?"
    message="Only confirm if this is the same workspace and its folder really moved. If the path points somewhere new by mistake, cancel and restore the original link instead."
    details=${html`
      <dl class="text-xs space-y-1">
        <div><dt class="text-fg-muted">Saved records belong to</dt><dd class="font-mono break-all text-body">${move.from}</dd></div>
        <div><dt class="text-fg-muted">The folder now resolves to</dt><dd class="font-mono break-all text-body">${move.to}</dd></div>
      </dl>
      <p class="text-sm text-body">
        AlphaClaw stops the gateway, runs <span class="font-mono">openclaw doctor --fix --force --yes</span>, then finishes the upgrade and starts the gateway again. OpenClaw moves its saved setup records and file-verification history to the new location and doesn't change any workspace files.
      </p>
      <p class="text-xs text-fg-muted">
        --force also lets this run rebuild stale Control UI assets, but only from an OpenClaw source checkout; AlphaClaw's installed OpenClaw has none, so confirming this move is the only extra repair it applies here.
      </p>
      <p class="text-xs text-fg-muted">${describeRetryDowntime(retry)}</p>
      ${refusal ? html`<p class="text-sm text-status-error" role="alert">${refusal}</p>` : null}
    `}
    confirmLabel="Confirm the workspace moved"
    confirmLoadingLabel="Starting…"
    confirmTone="warning"
    confirmLoading=${submitting}
    onConfirm=${confirm}
    onCancel=${() => {
      if (!submitting) onCancel?.();
    }}
  />`;
};

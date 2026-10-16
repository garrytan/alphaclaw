import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { ConfirmDialog } from "../confirm-dialog.js";
import { describeRetryDowntime, describeUnchanged } from "./model.js";

const html = htm.bind(h);

// The Retry upgrade confirm: names the downtime from the last successful
// Doctor, and turns into an explicit "Retry anyway" when nothing changed
// since the remembered failure (from the status, or from the server's 409).
export const RetryUpgradeDialog = ({ visible = false, retry = null, onRetry, onCancel }) => {
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState(null);
  const [unchanged, setUnchanged] = useState(false);
  useEffect(() => {
    if (!visible) return;
    setSubmitting(false);
    setRefusal(null);
    setUnchanged(retry?.unchanged === true);
  }, [visible, retry?.unchanged]);

  const unchangedLine = unchanged ? describeUnchanged({ ...retry, unchanged: true }) : null;
  const confirm = async () => {
    if (submitting) return;
    setSubmitting(true);
    setRefusal(null);
    const result = await onRetry?.({ confirmUnchanged: unchanged });
    setSubmitting(false);
    if (result?.notStarted) {
      if (result.code === "unchanged_since_failure") setUnchanged(true);
      setRefusal(result.code === "unchanged_since_failure" ? null : result.hint || result.error || "The upgrade retry didn't start.");
      return;
    }
    onCancel?.();
  };

  return html`<${ConfirmDialog}
    visible=${visible}
    title="Retry OpenClaw's data upgrade?"
    message=${describeRetryDowntime(retry)}
    details=${html`
      ${unchangedLine ? html`<p class="text-sm text-status-warning" role="status">${unchangedLine}</p>` : null}
      ${refusal ? html`<p class="text-sm text-status-error" role="alert">${refusal}</p>` : null}
    `}
    confirmLabel=${unchanged ? "Retry anyway" : "Retry upgrade"}
    confirmLoadingLabel="Starting…"
    confirmTone="warning"
    confirmLoading=${submitting}
    onConfirm=${confirm}
    onCancel=${() => {
      if (!submitting) onCancel?.();
    }}
  />`;
};

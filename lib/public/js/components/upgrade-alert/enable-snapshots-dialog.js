import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { ConfirmDialog } from "../confirm-dialog.js";
import { enableSnapshots, fetchSnapshotProposal } from "../../lib/api.js";
import { formatBytes } from "../../lib/format.js";
import { describeCaptureSize, describeModeChange } from "./model.js";

const html = htm.bind(h);

// Enable snapshots: shows the server's exact proposal (paths, modes, capture
// size, retention) and applies only that proposal. Success speaks about
// FUTURE Doctor runs only — an upgrade that already ran keeps no snapshot.
export const EnableSnapshotsDialog = ({ visible = false, onDone, onCancel }) => {
  const [proposal, setProposal] = useState(null);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      setProposal(await fetchSnapshotProposal());
    } catch (err) {
      setProposal(null);
      setError(err?.message || "Couldn't read the proposed change.");
    }
    setLoading(false);
  };
  useEffect(() => {
    if (!visible) return;
    setProposal(null);
    setError(null);
    setResult(null);
    void load();
  }, [visible]);

  const apply = async () => {
    if (result) {
      onDone?.(result);
      return;
    }
    if (!proposal?.ok || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      setResult(await enableSnapshots(proposal.proposalId));
    } catch (err) {
      const details = err?.details || {};
      if (err?.code === "proposal_stale") {
        setError(err.message);
        if (details.proposal) setProposal(details.proposal);
        else void load();
      } else if (err?.code === "chmod_failed") {
        const rolled = Array.isArray(details.rollbackFailed) && details.rollbackFailed.length
          ? ` Couldn't restore: ${details.rollbackFailed.map((entry) => entry.path).join(", ")}.`
          : details.rolledBack?.length
            ? " Every folder it had already changed was put back."
            : "";
        setError(`${err.message}${rolled}`);
      } else {
        setError(err?.message || "Couldn't enable snapshots.");
      }
    }
    setSubmitting(false);
  };

  const dirs = Array.isArray(proposal?.dirs) ? proposal.dirs : [];
  const details = html`
    ${loading ? html`<p class="text-sm text-fg-muted">Checking the folders…</p>` : null}
    ${!loading && proposal?.ok && !result
      ? html`
          <ul class="space-y-1">
            ${dirs.map(
              (dir) => html`<li key=${dir.path} class="ac-surface-inset border border-border rounded-lg px-3 py-2">
                <p class="font-mono text-xs text-body break-all">${dir.path}</p>
                <p class="text-xs text-fg-muted">mode ${describeModeChange(dir)} (sticky bit added; group and other permissions unchanged)</p>
              </li>`,
            )}
          </ul>
          <p class="text-xs text-fg-muted">
            Each later Doctor run (boot, repair, retry) then keeps a snapshot of ${describeCaptureSize(proposal)} in <span class="font-mono break-all">${proposal.captureRoot}</span>.
            OpenClaw removes a finished snapshot after ${proposal.retentionDays} days.
            ${Number.isFinite(Number(proposal.freeBytes)) ? ` ${formatBytes(proposal.freeBytes)} is free.` : ""}
          </p>
        `
      : null}
    ${!loading && proposal && !proposal.ok
      ? html`<p class="text-sm text-body">${proposal.code === "already_available" ? proposal.error : proposal.sentence || proposal.error}</p>
          ${proposal.manualFix ? html`<p class="text-xs text-fg-muted">${proposal.manualFix}</p>` : null}`
      : null}
    ${result ? html`<p class="text-sm text-body" role="status">${result.sentence}</p>` : null}
    ${error ? html`<p class="text-sm text-status-error" role="alert">${error}</p>` : null}
  `;
  return html`<${ConfirmDialog}
    visible=${visible}
    title=${result ? "Snapshots" : "Enable safety snapshots?"}
    message=${result
      ? "Done."
      : "AlphaClaw sets the sticky bit on these folders so OpenClaw trusts them for its pre-repair snapshot. Nothing else changes."}
    details=${details}
    confirmLabel=${result ? "Close" : "Enable snapshots"}
    confirmLoadingLabel="Changing…"
    confirmTone=${result ? "primary" : "warning"}
    confirmLoading=${submitting}
    confirmDisabled=${!result && (!proposal?.ok || loading)}
    onConfirm=${apply}
    onCancel=${() => {
      if (submitting) return;
      if (result) onDone?.(result);
      else onCancel?.();
    }}
  />`;
};

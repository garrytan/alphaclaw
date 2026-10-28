import { h } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { ConfirmDialog } from "../confirm-dialog.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { ToggleSwitch } from "../toggle-switch.js";
import { fetchAgentDeletePreview, fetchAgentDeletions } from "../../lib/api.js";
import {
  buildBusyLabel,
  buildExpectationLine,
  buildRemovalLine,
  buildSnapshotLine,
  kRemovedOutcomes,
  resolveBlockedReason,
} from "./delete-agent-copy.js";

const html = htm.bind(h);

const kCheckAttempts = 10;
const kCheckIntervalMs = 3000;

// Delete Agent: OpenClaw deletes the agent on the serving gateway; with the
// snapshot on (the default) OpenClaw first saves its chat history and
// AlphaClaw copies its workspace. The preview is read fresh on every open.
// phase: idle | submitting | checking (answer lost: reading the outcome back)
// | unconfirmed (still couldn't tell).
export const DeleteAgentDialog = ({
  visible = false,
  agent = null,
  onCancel = () => {},
  onSubmit = async () => ({}),
  onDone = () => {},
}) => {
  const agentId = String(agent?.id || "").trim();
  const name = String(agent?.name || agentId || "agent");
  const [previewState, setPreviewState] = useState({ loading: true, data: null, error: null });
  const [snapshotOn, setSnapshotOn] = useState(true);
  const [phase, setPhase] = useState("idle");
  const [error, setError] = useState(null);
  const requestRef = useRef(0);

  const loadPreview = useCallback(async () => {
    if (!agentId) return;
    const request = ++requestRef.current;
    setPreviewState((previous) => ({ ...previous, loading: true, error: null }));
    try {
      const data = await fetchAgentDeletePreview(agentId);
      if (request !== requestRef.current) return;
      setPreviewState({ loading: false, data, error: null });
      if (!data?.snapshot?.available) setSnapshotOn(false);
    } catch (fetchError) {
      if (request !== requestRef.current) return;
      setPreviewState({ loading: false, data: null, error: fetchError });
    }
  }, [agentId]);

  useEffect(() => {
    if (!visible) return;
    setSnapshotOn(true);
    setPhase("idle");
    setError(null);
    setPreviewState({ loading: true, data: null, error: null });
    loadPreview();
  }, [visible, agentId]);

  const finish = (result) => {
    setPhase("idle");
    onDone({ ...result, agentName: name });
  };

  // The answer was lost or OpenClaw's outcome is still open: read it back
  // from the server's record of this delete, never resend it.
  const checkOutcome = async () => {
    setPhase("checking");
    setError(null);
    for (let attempt = 0; attempt < kCheckAttempts; attempt += 1) {
      try {
        const { deletions = [] } = await fetchAgentDeletions();
        const entry = deletions.find((item) => item.agentId === agentId);
        if (entry && entry.outcome !== "unknown" && entry.outcome !== "running") {
          if (kRemovedOutcomes.has(entry.outcome)) {
            finish({ agentId, outcome: entry.outcome, archive: entry.archive ? { name: entry.archive, bytes: entry.archiveBytes } : null });
            return;
          }
          setPhase("idle");
          setError(new Error(`OpenClaw didn't delete ${name}.`));
          return;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, kCheckIntervalMs));
    }
    setPhase("unconfirmed");
  };

  const handleConfirm = async () => {
    setPhase("submitting");
    setError(null);
    let result;
    try {
      result = await onSubmit({ id: agentId, snapshot: snapshotOn });
    } catch (submitError) {
      if (!submitError?.status) {
        await checkOutcome();
        return;
      }
      setPhase("idle");
      setError(submitError);
      return;
    }
    if (kRemovedOutcomes.has(result?.outcome)) {
      finish(result);
      return;
    }
    if (result?.outcome === "unknown") {
      await checkOutcome();
      return;
    }
    setPhase("idle");
    setError(new Error(result?.message || `OpenClaw didn't delete ${name}.`));
  };

  const busy = phase === "submitting" || phase === "checking";
  const preview = previewState.data;
  const blockedReason = resolveBlockedReason({ previewState, snapshotOn });
  const snapshotAvailable = !!preview?.snapshot?.available;
  const expectation = buildExpectationLine({ preview, snapshotOn });
  const statusLine =
    phase === "submitting"
      ? expectation
      : phase === "checking"
        ? "Lost the connection. Checking whether the agent was deleted…"
        : phase === "unconfirmed"
          ? `Couldn't confirm whether "${name}" was deleted.`
          : null;

  return html`
    <${ConfirmDialog}
      visible=${visible}
      title="Delete agent"
      message=${`Delete "${name}"?`}
      details=${html`
        <div class="space-y-3">
          <p class="text-sm text-fg-muted">
            ${preview ? buildRemovalLine(preview.counts) : "Removes the agent. Other agents keep running and the gateway doesn't restart."}
          </p>
          ${previewState.error
            ? html`<${InlineErrorChip}
                error=${previewState.error}
                headline="Couldn't check the agent."
                onRetry=${loadPreview}
              />`
            : null}
          <div class="pt-2 border-t border-border space-y-1">
            <${ToggleSwitch}
              checked=${snapshotOn}
              disabled=${busy || phase === "unconfirmed" || (!previewState.error && !snapshotAvailable)}
              onChange=${setSnapshotOn}
              label="Keep a snapshot"
              describedBy="delete-agent-snapshot-line"
            />
            <p id="delete-agent-snapshot-line" class="text-xs text-fg-muted">
              ${previewState.loading
                ? "Measuring…"
                : previewState.error
                  ? snapshotOn
                    ? "The snapshot needs the agent check above."
                    : "No snapshot. AlphaClaw keeps no copy of its chat history."
                  : buildSnapshotLine({ preview, snapshotOn })}
            </p>
          </div>
          <p class="text-xs text-fg-muted">
            Its files move to OpenClaw's Trash folder on this box; AlphaClaw can't restore from there.
          </p>
          ${blockedReason && !busy && phase !== "unconfirmed"
            ? html`<p class="text-xs text-status-warning">
                ${blockedReason}
                ${!previewState.loading && preview && !preview.gatewayServing
                  ? html` <button type="button" class="underline" onclick=${loadPreview}>Check again</button>`
                  : null}
              </p>`
            : null}
          <p class="text-xs text-fg-muted" role="status" aria-live="polite">
            ${statusLine || ""}
            ${phase === "unconfirmed"
              ? html` <button type="button" class="underline" onclick=${checkOutcome}>Check again</button>`
              : null}
          </p>
          ${error
            ? html`<${InlineErrorChip} error=${error} headline="The agent wasn't deleted." />`
            : null}
        </div>
      `}
      confirmLabel="Delete agent"
      confirmLoadingLabel=${phase === "checking" ? "Checking…" : buildBusyLabel({ snapshotOn })}
      confirmTone="danger"
      confirmLoading=${busy}
      confirmDisabled=${!!blockedReason || phase === "unconfirmed"}
      closeOnEscape=${!busy}
      closeOnOverlayClick=${!busy}
      onCancel=${onCancel}
      onConfirm=${handleConfirm}
    />
  `;
};

import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { buildDeletionNotice, buildReceiptLine } from "./delete-agent-copy.js";

const html = htm.bind(h);

// One deletion that still needs the owner. Finish deleting asks once
// ("Finish deleting <id>?"), shows Finishing… while it runs, and after a
// repeat failure says what's left and becomes dismissible.
const DeletionNotice = ({ entry, onFinish, onCheck }) => {
  const notice = buildDeletionNotice(entry);
  const [state, setState] = useState("idle");
  const [error, setError] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  if (!notice || dismissed) return null;
  const finish = async () => {
    setState("finishing");
    setError(null);
    try {
      await onFinish(entry.agentId);
      setState("idle");
    } catch (finishError) {
      setError(finishError);
      setState("failed");
    }
  };
  return html`
    <div class="ac-surface-inset border border-status-warning/40 rounded-lg px-3 py-2 space-y-2" role="status" aria-live="polite">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-fg-muted min-w-0">${notice.text}</p>
        <div class="flex items-center gap-2">
          ${notice.action === "finish" && state !== "confirm"
            ? html`<${ActionButton}
                onClick=${() => setState("confirm")}
                loading=${state === "finishing"}
                tone="secondary"
                idleLabel="Finish deleting"
                loadingLabel="Finishing…"
              />`
            : null}
          ${notice.action === "finish" && state === "confirm"
            ? html`
                <span class="text-xs">Finish deleting ${entry.agentId}?</span>
                <${ActionButton} onClick=${finish} tone="danger" idleLabel="Finish" />
                <${ActionButton} onClick=${() => setState("idle")} tone="secondary" idleLabel="Cancel" />
              `
            : null}
          ${notice.action === "check"
            ? html`<${ActionButton} onClick=${onCheck} tone="secondary" idleLabel="Check again" />`
            : null}
          ${state === "failed"
            ? html`<${ActionButton} onClick=${() => setDismissed(true)} tone="secondary" idleLabel="Dismiss" />`
            : null}
        </div>
      </div>
      ${error
        ? html`<${InlineErrorChip}
            error=${error}
            headline="OpenClaw still couldn't finish. What's left may need removing by hand (README: Deleted agents' data)."
          />`
        : null}
    </div>
  `;
};

export const DeletionNotices = ({ receipt = null, deletions = [], onDismissReceipt, onFinish, onCheck }) => {
  const pending = deletions.filter((entry) => buildDeletionNotice(entry));
  if (!receipt && pending.length === 0) return null;
  return html`
    <div class="agents-deletion-notices space-y-2 px-4 pt-4">
      ${receipt
        ? html`<div class="ac-surface-inset border border-border rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2" role="status" aria-live="polite">
            <p class="text-xs text-fg-muted min-w-0">
              ${buildReceiptLine(receipt)}
              ${receipt.archive ? " How to restore: README, Deleted agents' data." : ""}
            </p>
            <${ActionButton} onClick=${onDismissReceipt} tone="secondary" idleLabel="Dismiss" />
          </div>`
        : null}
      ${pending.map(
        (entry) => html`<${DeletionNotice} key=${entry.agentId} entry=${entry} onFinish=${onFinish} onCheck=${onCheck} />`,
      )}
    </div>
  `;
};

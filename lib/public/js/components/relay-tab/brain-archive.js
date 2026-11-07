import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { formatRelativeTime } from "../../lib/format.js";
import { retryRelayArchive } from "../../lib/api.js";
import { showToast } from "../toast.js";
import { buildArchiveModel } from "./model.js";

const html = htm.bind(h);

// The brain archive: relay conversations saved as gbrain pages. Retry is the
// owner's only control (the agent actor cannot call it); there is no delete:
// a page is removed with gbrain delete, restorable for 72 hours.
export const RelayBrainArchive = ({ archive, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const model = buildArchiveModel(archive);
  const retry = async () => {
    setBusy(true);
    try {
      const result = await retryRelayArchive();
      showToast(result.retried ? "Retrying " + result.retried + " conversation" + (result.retried === 1 ? "" : "s") : "Checking the brain archive again", "success");
      onChanged?.();
    } catch (err) {
      showToast(String(err?.message || err), "error");
    } finally {
      setBusy(false);
    }
  };
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
      <div class="flex items-center gap-2">
        <h3 class="font-semibold text-sm">Brain archive</h3>
        <${Badge} tone=${model.tone}>${model.label}</${Badge}>
        ${model.canRetry
          ? html`<span class="ml-auto"><${ActionButton} onClick=${retry} loading=${busy} tone="subtle" idleLabel="Retry now" loadingLabel="Retrying…" /></span>`
          : null}
      </div>
      <p class="text-sm">${model.text}</p>
      ${model.parked.length
        ? html`<ul class="space-y-1">
            ${model.parked.map(
              (row) => html`<li key=${row.code} class="text-sm flex flex-wrap items-center gap-2">
                <${Badge} tone=${row.tone}>${row.code}</${Badge}>
                <span>${row.count} conversation${row.count === 1 ? "" : "s"} waiting for Retry. ${row.text}</span>
              </li>`,
            )}
          </ul>`
        : null}
      ${model.overBudget.length
        ? html`<ul class="space-y-1">
            ${model.overBudget.map(
              (row) => html`<li key=${row.peer + row.code} class="text-sm flex flex-wrap items-center gap-2">
                <${Badge} tone=${row.code === "peer_budget_total" ? "warning" : "info"}>over budget</${Badge}>
                <span>${row.text}</span>
              </li>`,
            )}
          </ul>`
        : null}
      ${model.lastError && !model.parked.length
        ? html`<p class="text-xs text-status-warning-muted">Last problem: ${model.lastError.text} (code ${model.lastError.code}, ${formatRelativeTime(model.lastError.at, { style: "compact" })})</p>`
        : null}
      ${model.commitError ? html`<p class="text-xs text-status-warning-muted">${model.commitError.text}</p>` : null}
      ${model.enabled && model.phase === "ready"
        ? html`<dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-fg-muted">
            <dt>Pages saved</dt><dd>${model.pages}</dd>
            <dt>Last saved</dt><dd>${model.lastSavedAt ? formatRelativeTime(model.lastSavedAt, { style: "compact" }) : "not since this start"}</dd>
            <dt>Waiting to save</dt><dd>${model.waiting}${model.pendingWrites ? " (" + model.pendingWrites + " pending in gbrain)" : ""}</dd>
          </dl>`
        : null}
      <p class="text-xs text-fg-muted">
        Pages hold both sides of each conversation and the box agent's own messages, with tool calls named but their arguments and results left out. Secrets are masked and private classes (email, meeting notes, health, family) are withheld. Pages stay until someone deletes them with gbrain delete.
      </p>
    </div>
  `;
};

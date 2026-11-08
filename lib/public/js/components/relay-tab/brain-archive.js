import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { formatRelativeTime } from "../../lib/format.js";
import { retryRelayArchive } from "../../lib/api.js";
import { showToast } from "../toast.js";
import { buildArchiveModel } from "./model.js";
import { BriefingSection, StatusDot, ToneWord, withLiterals } from "./parts.js";

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
    <${BriefingSection}
      id="relay-archive-title"
      title="Brain archive"
      actions=${model.canRetry
        ? html`<${ActionButton} onClick=${retry} loading=${busy} tone="subtle" idleLabel="Retry now" loadingLabel="Retrying…" />`
        : null}
    >
      <ul class="relay-facts">
        <li class="relay-fact">
          <${StatusDot} tone=${model.tone} />
          <span class="relay-fact-body">
            <${ToneWord} tone=${model.tone}>${model.label}</${ToneWord}>
            <span class="relay-fact-detail">${withLiterals(model.text)}</span>
          </span>
        </li>
      </ul>
      ${model.parked.length
        ? html`<ul class="relay-rows">
            ${model.parked.map(
              (row) => html`<li key=${row.code} class="relay-row">
                <${ToneWord} tone=${row.tone} mono=${true}>${row.code}</${ToneWord}>
                <span>${row.count} conversation${row.count === 1 ? "" : "s"} waiting for Retry. ${withLiterals(row.text)}</span>
              </li>`,
            )}
          </ul>`
        : null}
      ${model.overBudget.length
        ? html`<ul class="relay-rows">
            ${model.overBudget.map(
              (row) => html`<li key=${row.peer + row.code} class="relay-row">
                <${ToneWord} tone=${row.code === "peer_budget_total" ? "warning" : "info"}>over budget</${ToneWord}>
                <span>${row.text}</span>
              </li>`,
            )}
          </ul>`
        : null}
      ${model.lastError && !model.parked.length
        ? html`<p class="text-xs text-status-warning-muted">Last problem: ${model.lastError.text} (code <code class="font-mono">${model.lastError.code}</code>, ${formatRelativeTime(model.lastError.at, { style: "compact" })})</p>`
        : null}
      ${model.commitError ? html`<p class="text-xs text-status-warning-muted">${model.commitError.text}</p>` : null}
      ${model.enabled && model.phase === "ready"
        ? html`<dl class="relay-kv">
            <div class="relay-kv-row"><dt>Pages saved</dt><dd>${model.pages}</dd></div>
            <div class="relay-kv-row"><dt>Last saved</dt><dd>${model.lastSavedAt ? formatRelativeTime(model.lastSavedAt, { style: "compact" }) : "not since this start"}</dd></div>
            <div class="relay-kv-row"><dt>Waiting to save</dt><dd>${model.waiting}${model.pendingWrites ? " (" + model.pendingWrites + " pending in gbrain)" : ""}</dd></div>
          </dl>`
        : null}
      <p class="briefing-section-caption">
        Pages hold both sides of each conversation and the box agent's own messages, with tool calls named but their arguments and results left out. Secrets are masked and private classes (email, meeting notes, health, family) are withheld. Pages stay until someone deletes them with gbrain delete.
      </p>
    </${BriefingSection}>
  `;
};

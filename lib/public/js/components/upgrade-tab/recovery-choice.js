import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { formatBytes, formatInteger } from "../../lib/format.js";

const html = htm.bind(h);

export const resolveRecoveryRequest = (error, request) => {
  const target = error?.target;
  const original = request?.payload;
  if (target?.channel !== "dev" || original?.channel !== "dev" || !/^[a-f0-9]{40}$/.test(target.sha || "")) return request;
  if (original.devHead !== true && !(typeof original.sha === "string" && original.sha.length >= 7 && target.sha.startsWith(original.sha))) return request;
  return { ...request, payload: { channel: "dev", sha: target.sha }, label: `dev ${target.sha.slice(0, 8)}` };
};

export const buildRecoveryChoice = (error, request) => {
  if (error?.code !== "recovery_choice_required" || !error.operationId || !request?.payload) return null;
  const sizes = error.preflight?.dbSizesBytes;
  const values = sizes && typeof sizes === "object" && !Array.isArray(sizes) ? Object.values(sizes) : null;
  const knownSizes = values && values.every((bytes) => Number.isFinite(bytes) && bytes >= 0);
  return {
    operationId: error.operationId,
    request: { ...request, payload: { ...request.payload } },
    message: typeof error.message === "string" ? error.message : "This version requires a database migration.",
    hint: typeof error.hint === "string" ? error.hint : null,
    backupRiskEligible: error.backupRiskEligible === true,
    databaseBytes: Number.isFinite(error.databaseBytes) ? error.databaseBytes : knownSizes ? values.reduce((sum, bytes) => sum + bytes, 0) : null,
    databaseCount: Number.isInteger(error.databaseCount) ? error.databaseCount : knownSizes ? values.length : null,
    migration: error.migration || error.preflight,
    schema: error.schema,
    gatewayHeld: error.gatewayHeld === true || request.gatewayHeld === true,
    requiresServerCancel: error.gatewayHeld === true,
  };
};

export const RecoveryChoiceCard = ({ model, onSnapshot, onWithoutSnapshot, onCancel, cancelling = false, cancelError = null }) => {
  if (!model) return null;
  const details = model.migration && model.schema ? { migration: model.migration, schema: model.schema } : model.migration || model.schema;
  return html`<section class="bg-surface border border-yellow-500/40 rounded-xl p-4 space-y-3" aria-label="Database recovery choice">
    <h3 class="text-sm font-medium text-body">Choose database recovery protection</h3>
    <p class="text-xs text-fg-muted">Target: ${model.request.payload.version || model.request.payload.sha || model.request.label}</p>
    <p class="text-sm text-body">${model.message}</p>
    <p class="text-xs text-fg-muted">${model.gatewayHeld ? "The gateway remains stopped while you choose." : "The gateway stays up while you choose."} Nothing proceeds until you select an option. A configuration checkpoint cannot restore database data.</p>
    ${model.hint ? html`<p class="text-xs text-fg-muted">${model.hint}</p>` : null}
    ${cancelError ? html`<p role="alert" class="text-sm text-status-error">${cancelError.message} ${cancelError.hint || "The gateway remains held. Retry cancellation or review the current recovery state."}</p>` : null}
    <p class="text-xs text-fg-muted">Database snapshot estimate: ${Number.isFinite(model.databaseBytes) ? formatBytes(model.databaseBytes) : "size unavailable"}${Number.isFinite(model.databaseCount) ? ` across ${formatInteger(model.databaseCount)} databases` : ""}. Snapshots may be large and require a gateway pause.</p>
    ${details ? html`<details><summary class="text-xs text-body cursor-pointer">Migration and schema details</summary><pre class="text-xs text-fg-muted whitespace-pre-wrap break-words mt-2">${typeof details === "string" ? details : JSON.stringify(details, null, 2)}</pre></details>` : null}
    <div class="flex flex-wrap gap-2">
      <${ActionButton} onClick=${onSnapshot} idleLabel="Create database snapshot and upgrade" tone="secondary" disabled=${cancelling} />
      <${ActionButton} onClick=${onWithoutSnapshot} idleLabel="Upgrade without database snapshot" tone="warning" disabled=${cancelling || !model.backupRiskEligible} />
      <${ActionButton} onClick=${onCancel} idleLabel=${cancelError ? "Retry cancellation" : "Cancel"} loading=${cancelling} loadingLabel="Resuming prior gateway..." tone="secondary" />
    </div>
    ${!model.backupRiskEligible ? html`<p class="text-xs text-fg-muted">Forward-only approval is unavailable. Resolve the compatibility issue or cancel.</p>` : null}
  </section>`;
};

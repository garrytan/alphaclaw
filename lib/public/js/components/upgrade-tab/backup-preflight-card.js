import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { formatBytes, formatInteger } from "../../lib/format.js";
import { ActionButton } from "../action-button.js";
import { ConfirmDialog } from "../confirm-dialog.js";

const html = htm.bind(h);

export const AbsoluteSymlinkList = ({ directories }) => {
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(100);
  const links = directories.absoluteSymlinks || [];
  return html`<details onToggle=${(event) => setOpen(event.currentTarget.open)}>
    <summary class="text-xs text-body cursor-pointer">Absolute-target symlinks (${formatInteger(directories.absoluteSymlinkCount)})</summary>
    ${open ? html`
      <p class="text-xs text-fg-muted mt-2">Includes excluded links. .env files are never archived.</p>
      <ul class="max-h-48 overflow-auto mt-2 space-y-1 text-xs font-mono text-fg-muted">
        ${links.slice(0, limit).map((link) => html`<li key=${link.path} class="break-all">${link.path} → ${link.target}</li>`)}
      </ul>
      ${links.length > limit ? html`<button type="button" class="text-xs text-fg-muted hover:text-body mt-2"
        onClick=${() => setLimit((value) => value + 100)}>Show 100 more links (${formatInteger(links.length - limit)} remaining)</button>` : null}
    ` : null}
  </details>`;
};

const DirectoryTable = ({ rows = [] }) => html`
  <div class="overflow-x-auto">
    <table class="w-full text-xs text-left">
      <thead class="text-fg-muted"><tr><th class="py-1 font-medium">Path</th><th class="py-1 text-right font-medium">Entries</th><th class="py-1 text-right font-medium">Bytes</th></tr></thead>
      <tbody>${rows.map((row) => html`<tr key=${row.path} class="border-t border-border">
        <td class="py-1.5 pr-3 font-mono break-all">${row.path}${row.partial ? " (partial)" : ""}</td>
        <td class="py-1.5 text-right tabular-nums whitespace-nowrap">${formatInteger(row.entries)}</td>
        <td class="py-1.5 pl-3 text-right tabular-nums whitespace-nowrap" title=${`${row.bytes} bytes`}>${formatBytes(row.bytes)}</td>
      </tr>`)}</tbody>
    </table>
  </div>`;

export const BackupPreflightDetails = ({ model = {} }) => {
  const { data, error, checking = false } = model;
  const directories = data?.diagnosis?.directories;
  return html`<div class="space-y-3">
    <p class="text-xs text-fg-muted">Checks the full state tree before the gateway is paused. Symlink targets are listed, never followed. The backup checks again when it starts.</p>
    ${checking ? html`<p role="status" class="text-sm text-fg-muted">Checking backup sources… No gateway pause has started.</p>` : null}
    ${error ? html`<p role="alert" class="text-sm text-status-error">${error.message}${error.hint ? ` ${error.hint}` : ""}</p>` : null}
    ${data ? html`
      <p role="status" class=${`text-sm font-medium ${data.blocked ? "text-status-error" : "text-status-success-muted"}`}>
        ${data.blocked ? "Backup blocked before gateway pause" : "Backup preflight passed"}
        ${checking || error ? " (previous check)" : ""}
      </p>
      ${data.reason ? html`<p class="text-xs text-status-error break-words">${data.reason}</p>` : null}
      ${directories ? html`
        <p class="text-xs text-body">${directories.complete ? "Complete count" : "Incomplete count"}: ${formatInteger(directories.entries)} entries · ${formatBytes(directories.bytes)} across the state tree, including excluded scratch data.</p>
        ${Number.isFinite(data.diagnosis.fileCount) ? html`<p class="text-xs text-fg-muted">Selected for backup: ${formatInteger(data.diagnosis.fileCount)} files · ${formatBytes(data.diagnosis.copySetBytes)}.</p>` : null}
        ${directories.selection ? html`<p class="text-xs text-fg-muted">Excluded: ${formatInteger(directories.selection.excludedFiles)} files · ${formatBytes(directories.selection.excludedBytes)}.</p>` : null}
        <p class="text-xs text-fg-muted">State root is ${directories.rootSymlink ? "a symlink (resolved before backup)" : "not a symlink"}.</p>
        ${directories.rootSymlink && directories.stateDir ? html`<p class="text-xs font-mono text-fg-muted break-all">Resolved root: ${directories.stateDir}</p>` : null}
        <div><h4 class="text-xs font-medium text-body mb-1">Every top-level path</h4><${DirectoryTable} rows=${directories.topLevel || []} /></div>
        <details><summary class="text-xs text-body cursor-pointer">Top offenders by entries and bytes</summary>
          <div class="pt-2 space-y-2"><h4 class="text-xs text-fg-muted">Most entries</h4><${DirectoryTable} rows=${directories.topEntries || []} />
            <h4 class="text-xs text-fg-muted">Most bytes</h4><${DirectoryTable} rows=${directories.topBytes || []} /></div>
        </details>
        <${AbsoluteSymlinkList} directories=${directories} />
      ` : null}
    ` : null}
    <${ActionButton} onClick=${model.refresh} loading=${checking} idleLabel=${error ? "Retry preflight" : data ? "Check again" : "Check backup sources"}
      loadingLabel="Checking..." tone="secondary" />
  </div>`;
};

export const BackupPreflightCard = ({ model }) => !model ? null : html`
  <section class="bg-surface border border-border rounded-xl p-4 space-y-3" aria-label="Backup preflight">
    <h3 class="text-sm font-medium text-body">Backup preflight</h3>
    <${BackupPreflightDetails} model=${model} />
  </section>`;

export const BackupPreflightDialog = ({ model }) => !model?.dialogOpen ? null : html`
  <${ConfirmDialog} visible=${true} title="Review backup preflight"
    message="No gateway pause has started. Review the source inventory before continuing."
    details=${html`<${BackupPreflightDetails} model=${model} />`}
    confirmLabel="Continue" confirmDisabled=${!model.ready || model.checking || Boolean(model.error) || model.data?.blocked !== false}
    onConfirm=${model.confirm} onCancel=${model.cancel} />`;

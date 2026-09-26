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
  const databaseSnapshot = model.recoveryMode === "database_set";
  const directories = data?.diagnosis?.directories;
  return html`<div class="space-y-3">
    <p class="text-xs text-fg-muted">${databaseSnapshot ? "You requested a complete database snapshot plus a configuration checkpoint. The database copy may be large; the 16 MiB limit applies only to configuration." : "Configuration checkpoint; database data not backed up. Configuration is limited to 16 MiB total. Database snapshots are a separate, explicit choice and may be large."}</p>
    ${checking ? html`<p role="status" class="text-sm text-fg-muted">Checking configuration… No gateway pause has started.</p>` : null}
    ${error ? html`<p role="alert" class="text-sm text-status-error">${error.message}${error.hint ? ` ${error.hint}` : ""}</p>` : null}
    ${data ? html`
      <p role="status" class=${`text-sm font-medium ${data.blocked ? "text-status-error" : "text-status-success-muted"}`}>
        ${data.blocked ? "Checkpoint blocked before gateway pause" : "Configuration checkpoint preflight passed"}
        ${checking || error ? " (previous check)" : ""}
      </p>
      ${data.reason ? html`<p class="text-xs text-status-error break-words">${data.reason}</p>` : null}
      ${data.checkpoint ? html`<p class="text-xs text-body">Configuration: ${formatInteger(data.checkpoint.fileCount)} files · ${formatBytes(data.checkpoint.bytes)} of 16 MiB maximum.</p>` : null}
      ${Number.isFinite(data.databaseCount) ? html`<p class="text-xs text-fg-muted">${databaseSnapshot ? "Database snapshot selected" : "Database data omitted"}: ${formatInteger(data.databaseCount)} databases${Number.isFinite(data.databaseBytes) ? ` · ${formatBytes(data.databaseBytes)} estimated` : " · size unavailable"}.</p>` : null}
      ${databaseSnapshot && (!Number.isInteger(data.databaseCount) || !Number.isFinite(data.databaseBytes)) ? html`<p role="alert" class="text-xs text-status-error">Database count and size are unavailable. Retry the preflight before creating a snapshot.</p>` : null}
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
    <${ActionButton} onClick=${model.refresh} loading=${checking} idleLabel=${error ? "Retry preflight" : data ? "Check again" : "Check configuration"}
      loadingLabel="Checking..." tone="secondary" />
  </div>`;
};

export const BackupPreflightCard = ({ model }) => !model ? null : html`
  <section class="bg-surface border border-border rounded-xl p-4 space-y-3" aria-label="Backup preflight">
    <h3 class="text-sm font-medium text-body">Configuration checkpoint</h3>
    <${BackupPreflightDetails} model=${model} />
  </section>`;

export const BackupPreflightDialog = ({ model }) => !model?.dialogOpen ? null : html`
  <${ConfirmDialog} visible=${true} title=${model.recoveryMode === "database_set" ? "Create database snapshot?" : "Review configuration checkpoint"}
    message=${model.recoveryMode === "database_set" ? "The gateway will pause while the complete database set is copied and verified. Review the estimated size before confirming. No upgrade will be installed." : "No gateway pause has started. Database data is not backed up by this checkpoint."}
    details=${html`<${BackupPreflightDetails} model=${model} />`}
    confirmLabel=${model.recoveryMode === "database_set" ? "Create database snapshot" : "Continue"} confirmDisabled=${!model.ready || model.checking || Boolean(model.error) || model.data?.blocked !== false || (model.recoveryMode === "database_set" && (!Number.isInteger(model.data?.databaseCount) || model.data.databaseCount < 0 || !Number.isFinite(model.data?.databaseBytes) || model.data.databaseBytes < 0))}
    onConfirm=${model.confirm} onCancel=${model.cancel} />`;

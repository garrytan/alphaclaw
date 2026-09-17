import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { AsyncSection } from "../async-section.js";
import { Badge } from "../badge.js";
import { BackupPolicyEditor } from "./backup-policy-editor.js";
import {
  buildBackupInventoryRows,
  kBackupsEmptyLabel,
  kBackupsErrorHeadline,
  kBackupsRunbookUrl,
  kBackupsUnreadableMessage,
} from "./helpers.js";

const html = htm.bind(h);

export const kBackupsCardIntro =
  "Every update attempts a backup first, and Back up now takes one on demand. If a broad backup cannot finish, AlphaClaw may save a migration-only backup; its omitted data is shown below. Only verified, complete archives are reusable by a later update. The last 3 are kept, plus protected migration archives.";
export const kBackupNowLabel = "Back up now";
export const kBackupNowCaption =
  "May pause and relaunch the gateway while copying. Large backups and fallback attempts can take longer. Nothing is installed.";

const BackupRow = ({ row = {} }) => html`
  <li
    class=${`flex flex-wrap items-center gap-2 rounded-lg px-2 py-1.5 ${
      row.newest ? "ac-surface-inset border border-cyan-500/40" : ""
    }`}
    aria-current=${row.newest ? "true" : null}
  >
    <span
      class=${`font-mono text-xs min-w-0 break-all ${
        row.missing ? "text-fg-dim line-through" : "text-body"
      }`}
      >${row.name}</span
    >
    ${row.newest ? html`<${Badge} tone="cyan">newest<//>` : null}
    <span class="text-xs text-fg-muted">${row.ageLabel}</span>
    ${row.captureLabel ? html`<span class="text-xs text-fg-muted">${row.captureLabel}</span>` : null}
    <span class="text-xs text-fg-muted">${row.sizeLabel}</span>
    <${Badge} tone=${row.producerTone}>${row.producerLabel}<//>
    ${row.badges.map(
      (badge) => html`<${Badge} key=${badge.id} tone=${badge.tone}>${badge.label}<//>`,
    )}
  </li>
`;

// Frame-first Backups card (WI-4.3): the header and runbook link render in
// every state; the data region is the only thing that shows LOADING / EMPTY /
// ERROR(+Retry). Rows carry age · size · producer · self-standing badges with
// the reason text visible (never tooltip-only); the newest archive on disk is
// highlighted because it is the restore candidate the runbook names.
export const UpgradeBackupsCard = ({
  inventory = null,
  loading = false,
  error = null,
  onRetry = () => {},
  nowMs = Date.now(),
  // v0.9.81 (C3): "Back up now" + the ledger-derived last-manual-backup line.
  onBackupNow = () => {},
  backupNowDisabled = false,
  backupNowStarting = false,
  lastManualBackup = null,
}) => {
  const rows = buildBackupInventoryRows(inventory, nowMs);
  const truncated = inventory?.truncated === true;
  // A 200 whose scan failed (`readable:false` — EACCES, ENOTDIR, a stray file
  // at the backups path) is the ERROR state with Retry, never "No backups yet":
  // the server folds every readdir failure into that one flag EXCEPT ENOENT —
  // a missing directory is an EMPTY inventory (readable), not this state.
  const unreadable = inventory != null && inventory.readable === false;
  const regionError =
    inventory == null
      ? error
      : unreadable
        ? {
            message: inventory.backupsDir
              ? `${kBackupsUnreadableMessage} (${inventory.backupsDir}).`
              : `${kBackupsUnreadableMessage}.`,
          }
        : null;
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="card-label">Backups</h2>
        <div class="flex flex-wrap items-center gap-3">
          <a
            class="ac-tip-link text-xs"
            href=${kBackupsRunbookUrl}
            target="_blank"
            rel="noreferrer"
            >Restore runbook</a
          >
          <${ActionButton}
            onClick=${onBackupNow}
            tone="secondary"
            idleLabel=${kBackupNowLabel}
            loadingLabel="Starting backup..."
            loading=${backupNowStarting}
            disabled=${backupNowDisabled}
          />
        </div>
      </div>
      <p class="text-xs text-fg-muted">${kBackupsCardIntro}</p>
      <p class="text-xs text-fg-dim">${kBackupNowCaption}</p>
      ${lastManualBackup
        ? html`<p
            class=${`text-xs ${
              lastManualBackup.tone === "danger"
                ? "text-status-error-muted"
                : lastManualBackup.tone === "success"
                  ? "text-status-success-muted"
                  : lastManualBackup.tone === "warning"
                    ? "text-status-warning-muted"
                  : "text-fg-muted"
            }`}
            data-testid="last-manual-backup"
          >
            ${lastManualBackup.text}
          </p>`
        : null}
      <${AsyncSection}
        loading=${Boolean(loading) && inventory == null}
        loadingLabel="Loading backups..."
        error=${regionError}
        errorHeadline=${kBackupsErrorHeadline}
        onRetry=${onRetry}
        empty=${!unreadable && rows.length === 0}
        emptyLabel=${kBackupsEmptyLabel}
      >
        <ul class="space-y-1">
          ${rows.map((row) => html`<${BackupRow} key=${row.key} row=${row} />`)}
        </ul>
        ${truncated
          ? html`<p class="text-xs text-fg-dim">
              Showing the newest ${rows.length} archives — older ones
              are still in the backups directory.
            </p>`
          : null}
      <//>
      ${error && inventory != null
        ? html`<p class="text-xs text-status-warning-muted">
            Could not refresh the backup list — showing the last loaded data
            (${error.message || String(error)}).
          </p>`
        : null}
      <${BackupPolicyEditor} />
    </div>
  `;
};

import { h } from "preact";
import htm from "htm";
import { AsyncSection } from "../async-section.js";
import { Badge } from "../badge.js";
import {
  buildBackupInventoryRows,
  kBackupsEmptyLabel,
  kBackupsErrorHeadline,
  kBackupsInventoryCap,
  kBackupsRunbookUrl,
} from "./helpers.js";

const html = htm.bind(h);

export const kBackupsCardIntro =
  "Pre-update archives AlphaClaw can restore from (the last 3 are kept). Only verified, complete archives are reusable by a later update; the reason is on each row.";

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
}) => {
  const rows = buildBackupInventoryRows(inventory, nowMs);
  const truncated = inventory?.truncated === true;
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="card-label">Backups</h2>
        <a
          class="ac-tip-link text-xs"
          href=${kBackupsRunbookUrl}
          target="_blank"
          rel="noreferrer"
          >Restore runbook</a
        >
      </div>
      <p class="text-xs text-fg-muted">${kBackupsCardIntro}</p>
      <${AsyncSection}
        loading=${Boolean(loading) && inventory == null}
        loadingLabel="Loading backups..."
        error=${inventory == null ? error : null}
        errorHeadline=${kBackupsErrorHeadline}
        onRetry=${onRetry}
        empty=${rows.length === 0}
        emptyLabel=${kBackupsEmptyLabel}
      >
        <ul class="space-y-1">
          ${rows.map((row) => html`<${BackupRow} key=${row.key} row=${row} />`)}
        </ul>
        ${truncated
          ? html`<p class="text-xs text-fg-dim">
              Showing the newest ${kBackupsInventoryCap} archives — older ones
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
    </div>
  `;
};

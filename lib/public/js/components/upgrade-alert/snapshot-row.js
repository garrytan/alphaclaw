import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { fetchUpgradeStatus } from "../../lib/api.js";
import { buildSnapshotRowModel, kUpgradeStatusKey } from "./model.js";
import { EnableSnapshotsDialog } from "./enable-snapshots-dialog.js";

const html = htm.bind(h);

// Admin-only standing row in Backups: would the next Doctor keep a safety
// snapshot? Independent of any Doctor run, so the fix can happen between
// deploys. Members get no preflight from the server, so the row hides.
export const UpgradeSnapshotsRow = ({ isActive = true }) => {
  const status = useCachedFetch(kUpgradeStatusKey, fetchUpgradeStatus, { enabled: isActive, maxAgeMs: 30_000 });
  const [open, setOpen] = useState(false);
  const model = buildSnapshotRowModel(status.data);
  if (!model) return null;
  return html`
    <div class="ac-surface-inset border border-border rounded-lg px-3 py-2 space-y-1">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="text-xs font-semibold text-body">Upgrade safety snapshots</span>
          <${Badge} tone=${model.tone}>${model.label}<//>
        </div>
        ${model.canEnable
          ? html`<${ActionButton} onClick=${() => setOpen(true)} tone="secondary" size="sm" idleLabel="Enable snapshots" className="ac-touch" />`
          : null}
      </div>
      <p class="text-xs text-fg-muted break-words">${model.sentence}</p>
      ${model.manualFix ? html`<p class="text-xs text-body break-words">To fix it: ${model.manualFix}</p>` : null}
      <${EnableSnapshotsDialog}
        visible=${open}
        onDone=${() => {
          setOpen(false);
          void status.refresh({ force: true }).catch(() => null);
        }}
        onCancel=${() => setOpen(false)}
      />
    </div>
  `;
};

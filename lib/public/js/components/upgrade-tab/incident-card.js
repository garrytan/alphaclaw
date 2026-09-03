import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";

const html = htm.bind(h);

// U6: plain-language incident card for auto-rollbacks and failed updates.
export const UpgradeIncidentCard = ({
  incident = null,
  actionsDisabled = false,
  clearingBlocklistId = null,
  onClearBlocklist = () => {},
  rollingBack = false,
  onRequestRollback = () => {},
}) => {
  if (!incident) return null;
  return html`
    <div class="bg-surface border border-red-500/40 rounded-xl p-4 space-y-2">
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
        <span class="text-sm font-medium">${incident.title}</span>
      </div>
      <p class="text-sm text-fg-muted">${incident.detail}</p>
      <p class="text-sm text-body">${incident.recovery}</p>
      <div class="flex flex-wrap items-center gap-2">
        ${incident.blockedId
          ? html`
              <${ActionButton}
                onClick=${() => onClearBlocklist(incident.blockedId)}
                tone="subtle"
                idleLabel="Clear blocklist entry"
                loadingLabel="Clearing..."
                loading=${clearingBlocklistId === incident.blockedId}
                disabled=${actionsDisabled &&
                clearingBlocklistId !== incident.blockedId}
              />
            `
          : null}
        ${
          // An apply-failed incident means nothing changed — the RUNNING
          // version is the good one, so offering Roll back (which would
          // blocklist it) is only sensible for the auto-rollback kind.
          incident.kind === "rollback"
            ? html`
                <${ActionButton}
                  onClick=${onRequestRollback}
                  tone="danger"
                  idleLabel="Roll back"
                  loadingLabel="Rolling back..."
                  loading=${rollingBack}
                  disabled=${actionsDisabled && !rollingBack}
                />
              `
            : null
        }
      </div>
    </div>
  `;
};

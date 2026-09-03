import { h } from 'preact';
import { useState } from 'preact/hooks';
import htm from 'htm';
import { ActionButton } from './action-button.js';
import { InlineErrorChip } from './inline-error-chip.js';
const html = htm.bind(h);

const kModeLabels = {
  webchat: 'Browser',
  cli: 'CLI',
};

const formatTitle = (d) => kModeLabels[d.clientMode] || d.clientId || 'Device';

const formatSubtitle = (d) => {
  const parts = [];
  if (d.platform) parts.push(d.platform);
  if (d.role) parts.push(d.role);
  return parts.join(' · ');
};

const DeviceRow = ({ d, onApprove, onReject }) => {
  const [busy, setBusy] = useState(null);
  // The row owns its failure UX: callers may toast, but a failed action must
  // clear busy and leave a persistent inline error here, not a silent revert.
  const [actionError, setActionError] = useState(null);

  const handle = async (action) => {
    setBusy(action);
    setActionError(null);
    try {
      if (action === 'approve') await onApprove(d.id);
      else await onReject(d.id);
    } catch (err) {
      setBusy(null);
      setActionError({ action, error: err });
    }
  };

  const title = formatTitle(d);
  const subtitle = formatSubtitle(d);

  if (busy === 'approve') {
    return html`
      <div class="bg-field rounded-lg p-3 mb-2 flex items-center gap-2">
        <span class="text-status-success text-sm">Approved</span>
        <span class="text-fg-muted text-xs">${title}</span>
      </div>`;
  }
  if (busy === 'reject') {
    return html`
      <div class="bg-field rounded-lg p-3 mb-2 flex items-center gap-2">
        <span class="text-fg-muted text-sm">Rejected</span>
        <span class="text-fg-muted text-xs">${title}</span>
      </div>`;
  }

  return html`
    <div class="bg-field rounded-lg p-3 mb-2">
      <div class="flex items-center gap-2 mb-2">
        <span class="font-medium text-sm">${title}</span>
        ${subtitle && html`<span class="text-xs text-fg-muted">${subtitle}</span>`}
      </div>
      <div class="flex gap-2">
        <${ActionButton}
          onClick=${() => handle('approve')}
          tone="success"
          size="sm"
          idleLabel="Approve"
          className="font-medium px-3 py-1.5"
        />
        <${ActionButton}
          onClick=${() => handle('reject')}
          tone="secondary"
          size="sm"
          idleLabel="Reject"
          className="font-medium px-3 py-1.5"
        />
      </div>
      ${actionError
        ? html`<div class="mt-2">
            <${InlineErrorChip}
              error=${actionError.error}
              headline=${actionError.action === 'approve'
                ? "Couldn't approve this device."
                : "Couldn't reject this device."}
            />
          </div>`
        : null}
    </div>`;
};

export const DevicePairings = ({ pending, onApprove, onReject }) => {
  if (!pending || pending.length === 0) return null;

  return html`
    <div class="mt-3 pt-3 border-t border-border">
      <p class="text-xs text-fg-muted mb-2">Pending device pairings</p>
      ${pending.map((d) => html`<${DeviceRow} key=${d.id} d=${d} onApprove=${onApprove} onReject=${onReject} />`)}
    </div>`;
};

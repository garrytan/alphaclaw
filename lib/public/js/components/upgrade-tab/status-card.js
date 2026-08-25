import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { SegmentedControl } from "../segmented-control.js";
import { buildChannelOptions, kChannelLabels } from "./helpers.js";

const html = htm.bind(h);

const StatusRow = ({ label = "", children }) => html`
  <div class="flex items-baseline justify-between gap-3">
    <dt class="text-xs text-fg-muted shrink-0">${label}</dt>
    <dd class="text-sm text-body text-right min-w-0 break-words">${children}</dd>
  </div>
`;

export const UpgradeStatusCard = ({
  model = null,
  availabilityLine = null,
  activeChannel = "stable",
  onSelectChannel = () => {},
  actionsDisabled = false,
  savingChannel = false,
  latestTarget = null,
  onUpdateToLatest = () => {},
  markingGood = false,
  onMarkGood = () => {},
  rollingBack = false,
  onRequestRollback = () => {},
}) => {
  if (!model) return null;
  const channelLabel = kChannelLabels[activeChannel] || activeChannel;
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <h2 class="card-label">Release channel</h2>
          ${model.stabilization
            ? html`<${Badge} tone="warning">${model.stabilization.badge}</${Badge}>`
            : null}
        </div>
        <${SegmentedControl}
          options=${buildChannelOptions()}
          value=${activeChannel}
          onChange=${onSelectChannel}
          disabled=${actionsDisabled || savingChannel}
        />
      </div>

      ${model.driftNotice
        ? html`<p class="text-xs text-status-warning-muted">${model.driftNotice}</p>`
        : null}

      <dl class="space-y-1.5">
        <${StatusRow} label="Running">${model.runningLabel}</${StatusRow}>
        ${model.pinVersion
          ? html`<${StatusRow} label="Pinned fallback">${model.pinVersion}</${StatusRow}>`
          : null}
        ${availabilityLine
          ? html`<${StatusRow} label="Availability">${availabilityLine}</${StatusRow}>`
          : null}
        ${model.lastUpdate
          ? html`<${StatusRow} label="Last update">
              <span
                class=${model.lastUpdate.ok === false
                  ? "text-status-error-muted"
                  : ""}
                >${model.lastUpdate.text}</span
              >
            </${StatusRow}>`
          : null}
        ${model.lastKnownGood
          ? html`<${StatusRow} label="Last known good">${model.lastKnownGood}</${StatusRow}>`
          : null}
      </dl>

      ${model.stabilization
        ? html`
            <div
              class="ac-surface-inset border border-yellow-500/35 rounded-lg p-3 space-y-2"
            >
              <p class="text-sm text-body">${model.stabilization.line}</p>
              <div class="flex flex-wrap items-center gap-2">
                <${ActionButton}
                  onClick=${onMarkGood}
                  tone="success"
                  idleLabel="Mark as good now"
                  loadingLabel="Marking..."
                  loading=${markingGood}
                  disabled=${actionsDisabled && !markingGood}
                />
                <${ActionButton}
                  onClick=${onRequestRollback}
                  tone="warning"
                  idleLabel="Roll back now"
                  loadingLabel="Rolling back..."
                  loading=${rollingBack}
                  disabled=${actionsDisabled && !rollingBack}
                />
                <p class="text-xs text-fg-muted">
                  ${model.stabilization.caption}
                </p>
              </div>
            </div>
          `
        : null}

      ${model.autoAcceptedNote
        ? html`<p class="text-xs text-status-warning-muted">
            ${model.autoAcceptedNote}
          </p>`
        : null}

      ${model.bootCostNote
        ? html`<p class="text-xs text-fg-muted">${model.bootCostNote}</p>`
        : null}

      ${latestTarget
        ? html`
            <div class="pt-1">
              <${ActionButton}
                onClick=${onUpdateToLatest}
                tone="primary"
                size="md"
                idleLabel=${`Update to latest ${channelLabel.toLowerCase()}`}
                loading=${savingChannel}
                loadingLabel="Saving..."
                disabled=${actionsDisabled}
              />
            </div>
          `
        : null}
    </div>
  `;
};

import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { LoadingSpinner } from "../loading-spinner.js";
import { SegmentedControl } from "../segmented-control.js";
import { buildChannelOptions, kChannelLabels } from "./helpers.js";

const html = htm.bind(h);

const StatusRow = ({ label = "", children }) => html`
  <div class="flex items-baseline justify-between gap-3">
    <dt class="text-xs text-fg-muted shrink-0">${label}</dt>
    <dd class="text-sm text-body text-right min-w-0 break-words">${children}</dd>
  </div>
`;

// Channel-intent mismatch banner: the configured channel's latest applicable
// target differs from the running build. Persistent (not a toast) — admins
// often arrive from chat-app deep links on a phone.
export const ChannelMismatchBanner = ({
  model = null,
  actionsDisabled = false,
  savingChannel = false,
  onRequestApply = () => {},
  onToggleNotes = () => {},
  onSelectChannel = () => {},
}) => {
  if (!model) return null;
  return html`
    <div class="bg-surface border border-yellow-500/40 rounded-xl p-4 space-y-2">
      <p class="text-sm text-body min-w-0 break-words">${model.message}</p>
      <div class="flex flex-wrap items-center gap-2">
        ${model.applyTarget
          ? html`
              <${ActionButton}
                onClick=${() =>
                  onRequestApply({
                    payload: model.applyTarget.applyPayload,
                    label: model.applyTarget.label,
                    isDowngrade: false,
                  })}
                tone="primary"
                idleLabel=${model.applyLabel}
                disabled=${actionsDisabled || model.applyDisabled}
              />
            `
          : null}
        ${model.applyDisabledReason
          ? html`<span
              class="text-xs text-status-warning-muted ac-surface-inset border border-yellow-500/35 rounded px-1.5 py-0.5"
              >${model.applyDisabledReason}</span
            >`
          : null}
        ${model.notesRowId
          ? html`
              <button
                type="button"
                class="text-xs text-fg-muted hover:text-body"
                onclick=${() => onToggleNotes(model.notesRowId)}
              >
                Release notes
              </button>
            `
          : null}
        ${model.backChannel
          ? html`
              <${ActionButton}
                onClick=${() => onSelectChannel(model.backChannel)}
                tone="secondary"
                idleLabel=${model.backLabel}
                loadingLabel="Saving..."
                loading=${savingChannel}
                disabled=${actionsDisabled && !savingChannel}
              />
            `
          : null}
      </div>
    </div>
  `;
};

export const UpgradeStatusCard = ({
  model = null,
  availabilityLine = null,
  activeChannel = "stable",
  onSelectChannel = () => {},
  actionsDisabled = false,
  savingChannel = false,
  channelSaveError = null,
  onDismissChannelSaveError = () => {},
  latestTarget = null,
  applyGate = null,
  onUpdateToLatest = () => {},
  markingGood = false,
  onMarkGood = () => {},
  rollingBack = false,
  onRequestRollback = () => {},
  loadingChannel = false,
}) => {
  if (!model) {
    // Never hold the card hostage to the fetch: render the frame with the
    // (static) channel options disabled and scope the loading line to the
    // data region, so tab visits don't blank the page.
    if (!loadingChannel) return null;
    return html`
      <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h2 class="card-label">Release channel</h2>
          <${SegmentedControl}
            options=${buildChannelOptions()}
            value=${activeChannel}
            onChange=${() => {}}
            disabled=${true}
          />
        </div>
        <div class="flex items-center gap-2 text-sm text-fg-muted py-2">
          <${LoadingSpinner} className="h-4 w-4" />
          Loading version info...
        </div>
      </div>
    `;
  }
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
        <div class="flex items-center gap-2">
          ${savingChannel
            ? html`<${LoadingSpinner} className="h-4 w-4" />`
            : null}
          <${SegmentedControl}
            options=${buildChannelOptions()}
            value=${activeChannel}
            onChange=${onSelectChannel}
            disabled=${actionsDisabled || savingChannel}
          />
        </div>
      </div>

      ${channelSaveError
        ? html`
            <div
              class="ac-surface-inset border border-red-500/40 rounded-lg px-3 py-2 flex flex-wrap items-start justify-between gap-2"
            >
              <div class="min-w-0 space-y-0.5">
                <p class="text-xs text-status-error">
                  ${channelSaveError.message}
                </p>
                ${channelSaveError.detail
                  ? html`<p class="text-xs text-fg-muted">
                      ${channelSaveError.detail}
                    </p>`
                  : null}
                ${channelSaveError.hint
                  ? html`<p class="text-xs text-fg-muted">
                      ${channelSaveError.hint}
                    </p>`
                  : null}
              </div>
              <button
                type="button"
                class="text-xs text-fg-muted hover:text-body shrink-0"
                onclick=${onDismissChannelSaveError}
              >
                Dismiss
              </button>
            </div>
          `
        : null}

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
        ${model.settingsMigration
          ? html`<${StatusRow} label="Settings migration">
              <span
                class=${model.settingsMigration.ok === false
                  ? "text-status-error-muted"
                  : ""}
                >${model.settingsMigration.text}</span
              >
            </${StatusRow}>`
          : null}
      </dl>

      ${model.showStabilizationActions
        ? html`
            <div
              class="ac-surface-inset border border-yellow-500/35 rounded-lg p-3 space-y-2"
            >
              ${model.stabilization
                ? html`<p class="text-sm text-body">${model.stabilization.line}</p>`
                : null}
              ${model.autoAcceptedNote
                ? html`<p class="text-xs text-status-warning-muted">
                    ${model.autoAcceptedNote}
                  </p>`
                : null}
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
                ${model.stabilization
                  ? html`<p class="text-xs text-fg-muted">
                      ${model.stabilization.caption}
                    </p>`
                  : null}
              </div>
            </div>
          `
        : null}

      ${model.bootCostNote
        ? html`<p class="text-xs text-fg-muted">${model.bootCostNote}</p>`
        : null}

      ${latestTarget
        ? html`
            <div class="pt-1 flex flex-wrap items-center gap-2">
              <${ActionButton}
                onClick=${onUpdateToLatest}
                tone="primary"
                size="md"
                idleLabel=${`Update to latest ${channelLabel.toLowerCase()}`}
                disabled=${actionsDisabled || Boolean(applyGate?.applyDisabled)}
              />
              ${applyGate?.applyDisabledReason
                ? html`<span class="text-xs text-status-warning-muted"
                    >${applyGate.applyDisabledReason}</span
                  >`
                : null}
            </div>
          `
        : null}
    </div>
  `;
};

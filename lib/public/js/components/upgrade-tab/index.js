import { h } from "preact";
import htm from "htm";
import { LoadingSpinner } from "../loading-spinner.js";
import { PageHeader } from "../page-header.js";
import { useUpgradeTab } from "./use-upgrade-tab.js";
import { UpgradeStatusCard } from "./status-card.js";
import { UpgradeCatalogCard } from "./catalog-card.js";
import { UpgradeProgressCard } from "./progress-card.js";
import { UpgradeIncidentCard } from "./incident-card.js";
import {
  ApplyConfirmDialog,
  ChannelSwitchDialog,
  RollbackConfirmDialog,
} from "./dialogs.js";
import {
  buildAvailabilityLine,
  buildIncidentModel,
  buildStatusCardModel,
  getLatestApplicableTarget,
  kAlphaclawCrossLink,
} from "./helpers.js";

const html = htm.bind(h);

const VerdictBanner = ({ verdict = null, onDismiss = () => {} }) => {
  if (!verdict) return null;
  return html`
    <div
      class=${`bg-surface border rounded-xl p-4 flex flex-wrap items-start justify-between gap-3 ${
        verdict.ok ? "border-green-500/40" : "border-red-500/40"
      }`}
    >
      <div class="flex items-center gap-2 min-w-0">
        <span
          class=${`w-2 h-2 rounded-full ${
            verdict.ok ? "bg-green-500" : "bg-red-500"
          }`}
        ></span>
        <p class="text-sm text-body">${verdict.message}</p>
      </div>
      <button
        type="button"
        class="text-xs text-fg-muted hover:text-body"
        onclick=${onDismiss}
      >
        Dismiss
      </button>
    </div>
  `;
};

const ApplyErrorCard = ({ applyError = null, onDismiss = () => {} }) => {
  if (!applyError) return null;
  return html`
    <div class="bg-surface border border-red-500/40 rounded-xl p-4 space-y-1">
      <div class="flex items-start justify-between gap-3">
        <p class="text-sm text-status-error">${applyError.message}</p>
        <button
          type="button"
          class="text-xs text-fg-muted hover:text-body shrink-0"
          onclick=${onDismiss}
        >
          Dismiss
        </button>
      </div>
      ${applyError.hint
        ? html`<p class="text-xs text-fg-muted">${applyError.hint}</p>`
        : null}
      ${typeof applyError.docsUrl === "string" && applyError.docsUrl
        ? html`<a
            class="ac-tip-link text-xs"
            href=${applyError.docsUrl}
            target="_blank"
            rel="noreferrer"
            >Learn more</a
          >`
        : null}
    </div>
  `;
};

// Pure presentational component: all state comes in via the `state` prop so
// the page can be rendered (and tested) without any hooks.
export const UpgradeTabView = ({ state = {} }) => {
  const {
    channelInfo = null,
    channelError = null,
    loadingChannel = false,
    catalog = null,
    catalogError = null,
    loadingCatalog = false,
    refreshingCatalog = false,
    activeChannel = "stable",
    nowMs = Date.now(),
    channelSwitchPrompt = null,
    onSelectChannel = () => {},
    onConfirmSwitchApply = () => {},
    onConfirmSwitchBrowse = () => {},
    onCancelSwitch = () => {},
    savingChannel = false,
    pendingApply = null,
    onRequestApply = () => {},
    onConfirmApply = () => {},
    onCancelApply = () => {},
    operation = null,
    applyError = null,
    onDismissApplyError = () => {},
    logOpen = false,
    onToggleLog = () => {},
    verdict = null,
    onDismissVerdict = () => {},
    markingGood = false,
    onMarkGood = () => {},
    rollingBack = false,
    onRollback = () => {},
    rollbackPrompt = false,
    onRequestRollback = () => {},
    onCancelRollback = () => {},
    clearingBlocklistId = null,
    lastClearedId = null,
    onClearBlocklist = () => {},
    onCheckNow = () => {},
    onUpdateToLatest = () => {},
    expandedNotesId = null,
    onToggleNotes = () => {},
    devAdvancedOpen = false,
    onToggleDevAdvanced = () => {},
    actionsDisabled = false,
  } = state;

  const statusModel = buildStatusCardModel(channelInfo);
  const incident = buildIncidentModel({
    lastUpdateRun: channelInfo?.lastUpdateRun || null,
    blocklist: channelInfo?.blocklist || [],
  });
  const availabilityLine = buildAvailabilityLine({
    catalog,
    releaseChannel: activeChannel,
  });
  const latestTarget = getLatestApplicableTarget({
    catalog,
    releaseChannel: activeChannel,
  });
  const isInitialLoading = loadingChannel && !channelInfo && !channelError;

  return html`
    <div class="space-y-4">
      <${PageHeader} title="OpenClaw — Versions & Channels" />

      <${VerdictBanner} verdict=${verdict} onDismiss=${onDismissVerdict} />

      ${!operation
        ? html`<${UpgradeIncidentCard}
            incident=${incident}
            actionsDisabled=${actionsDisabled}
            clearingBlocklistId=${clearingBlocklistId}
            onClearBlocklist=${onClearBlocklist}
            rollingBack=${rollingBack}
            onRequestRollback=${onRequestRollback}
          />`
        : null}

      <${UpgradeProgressCard}
        operation=${operation}
        nowMs=${nowMs}
        logOpen=${logOpen}
        onToggleLog=${onToggleLog}
      />

      <${ApplyErrorCard}
        applyError=${applyError}
        onDismiss=${onDismissApplyError}
      />

      ${isInitialLoading
        ? html`
            <div class="bg-surface border border-border rounded-xl p-4">
              <div class="flex items-center gap-2 text-sm text-fg-muted py-2">
                <${LoadingSpinner} className="h-4 w-4" />
                Loading version info...
              </div>
            </div>
          `
        : null}

      ${channelError && !channelInfo
        ? html`
            <div class="bg-surface border border-red-500/40 rounded-xl p-4 space-y-1">
              <p class="text-sm text-status-error">${channelError.message}</p>
              ${channelError.hint
                ? html`<p class="text-xs text-fg-muted">${channelError.hint}</p>`
                : null}
            </div>
          `
        : null}

      ${channelError && channelInfo
        ? html`<p class="text-xs text-status-warning-muted">
            Could not refresh status — showing last loaded data.
          </p>`
        : null}

      <${UpgradeStatusCard}
        model=${statusModel}
        availabilityLine=${availabilityLine}
        activeChannel=${activeChannel}
        onSelectChannel=${onSelectChannel}
        actionsDisabled=${actionsDisabled}
        savingChannel=${savingChannel}
        latestTarget=${latestTarget}
        onUpdateToLatest=${onUpdateToLatest}
        markingGood=${markingGood}
        onMarkGood=${onMarkGood}
        rollingBack=${rollingBack}
        onRequestRollback=${onRequestRollback}
      />

      <${UpgradeCatalogCard}
        catalog=${catalog}
        catalogError=${catalogError}
        loadingCatalog=${loadingCatalog}
        refreshingCatalog=${refreshingCatalog}
        nowMs=${nowMs}
        installedVersion=${channelInfo?.installedVersion || null}
        actionsDisabled=${actionsDisabled}
        onCheckNow=${onCheckNow}
        devAdvancedOpen=${devAdvancedOpen}
        onToggleDevAdvanced=${onToggleDevAdvanced}
        onRequestApply=${onRequestApply}
        onClearBlocklist=${onClearBlocklist}
        clearingBlocklistId=${clearingBlocklistId}
        lastClearedId=${lastClearedId}
        expandedNotesId=${expandedNotesId}
        onToggleNotes=${onToggleNotes}
      />

      <p class="text-xs text-fg-muted">${kAlphaclawCrossLink}</p>

      <${ChannelSwitchDialog}
        prompt=${channelSwitchPrompt}
        saving=${savingChannel}
        onApplyNow=${onConfirmSwitchApply}
        onBrowseOnly=${onConfirmSwitchBrowse}
        onCancel=${onCancelSwitch}
      />

      <${ApplyConfirmDialog}
        pendingApply=${pendingApply}
        onConfirm=${onConfirmApply}
        onCancel=${onCancelApply}
      />

      <${RollbackConfirmDialog}
        visible=${Boolean(rollbackPrompt)}
        rollingBack=${rollingBack}
        onConfirm=${onRollback}
        onCancel=${onCancelRollback}
      />
    </div>
  `;
};

export const UpgradeTab = ({
  statusData = null,
  onRefreshStatuses = () => {},
}) => {
  const state = useUpgradeTab({ statusData, onRefreshStatuses });
  return html`<${UpgradeTabView} state=${state} />`;
};

import { h } from "preact";
import htm from "htm";
import { LoadingSpinner } from "../loading-spinner.js";
import { PageHeader } from "../page-header.js";
import { useUpgradeTab } from "./use-upgrade-tab.js";
import { ChannelMismatchBanner, UpgradeStatusCard } from "./status-card.js";
import { WhatsNewCard } from "./whats-new-card.js";
import { UpgradeCatalogCard } from "./catalog-card.js";
import { UpgradeProgressCard } from "./progress-card.js";
import { UpgradeIncidentCard } from "./incident-card.js";
import { RunLogViewer, UpgradeTimelineCard } from "./timeline-card.js";
import { UpgradeMedicCard } from "./medic-card.js";
import { UpgradeOverseerCard } from "./overseer-card.js";
import { ApplyConfirmDialog, RollbackConfirmDialog } from "./dialogs.js";
import {
  buildAvailabilityLine,
  buildCatalogGatingModel,
  buildChannelMismatchModel,
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

// Post-restart continuity: the latest run finished as activation_failed or
// interrupted — the persisted result envelope plus a way into the full log.
const RunFailureCard = ({
  runFailure = null,
  onDismiss = () => {},
  onViewRunLog = () => {},
  runLog = null,
  onCloseRunLog = () => {},
}) => {
  if (!runFailure) return null;
  return html`
    <div class="bg-surface border border-red-500/40 rounded-xl p-4 space-y-2">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-2 h-2 rounded-full bg-red-500 shrink-0"></span>
          <p class="text-sm font-medium text-body min-w-0 break-words">
            ${runFailure.title}
          </p>
        </div>
        <button
          type="button"
          class="text-xs text-fg-muted hover:text-body shrink-0"
          onclick=${onDismiss}
        >
          Dismiss
        </button>
      </div>
      ${runFailure.error
        ? html`
            <p class="text-sm text-status-error">${runFailure.error.message}</p>
            ${runFailure.error.hint
              ? html`<p class="text-xs text-fg-muted">${runFailure.error.hint}</p>`
              : null}
          `
        : null}
      ${runFailure.hasLog && runFailure.operationId
        ? html`
            <button
              type="button"
              class="text-xs text-fg-muted hover:text-body"
              onclick=${() => onViewRunLog(runFailure.operationId)}
            >
              View full log
            </button>
          `
        : null}
      <${RunLogViewer} runLog=${runLog} onCloseRunLog=${onCloseRunLog} />
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
    whatsNew = null,
    catalogError = null,
    loadingCatalog = false,
    refreshingCatalog = false,
    activeChannel = "stable",
    nowMs = Date.now(),
    onSelectChannel = () => {},
    savingChannel = false,
    channelSaveError = null,
    onDismissChannelSaveError = () => {},
    runs = [],
    runFailure = null,
    onDismissRunFailure = () => {},
    runLog = null,
    onViewRunLog = () => {},
    onCloseRunLog = () => {},
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
    repairAvailable = false,
    onRunRepair = () => {},
    onRetryApply = () => {},
    onDismissOperation = () => {},
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

  const statusModel = buildStatusCardModel(channelInfo, nowMs);
  const incident = buildIncidentModel({
    lastUpdateRun: channelInfo?.lastUpdateRun || null,
    blocklist: channelInfo?.blocklist || [],
  });
  const availabilityLine = buildAvailabilityLine({
    catalog,
    releaseChannel: activeChannel,
    installedVersion: channelInfo?.installedVersion || null,
  });
  const latestTarget = getLatestApplicableTarget({
    catalog,
    releaseChannel: activeChannel,
  });
  const applyGate = buildCatalogGatingModel(catalog);
  const mismatch = operation
    ? null
    : buildChannelMismatchModel({
        catalog,
        channelInfo,
        releaseChannel: activeChannel,
      });
  // One log pane at a time: the failure card owns the viewer for its own run,
  // the timeline card shows every other run's log.
  const failureLog =
    runFailure && runLog && runLog.operationId === runFailure.operationId
      ? runLog
      : null;
  const timelineLog = failureLog ? null : runLog;
  const isInitialLoading = loadingChannel && !channelInfo && !channelError;

  return html`
    <div class="space-y-4">
      <${PageHeader} title="OpenClaw — Versions & Channels" />

      <${VerdictBanner} verdict=${verdict} onDismiss=${onDismissVerdict} />

      <${RunFailureCard}
        runFailure=${runFailure}
        onDismiss=${onDismissRunFailure}
        onViewRunLog=${onViewRunLog}
        runLog=${failureLog}
        onCloseRunLog=${onCloseRunLog}
      />

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
        repairAvailable=${repairAvailable}
        onRunRepair=${onRunRepair}
        onRetryApply=${onRetryApply}
        onDismissOperation=${onDismissOperation}
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

      <${ChannelMismatchBanner}
        model=${mismatch}
        actionsDisabled=${actionsDisabled}
        savingChannel=${savingChannel}
        onRequestApply=${onRequestApply}
        onToggleNotes=${onToggleNotes}
        onSelectChannel=${onSelectChannel}
      />

      <${UpgradeStatusCard}
        model=${statusModel}
        availabilityLine=${availabilityLine}
        activeChannel=${activeChannel}
        onSelectChannel=${onSelectChannel}
        actionsDisabled=${actionsDisabled}
        savingChannel=${savingChannel}
        channelSaveError=${channelSaveError}
        onDismissChannelSaveError=${onDismissChannelSaveError}
        latestTarget=${latestTarget}
        applyGate=${applyGate}
        onUpdateToLatest=${onUpdateToLatest}
        markingGood=${markingGood}
        onMarkGood=${onMarkGood}
        rollingBack=${rollingBack}
        onRequestRollback=${onRequestRollback}
      />

      <${WhatsNewCard} whatsNew=${whatsNew} activeChannel=${activeChannel} />

      <${UpgradeOverseerCard}
        actionsDisabled=${actionsDisabled}
        markingGood=${markingGood}
        onMarkGood=${onMarkGood}
        rollingBack=${rollingBack}
        onRequestRollback=${onRequestRollback}
        runs=${state.runs}
      />

      <${UpgradeMedicCard} />

      <${UpgradeCatalogCard}
        catalog=${catalog}
        catalogError=${catalogError}
        loadingCatalog=${loadingCatalog}
        refreshingCatalog=${refreshingCatalog}
        nowMs=${nowMs}
        installedVersion=${channelInfo?.installedVersion || null}
        actionsDisabled=${actionsDisabled}
        applyGate=${applyGate}
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

      <${UpgradeTimelineCard}
        runs=${runs}
        nowMs=${nowMs}
        onViewRunLog=${onViewRunLog}
        runLog=${timelineLog}
        onCloseRunLog=${onCloseRunLog}
      />

      <p class="text-xs text-fg-muted">${kAlphaclawCrossLink}</p>

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

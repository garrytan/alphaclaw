import { h } from "preact";
import htm from "htm";
import { Gateway } from "../gateway.js";
import { useWatchdogTab } from "./use-watchdog-tab.js";
import { WatchdogSafeModeBanner } from "./safe-mode-banner.js";
import { WatchdogStatusDetails } from "./status-details.js";
import { WatchdogNarrativeCard } from "./narrative-card.js";
import { WatchdogOverseerCard } from "./overseer-card.js";
import { WatchdogDegradedCard } from "./degraded-card.js";
import { WatchdogResourcesCard } from "./resources/index.js";
import { WatchdogAutotuneCard } from "./autotune-card.js";
import { WatchdogSettingsCard } from "./settings/index.js";
import { WatchdogConsoleCard } from "./console/index.js";
import { WatchdogIncidentsCard } from "./incidents/index.js";
import { useGatewayShell } from "../restart-progress-card.js";
import { WatchdogSqliteBackupCard } from "./backup-card.js";

const html = htm.bind(h);

// Page hierarchy: Gateway card (anchor, full width) → narrative → degraded →
// status details → overseer → incidents → backup → console → resources
// (live usage — checked daily) → autotune (capacity/tuning — checked on
// incidents and resizes) → settings. The Gateway card owns safe-mode
// presentation when the server sends the unified state; the standalone
// banner survives only for old servers (version skew).
export const WatchdogTab = ({
  gatewayStatus = null,
  openclawVersion = null, // eslint-disable-line no-unused-vars
  watchdogStatus = null,
  onRefreshStatuses = () => {},
  restartingGateway = false,
  onRestartGateway,
  restartSignal = 0,
}) => {
  const state = useWatchdogTab({
    watchdogStatus,
    onRefreshStatuses,
    restartSignal,
  });
  const shell = useGatewayShell();

  return html`
    <div class="space-y-4">
      ${!shell.statusState
        ? html`<${WatchdogSafeModeBanner}
            watchdogStatus=${state.currentWatchdogStatus}
            onResumeChannels=${state.onResumeChannels}
            resuming=${state.resumingChannels}
          />`
        : null}

      <${Gateway}
        status=${gatewayStatus}
        restarting=${restartingGateway}
        onRestart=${onRestartGateway}
        watchdogStatus=${state.currentWatchdogStatus}
        onRepair=${state.onRepair}
        repairing=${state.isRepairInProgress}
        onViewLogs=${state.onViewLogs}
        onResumeChannels=${state.onResumeChannels}
        onRefreshStatuses=${onRefreshStatuses}
      />

      <${WatchdogNarrativeCard} watchdogStatus=${state.currentWatchdogStatus} />

      <${WatchdogDegradedCard} watchdogStatus=${state.currentWatchdogStatus} />

      <${WatchdogStatusDetails} watchdogStatus=${state.currentWatchdogStatus} />

      <${WatchdogOverseerCard}
        incidents=${state.incidents}
        onRepair=${state.onRepair}
        repairing=${state.isRepairInProgress}
        onRestartGateway=${onRestartGateway}
        restartingGateway=${restartingGateway}
        onResumeChannels=${state.onResumeChannels}
        resumingChannels=${state.resumingChannels}
        onRefreshIncidents=${state.refreshEvents}
      />

      <${WatchdogIncidentsCard}
        activeTab=${state.incidentsTab}
        onSelectTab=${state.onSelectIncidentsTab}
        incidents=${state.incidents}
        incidentsLoaded=${state.incidentsLoaded}
        incidentsError=${state.incidentsError}
        detailById=${state.incidentDetailById}
        expandedIds=${state.expandedIncidentIds}
        onToggleIncident=${state.onToggleIncident}
        onLoadMore=${state.onLoadMoreIncidents}
        loadingMore=${state.loadingMoreIncidents}
        hasMore=${state.hasMoreIncidents}
        highlightIncidentId=${state.highlightIncidentId}
        events=${state.events}
        eventsLoaded=${state.eventsLoaded}
        eventsError=${state.eventsError}
        includeRoutine=${state.includeRoutine}
        onSetIncludeRoutine=${state.onSetIncludeRoutine}
        isRefreshing=${state.refreshing}
        onRefresh=${state.refreshEvents}
      />

      <${WatchdogSqliteBackupCard} />

      <${WatchdogConsoleCard}
        activeConsoleTab=${state.activeConsoleTab}
        stickToBottom=${state.stickToBottom}
        onSetStickToBottom=${state.setStickToBottom}
        onSelectConsoleTab=${state.handleSelectConsoleTab}
        connectingTerminal=${state.connectingTerminal}
        terminalConnected=${state.terminalConnected}
        terminalEnded=${state.terminalEnded}
        terminalStatusText=${state.terminalStatusText}
        terminalUiSettling=${state.terminalUiSettling}
        onRestartTerminalSession=${state.onRestartTerminalSession}
        logsRef=${state.logsRef}
        logs=${state.logs}
        logsError=${state.logsError}
        loadingLogs=${state.loadingLogs}
        copyingAll=${state.copyingAll}
        terminalPanelRef=${state.terminalPanelRef}
        terminalHostRef=${state.terminalHostRef}
        terminalInstanceRef=${state.terminalInstanceRef}
        logsPanelHeightPx=${state.logsPanelHeightPx}
        onCopyAll=${state.onCopyAll}
      />

      <${WatchdogResourcesCard}
        resources=${state.resources}
        profile=${state.resourcesProfile}
        error=${state.resourcesError}
        onRetry=${state.refreshResources}
        memoryExpanded=${state.memoryExpanded}
        onSetMemoryExpanded=${state.setMemoryExpanded}
      />

      <${WatchdogAutotuneCard}
        restartSignal=${restartSignal}
        resourcesProfile=${state.resourcesProfile}
        onRestartGateway=${onRestartGateway}
        restartingGateway=${restartingGateway}
      />

      <${WatchdogSettingsCard}
        settings=${state.settings}
        settingsHydrated=${state.settingsHydrated}
        savingSettings=${state.savingSettings}
        savingSettingsContext=${state.savingSettingsContext}
        settingsSaveError=${state.settingsSaveError}
        settingsLoadError=${state.settingsLoadError}
        onRetryLoadSettings=${state.onRetryLoadSettings}
        onToggleAutoRepair=${state.onToggleAutoRepair}
        onToggleNotifications=${state.onToggleNotifications}
        onToggleNotificationsVerbose=${state.onToggleNotificationsVerbose}
      />
    </div>
  `;
};

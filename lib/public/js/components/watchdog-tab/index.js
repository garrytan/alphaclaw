import { h } from "preact";
import htm from "htm";
import { Gateway } from "../gateway.js";
import { useWatchdogTab } from "./use-watchdog-tab.js";
import { WatchdogSafeModeBanner } from "./safe-mode-banner.js";
import { WatchdogStatusDetails } from "./status-details.js";
import { WatchdogNarrativeCard } from "./narrative-card.js";
import { WatchdogResourcesCard } from "./resources/index.js";
import { WatchdogSettingsCard } from "./settings/index.js";
import { WatchdogConsoleCard } from "./console/index.js";
import { WatchdogIncidentsCard } from "./incidents/index.js";
import { WatchdogSqliteBackupCard } from "./backup-card.js";

const html = htm.bind(h);

export const WatchdogTab = ({
  gatewayStatus = null,
  openclawVersion = null,
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

  return html`
    <div class="space-y-4">
      <${WatchdogSafeModeBanner}
        watchdogStatus=${state.currentWatchdogStatus}
        onResumeChannels=${state.onResumeChannels}
        resuming=${state.resumingChannels}
      />

      <${Gateway}
        status=${gatewayStatus}
        openclawVersion=${openclawVersion}
        restarting=${restartingGateway}
        onRestart=${onRestartGateway}
        watchdogStatus=${state.currentWatchdogStatus}
        onRepair=${state.onRepair}
        repairing=${state.isRepairInProgress}
      />

      <${WatchdogNarrativeCard} watchdogStatus=${state.currentWatchdogStatus} />

      <${WatchdogStatusDetails} watchdogStatus=${state.currentWatchdogStatus} />

      <${WatchdogIncidentsCard}
        activeTab=${state.incidentsTab}
        onSelectTab=${state.onSelectIncidentsTab}
        incidents=${state.incidents}
        incidentsLoading=${state.incidentsLoading}
        incidentsError=${state.incidentsError}
        detailById=${state.incidentDetailById}
        expandedIds=${state.expandedIncidentIds}
        onToggleIncident=${state.onToggleIncident}
        onLoadMore=${state.onLoadMoreIncidents}
        loadingMore=${state.loadingMoreIncidents}
        hasMore=${state.hasMoreIncidents}
        highlightIncidentId=${state.highlightIncidentId}
        events=${state.events}
        includeRoutine=${state.includeRoutine}
        onSetIncludeRoutine=${state.onSetIncludeRoutine}
        onRefresh=${state.refreshEvents}
      />

      <${WatchdogResourcesCard}
        resources=${state.resources}
        memoryExpanded=${state.memoryExpanded}
        onSetMemoryExpanded=${state.setMemoryExpanded}
      />

      <${WatchdogSettingsCard}
        settings=${state.settings}
        savingSettings=${state.savingSettings}
        onToggleAutoRepair=${state.onToggleAutoRepair}
        onToggleNotifications=${state.onToggleNotifications}
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
        loadingLogs=${state.loadingLogs}
        copyingAll=${state.copyingAll}
        terminalPanelRef=${state.terminalPanelRef}
        terminalHostRef=${state.terminalHostRef}
        terminalInstanceRef=${state.terminalInstanceRef}
        logsPanelHeightPx=${state.logsPanelHeightPx}
        onCopyAll=${state.onCopyAll}
      />
    </div>
  `;
};

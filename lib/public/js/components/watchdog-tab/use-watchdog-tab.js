import { useWatchdogConsole } from "./console/use-console.js";
import { useWatchdogIncidents } from "./incidents/use-incidents.js";
import { useWatchdogResources } from "./resources/use-resources.js";
import { useWatchdogSettings } from "./settings/use-settings.js";
import { kWatchdogConsoleTabLogs } from "./helpers.js";

export const useWatchdogTab = ({
  watchdogStatus = null,
  onRefreshStatuses = () => {},
  restartSignal = 0,
} = {}) => {
  const currentWatchdogStatus = watchdogStatus || {};
  const incidents = useWatchdogIncidents({
    restartSignal,
    onRefreshStatuses,
  });
  const resources = useWatchdogResources();
  const settings = useWatchdogSettings({
    watchdogStatus: currentWatchdogStatus,
    onRefreshStatuses,
    onRefreshIncidents: incidents.refreshEvents,
  });
  const consoleState = useWatchdogConsole({
    copyExtras: {
      status: currentWatchdogStatus,
      incidents: incidents.incidents,
    },
  });

  // On this page "View logs" scrolls/focuses the logs pane instead of
  // navigating away (the pane is made programmatically focusable so the
  // deep-link lands screen-reader focus there).
  const onViewLogs = () => {
    consoleState.handleSelectConsoleTab(kWatchdogConsoleTabLogs);
    const logsEl = consoleState.logsRef?.current || null;
    if (logsEl && typeof logsEl === "object") {
      try {
        logsEl.tabIndex = -1;
        logsEl.scrollIntoView?.({ behavior: "smooth", block: "start" });
        logsEl.focus?.({ preventScroll: true });
      } catch {}
    }
  };

  return {
    onViewLogs,
    currentWatchdogStatus,
    events: incidents.events,
    eventsLoaded: incidents.eventsLoaded,
    eventsError: incidents.eventsError,
    refreshingEvents: incidents.refreshingEvents,
    refreshEvents: incidents.refreshEvents,
    incidentsTab: incidents.activeTab,
    onSelectIncidentsTab: incidents.setActiveTab,
    incidents: incidents.incidents,
    incidentsLoaded: incidents.incidentsLoaded,
    incidentsError: incidents.incidentsError,
    refreshing: incidents.refreshing,
    incidentDetailById: incidents.detailById,
    expandedIncidentIds: incidents.expandedIds,
    onToggleIncident: incidents.onToggleIncident,
    onLoadMoreIncidents: incidents.onLoadMore,
    loadingMoreIncidents: incidents.loadingMore,
    hasMoreIncidents: incidents.hasMore,
    highlightIncidentId: incidents.highlightIncidentId,
    includeRoutine: incidents.includeRoutine,
    onSetIncludeRoutine: incidents.setIncludeRoutine,
    resources: resources.resources,
    resourcesProfile: resources.resourcesProfile,
    resourcesError: resources.resourcesError,
    refreshResources: resources.refreshResources,
    memoryExpanded: resources.memoryExpanded,
    setMemoryExpanded: resources.setMemoryExpanded,
    settings: settings.settings,
    settingsHydrated: settings.settingsHydrated,
    savingSettings: settings.savingSettings,
    savingSettingsContext: settings.savingSettingsContext,
    settingsSaveError: settings.settingsSaveError,
    settingsLoadError: settings.settingsLoadError,
    onRetryLoadSettings: settings.onRetryLoadSettings,
    onToggleAutoRepair: settings.onToggleAutoRepair,
    onToggleNotifications: settings.onToggleNotifications,
    onToggleNotificationsVerbose: settings.onToggleNotificationsVerbose,
    onRepair: settings.onRepair,
    isRepairInProgress: settings.isRepairInProgress,
    onResumeChannels: settings.onResumeChannels,
    resumingChannels: settings.resumingChannels,
    logs: consoleState.logs,
    logsError: consoleState.logsError,
    loadingLogs: consoleState.loadingLogs,
    copyingAll: consoleState.copyingAll,
    stickToBottom: consoleState.stickToBottom,
    setStickToBottom: consoleState.setStickToBottom,
    activeConsoleTab: consoleState.activeConsoleTab,
    handleSelectConsoleTab: consoleState.handleSelectConsoleTab,
    connectingTerminal: consoleState.connectingTerminal,
    terminalConnected: consoleState.terminalConnected,
    terminalEnded: consoleState.terminalEnded,
    terminalStatusText: consoleState.terminalStatusText,
    terminalUiSettling: consoleState.terminalUiSettling,
    onRestartTerminalSession: consoleState.onRestartTerminalSession,
    logsPanelHeightPx: consoleState.logsPanelHeightPx,
    logsRef: consoleState.logsRef,
    terminalPanelRef: consoleState.terminalPanelRef,
    terminalHostRef: consoleState.terminalHostRef,
    terminalInstanceRef: consoleState.terminalInstanceRef,
    onCopyAll: consoleState.onCopyAll,
  };
};

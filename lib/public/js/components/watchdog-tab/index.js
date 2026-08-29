import { h } from "preact";
import htm from "htm";
import { Gateway } from "../gateway.js";
import { useWatchdogTab } from "./use-watchdog-tab.js";
import { WatchdogSafeModeBanner } from "./safe-mode-banner.js";
import { WatchdogDegradedCard } from "./degraded-card.js";
import { WatchdogResourcesCard } from "./resources/index.js";
import { WatchdogSettingsCard } from "./settings/index.js";
import { WatchdogConsoleCard } from "./console/index.js";
import { WatchdogIncidentsCard } from "./incidents/index.js";
import { useGatewayShell } from "../restart-progress-card.js";
import { WatchdogSqliteBackupCard } from "./backup-card.js";

const html = htm.bind(h);

// Page hierarchy: Gateway card (anchor, full width) → incidents → console →
// resources → settings. The Gateway card owns safe-mode presentation when
// the server sends the unified state; the standalone banner survives only
// for old servers (version skew).
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

      <${WatchdogDegradedCard} watchdogStatus=${state.currentWatchdogStatus} />

      <${WatchdogIncidentsCard}
        events=${state.events}
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
        memoryExpanded=${state.memoryExpanded}
        onSetMemoryExpanded=${state.setMemoryExpanded}
      />

      <${WatchdogSettingsCard}
        settings=${state.settings}
        savingSettings=${state.savingSettings}
        onToggleAutoRepair=${state.onToggleAutoRepair}
        onToggleNotifications=${state.onToggleNotifications}
      />
    </div>
  `;
};

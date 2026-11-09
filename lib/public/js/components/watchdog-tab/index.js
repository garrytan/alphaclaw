import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { RoutePageHeader } from "../page-header.js";
import { deriveStatusChip } from "../status-chip.js";
import { VerticalDotsIcon } from "../icons.js";
import {
  GatewayActionConfirm,
  GatewayDetails,
  GatewayOtherActions,
  GatewayProgress,
  GatewayRepairControl,
  GatewayRestartControl,
  GatewayStateLabel,
  GatewayStateNotes,
  useGatewayControls,
} from "../gateway.js";
import { useWatchdogTab } from "./use-watchdog-tab.js";
import { WatchdogSafeModeBanner } from "./safe-mode-banner.js";
import { WatchdogStatusDetails } from "./status-details.js";
import { WatchdogNarrativeCard } from "./narrative-card.js";
import { WatchdogOverseerCard } from "./overseer/index.js";
import { WatchdogDegradedCard } from "./degraded-card.js";
import { WatchdogResourcesCard } from "./resources/index.js";
import { WatchdogBoxCard } from "./box/index.js";
import { WatchdogAutotuneCard } from "./autotune/index.js";
import { WatchdogSettingsCard } from "./settings/index.js";
import { WatchdogConsoleCard } from "./console/index.js";
import { WatchdogIncidentsCard } from "./incidents/index.js";
import { WatchdogRescueSessionCard } from "./rescue-session-card.js";
import { WatchdogRestartEvidence } from "./restart-evidence.js";
import { buildWatchdogNarrative } from "./helpers.js";
import { buildHealthHeadline, describeWatchdogState, summarizeIncidentsToday } from "./headline-model.js";

const html = htm.bind(h);

// Health (ALPH-69 PR 3b), a Briefing page in Health C's order: header actions
// (View logs, Repair, Restart gateway), the restart progress, the headline,
// degraded and safe-mode content while active, the status line, Resources,
// Incidents, "If the gateway goes down", the log tail, then Recent boots and
// Watchdog settings as closed disclosures. Every part is the watchdog tab's
// existing component with its existing handlers; only the layout changed.
// The Gateway header owns safe-mode presentation when the server sends the
// unified state; the standalone banner survives only for old servers.
export const WatchdogTab = ({
  gatewayStatus = null,
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
  const gw = useGatewayControls({
    status: gatewayStatus,
    watchdogStatus: state.currentWatchdogStatus,
    repairing: state.isRepairInProgress,
    onViewLogs: state.onViewLogs,
    onResumeChannels: state.onResumeChannels,
    onRefreshStatuses,
  });
  const [moreOpen, setMoreOpen] = useState(false);
  const [manualRepairRunning, setManualRepairRunning] = useState(false);
  const [repairOutcome, setRepairOutcome] = useState(null);
  const moreRef = useRef(null);

  // The phone's ⋯ menu closes on Escape (focus back on its button) and on a
  // click outside it. Repair's confirm dialog renders in a portal, so a click
  // in a dialog is not outside: closing would hide Repair's failure alert.
  useEffect(() => {
    if (!moreOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      setMoreOpen(false);
      moreRef.current?.querySelector?.(".health-more-toggle")?.focus?.();
    };
    const onClick = (event) => {
      if (moreRef.current?.contains?.(event.target)) return;
      if (event.target?.closest?.("[role=dialog], [role=alertdialog]")) return;
      setMoreOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("click", onClick);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("click", onClick);
    };
  }, [moreOpen]);
  const shell = gw.shell;
  // Shared by the overseer row and the incidents section's row action; the
  // tab-level test stubs the hook, so tolerate a missing slice.
  const overseer = state.overseer || {};
  const nowMs = Date.now();
  const headline = buildHealthHeadline({
    watchdogStatus: state.currentWatchdogStatus,
    narrative: buildWatchdogNarrative(state.currentWatchdogStatus, nowMs),
    chipKey: deriveStatusChip(shell).key,
    restarting: restartingGateway || gw.operation?.phase === "running",
    repairing: manualRepairRunning || !!state.isRepairInProgress || !!state.currentWatchdogStatus?.operationInProgress,
    connectivityMode: shell.connectivityMode,
    stale: shell.statusFreshness?.mode === "stale",
    statusReason: gw.serverState?.reason || "",
    incidentsToday: state.incidentsLoaded ? summarizeIncidentsToday(state.incidents, nowMs) : null,
  });
  const watchdogWord = describeWatchdogState(state.currentWatchdogStatus);

  const headerActions = html`
    ${gw.operation?.phase === "running"
      ? html`<${ActionButton}
          tone="solid"
          size="md"
          loading=${true}
          idleLabel="Restart gateway"
          loadingLabel="Restarting gateway…"
          className="health-restart"
        />`
      : html`<${GatewayRestartControl} gw=${gw} tone="solid" size="md" noun="gateway" className="health-restart" />`}
    <div class="health-more" ref=${moreRef} data-open=${moreOpen ? "true" : "false"}>
      <button
        type="button"
        class="health-more-toggle"
        aria-label="More actions"
        aria-expanded=${moreOpen ? "true" : "false"}
        aria-controls="health-more-actions"
        onclick=${() => setMoreOpen(!moreOpen)}
      >
        <${VerticalDotsIcon} />
      </button>
      <div class="health-more-actions" id="health-more-actions">
        <${ActionButton}
          onClick=${() => {
            setMoreOpen(false);
            state.onViewLogs?.();
          }}
          tone="secondary"
          size="md"
          idleLabel="View logs"
        />
        <${GatewayRepairControl}
          gw=${gw}
          size="md"
          onBusyChange=${setManualRepairRunning}
          onOutcomeChange=${setRepairOutcome}
        />
      </div>
    </div>
  `;

  return html`
    <div class="health briefing">
      <${RoutePageHeader} routeId="health" actions=${headerActions} />
      ${repairOutcome
        ? html`<p class="ac-repair-outcome health-repair-outcome text-xs text-status-warning-muted" role="alert">
            ${repairOutcome}
          </p>`
        : null}
      <div class="health-progress">
        <${GatewayProgress} gw=${gw} />
      </div>

      <p class="briefing-headline" data-tone=${headline.tone} aria-live="polite">${headline.text}</p>
      <${WatchdogNarrativeCard} watchdogStatus=${state.currentWatchdogStatus} compact=${true} />

      ${!shell.statusState
        ? html`<${WatchdogSafeModeBanner}
            watchdogStatus=${state.currentWatchdogStatus}
            onResumeChannels=${state.onResumeChannels}
            resuming=${state.resumingChannels}
          />`
        : null}
      <${WatchdogDegradedCard} watchdogStatus=${state.currentWatchdogStatus} />

      <div class="health-status">
        <div class="health-status-line">
          <span class="health-status-item">
            <${GatewayStateLabel} gw=${gw} prefix="Gateway: " />
          </span>
          <${WatchdogStatusDetails} watchdogStatus=${state.currentWatchdogStatus} />
          ${watchdogWord
            ? html`<span class="health-status-item">
                <span class=${"status-chip-dot status-chip-dot--" + watchdogWord.dot} aria-hidden="true"></span>
                <span class="text-sm">Watchdog: ${watchdogWord.word}</span>
              </span>`
            : null}
        </div>
        <${GatewayStateNotes} gw=${gw} />
        <div class="health-status-actions">
          <${GatewayDetails} gw=${gw} />
          <${GatewayOtherActions} gw=${gw} exclude=${["view_logs"]} />
        </div>
      </div>

      <${WatchdogResourcesCard}
        resources=${state.resources}
        profile=${state.resourcesProfile}
        error=${state.resourcesError}
        onRetry=${state.refreshResources}
        memoryExpanded=${state.memoryExpanded}
        onSetMemoryExpanded=${state.setMemoryExpanded}
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
        overseerEnabled=${overseer.enabled}
        overseerAvailability=${overseer.availability}
        overseerSituation=${overseer.situation}
        reviewInFlight=${overseer.reviewInFlight}
        incidentReviewError=${overseer.incidentReviewError}
        onReviewIncident=${overseer.onReviewIncident}
      />

      <section class="briefing-section" aria-labelledby="health-down-title">
        <div class="briefing-section-head">
          <h2 class="briefing-section-title" id="health-down-title">If the gateway goes down</h2>
        </div>
        <div class="health-rows">
          <${WatchdogRescueSessionCard} />
          <${WatchdogOverseerCard}
            incidents=${state.incidents}
            watchdogStatus=${state.currentWatchdogStatus}
            enabled=${overseer.enabled}
            availability=${overseer.availability}
            settingsLoaded=${overseer.settingsLoaded}
            saving=${overseer.saving}
            onToggle=${overseer.onToggle}
            setting=${overseer.setting}
            situation=${overseer.situation}
            situationError=${overseer.situationError}
            ephemeral=${overseer.ephemeral}
            reviewStatus=${overseer.reviewStatus}
            reviewInFlight=${overseer.reviewInFlight}
            onReviewSituation=${overseer.onReviewSituation}
            primaryKind=${overseer.primaryKind}
            onSelectPrimaryKind=${overseer.onSelectPrimaryKind}
            onRepair=${state.onRepair}
            repairing=${state.isRepairInProgress}
            onRestartGateway=${onRestartGateway}
            restartingGateway=${restartingGateway}
            onResumeChannels=${state.onResumeChannels}
            resumingChannels=${state.resumingChannels}
          />
        </div>
      </section>

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
        manualCopyText=${state.manualCopyText}
        terminalPanelRef=${state.terminalPanelRef}
        terminalHostRef=${state.terminalHostRef}
        terminalInstanceRef=${state.terminalInstanceRef}
        logsPanelHeightPx=${state.logsPanelHeightPx}
        onCopyAll=${state.onCopyAll}
      />

      <details class="briefing-disclosure" data-disclosure="boots">
        <summary class="briefing-disclosure-summary">Recent boots</summary>
        <div class="health-rows">
          <${WatchdogBoxCard}
            box=${state.box}
            errors=${state.boxErrors}
            expanded=${state.boxExpanded}
            onSetExpanded=${state.setBoxExpanded}
            onRetry=${state.refreshBox}
          />
          <${WatchdogRestartEvidence}
            operation=${shell.restartOperation}
            onLoadEvidence=${shell.actions?.loadEvidence || null}
          />
        </div>
      </details>

      <details class="briefing-disclosure" data-disclosure="settings">
        <summary class="briefing-disclosure-summary">Watchdog settings</summary>
        <div class="health-rows">
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
          <${WatchdogAutotuneCard}
            restartSignal=${restartSignal}
            resourcesProfile=${state.resourcesProfile}
            onRestartGateway=${onRestartGateway}
            restartingGateway=${restartingGateway}
          />
        </div>
      </details>

      <${GatewayActionConfirm} gw=${gw} />
    </div>
  `;
};

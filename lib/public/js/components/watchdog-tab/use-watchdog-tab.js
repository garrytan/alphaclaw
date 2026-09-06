import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { usePolling } from "../../hooks/usePolling.js";
import { useSavedSetting } from "../../hooks/use-saved-setting.js";
import {
  fetchWatchdogOverseer,
  fetchWatchdogOverseerSituation,
  requestWatchdogOverseerReview,
  updateWatchdogOverseer,
} from "../../lib/api.js";
import { showToast } from "../toast.js";
import { useWatchdogConsole } from "./console/use-console.js";
import { useWatchdogIncidents } from "./incidents/use-incidents.js";
import { useWatchdogResources } from "./resources/use-resources.js";
import { useWatchdogSettings } from "./settings/use-settings.js";
import { kOverseerSharedCopy, kWatchdogConsoleTabLogs } from "./helpers.js";

export const kOverseerReviewCopy = {
  toggleOn: "Overseer enabled — reviews run in any watchdog state",
  toggleOff: "Overseer disabled",
  situationReady: "Situation report ready",
  // An older server (rollback, cached tab) answers the no-id POST with an
  // incident review; say what actually happened instead of claiming a report.
  reviewFinished: kOverseerSharedCopy.reviewFinished,
  incidentRecorded: (incidentId) => `Review recorded on incident #${incidentId}`,
  connectionLost:
    "Connection lost — the review continues on the server; the result appears here when it finishes.",
  persistFailed: kOverseerSharedCopy.persistFailed,
  startFailed: "Could not start an overseer review",
};

const kSituationCacheKey = "/api/watchdog/overseer/situation";
const kSituationPollMs = 15000;
const kAvailabilityProbeRetries = 5;
const kAvailabilityProbeDelayMs = 3000;

// fetch() rejects with a TypeError when the connection drops mid-request
// ("Failed to fetch" / "NetworkError…" / "Load failed"); HTTP-level refusals
// arrive as plain Errors from parseJsonOrThrow (E13). Any OTHER TypeError is a
// client bug and must not be reported as a dropped connection.
const kFetchNetworkErrorPattern = /fetch|network|load failed/i;
const isNetworkError = (error) =>
  error?.name === "AbortError" ||
  (error?.name === "TypeError" && kFetchNetworkErrorPattern.test(String(error?.message || "")));

const asRecord = (value) =>
  value && typeof value === "object" ? value : null;

// `at` is an ms epoch on the wire; tolerate an ISO string the same way the
// card's view model does so both sides agree on "newest".
const recordAt = (record) => {
  const raw = asRecord(record) ? record.at : null;
  if (raw == null || raw === "") return 0;
  const at = typeof raw === "number" ? raw : Date.parse(raw);
  return Number.isFinite(at) ? at : 0;
};

const newestReportAt = ({ incidents, situation, ephemeral }) => {
  let newest = Math.max(
    recordAt(ephemeral),
    recordAt(situation?.lastVerdict),
    recordAt(situation?.current),
  );
  for (const incident of incidents) {
    newest = Math.max(newest, recordAt(incident?.overseer?.current));
  }
  return newest;
};

// Overseer state shared by the overseer card AND the incidents card's
// "Review this incident" row action — so it lives in the tab hook, not a
// card. The situation poll runs unconditionally (DD11): the enabled toggle
// gates execution (consent), never reads of what was already recorded.
export const useWatchdogOverseer = ({
  incidents = [],
  onRefreshIncidents = () => {},
} = {}) => {
  // One value drives both review buttons (DD17): null | "situation" | <incidentId>.
  const [reviewInFlight, setReviewInFlight] = useState(null);
  // Last POST result record; beats polled data until a newer polled `done`
  // record arrives or the next click (DD10/E6).
  const [ephemeral, setEphemeral] = useState(null);
  // Client-transient status slot ({ tone, text, error?, sinceAt }); the view
  // model drops it once the polled current.at advances past sinceAt (DD7).
  const [reviewStatus, setReviewStatus] = useState(null);
  const [incidentReviewError, setIncidentReviewError] = useState(null);
  // Operator's pinned report kind, bound to the newest record `at` it was
  // pinned against — a newer record anywhere resets the pin to auto (DD19).
  const [primaryPin, setPrimaryPin] = useState(null);

  // The persisted toggle goes through the shared setting loop (fix wave
  // F158): hydration, optimistic flip, revert + inline chip on a failed save,
  // Retry on a failed load — instead of the hand-rolled loaded/saving pair
  // that toasted failures and left the switch wherever the DOM put it.
  const setting = useSavedSetting({
    cacheKey: "/api/watchdog/overseer",
    load: fetchWatchdogOverseer,
    select: (data) => data?.enabled === true,
    selectSaved: (response) =>
      typeof response?.enabled === "boolean" ? response.enabled : undefined,
    save: (next) => updateWatchdogOverseer(next),
    label: "watchdog overseer",
  });
  const enabled = setting.value === true;
  const availability = setting.payload?.availability || null;
  // A failed load still unblocks the card (SavedToggle renders the Retry chip).
  const settingsLoaded = setting.hydrated;
  const saving = setting.saving;

  // A cold server cache answers availability "probing" (available === null)
  // while it spawns `claude --version` in the background — re-poll briefly so
  // the card doesn't show "Checking..." forever (bounded retries).
  const probeRetriesRef = useRef(0);
  useEffect(() => {
    if (!settingsLoaded || !availability || availability.available !== null) return;
    if (probeRetriesRef.current >= kAvailabilityProbeRetries) return;
    probeRetriesRef.current += 1;
    const timer = setTimeout(setting.reload, kAvailabilityProbeDelayMs);
    return () => clearTimeout(timer);
  }, [settingsLoaded, availability, setting.reload]);

  const onToggle = useCallback(
    async (next) => {
      const outcome = await setting.commit(next === true);
      if (outcome.ok) {
        showToast(
          next ? kOverseerReviewCopy.toggleOn : kOverseerReviewCopy.toggleOff,
          "info",
        );
      }
      // A failed save reverts the switch and shows the inline chip
      // (setting.saveError) — no error toast.
    },
    [setting.commit],
  );

  const situationPoll = usePolling(fetchWatchdogOverseerSituation, kSituationPollMs, {
    cacheKey: kSituationCacheKey,
    dedupeInFlight: true,
  });
  const situation = situationPoll.data ?? null;

  // Synchronous in-flight guard: two clicks in the same tick both see the
  // stale reviewInFlight render closure — the ref blocks the duplicate POST.
  const reviewInFlightRef = useRef(null);
  const beginReview = (key) => {
    if (reviewInFlightRef.current != null) return false;
    reviewInFlightRef.current = key;
    setReviewInFlight(key);
    setReviewStatus(null);
    setIncidentReviewError(null);
    return true;
  };
  const endReview = () => {
    reviewInFlightRef.current = null;
    setReviewInFlight(null);
  };

  const onReviewSituation = async () => {
    if (!beginReview("situation")) return;
    setEphemeral(null);
    const baselineAt = recordAt(situation?.current);
    try {
      const data = await requestWatchdogOverseerReview();
      const record = asRecord(data?.result?.record);
      if (record) setEphemeral(record);
      if (data?.result?.persisted === false) {
        setReviewStatus({
          tone: "warning",
          text: data?.warning?.message || kOverseerReviewCopy.persistFailed,
          sinceAt: record ? recordAt(record) : baselineAt,
        });
      }
      const producedSituation = data?.result?.mode === "situation" && !!record;
      showToast(
        producedSituation ? kOverseerReviewCopy.situationReady : kOverseerReviewCopy.reviewFinished,
        "success",
      );
    } catch (error) {
      setReviewStatus(
        isNetworkError(error)
          ? { tone: "muted", text: kOverseerReviewCopy.connectionLost, sinceAt: baselineAt }
          : {
              tone: "error",
              text: error?.message || kOverseerReviewCopy.startFailed,
              error,
              sinceAt: baselineAt,
            },
      );
    } finally {
      endReview();
      // Force past dedupe so the stale `inFlight`/`pending` from the last
      // poll can't keep the button in "Reviewing..." for another 15s.
      void situationPoll.refresh({ force: true });
      // The report's audit event lands in the live incident's timeline.
      onRefreshIncidents();
    }
  };

  const onReviewIncident = async (incidentId) => {
    if (incidentId == null || !beginReview(incidentId)) return;
    try {
      const data = await requestWatchdogOverseerReview({ incidentId });
      if (data?.result?.persisted === false) {
        showToast(data?.warning?.message || kOverseerReviewCopy.persistFailed, "warning");
      } else {
        showToast(kOverseerReviewCopy.incidentRecorded(incidentId), "success");
      }
    } catch (error) {
      const networkError = isNetworkError(error);
      setIncidentReviewError({
        incidentId,
        error: networkError ? null : error,
        message: networkError
          ? kOverseerReviewCopy.connectionLost
          : error?.message || kOverseerReviewCopy.startFailed,
      });
    } finally {
      endReview();
      // The verdict chip on the row updates immediately (DD15).
      onRefreshIncidents();
      // The server's review mutex is shared: the last situation poll may still
      // say inFlight=true, which would hold the header button in "Reviewing..."
      // until the next 15s tick.
      void situationPoll.refresh({ force: true });
    }
  };

  const newestAt = newestReportAt({ incidents, situation, ephemeral });
  const primaryKind =
    primaryPin && primaryPin.newestAt === newestAt ? primaryPin.kind : "auto";
  const onSelectPrimaryKind = (kind) =>
    setPrimaryPin(!kind || kind === "auto" ? null : { kind, newestAt });

  return {
    enabled,
    availability,
    settingsLoaded,
    saving,
    onToggle,
    // The SavedToggle in the card reads hydration/saving/error state from here.
    setting,
    situation,
    situationError: situationPoll.error,
    reviewInFlight,
    ephemeral,
    reviewStatus,
    incidentReviewError,
    primaryKind,
    onSelectPrimaryKind,
    onReviewSituation,
    onReviewIncident,
  };
};

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
  const overseer = useWatchdogOverseer({
    incidents: incidents.incidents,
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
    overseer,
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

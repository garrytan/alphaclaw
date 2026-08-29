import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "preact/hooks";
import { usePolling } from "../../hooks/usePolling.js";
import { useDestinationSessionSelection } from "../../hooks/use-destination-session-selection.js";
import {
  fetchCronBulkRuns,
  fetchCronBulkUsage,
  fetchCronJobRuns,
  fetchCronJobTrends,
  fetchCronJobs,
  fetchCronJobUsage,
  fetchCronStatus,
  setCronJobEnabled,
  triggerCronJobRun,
  updateCronJobPrompt,
  updateCronJobRouting,
} from "../../lib/api.js";
import { readUiSettings, writeUiSettings } from "../../lib/ui-settings.js";
import {
  getDestinationFromSession,
  getSessionRowKey,
} from "../../lib/session-keys.js";
import { showToast } from "../toast.js";
import { kAllCronJobsRouteKey, readCronJobPrompt } from "./cron-helpers.js";

const kDefaultListPanelWidthPx = 372;
const kListPanelMinWidthPx = 220;
const kListPanelMaxWidthPx = 480;
const kListPanelWidthUiSettingKey = "cronListPanelWidthPx";
const kRunsPageSize = 25;
const kCalendarUsageDays = 30;
const kCalendarPastDays = 30;
const kTrendRange24h = "24h";
const kTrendRange7d = "7d";
const kTrendRange30d = "30d";
const kRoutingDefaults = {
  sessionTarget: "main",
  wakeMode: "now",
  deliveryMode: "none",
  deliveryChannel: "",
  deliveryTo: "",
};
const readRoutingDraftFromJob = (job = null) => ({
  sessionTarget: String(job?.sessionTarget || kRoutingDefaults.sessionTarget),
  wakeMode: String(job?.wakeMode || kRoutingDefaults.wakeMode),
  deliveryMode: String(job?.delivery?.mode || kRoutingDefaults.deliveryMode),
  deliveryChannel: String(job?.delivery?.channel || ""),
  deliveryTo: String(job?.delivery?.to || ""),
});

const isSameRoutingDraft = (left = {}, right = {}) =>
  String(left?.sessionTarget || "") === String(right?.sessionTarget || "") &&
  String(left?.wakeMode || "") === String(right?.wakeMode || "") &&
  String(left?.deliveryMode || "") === String(right?.deliveryMode || "") &&
  String(left?.deliveryChannel || "") === String(right?.deliveryChannel || "") &&
  String(left?.deliveryTo || "") === String(right?.deliveryTo || "");

// Single source of truth for "does the routing draft differ from the job's
// saved routing" — delivery channel/to included (omitting them hid dirty
// delivery edits from the Save button). Empty channel/to are meaningful
// (delivery "none" clears them), so they only fall back when the draft
// leaves them undefined.
export const isRoutingDirty = (routingDraft = null, job = null) => {
  const current = readRoutingDraftFromJob(job);
  return !isSameRoutingDraft(
    {
      sessionTarget: String(routingDraft?.sessionTarget || current.sessionTarget),
      wakeMode: String(routingDraft?.wakeMode || current.wakeMode),
      deliveryMode: String(routingDraft?.deliveryMode || current.deliveryMode),
      deliveryChannel: String(routingDraft?.deliveryChannel ?? current.deliveryChannel),
      deliveryTo: String(routingDraft?.deliveryTo ?? current.deliveryTo),
    },
    current,
  );
};

const clampListPanelWidth = (value) =>
  Math.max(kListPanelMinWidthPx, Math.min(kListPanelMaxWidthPx, value));

const normalizeRouteJobId = (jobId = "") => {
  const normalized = String(jobId || "").trim();
  return normalized || kAllCronJobsRouteKey;
};

export const useCronTab = ({ jobId = "", onSetLocation = () => {} } = {}) => {
  const selectedRouteKey = normalizeRouteJobId(jobId);
  const selectedJobId =
    selectedRouteKey === kAllCronJobsRouteKey ? "" : selectedRouteKey;
  const listPanelRef = useRef(null);
  const [listPanelWidthPx, setListPanelWidthPx] = useState(() => {
    const settings = readUiSettings();
    if (!Number.isFinite(settings?.[kListPanelWidthUiSettingKey])) {
      return kDefaultListPanelWidthPx;
    }
    return clampListPanelWidth(settings[kListPanelWidthUiSettingKey]);
  });
  const [isResizingListPanel, setIsResizingListPanel] = useState(false);
  const [runStatusFilter, setRunStatusFilter] = useState("all");
  const [runEntries, setRunEntries] = useState([]);
  const [runHasMore, setRunHasMore] = useState(false);
  const [runNextOffset, setRunNextOffset] = useState(0);
  const [runTotal, setRunTotal] = useState(0);
  const [loadingMoreRuns, setLoadingMoreRuns] = useState(false);
  // Identity of the run list currently on screen; a Load More response is
  // discarded when the job or filter changed while it was in flight.
  const activeRunsQueryRef = useRef("");
  activeRunsQueryRef.current = `${selectedJobId}\u0000${runStatusFilter}`;
  const [promptValue, setPromptValue] = useState("");
  const [savedPromptValue, setSavedPromptValue] = useState("");
  const [savingChanges, setSavingChanges] = useState(false);
  const [runningJob, setRunningJob] = useState(false);
  const [togglingJobEnabled, setTogglingJobEnabled] = useState(false);
  // Optimistic enable/disable: { jobId, value, saving }. The override wins
  // over polled job data while the save is in flight AND until a poll
  // reports the committed value back, so a snapshot dispatched before the
  // mutation can never clobber the toggle.
  const [enabledOverride, setEnabledOverride] = useState(null);
  const [enableSaveError, setEnableSaveError] = useState(null);
  const enableTokenRef = useRef(0);
  const togglingRef = useRef(false);
  const [routingDraft, setRoutingDraft] = useState(kRoutingDefaults);
  const [usageDays, setUsageDays] = useState(30);
  const [jobTrendRange, setJobTrendRange] = useState(kTrendRange7d);
  const [selectedJobTrendBucketFilter, setSelectedJobTrendBucketFilter] = useState(null);
  const {
    sessions: deliverySessions,
    loading: loadingDeliverySessions,
    error: deliverySessionsError,
    destinationSessionKey,
    setDestinationSessionKey,
    selectedDestination,
  } = useDestinationSessionSelection({
    enabled: !!selectedJobId,
    resetKey: String(selectedJobId || ""),
  });

  const jobsPoll = usePolling(
    () => fetchCronJobs({ sortBy: "nextRunAtMs", sortDir: "asc" }),
    15000,
  );
  const statusPoll = usePolling(fetchCronStatus, 30000);
  // Poll refetches everything paged in so far, not just page 1 — otherwise
  // each tick would wipe the pages Load More appended.
  const runEntriesCountRef = useRef(0);
  const runsPoll = usePolling(
    () => {
      if (!selectedJobId) {
        return Promise.resolve({
          ok: true,
          runs: { entries: [], hasMore: false, nextOffset: 0 },
        });
      }
      return fetchCronJobRuns(selectedJobId, {
        limit: Math.max(kRunsPageSize, runEntriesCountRef.current),
        offset: 0,
        status: runStatusFilter,
        sortDir: "desc",
      });
    },
    10000,
    { enabled: !!selectedJobId },
  );
  const usagePoll = usePolling(
    () => {
      if (!selectedJobId) return Promise.resolve({ ok: true, usage: null });
      return fetchCronJobUsage(selectedJobId, { days: usageDays });
    },
    60000,
    { enabled: !!selectedJobId },
  );
  const trendsPoll = usePolling(
    () => {
      if (!selectedJobId) return Promise.resolve({ ok: true, trends: null });
      return fetchCronJobTrends(selectedJobId, { range: jobTrendRange });
    },
    60000,
    { enabled: !!selectedJobId },
  );
  const bulkUsagePoll = usePolling(
    () => fetchCronBulkUsage({ days: kCalendarUsageDays }),
    60000,
    { enabled: !selectedJobId },
  );
  const bulkRunsPoll = usePolling(
    () =>
      fetchCronBulkRuns({
        sinceMs: Date.now() - kCalendarPastDays * 24 * 60 * 60 * 1000,
        limitPerJob: 1200,
      }),
    30000,
    { enabled: !selectedJobId },
  );

  useEffect(() => {
    const settings = readUiSettings();
    settings[kListPanelWidthUiSettingKey] = listPanelWidthPx;
    writeUiSettings(settings);
  }, [listPanelWidthPx]);

  useEffect(() => {
    if (!runsPoll.data?.runs) return;
    const incomingEntries = Array.isArray(runsPoll.data.runs.entries)
      ? runsPoll.data.runs.entries
      : [];
    // A poll dispatched before Load More appended returns a truncated prefix
    // of what is already on screen — hasMore distinguishes truncation from a
    // genuinely shrunken history, so only the former is skipped.
    if (
      runsPoll.data.runs.hasMore &&
      incomingEntries.length < runEntriesCountRef.current
    ) {
      return;
    }
    runEntriesCountRef.current = incomingEntries.length;
    setRunEntries(incomingEntries);
    setRunHasMore(!!runsPoll.data.runs.hasMore);
    setRunNextOffset(Number(runsPoll.data.runs.nextOffset || 0));
    setRunTotal(Number(runsPoll.data.runs.total || 0));
  }, [runsPoll.data]);

  const jobs = useMemo(
    () => (Array.isArray(jobsPoll.data?.jobs) ? jobsPoll.data.jobs : []),
    [jobsPoll.data],
  );

  const selectedJob = useMemo(
    () => jobs.find((job) => String(job?.id || "") === selectedJobId) || null,
    [jobs, selectedJobId],
  );
  const selectedJobPrompt = readCronJobPrompt(selectedJob);

  const selectedJobEnabled =
    enabledOverride && enabledOverride.jobId === selectedJobId
      ? enabledOverride.value
      : selectedJob?.enabled !== false;

  // Drop the override only once the poll reports the committed value back;
  // from then on external changes show through again.
  useEffect(() => {
    if (!enabledOverride || enabledOverride.saving) return;
    const overriddenJob = jobs.find(
      (job) => String(job?.id || "") === enabledOverride.jobId,
    );
    if (!overriddenJob) return;
    if ((overriddenJob.enabled !== false) === enabledOverride.value) {
      setEnabledOverride(null);
    }
  }, [jobs, enabledOverride]);

  useEffect(() => {
    enableTokenRef.current += 1; // in-flight toggles from the old job go stale
    togglingRef.current = false;
    setEnabledOverride(null);
    setEnableSaveError(null);
    setTogglingJobEnabled(false);
  }, [selectedJobId]);

  // Prompt seed/merge: a poll refresh may not clobber an unsaved draft
  // (draft !== last saved baseline); the baseline still advances so the
  // dirty indicator stays truthful. A job switch always reseeds.
  const lastSeededPromptJobIdRef = useRef("");
  useEffect(() => {
    if (!selectedJobId) {
      lastSeededPromptJobIdRef.current = "";
      setPromptValue("");
      setSavedPromptValue("");
      return;
    }
    const isNewJob = lastSeededPromptJobIdRef.current !== selectedJobId;
    lastSeededPromptJobIdRef.current = selectedJobId;
    const prompt = selectedJobPrompt;
    const promptDirty = !isNewJob && promptValue !== savedPromptValue;
    setSavedPromptValue(prompt);
    if (!promptDirty) setPromptValue(prompt);
  }, [selectedJobId, selectedJobPrompt]);

  // Routing seed/merge: same dirty-check merge, keyed off the job's saved
  // routing fields (delivery channel/to included).
  const lastSeededRoutingJobIdRef = useRef("");
  const lastSeededRoutingRef = useRef(null);
  useEffect(() => {
    if (!selectedJobId) {
      lastSeededRoutingJobIdRef.current = "";
      lastSeededRoutingRef.current = null;
      setRoutingDraft(kRoutingDefaults);
      return;
    }
    const nextBaseline = readRoutingDraftFromJob(selectedJob);
    const isNewJob = lastSeededRoutingJobIdRef.current !== selectedJobId;
    lastSeededRoutingJobIdRef.current = selectedJobId;
    const previousBaseline = lastSeededRoutingRef.current;
    lastSeededRoutingRef.current = nextBaseline;
    const draftDirty =
      !isNewJob &&
      previousBaseline !== null &&
      !isSameRoutingDraft(routingDraft, previousBaseline);
    if (!draftDirty) setRoutingDraft(nextBaseline);
  }, [
    selectedJobId,
    selectedJob?.sessionTarget,
    selectedJob?.wakeMode,
    selectedJob?.delivery?.mode,
    selectedJob?.delivery?.channel,
    selectedJob?.delivery?.to,
  ]);

  // "" → jobId enables the poll, and usePolling refreshes on enable — a
  // manual refresh there would double-fetch. Only refresh when an already-
  // enabled poll needs new params (job switch, filter/range change).
  const prevRunsSelectedJobIdRef = useRef("");
  useEffect(() => {
    const previousSelectedJobId = prevRunsSelectedJobIdRef.current;
    prevRunsSelectedJobIdRef.current = selectedJobId;
    runEntriesCountRef.current = 0;
    setRunEntries([]);
    setRunHasMore(false);
    setRunNextOffset(0);
    setRunTotal(0);
    if (!selectedJobId) return;
    if (!previousSelectedJobId) return;
    runsPoll.refresh();
  }, [selectedJobId, runStatusFilter]);

  const prevUsageSelectedJobIdRef = useRef("");
  useEffect(() => {
    const previousSelectedJobId = prevUsageSelectedJobIdRef.current;
    prevUsageSelectedJobIdRef.current = selectedJobId;
    if (!selectedJobId) return;
    if (!previousSelectedJobId) return;
    usagePoll.refresh();
  }, [selectedJobId, usageDays]);
  const prevTrendsSelectedJobIdRef = useRef("");
  useEffect(() => {
    const previousSelectedJobId = prevTrendsSelectedJobIdRef.current;
    prevTrendsSelectedJobIdRef.current = selectedJobId;
    if (!selectedJobId) return;
    setSelectedJobTrendBucketFilter(null);
    if (!previousSelectedJobId) return;
    trendsPoll.refresh();
  }, [jobTrendRange, selectedJobId]);
  const filteredRunEntries = useMemo(() => {
    const entries = Array.isArray(runEntries) ? runEntries : [];
    const filterValue = selectedJobTrendBucketFilter;
    if (!filterValue) return entries;
    const startMs = Number(filterValue?.startMs || 0);
    const endMs = Number(filterValue?.endMs || 0);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
      return entries;
    }
    return entries.filter((entry) => {
      const timestampMs = Number(entry?.ts || 0);
      return (
        Number.isFinite(timestampMs) &&
        timestampMs >= startMs &&
        timestampMs < endMs
      );
    });
  }, [runEntries, selectedJobTrendBucketFilter]);

  const resizeListPanelWithClientX = useCallback((clientX) => {
    const listPanelElement = listPanelRef.current;
    if (!listPanelElement) return;
    const parentBounds =
      listPanelElement.parentElement?.getBoundingClientRect();
    if (!parentBounds) return;
    const nextWidth = clampListPanelWidth(
      Math.round(clientX - parentBounds.left),
    );
    setListPanelWidthPx(nextWidth);
  }, []);

  const onListResizerPointerDown = useCallback(
    (event) => {
      event.preventDefault();
      setIsResizingListPanel(true);
      resizeListPanelWithClientX(event.clientX);
    },
    [resizeListPanelWithClientX],
  );

  useEffect(() => {
    if (!isResizingListPanel) return () => {};
    const onPointerMove = (event) => resizeListPanelWithClientX(event.clientX);
    const onPointerUp = () => setIsResizingListPanel(false);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
    };
  }, [isResizingListPanel, resizeListPanelWithClientX]);

  const selectAllJobs = useCallback(() => {
    onSetLocation("/cron");
  }, [onSetLocation]);

  const selectJob = useCallback(
    (nextJobId) => {
      onSetLocation(`/cron/${encodeURIComponent(String(nextJobId || ""))}`);
    },
    [onSetLocation],
  );

  const refreshAll = useCallback(() => {
    jobsPoll.refresh();
    statusPoll.refresh();
    runsPoll.refresh();
    usagePoll.refresh();
    trendsPoll.refresh();
    bulkUsagePoll.refresh();
    bulkRunsPoll.refresh();
  }, [
    bulkRunsPoll.refresh,
    bulkUsagePoll.refresh,
    jobsPoll.refresh,
    runsPoll.refresh,
    statusPoll.refresh,
    trendsPoll.refresh,
    usagePoll.refresh,
  ]);

  const runSelectedJobNow = useCallback(async () => {
    if (!selectedJobId || runningJob) return;
    setRunningJob(true);
    try {
      await triggerCronJobRun(selectedJobId);
      showToast("Cron run triggered", "success");
      refreshAll();
    } catch (error) {
      showToast(error.message || "Could not run cron job", "error");
    } finally {
      setRunningJob(false);
    }
  }, [refreshAll, runningJob, selectedJobId]);

  const setSelectedJobEnabled = useCallback(
    async (enabled) => {
      if (!selectedJobId || togglingRef.current) return;
      togglingRef.current = true;
      const jobId = selectedJobId;
      const token = ++enableTokenRef.current;
      setEnabledOverride({ jobId, value: enabled, saving: true });
      setEnableSaveError(null);
      setTogglingJobEnabled(true);
      try {
        await setCronJobEnabled(jobId, enabled);
        if (enableTokenRef.current !== token) return;
        // Hold the committed value until the poll confirms it (see the
        // converge effect) — never let a pre-mutation snapshot flip it back.
        setEnabledOverride({ jobId, value: enabled, saving: false });
        showToast(
          enabled ? "Cron job enabled" : "Cron job disabled",
          "success",
        );
        jobsPoll.refresh();
        statusPoll.refresh();
      } catch (error) {
        if (enableTokenRef.current !== token) return;
        // Loud revert: back to the server's value + persistent inline chip;
        // reconcile because the rejection does not prove the write failed.
        setEnabledOverride(null);
        setEnableSaveError({ attempted: enabled, error });
        jobsPoll.refresh();
      } finally {
        if (enableTokenRef.current === token) {
          togglingRef.current = false;
          setTogglingJobEnabled(false);
        }
      }
    },
    [jobsPoll.refresh, statusPoll.refresh, selectedJobId],
  );

  const loadMoreRuns = useCallback(async () => {
    if (!selectedJobId || !runHasMore || loadingMoreRuns) return;
    // Token: a response for another job/filter must not append into the
    // current list.
    const dispatchedRunsQuery = activeRunsQueryRef.current;
    setLoadingMoreRuns(true);
    try {
      const data = await fetchCronJobRuns(selectedJobId, {
        limit: kRunsPageSize,
        offset: runNextOffset,
        status: runStatusFilter,
        sortDir: "desc",
      });
      if (activeRunsQueryRef.current !== dispatchedRunsQuery) return;
      const nextEntries = Array.isArray(data?.runs?.entries)
        ? data.runs.entries
        : [];
      setRunEntries((currentValue) => {
        const merged = [...currentValue, ...nextEntries];
        runEntriesCountRef.current = merged.length;
        return merged;
      });
      setRunHasMore(!!data?.runs?.hasMore);
      setRunNextOffset(Number(data?.runs?.nextOffset || 0));
      setRunTotal(Number(data?.runs?.total || 0));
    } catch (error) {
      if (activeRunsQueryRef.current !== dispatchedRunsQuery) return;
      showToast(error.message || "Could not load more runs", "error");
    } finally {
      setLoadingMoreRuns(false);
    }
  }, [
    loadingMoreRuns,
    runHasMore,
    runNextOffset,
    runStatusFilter,
    selectedJobId,
  ]);

  const saveChanges = useCallback(async () => {
    if (!selectedJobId || !selectedJob || savingChanges) return;
    const nextRouting = {
      sessionTarget: String(routingDraft?.sessionTarget || kRoutingDefaults.sessionTarget),
      wakeMode: String(routingDraft?.wakeMode || kRoutingDefaults.wakeMode),
      deliveryMode: String(routingDraft?.deliveryMode || kRoutingDefaults.deliveryMode),
      deliveryChannel: String(routingDraft?.deliveryChannel || ""),
      deliveryTo: String(routingDraft?.deliveryTo || ""),
    };
    const routingUnchanged = !isRoutingDirty(routingDraft, selectedJob);
    const promptUnchanged = promptValue === savedPromptValue;
    if (routingUnchanged && promptUnchanged) return;
    setSavingChanges(true);
    try {
      if (!routingUnchanged) {
        await updateCronJobRouting(selectedJobId, nextRouting);
      }
      if (!promptUnchanged) {
        await updateCronJobPrompt(selectedJobId, promptValue);
        setSavedPromptValue(promptValue);
      }
      showToast("Changes saved", "success");
      refreshAll();
    } catch (error) {
      showToast(error.message || "Could not save changes", "error");
    } finally {
      setSavingChanges(false);
    }
  }, [
    promptValue,
    refreshAll,
    routingDraft,
    savedPromptValue,
    savingChanges,
    selectedJob,
    selectedJobId,
  ]);

  // The destination select must open on the job's SAVED destination — never
  // the global preferred session (that default is what used to clobber saved
  // delivery), and the draft-rewrite below only runs after the user picks a
  // session by hand.
  const [
    hasManualDestinationSelection,
    setHasManualDestinationSelection,
  ] = useState(false);
  useEffect(() => {
    setHasManualDestinationSelection(false);
  }, [selectedJobId]);

  const savedDeliveryDestinationKey = useMemo(() => {
    if (String(selectedJob?.delivery?.mode || "none") !== "announce") return "";
    const savedChannel = String(selectedJob?.delivery?.channel || "").trim();
    const savedTo = String(selectedJob?.delivery?.to || "").trim();
    if (!savedChannel || !savedTo) return "";
    const matchingSession = (
      Array.isArray(deliverySessions) ? deliverySessions : []
    ).find((sessionRow) => {
      const destination = getDestinationFromSession(sessionRow);
      return (
        destination?.channel === savedChannel && destination?.to === savedTo
      );
    });
    return matchingSession ? getSessionRowKey(matchingSession) : "";
  }, [
    deliverySessions,
    selectedJob?.delivery?.mode,
    selectedJob?.delivery?.channel,
    selectedJob?.delivery?.to,
  ]);

  const effectiveDestinationSessionKey = hasManualDestinationSelection
    ? destinationSessionKey
    : savedDeliveryDestinationKey;

  const selectDestinationSessionKey = useCallback(
    (key) => {
      setHasManualDestinationSelection(true);
      setDestinationSessionKey(key);
    },
    [setDestinationSessionKey],
  );

  useEffect(() => {
    if (!selectedJobId) return;
    if (!hasManualDestinationSelection) return;
    if (String(routingDraft?.deliveryMode || "none") !== "announce") return;
    if (!selectedDestination?.channel && !selectedDestination?.to) return;
    setRoutingDraft((currentValue = kRoutingDefaults) => {
      const nextChannel = String(selectedDestination?.channel || currentValue.deliveryChannel || "");
      const nextTo = String(selectedDestination?.to || currentValue.deliveryTo || "");
      if (
        nextChannel === String(currentValue.deliveryChannel || "") &&
        nextTo === String(currentValue.deliveryTo || "")
      ) {
        return currentValue;
      }
      return {
        ...currentValue,
        deliveryChannel: nextChannel,
        deliveryTo: nextTo,
      };
    });
  }, [
    hasManualDestinationSelection,
    routingDraft?.deliveryMode,
    selectedDestination?.channel,
    selectedDestination?.to,
    selectedJobId,
  ]);

  return {
    refs: {
      listPanelRef,
    },
    state: {
      jobs,
      hasLoadedJobs: jobsPoll.data !== null,
      jobsError: jobsPoll.error,
      status: statusPoll.data?.status || null,
      statusError: statusPoll.error,
      selectedRouteKey,
      selectedJobId,
      selectedJob,
      listPanelWidthPx,
      isResizingListPanel,
      runEntries,
      filteredRunEntries,
      runHasMore,
      runNextOffset,
      runTotal,
      runStatusFilter,
      runsError: runsPoll.error,
      loadingMoreRuns,
      usage: usagePoll.data?.usage || null,
      jobTrends: trendsPoll.data?.trends || null,
      usageError: usagePoll.error,
      trendsError: trendsPoll.error,
      usageDays,
      jobTrendRange:
        jobTrendRange === kTrendRange30d
          ? kTrendRange30d
          : jobTrendRange === kTrendRange24h
            ? kTrendRange24h
            : kTrendRange7d,
      selectedJobTrendBucketFilter,
      bulkUsageByJobId: bulkUsagePoll.data?.usage?.byJobId || {},
      bulkUsageError: bulkUsagePoll.error,
      bulkRunsByJobId: bulkRunsPoll.data?.runs?.byJobId || {},
      bulkRunsError: bulkRunsPoll.error,
      promptValue,
      savedPromptValue,
      savingChanges,
      runningJob,
      togglingJobEnabled,
      selectedJobEnabled,
      enableSaveError,
      routingDraft,
      deliverySessions,
      loadingDeliverySessions,
      deliverySessionsError,
      destinationSessionKey: effectiveDestinationSessionKey,
    },
    actions: {
      setRunStatusFilter,
      setUsageDays,
      setJobTrendRange,
      setSelectedJobTrendBucketFilter,
      setPromptValue,
      saveChanges,
      refreshAll,
      loadMoreRuns,
      runSelectedJobNow,
      setSelectedJobEnabled,
      selectAllJobs,
      selectJob,
      onListResizerPointerDown,
      setRoutingDraft,
      setDestinationSessionKey: selectDestinationSessionKey,
    },
  };
};

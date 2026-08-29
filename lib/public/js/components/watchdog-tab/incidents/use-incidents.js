import { useEffect, useRef, useState } from "preact/hooks";
import { usePolling } from "../../../hooks/usePolling.js";
import {
  fetchWatchdogEvents,
  fetchWatchdogIncidentDetail,
  fetchWatchdogIncidents,
} from "../../../lib/api.js";
import { showToast } from "../../toast.js";
import { mergeIncidentPages, parseIncidentAnchor } from "./helpers.js";

export const kIncidentsTabIncidents = "incidents";
export const kIncidentsTabEvents = "events";

const kIncidentsPageSize = 10;

export const useWatchdogIncidents = ({
  restartSignal = 0,
  onRefreshStatuses = () => {},
} = {}) => {
  const [activeTab, setActiveTab] = useState(kIncidentsTabIncidents);
  const [includeRoutine, setIncludeRoutine] = useState(false);
  // Older pages loaded via "Load more"; the polling first page merges over
  // them by id, so a refresh never duplicates or drops rows.
  const [olderPages, setOlderPages] = useState([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  // Fetched-on-expand event timelines, keyed by incident id.
  const [detailById, setDetailById] = useState({});
  // Deep-link arrival (`/#/watchdog?incident=<id>`): expand + highlight.
  const [highlightIncidentId, setHighlightIncidentId] = useState(null);
  const [expandedIds, setExpandedIds] = useState({});

  // The poll's limit grows to cover every page loaded via "Load more" (capped
  // at the server max of 50): a sliding newest-N first page + frozen older
  // pages would otherwise open an id gap after new incidents arrive. Beyond
  // 50 loaded, dedup-by-id still protects against duplicates.
  const pollLimit = Math.min(50, kIncidentsPageSize * (1 + olderPages.length));
  const incidentsPoll = usePolling(
    () => fetchWatchdogIncidents({ limit: pollLimit }),
    15000,
    {
      cacheKey: `/api/watchdog/incidents?limit=${pollLimit}`,
      dedupeInFlight: true,
    },
  );
  const eventsPoll = usePolling(
    () => fetchWatchdogEvents(20, { includeRoutine }),
    15000,
    {
      cacheKey: `/api/watchdog/events?limit=20&includeRoutine=${includeRoutine ? "1" : "0"}`,
      enabled: activeTab === kIncidentsTabEvents,
      dedupeInFlight: true,
    },
  );

  // Deep-linked incidents older than every loaded page still render: the
  // direct detail fetch's incident row joins the DISPLAY merge (dedup by id).
  // Pagination must NOT see it — a load-more cursor derived from an old
  // anchored row would silently skip every incident between the loaded pages
  // and the anchor.
  const anchoredIncident =
    highlightIncidentId != null
      ? detailById[highlightIncidentId]?.incident
      : null;
  const firstPage = incidentsPoll.data?.incidents || [];
  const pagedIncidents = mergeIncidentPages([firstPage, ...olderPages]);
  const incidents = mergeIncidentPages([
    firstPage,
    ...olderPages,
    anchoredIncident ? [anchoredIncident] : [],
  ]);
  // Server-declared next-page indicator (with the local pollLimit heuristic
  // as a belt for older responses that lack it).
  const exhaustedByPoll =
    incidentsPoll.data?.hasMore === false ||
    (Array.isArray(incidentsPoll.data?.incidents) && firstPage.length < pollLimit);

  const loadIncidentDetail = async (incidentId, { force = false } = {}) => {
    if (detailById[incidentId]?.loading) return;
    if (!force && detailById[incidentId]?.loaded) return;
    setDetailById((current) => ({
      ...current,
      [incidentId]: { loading: true },
    }));
    try {
      const data = await fetchWatchdogIncidentDetail(incidentId);
      setDetailById((current) => ({
        ...current,
        [incidentId]: {
          loaded: true,
          events: data.events || [],
          truncated: !!data.truncated,
          omittedCount: Number(data.omittedCount) || 0,
          incident: data.incident || null,
        },
      }));
    } catch (error) {
      setDetailById((current) => ({
        ...current,
        [incidentId]: { error: error.message || "Could not load incident" },
      }));
    }
  };

  const onToggleIncident = (incidentId, expanded) => {
    setExpandedIds((current) => ({ ...current, [incidentId]: expanded }));
    // An OPEN incident's timeline keeps accruing events — refetch on every
    // expand so the cached first load can't freeze an ongoing story.
    const isOpen = incidents.some(
      (incident) => incident.id === incidentId && incident.status === "open",
    );
    if (expanded) void loadIncidentDetail(incidentId, { force: isOpen });
  };

  // Synchronous in-flight guard: two clicks in the same tick both see the
  // stale loadingMore render closure — the ref blocks the duplicate fetch.
  const loadingMoreRef = useRef(false);
  const onLoadMore = async () => {
    if (loadingMoreRef.current || !pagedIncidents.length) return;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      // Cursor from the PAGED list only — never the deep-link anchor row.
      const oldestId = pagedIncidents[pagedIncidents.length - 1].id;
      const data = await fetchWatchdogIncidents({
        limit: kIncidentsPageSize,
        before: oldestId,
      });
      const page = data.incidents || [];
      setOlderPages((pages) => [...pages, page]);
      if (data.hasMore === false || page.length < kIncidentsPageSize) {
        setHasMore(false);
      }
    } catch (error) {
      showToast(error.message || "Could not load more incidents", "error");
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  };

  // Pagination hole detection: the poll's first page is capped at 50; if
  // enough new incidents land mid-session, the ids between the polled window
  // and the frozen older pages were never fetched. oldestPolled > newestCached
  // is an exact disjointness test — reset the cache so paging restarts from
  // the fresh window (no false resets on overlap).
  useEffect(() => {
    const oldestPolled = firstPage[firstPage.length - 1]?.id;
    const newestCached = olderPages[0]?.[0]?.id;
    if (
      Number.isInteger(oldestPolled) &&
      Number.isInteger(newestCached) &&
      oldestPolled > newestCached
    ) {
      setOlderPages([]);
      setHasMore(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incidentsPoll.data]);

  // Deep-link arrival: parse once on mount; a direct detail fetch bypasses
  // pagination so the anchor works however deep the incident is.
  useEffect(() => {
    const anchorId = parseIncidentAnchor(
      typeof window !== "undefined" ? window.location.hash : "",
    );
    if (!anchorId) return;
    setActiveTab(kIncidentsTabIncidents);
    setHighlightIncidentId(anchorId);
    setExpandedIds((current) => ({ ...current, [anchorId]: true }));
    void loadIncidentDetail(anchorId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Guard on the SIGNAL VALUE, not effect identity: incidentsPoll.refresh
  // changes identity whenever pollLimit grows (cacheKey), and without the ref
  // every "Load more" after a restart would replay the refresh burst.
  const lastRestartSignalRef = useRef(0);
  useEffect(() => {
    if (!restartSignal || lastRestartSignalRef.current === restartSignal) return;
    lastRestartSignalRef.current = restartSignal;
    onRefreshStatuses();
    incidentsPoll.refresh();
    eventsPoll.refresh();
    const t1 = setTimeout(() => {
      onRefreshStatuses();
      incidentsPoll.refresh();
      eventsPoll.refresh();
    }, 1200);
    const t2 = setTimeout(() => {
      onRefreshStatuses();
      incidentsPoll.refresh();
      eventsPoll.refresh();
    }, 3500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [restartSignal, onRefreshStatuses, incidentsPoll.refresh, eventsPoll.refresh]);

  // Manual refresh covers both feeds — refresh() runs even while a poll's
  // interval is disabled (inactive tab), so the other tab is warm on switch.
  const refreshAll = () =>
    Promise.all([incidentsPoll.refresh(), eventsPoll.refresh()]);

  return {
    activeTab,
    setActiveTab,
    incidents,
    incidentsLoaded: !!incidentsPoll.data,
    incidentsError: incidentsPoll.error,
    detailById,
    expandedIds,
    onToggleIncident,
    onLoadMore,
    loadingMore,
    hasMore: hasMore && !exhaustedByPoll,
    highlightIncidentId,
    events: eventsPoll.data?.events || [],
    includeRoutine,
    setIncludeRoutine,
    // Loaded/error travel separately so a failed fetch never renders as a
    // confident "No incidents recorded." — the card distinguishes loading,
    // error (+Retry), stale-with-error, and genuinely empty.
    eventsLoaded: !!eventsPoll.data,
    eventsError: eventsPoll.error,
    refreshingEvents: eventsPoll.isPolling,
    refreshing: incidentsPoll.isPolling || eventsPoll.isPolling,
    refreshEvents: refreshAll,
  };
};

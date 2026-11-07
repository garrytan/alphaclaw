import { useEffect, useRef, useState } from "preact/hooks";
import { usePolling } from "../../hooks/usePolling.js";
import { fetchRelayConversation, fetchRelayConversations } from "../../lib/api.js";

const kEmptyFilters = { q: "", agent: "", from: "", to: "" };

const filterQuery = (filters) =>
  Object.entries(filters)
    .filter(([, value]) => value)
    .map(([key, value]) => key + "=" + encodeURIComponent(value))
    .join("&");

// A conversation id the engine knows. "session:" rows are relay sessions on
// the box whose engine messages retention already removed, so they have no
// relay log to read.
export const hasRelayLog = (item) => Boolean(item?.id) && !String(item.id).startsWith("session:");

// The conversations list for the Relay page, plus the relay log of at most
// one expanded row. The first page of each polls while the relay is ready
// (the log only while its row is expanded); older pages are loaded on
// request and kept until the filters or the expanded row change.
export const useRelayConversations = ({ ready = false } = {}) => {
  const [filters, setFilters] = useState(kEmptyFilters);
  const [olderItems, setOlderItems] = useState([]);
  const [listCursor, setListCursor] = useState(null);
  const [expandedId, setExpandedId] = useState("");
  const [olderMessages, setOlderMessages] = useState([]);
  const [logCursor, setLogCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(null);

  const listKey = "/api/relay/conversations?" + filterQuery(filters);
  // An older page answers for the filters and expanded row it was asked
  // for; one that lands after either changed is dropped.
  const currentRef = useRef({});
  currentRef.current = { listKey, expandedId };
  const listPoll = usePolling(() => fetchRelayConversations({ ...filters, limit: 50 }), 10000, { cacheKey: listKey, enabled: ready });
  const firstPage = listPoll.data?.conversations || [];
  useEffect(() => {
    setOlderItems([]);
    setListCursor(null);
  }, [listKey]);

  const logEnabled = ready && hasRelayLog({ id: expandedId });
  const logPoll = usePolling(() => fetchRelayConversation(expandedId), 10000, {
    cacheKey: "/api/relay/conversations/" + expandedId,
    enabled: logEnabled,
  });
  useEffect(() => {
    setOlderMessages([]);
    setLogCursor(null);
  }, [expandedId]);

  const seenIds = new Set(firstPage.map((item) => item.id));
  const conversations = [...firstPage, ...olderItems.filter((item) => !seenIds.has(item.id))];
  const nextListCursor = olderItems.length ? listCursor : listPoll.data?.nextBefore || null;

  const newestMessages = logEnabled ? logPoll.data?.messages || [] : [];
  const seenMessages = new Set(newestMessages.map((message) => message.id));
  const messages = [...olderMessages.filter((message) => !seenMessages.has(message.id)), ...newestMessages];
  const nextLogCursor = olderMessages.length ? logCursor : logPoll.data?.nextBefore || null;

  const runMore = async (task) => {
    setLoadingMore(true);
    setMoreError(null);
    try {
      await task();
    } catch (error) {
      setMoreError(error);
    } finally {
      setLoadingMore(false);
    }
  };

  return {
    filters,
    setFilters: (next) => setFilters({ ...kEmptyFilters, ...next }),
    conversations,
    agentName: listPoll.data?.agentName || null,
    listError: listPoll.error,
    listLoading: ready && !listPoll.data && !listPoll.error,
    hasMoreConversations: Boolean(nextListCursor),
    loadMoreConversations: () =>
      runMore(async () => {
        const page = await fetchRelayConversations({ ...filters, before: nextListCursor, limit: 50 });
        if (currentRef.current.listKey !== listKey) return;
        setOlderItems((previous) => [...previous, ...(page.conversations || [])]);
        setListCursor(page.nextBefore || null);
      }),
    expandedId,
    toggleLog: (id) => setExpandedId((current) => (current === id ? "" : id)),
    log: logEnabled
      ? {
          messages,
          loading: !logPoll.data && !logPoll.error,
          error: logPoll.error,
          hasEarlier: Boolean(nextLogCursor),
          loadingEarlier: loadingMore,
          loadEarlier: () =>
            runMore(async () => {
              const page = await fetchRelayConversation(expandedId, { before: nextLogCursor });
              if (currentRef.current.expandedId !== expandedId) return;
              setOlderMessages((previous) => [...(page.messages || []), ...previous]);
              setLogCursor(page.nextBefore || null);
            }),
        }
      : null,
    loadingMore,
    moreError,
    refresh: () => {
      listPoll.refresh();
      if (logEnabled) logPoll.refresh();
    },
  };
};

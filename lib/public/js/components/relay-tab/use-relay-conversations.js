import { useEffect, useRef, useState } from "preact/hooks";
import { usePolling } from "../../hooks/usePolling.js";
import { fetchRelayConversation, fetchRelayConversations } from "../../lib/api.js";

const kEmptyFilters = { q: "", agent: "", from: "", to: "" };

const filterQuery = (filters) =>
  Object.entries(filters)
    .filter(([, value]) => value)
    .map(([key, value]) => key + "=" + encodeURIComponent(value))
    .join("&");

// Conversations list and one open transcript for the Relay page. The first
// page of each polls while the relay is ready; older pages are loaded on
// request and kept until the filters or the selection change.
export const useRelayConversations = ({ ready = false } = {}) => {
  const [filters, setFilters] = useState(kEmptyFilters);
  const [olderItems, setOlderItems] = useState([]);
  const [listCursor, setListCursor] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [olderMessages, setOlderMessages] = useState([]);
  const [transcriptCursor, setTranscriptCursor] = useState(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(null);

  const listKey = "/api/relay/conversations?" + filterQuery(filters);
  // An older page answers for the filters and conversation it was asked for;
  // one that lands after either changed is dropped.
  const currentRef = useRef({});
  currentRef.current = { listKey, selectedId };
  const listPoll = usePolling(() => fetchRelayConversations({ ...filters, limit: 50 }), 10000, { cacheKey: listKey, enabled: ready });
  const firstPage = listPoll.data?.conversations || [];
  useEffect(() => {
    setOlderItems([]);
    setListCursor(null);
  }, [listKey]);

  const detailEnabled = ready && Boolean(selectedId) && !selectedId.startsWith("session:");
  const detailPoll = usePolling(() => fetchRelayConversation(selectedId), 10000, {
    cacheKey: "/api/relay/conversations/" + selectedId,
    enabled: detailEnabled,
  });
  useEffect(() => {
    setOlderMessages([]);
    setTranscriptCursor(null);
  }, [selectedId]);

  const seenIds = new Set(firstPage.map((item) => item.id));
  const conversations = [...firstPage, ...olderItems.filter((item) => !seenIds.has(item.id))];
  const nextListCursor = olderItems.length ? listCursor : listPoll.data?.nextBefore || null;

  const newestMessages = detailEnabled ? detailPoll.data?.messages || [] : [];
  const seenMessages = new Set(newestMessages.map((message) => message.id));
  const messages = [...olderMessages.filter((message) => !seenMessages.has(message.id)), ...newestMessages];
  const nextTranscriptCursor = olderMessages.length ? transcriptCursor : detailPoll.data?.nextBefore || null;

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
    selectedId,
    select: setSelectedId,
    selected: conversations.find((item) => item.id === selectedId) || null,
    transcript: detailEnabled ? { ...(detailPoll.data || {}), messages } : null,
    transcriptError: detailEnabled ? detailPoll.error : null,
    hasEarlierMessages: Boolean(nextTranscriptCursor),
    loadEarlierMessages: () =>
      runMore(async () => {
        const page = await fetchRelayConversation(selectedId, { before: nextTranscriptCursor });
        if (currentRef.current.selectedId !== selectedId) return;
        setOlderMessages((previous) => [...(page.messages || []), ...previous]);
        setTranscriptCursor(page.nextBefore || null);
      }),
    loadingMore,
    moreError,
    refresh: () => {
      listPoll.refresh();
      if (detailEnabled) detailPoll.refresh();
    },
  };
};

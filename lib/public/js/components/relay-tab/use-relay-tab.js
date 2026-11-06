import { usePolling } from "../../hooks/usePolling.js";
import { fetchRelayMessages, fetchRelayRuns, fetchRelayStatus } from "../../lib/api.js";

export const useRelayTab = () => {
  const statusPoll = usePolling(() => fetchRelayStatus(), 5000, { cacheKey: "/api/relay/status" });
  const runsPoll = usePolling(() => fetchRelayRuns({ limit: 50 }), 5000, { cacheKey: "/api/relay/runs?limit=50" });
  const ready = statusPoll.data?.phase === "ready";
  const messagesPoll = usePolling(() => fetchRelayMessages({ limit: 50 }), 10000, {
    cacheKey: "/api/relay/messages?limit=50",
    enabled: ready,
  });
  return {
    status: statusPoll.data || null,
    statusError: statusPoll.error,
    runs: runsPoll.data?.runs || [],
    runsError: runsPoll.error,
    messages: messagesPoll.data?.messages || [],
    messagesError: messagesPoll.error,
    refresh: () => {
      statusPoll.refresh();
      runsPoll.refresh();
      if (ready) messagesPoll.refresh();
    },
  };
};

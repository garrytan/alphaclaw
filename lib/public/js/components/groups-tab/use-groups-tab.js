import { usePolling } from "../../hooks/usePolling.js";
import { fetchTelegramGroups } from "../../lib/api.js";

export const useGroupsTab = ({ accountId = "default" } = {}) => {
  const cacheKey = "/api/telegram/groups?accountId=" + encodeURIComponent(accountId);
  const poll = usePolling(() => fetchTelegramGroups({ accountId }), 10000, { cacheKey });
  return {
    data: poll.data || null,
    error: poll.error || null,
    refresh: poll.refresh,
  };
};

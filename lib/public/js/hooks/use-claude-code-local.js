import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  cancelClaudeCodeLocalLogin,
  createClaudeCodeLocalSession,
  fetchClaudeCodeLocalTail,
  fetchClaudeCodeStatusDirect,
  logoutClaudeCodeLocal,
  startClaudeCodeLocalLogin,
  stopClaudeCodeLocalSession,
  submitClaudeCodeLocalLoginCode,
} from "../lib/api.js";
import { invalidateCache } from "../lib/api-cache.js";
import { kClaudeCodeStatusCacheKey } from "../lib/cache-keys.js";

// Fast poll while a transition the user is WATCHING is in flight (the setup
// modal's login phases, a starting spawn); slow steady-state poll otherwise.
const kIdlePollMs = 5_000;
const kActivePollMs = 1_000;

// Status + actions for the Watchdog rescue-session card and the guided-login
// setup modal. Deliberately polls the status endpoint DIRECTLY (E9): reading
// through useCachedFetch would show up-to-60s-stale local state mid-login.
// Every mutating action invalidates kClaudeCodeStatusCacheKey so the cached
// consumers (sidebar launcher tooltip/live-dot) refresh too, then re-polls.
export const useClaudeCodeLocal = ({ enabled = true } = {}) => {
  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  // Visibility pause parity with usePolling.js (whose API doesn't fit here:
  // the cadence derives from the polled data itself, and mutations need the
  // latest-request-wins refresh below). Reactive state, not a render-time
  // read of document.hidden, so mounting while hidden still starts polling
  // once the tab becomes visible.
  const [isDocumentVisible, setIsDocumentVisible] = useState(() =>
    typeof document === "undefined" ? true : !document.hidden,
  );
  const local = status?.local || null;
  const pollMs =
    local && (local.state === "login_in_progress" || local.state === "starting")
      ? kActivePollMs
      : kIdlePollMs;

  // Latest-request-wins: a slow poll resolving after a post-mutation refresh
  // must not paint the pre-mutation world back onto the card.
  const latestFetchIdRef = useRef(0);

  const refresh = useCallback(async () => {
    const fetchId = ++latestFetchIdRef.current;
    try {
      const data = await fetchClaudeCodeStatusDirect();
      if (latestFetchIdRef.current === fetchId) {
        setStatus(data);
        setStatusError(null);
      }
      return data;
    } catch (error) {
      if (latestFetchIdRef.current === fetchId) {
        setStatusError(error);
      }
      return null;
    }
  }, []);

  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    const handleVisibilityChange = () => {
      setIsDocumentVisible(!document.hidden);
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, []);

  // Hidden tabs pause the interval entirely; the effect re-running on the
  // visibility flip refreshes immediately on return.
  useEffect(() => {
    if (!enabled || !isDocumentVisible) return undefined;
    refresh();
    const intervalId = setInterval(refresh, pollMs);
    return () => clearInterval(intervalId);
  }, [enabled, pollMs, isDocumentVisible, refresh]);

  // Mutations: run → invalidate the shared cache key → refresh. Invalidation
  // happens in finally so even a refused/failing action re-syncs the card
  // (the server may have moved state before refusing, e.g. probe results).
  const runMutation = useCallback(
    async (action) => {
      try {
        return await action();
      } finally {
        invalidateCache(kClaudeCodeStatusCacheKey);
        await refresh();
      }
    },
    [refresh],
  );

  const start = useCallback(
    ({ confirmed = false, permissionMode = null } = {}) =>
      runMutation(() =>
        createClaudeCodeLocalSession({ confirmed, permissionMode }),
      ),
    [runMutation],
  );

  const stop = useCallback(
    () => runMutation(() => stopClaudeCodeLocalSession()),
    [runMutation],
  );

  const beginLogin = useCallback(
    () => runMutation(() => startClaudeCodeLocalLogin()),
    [runMutation],
  );

  const submitLoginCode = useCallback(
    (code) => runMutation(() => submitClaudeCodeLocalLoginCode({ code })),
    [runMutation],
  );

  const cancelLogin = useCallback(
    () => runMutation(() => cancelClaudeCodeLocalLogin()),
    [runMutation],
  );

  const logout = useCallback(
    () => runMutation(() => logoutClaudeCodeLocal()),
    [runMutation],
  );

  const fetchTail = useCallback(
    ({ source = "session" } = {}) => fetchClaudeCodeLocalTail({ source }),
    [],
  );

  return {
    local,
    statusError,
    refresh,
    start,
    stop,
    login: {
      begin: beginLogin,
      submitCode: submitLoginCode,
      cancel: cancelLogin,
    },
    logout,
    fetchTail,
  };
};

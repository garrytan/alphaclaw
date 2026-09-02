import { useCallback, useRef } from "preact/hooks";
import { fetchOpenclawBackups } from "../../lib/api.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";

// Backup inventory (WI-4.3) for the Upgrade page: ONE cached read shared by
// the Backups card (rows) and the apply confirm (reuse-consent candidate).
// No polling — archives only change when an update runs, so the owner hook
// force-refreshes after an apply settles (failure, finish, dismiss). The
// payload also carries the server's reuse window (`reuseWindowStartMs`,
// `reuseMaxAgeMs`) — the consent model reads them off this same object, so
// a forced refresh re-binds the window together with the candidate rows.
export const kBackupsCacheKey = "/api/openclaw/backups";
export const kBackupsCacheMaxAgeMs = 60_000;

export const useBackupsInventory = ({ enabled = true } = {}) => {
  // A forced refresh must reach the SERVER fresh too: its 5 s SWR copy can
  // still describe the pre-update directory right after an apply settles, and
  // bypassing only the client cache would store that answer as fresh for
  // kBackupsCacheMaxAgeMs — long enough for the next confirm to bind consent
  // to an archive that no longer is the newest one.
  const forceNextRef = useRef(false);
  const fetcher = useCallback(() => {
    const force = forceNextRef.current === true;
    forceNextRef.current = false;
    return fetchOpenclawBackups({ force });
  }, []);
  const { data, error, loading, refresh } = useCachedFetch(
    kBackupsCacheKey,
    fetcher,
    { maxAgeMs: kBackupsCacheMaxAgeMs, enabled },
  );
  // Force = invalidate + refetch (server-side too); the rejection is already
  // in `error`.
  const refreshBackups = useCallback(() => {
    forceNextRef.current = true;
    return refresh({ force: true }).catch(() => null);
  }, [refresh]);
  return {
    inventory: data,
    error,
    // The frame renders immediately; only the data region shows LOADING, and
    // only while there is no last-known inventory to keep showing.
    loading: loading && data == null,
    refreshBackups,
  };
};

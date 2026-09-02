import { useCallback } from "preact/hooks";
import { fetchOpenclawBackups } from "../../lib/api.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";

// Backup inventory (WI-4.3) for the Upgrade page: ONE cached read shared by
// the Backups card (rows) and the apply confirm (reuse-consent candidate).
// No polling — archives only change when an update runs, so the owner hook
// force-refreshes after an apply settles (failure, finish, dismiss).
export const kBackupsCacheKey = "/api/openclaw/backups";
export const kBackupsCacheMaxAgeMs = 60_000;

export const useBackupsInventory = ({ enabled = true } = {}) => {
  const { data, error, loading, refresh } = useCachedFetch(
    kBackupsCacheKey,
    fetchOpenclawBackups,
    { maxAgeMs: kBackupsCacheMaxAgeMs, enabled },
  );
  // Force = invalidate + refetch; the rejection is already in `error`.
  const refreshBackups = useCallback(
    () => refresh({ force: true }).catch(() => null),
    [refresh],
  );
  return {
    inventory: data,
    error,
    // The frame renders immediately; only the data region shows LOADING, and
    // only while there is no last-known inventory to keep showing.
    loading: loading && data == null,
    refreshBackups,
  };
};

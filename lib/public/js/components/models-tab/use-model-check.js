import { useCallback, useState } from "preact/hooks";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { setCached } from "../../lib/api-cache.js";
import { kModelCheckCacheKey } from "../../lib/cache-keys.js";
import { fetchModelCheck, runModelCheck } from "../../lib/api/models.js";

export const useModelCheck = () => {
  const { data, error, loading, refresh } = useCachedFetch(kModelCheckCacheKey, fetchModelCheck, { maxAgeMs: 30000 });
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState("");

  const runCheck = useCallback(async () => {
    setRunning(true);
    setRunError("");
    try {
      const run = await runModelCheck();
      setCached(kModelCheckCacheKey, { ...(data || {}), ok: true, running: false, lastRun: run });
      await refresh({ force: true }).catch(() => {});
    } catch (err) {
      setRunError(err?.message || "Could not run the model check");
    } finally {
      setRunning(false);
    }
  }, [data, refresh]);

  return {
    lastRun: data?.lastRun || null,
    failures: data?.failures || [],
    loading,
    error: runError || (error ? error.message || "Could not load the model check" : ""),
    running: running || data?.running === true,
    runCheck,
  };
};

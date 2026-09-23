import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { authFetch } from "../../lib/api.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";

export const kBackupPreflightCacheKey = "/api/openclaw/backup-preflight";

export const fetchBackupPreflight = async ({ signal } = {}) => {
  const response = await authFetch(kBackupPreflightCacheKey, { signal, readTimeoutMs: 120_000 });
  const data = await response.json();
  if (!response.ok || data?.ok !== true) {
    throw Object.assign(new Error(data?.message || data?.error || "Could not check the backup sources."), {
      status: response.status, code: data?.code, hint: data?.hint,
    });
  }
  if (!data.diagnosis || typeof data.blocked !== "boolean") {
    throw new Error("The server returned an invalid backup preflight. Retry the check.");
  }
  return data;
};

export const useBackupPreflight = () => {
  const read = useCachedFetch(kBackupPreflightCacheKey, fetchBackupPreflight, {
    initialFetch: false, staleWhileRevalidate: false, acceptsSignal: true, timeoutMs: 120_000,
  });
  const pending = useRef(null);
  const active = useRef(true);
  const generation = useRef(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    active.current = true;
    return () => { active.current = false; pending.current = null; generation.current += 1; };
  }, []);
  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    setChecking(true);
    setReady(false);
    try {
      const result = await read.refresh({ force: true });
      if (active.current && generation.current === gen) setReady(result?.blocked === false);
    } catch {
      if (active.current && generation.current === gen) setReady(false);
    } finally {
      if (active.current && generation.current === gen) setChecking(false);
    }
  }, [read.refresh]);
  const request = useCallback((action) => {
    pending.current = action;
    setDialogOpen(true);
    return refresh();
  }, [refresh]);
  const cancel = useCallback(() => {
    pending.current = null;
    setDialogOpen(false);
    setReady(false);
  }, []);
  const confirm = useCallback(async () => {
    if (!ready || checking || read.error || read.isFetching || read.stale || !read.data || read.data.blocked) return;
    const action = pending.current;
    if (!action) return;
    pending.current = null;
    setDialogOpen(false);
    setReady(false);
    await action();
  }, [checking, ready, read.data, read.error, read.isFetching, read.stale]);
  return {
    data: read.data, error: read.error, checking: checking || read.isFetching,
    ready: ready && !read.stale && !read.error, dialogOpen, refresh, request, cancel, confirm,
  };
};

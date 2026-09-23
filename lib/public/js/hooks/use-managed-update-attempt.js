import { useCallback, useRef, useState } from "preact/hooks";
import { fetchAlphaclawVersion, resolveManagedUpdateAttempt, updateAlphaclaw } from "../lib/api.js";
import { getCached, setCached } from "../lib/api-cache.js";
import { usePolling } from "./usePolling.js";

const kVersionKey = "/api/alphaclaw/version";
export const isManagedUpdateBlocking = (attempt) => ["submitting", "accepted", "unknown"].includes(attempt?.state);

export const useManagedUpdateAttempt = ({ enabled = true, identityRole = null } = {}) => {
  const read = usePolling(() => fetchAlphaclawVersion(false), 5 * 60_000, { enabled, cacheKey: kVersionKey });
  const [submitting, setSubmitting] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [actionError, setActionError] = useState(null);
  const busy = useRef(false);
  const attempt = read.data?.managedUpdateAttempt || null;
  const blocked = isManagedUpdateBlocking(attempt);
  const isAdmin = identityRole === "admin";
  const commitAttempt = (data, previousId) => {
    if (!Object.hasOwn(data || {}, "managedUpdateAttempt")) return;
    const current = getCached(kVersionKey) || {};
    const currentId = current.managedUpdateAttempt?.id;
    if (currentId !== previousId && currentId !== data.managedUpdateAttempt?.id) return;
    setCached(kVersionKey, { ...current, managedUpdateAttempt: data.managedUpdateAttempt });
  };
  const retry = useCallback(async () => {
    const data = await read.refresh({ force: true });
    if (data) setActionError(null);
    return data;
  }, [read.refresh]);

  const submit = useCallback(async () => {
    if (busy.current || blocked || read.error || !read.data || !isAdmin) return null;
    busy.current = true;
    setSubmitting(true);
    setActionError(null);
    try {
      const data = await updateAlphaclaw();
      commitAttempt(data, attempt?.id);
      return data;
    } catch (error) {
      setActionError(error);
      // A dropped response may already have triggered a deployment. The
      // persisted server attempt is the only permission to submit again.
      await read.refresh({ force: true });
      return null;
    } finally {
      busy.current = false;
      setSubmitting(false);
    }
  }, [blocked, read.error, read.data, isAdmin, attempt?.id, read.refresh]);

  const resolve = useCallback(async (attemptId, outcome) => {
    if (busy.current || !isAdmin || attemptId !== attempt?.id || !["deployed", "not_deployed"].includes(outcome)) return false;
    busy.current = true;
    setResolving(true);
    setActionError(null);
    try {
      const data = await resolveManagedUpdateAttempt(attemptId, outcome);
      commitAttempt(data, attemptId);
      await read.refresh({ force: true });
      return true;
    } catch (error) {
      setActionError(error);
      await read.refresh({ force: true });
      return false;
    } finally {
      busy.current = false;
      setResolving(false);
    }
  }, [attempt?.id, isAdmin, read.refresh]);
  return {
    version: read.data, attempt, blocked, isAdmin, submitting, resolving,
    error: read.error || actionError, retry, submit, resolve,
    disabled: blocked || submitting || resolving || Boolean(read.error) || !read.data || !isAdmin,
  };
};

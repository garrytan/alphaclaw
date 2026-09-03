import { useState, useEffect, useRef, useCallback } from "preact/hooks";
import {
  fetchModels,
  fetchModelsConfig,
  saveModelsConfig,
  fetchCodexStatus,
} from "../../lib/api.js";
import { showToast } from "../toast.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { usePolling } from "../../hooks/usePolling.js";
import { invalidateCache } from "../../lib/api-cache.js";
import {
  kCodexStatusCacheKey,
  kModelsConfigCacheKey,
} from "../../lib/cache-keys.js";
import {
  getModelCatalogModels,
  isModelCatalogRefreshing,
  kModelCatalogCacheKey,
  kModelCatalogPollIntervalMs,
} from "../../lib/model-catalog.js";
import { withAlwaysAvailableModels } from "../../lib/model-config.js";
import { applyCodexStatusRead } from "../../lib/codex-status.js";
import {
  cancelStoreUnavailableRecheck,
  isStoreUnavailable,
  kStoreUnavailableReasonBackup,
  settleStoreUnavailableRecheck,
} from "../../lib/store-availability.js";

let kModelsTabCache = null;
const getCredentialValue = (value) =>
  String(value?.key || value?.token || value?.access || "").trim();
const kNoModelsFoundError = "No models found";
const kModelSettingsLoadError = "Failed to load model settings";
// Re-exported from the shared registry so existing importers keep working.
export { kCodexStatusCacheKey };

const stableStringify = (obj) =>
  JSON.stringify(
    Object.keys(obj)
      .sort()
      .reduce((acc, k) => {
        acc[k] = obj[k];
        return acc;
      }, {}),
  );

export const useModels = (agentId) => {
  const isScoped = !!agentId;
  const normalizedAgentId = String(agentId || "").trim();
  const useCache = !isScoped;
  const [catalog, setCatalog] = useState(() => (useCache && kModelsTabCache?.catalog) || []);
  const [catalogStatus, setCatalogStatus] = useState(
    () =>
      (useCache && kModelsTabCache?.catalogStatus) || {
        source: "",
        fetchedAt: null,
        stale: false,
        refreshing: false,
      },
  );
  const [primary, setPrimary] = useState(() => (useCache && kModelsTabCache?.primary) || "");
  const [configuredModels, setConfiguredModels] = useState(
    () => (useCache && kModelsTabCache?.configuredModels) || {},
  );
  const [authProfiles, setAuthProfiles] = useState(
    () => (useCache && kModelsTabCache?.authProfiles) || [],
  );
  const [authOrder, setAuthOrder] = useState(
    () => (useCache && kModelsTabCache?.authOrder) || {},
  );
  const [codexStatus, setCodexStatus] = useState(
    () => (useCache && kModelsTabCache?.codexStatus) || { connected: false },
  );
  // codexStatusError carries the failed-check message ("" when healthy);
  // codexStatusKnown is true only once a status CHECK has succeeded — the
  // { connected: false } initial above is a placeholder, not a checked status.
  const [codexStatusError, setCodexStatusError] = useState("");
  const [codexStatusKnown, setCodexStatusKnown] = useState(
    () => !!(useCache && kModelsTabCache?.codexStatus),
  );
  // `{ reason }` while GET /api/models/config answers `unavailable: true`
  // (state-DB quiet period): the auth store could not be read, so the
  // profiles/order in that payload are placeholders — the last-known copies
  // stay on screen and the tab says why. null = store readable.
  const [authStoreUnavailable, setAuthStoreUnavailable] = useState(null);
  // Refs so refresh()/refreshCodexStatus() read the CURRENT status without
  // depending on it (a dep would re-create the callbacks on every read).
  const codexStatusRef = useRef(codexStatus);
  codexStatusRef.current = codexStatus;
  const codexStatusKnownRef = useRef(codexStatusKnown);
  codexStatusKnownRef.current = codexStatusKnown;
  const [loading, setLoading] = useState(() => !(useCache && kModelsTabCache));
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(() => !!(useCache && kModelsTabCache));
  const [error, setError] = useState("");

  const [profileEdits, setProfileEdits] = useState({});
  const [orderEdits, setOrderEdits] = useState({});

  const savedPrimaryRef = useRef(kModelsTabCache?.primary || "");
  const savedConfiguredRef = useRef(kModelsTabCache?.configuredModels || {});
  // Stale-guard (review remedy R4, latest-request-wins): a refresh superseded by a newer refresh — or by an agent
  // switch — must never apply its results over fresher state or live drafts.
  const refreshGenerationRef = useRef(0);
  const agentKeyRef = useRef(normalizedAgentId);
  agentKeyRef.current = normalizedAgentId;
  // ONE bounded re-read while a store read is unavailable (backup barrier):
  // the timer calls the LATEST refresh through a ref so an armed recheck
  // never runs a stale closure after an agent switch.
  const storeRecheckRef = useRef(null);
  const refreshRef = useRef(null);

  const updateCache = useCallback((patch) => {
    if (!isScoped) kModelsTabCache = { ...(kModelsTabCache || {}), ...patch };
  }, [isScoped]);
  const modelsConfigCacheKey = normalizedAgentId
    ? `${kModelsConfigCacheKey}?agentId=${encodeURIComponent(normalizedAgentId)}`
    : kModelsConfigCacheKey;
  const catalogFetchState = useCachedFetch(kModelCatalogCacheKey, fetchModels, {
    maxAgeMs: 30000,
  });
  const fetchScopedModelsConfig = useCallback(
    () => fetchModelsConfig(isScoped ? { agentId } : undefined),
    [isScoped, agentId],
  );
  const configFetchState = useCachedFetch(
    modelsConfigCacheKey,
    fetchScopedModelsConfig,
    { maxAgeMs: 30000 },
  );
  const codexFetchState = useCachedFetch(kCodexStatusCacheKey, fetchCodexStatus, {
    maxAgeMs: 15000,
  });
  const catalogPoll = usePolling(fetchModels, kModelCatalogPollIntervalMs, {
    enabled: ready && isModelCatalogRefreshing(catalogStatus),
    pauseWhenHidden: true,
    cacheKey: kModelCatalogCacheKey,
  });

  const syncCatalogError = useCallback((catalogModels) => {
    setError((current) => {
      if (catalogModels.length > 0) {
        return current === kNoModelsFoundError ? "" : current;
      }
      return current || kNoModelsFoundError;
    });
  }, []);

  const applyCatalogResult = useCallback(
    (catalogResult) => {
      const catalogModels = getModelCatalogModels(catalogResult);
      const nextCatalogStatus = {
        source: String(catalogResult?.source || ""),
        fetchedAt: Number(catalogResult?.fetchedAt || 0) || null,
        stale: Boolean(catalogResult?.stale),
        refreshing: Boolean(catalogResult?.refreshing),
      };
      setCatalog(catalogModels);
      setCatalogStatus(nextCatalogStatus);
      updateCache({
        catalog: catalogModels,
        catalogStatus: nextCatalogStatus,
      });
      syncCatalogError(catalogModels);
      return catalogModels;
    },
    [syncCatalogError, updateCache],
  );

  // One adoption path for every successful Codex status READ: an
  // `unavailable` payload keeps the last-known status under the marker and
  // never advances `known`; the tab cache only ever seeds a KNOWN status (an
  // unavailable placeholder would read as checked on the next mount).
  const adoptCodexStatusRead = useCallback(
    (codex) => {
      const read = applyCodexStatusRead({
        previous: codexStatusRef.current,
        previousKnown: codexStatusKnownRef.current,
        next: codex,
      });
      setCodexStatus(read.status);
      setCodexStatusKnown(read.known);
      setCodexStatusError("");
      return read;
    },
    [],
  );

  const refresh = useCallback(async ({ force = true } = {}) => {
    const generation = ++refreshGenerationRef.current;
    const agentKey = normalizedAgentId;
    const isStale = () =>
      refreshGenerationRef.current !== generation ||
      agentKeyRef.current !== agentKey;
    if (!ready) setLoading(true);
    setError("");
    try {
      const [catalogResult, configResult, codex] = await Promise.all([
        catalogFetchState.refresh({ force }),
        configFetchState.refresh({ force }),
        codexFetchState.refresh({ force }),
      ]);
      if (isStale()) return;
      // The fetchers resolve HTTP error responses as {ok:false} envelopes.
      // Treat those like rejections: adopting one would silently clear
      // models/profiles/order, advance the saved baselines, and poison the
      // cache with fabricated-empty config.
      for (const result of [catalogResult, configResult, codex]) {
        if (result?.ok === false) {
          throw new Error(String(result.error || "Server reported an error"));
        }
      }
      const catalogModels = applyCatalogResult(catalogResult);
      const p = configResult.primary || "";
      const cm = configResult.configuredModels || {};
      const ap = configResult.authProfiles || [];
      const ao = configResult.authOrder || {};
      // Dirty-check merge: values changed since the last save survive the
      // refresh — only clean values adopt the server copy. Baselines always
      // move to the fresh server truth, so a draft that now matches the
      // server naturally reads as clean.
      const prevSavedPrimary = savedPrimaryRef.current;
      const prevSavedConfigured = savedConfiguredRef.current || {};
      let mergedPrimary = p;
      setPrimary((prev) => {
        mergedPrimary = prev !== prevSavedPrimary ? prev : p;
        return mergedPrimary;
      });
      let mergedConfigured = cm;
      setConfiguredModels((prev) => {
        mergedConfigured =
          stableStringify(prev) !== stableStringify(prevSavedConfigured)
            ? prev
            : cm;
        return mergedConfigured;
      });
      // Quiet-period read: the store's profiles/order in this payload are
      // empty placeholders, not the truth — adopting them would render every
      // configured credential as removed (and a save would write that back).
      // Keep the last-known copies and the pending edits; only the flag moves.
      const storeUnavailable = isStoreUnavailable(configResult);
      setAuthStoreUnavailable(
        storeUnavailable
          ? { reason: configResult.reason || kStoreUnavailableReasonBackup }
          : null,
      );
      if (!storeUnavailable) {
        setAuthProfiles(ap);
        setAuthOrder(ao);
        // Clear only the edits the server now reflects; live drafts stay put.
        setProfileEdits((prev) =>
          Object.fromEntries(
            Object.entries(prev).filter(([id, cred]) => {
              const saved = ap.find((profile) => profile.id === id);
              return getCredentialValue(cred) !== getCredentialValue(saved);
            }),
          ),
        );
        setOrderEdits((prev) =>
          Object.fromEntries(
            Object.entries(prev).filter(
              ([provider, order]) =>
                JSON.stringify(order) !== JSON.stringify(ao[provider] || null),
            ),
          ),
        );
      }
      const codexRead = adoptCodexStatusRead(codex);
      // Nothing else re-reads the store while the barrier holds — arm one
      // bounded recheck so the "unavailable during a backup" lines clear on
      // their own once it lifts; a readable read drops the pending timer.
      settleStoreUnavailableRecheck(storeRecheckRef, {
        unavailable: storeUnavailable || isStoreUnavailable(codex),
        recheck: () => refreshRef.current?.({ force: true }),
      });
      savedPrimaryRef.current = p;
      savedConfiguredRef.current = cm;
      updateCache({
        catalog: catalogModels,
        primary: mergedPrimary,
        configuredModels: mergedConfigured,
        ...(storeUnavailable ? {} : { authProfiles: ap, authOrder: ao }),
        ...(codexRead.known ? { codexStatus: codexRead.status } : {}),
      });
    } catch (err) {
      if (isStale()) return;
      setError(kModelSettingsLoadError);
      showToast(`${kModelSettingsLoadError}: ${err.message}`, "error");
    } finally {
      if (!isStale()) {
        setReady(true);
        setLoading(false);
      }
    }
  }, [
    adoptCodexStatusRead,
    applyCatalogResult,
    catalogFetchState,
    codexFetchState,
    configFetchState,
    normalizedAgentId,
    ready,
    updateCache,
  ]);

  refreshRef.current = refresh;

  // refresh() is the ONLY path that adopts fetch results into hook state and
  // sets `ready`, so it must run on first mount too — but non-forced, so it
  // dedupes onto the three useCachedFetch mount fetches instead of
  // double-hitting /api/models, /api/models/config, and /api/codex/status
  // (force deliberately never dedupes onto an in-flight request). Genuine
  // agent SWITCHES force so a stale scoped config can't serve.
  const refreshedAgentRef = useRef(null);
  useEffect(() => {
    const firstSighting = refreshedAgentRef.current === null;
    if (!firstSighting && refreshedAgentRef.current === agentId) return;
    refreshedAgentRef.current = agentId;
    refresh({ force: !firstSighting });
  }, [agentId]);

  useEffect(() => {
    if (!catalogPoll.data) return;
    applyCatalogResult(catalogPoll.data);
  }, [applyCatalogResult, catalogPoll.data]);

  useEffect(() => () => cancelStoreUnavailableRecheck(storeRecheckRef), []);

  const modelConfigDirty =
    primary !== savedPrimaryRef.current ||
    stableStringify(configuredModels) !==
      stableStringify(savedConfiguredRef.current);

  const authDirty = (() => {
    const hasProfileChanges = Object.entries(profileEdits).some(
      ([id, cred]) => {
        const existing = authProfiles.find((p) => p.id === id);
        return getCredentialValue(cred) !== getCredentialValue(existing);
      },
    );
    const hasOrderChanges = Object.entries(orderEdits).some(
      ([provider, order]) => {
        const existing = authOrder[provider];
        return JSON.stringify(order) !== JSON.stringify(existing);
      },
    );
    return hasProfileChanges || hasOrderChanges;
  })();

  const isDirty = modelConfigDirty || authDirty;

  const addModel = useCallback(
    (modelKey) => {
      if (!modelKey) return;
      const catalogEntry = withAlwaysAvailableModels(catalog).find(
        (model) => model?.key === modelKey,
      );
      const modelConfig = catalogEntry?.agentRuntime
        ? { agentRuntime: catalogEntry.agentRuntime }
        : {};
      setConfiguredModels((prev) => {
        const next = { ...prev, [modelKey]: modelConfig };
        updateCache({ configuredModels: next });
        return next;
      });
    },
    [catalog, updateCache],
  );

  const removeModel = useCallback(
    (modelKey) => {
      setConfiguredModels((prev) => {
        const next = { ...prev };
        delete next[modelKey];
        updateCache({ configuredModels: next });
        return next;
      });
      if (primary === modelKey) {
        const remaining = Object.keys(configuredModels).filter(
          (k) => k !== modelKey,
        );
        const newPrimary = remaining[0] || "";
        setPrimary(newPrimary);
        updateCache({ primary: newPrimary });
      }
    },
    [primary, configuredModels, updateCache],
  );

  const setPrimaryModel = useCallback(
    (modelKey) => {
      setPrimary(modelKey);
      updateCache({ primary: modelKey });
    },
    [updateCache],
  );

  const editProfile = useCallback(
    (profileId, credential) => {
      const existing = authProfiles.find((p) => p.id === profileId);
      if (getCredentialValue(credential) === getCredentialValue(existing)) {
        setProfileEdits((prev) => {
          const next = { ...prev };
          delete next[profileId];
          return next;
        });
        return;
      }
      setProfileEdits((prev) => ({ ...prev, [profileId]: credential }));
    },
    [authProfiles],
  );

  const editAuthOrder = useCallback(
    (provider, orderedIds) => {
      const existing = authOrder[provider] || null;
      if (JSON.stringify(orderedIds) === JSON.stringify(existing)) {
        setOrderEdits((prev) => {
          const next = { ...prev };
          delete next[provider];
          return next;
        });
        return;
      }
      setOrderEdits((prev) => ({ ...prev, [provider]: orderedIds }));
    },
    [authOrder],
  );

  const getProfileValue = useCallback(
    (profileId) => {
      if (profileEdits[profileId] !== undefined) return profileEdits[profileId];
      const existing = authProfiles.find((p) => p.id === profileId);
      return existing || null;
    },
    [profileEdits, authProfiles],
  );

  const getEffectiveOrder = useCallback(
    (provider) => {
      if (orderEdits[provider] !== undefined) return orderEdits[provider];
      return authOrder[provider] || null;
    },
    [orderEdits, authOrder],
  );

  const cancelChanges = useCallback(() => {
    const savedPrimary = savedPrimaryRef.current || "";
    const savedConfigured = savedConfiguredRef.current || {};
    setPrimary(savedPrimary);
    setConfiguredModels(savedConfigured);
    setProfileEdits({});
    setOrderEdits({});
    updateCache({
      primary: savedPrimary,
      configuredModels: savedConfigured,
    });
  }, [updateCache]);

  const saveAll = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const changedProfiles = Object.entries(profileEdits)
        .filter(([id, cred]) => {
          const existing = authProfiles.find((p) => p.id === id);
          return getCredentialValue(cred) !== getCredentialValue(existing);
        })
        .map(([id, cred]) => ({ id, ...cred }));

      const result = await saveModelsConfig({
        primary,
        configuredModels,
        profiles: changedProfiles.length > 0 ? changedProfiles : undefined,
        authOrder:
          Object.keys(orderEdits).length > 0 ? orderEdits : undefined,
        ...(isScoped ? { agentId } : {}),
      });
      if (!result.ok)
        throw new Error(result.error || "Failed to save config");
      showToast("Changes saved", "success");
      if (result.syncWarning) {
        showToast(`Saved, but git-sync failed: ${result.syncWarning}`, "warning");
      }
      invalidateCache(kModelCatalogCacheKey);
      await refresh();
    } catch (err) {
      showToast(err.message || "Failed to save changes", "error");
    } finally {
      setSaving(false);
    }
  }, [
    saving,
    primary,
    configuredModels,
    profileEdits,
    orderEdits,
    authProfiles,
    isScoped,
    agentId,
    refresh,
  ]);

  const refreshCodexStatus = useCallback(async () => {
    let codex;
    try {
      // Force-refresh through the cached state (generation-safe) so the
      // shared "/api/codex/status" cache stays in step with what we render.
      codex = await codexFetchState.refresh({ force: true });
    } catch (err) {
      // A failed status CHECK keeps the last-known status — fabricating
      // "not connected" (in state or cache) would misreport a live auth.
      setCodexStatusError(err?.message || "unknown error");
      return;
    }
    if (codex?.ok === false) {
      // HTTP errors resolve as {ok:false} envelopes — same rule as the
      // rejection path above: keep last-known, never fabricate.
      setCodexStatusError(String(codex.error || codex.message || "unknown error"));
      return;
    }
    const read = adoptCodexStatusRead(codex);
    if (read.known) updateCache({ codexStatus: read.status });
    // A codex-only read says nothing about the config store, so it only ARMS
    // (never cancels) the recheck; the full refresh it triggers settles both.
    if (isStoreUnavailable(codex)) {
      settleStoreUnavailableRecheck(storeRecheckRef, {
        unavailable: true,
        recheck: () => refreshRef.current?.({ force: true }),
      });
    }
    try {
      invalidateCache(kModelCatalogCacheKey);
      const catalogResult = await catalogFetchState.refresh({ force: true });
      applyCatalogResult(catalogResult);
    } catch {
      // Keep the successful auth status; catalog polling will retry discovery.
    }
  }, [
    adoptCodexStatusRead,
    applyCatalogResult,
    catalogFetchState,
    codexFetchState,
    updateCache,
  ]);

  return {
    catalog,
    primary,
    configuredModels,
    authProfiles,
    authOrder,
    authStoreUnavailable,
    codexStatus,
    codexStatusError,
    codexStatusKnown,
    loading,
    saving,
    ready,
    error,
    isDirty,
    refresh,
    addModel,
    removeModel,
    setPrimaryModel,
    editProfile,
    editAuthOrder,
    getProfileValue,
    getEffectiveOrder,
    cancelChanges,
    saveAll,
    refreshCodexStatus,
  };
};

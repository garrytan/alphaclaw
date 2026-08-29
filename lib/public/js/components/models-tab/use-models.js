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
  getModelCatalogModels,
  isModelCatalogRefreshing,
  kModelCatalogCacheKey,
  kModelCatalogPollIntervalMs,
} from "../../lib/model-catalog.js";
import { withAlwaysAvailableModels } from "../../lib/model-config.js";

let kModelsTabCache = null;
const getCredentialValue = (value) =>
  String(value?.key || value?.token || value?.access || "").trim();
const kNoModelsFoundError = "No models found";
const kModelSettingsLoadError = "Failed to load model settings";
export const kCodexStatusCacheKey = "/api/codex/status";

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
  const [codexStatusError, setCodexStatusError] = useState(false);
  const [loading, setLoading] = useState(() => !(useCache && kModelsTabCache));
  const [saving, setSaving] = useState(false);
  const [ready, setReady] = useState(() => !!(useCache && kModelsTabCache));
  const [error, setError] = useState("");

  const [profileEdits, setProfileEdits] = useState({});
  const [orderEdits, setOrderEdits] = useState({});

  const savedPrimaryRef = useRef(kModelsTabCache?.primary || "");
  const savedConfiguredRef = useRef(kModelsTabCache?.configuredModels || {});
  // R4 stale-guard: a refresh superseded by a newer refresh — or by an agent
  // switch — must never apply its results over fresher state or live drafts.
  const refreshGenerationRef = useRef(0);
  const agentKeyRef = useRef(normalizedAgentId);
  agentKeyRef.current = normalizedAgentId;

  const updateCache = useCallback((patch) => {
    if (!isScoped) kModelsTabCache = { ...(kModelsTabCache || {}), ...patch };
  }, [isScoped]);
  const modelsConfigCacheKey = normalizedAgentId
    ? `/api/models/config?agentId=${encodeURIComponent(normalizedAgentId)}`
    : "/api/models/config";
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

  const refresh = useCallback(async () => {
    const generation = ++refreshGenerationRef.current;
    const agentKey = normalizedAgentId;
    const isStale = () =>
      refreshGenerationRef.current !== generation ||
      agentKeyRef.current !== agentKey;
    if (!ready) setLoading(true);
    setError("");
    try {
      const [catalogResult, configResult, codex] = await Promise.all([
        catalogFetchState.refresh({ force: true }),
        configFetchState.refresh({ force: true }),
        codexFetchState.refresh({ force: true }),
      ]);
      if (isStale()) return;
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
      setAuthProfiles(ap);
      setAuthOrder(ao);
      setCodexStatus(codex || { connected: false });
      setCodexStatusError(false);
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
      savedPrimaryRef.current = p;
      savedConfiguredRef.current = cm;
      updateCache({
        catalog: catalogModels,
        primary: mergedPrimary,
        configuredModels: mergedConfigured,
        authProfiles: ap,
        authOrder: ao,
        codexStatus: codex || { connected: false },
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
    applyCatalogResult,
    catalogFetchState,
    codexFetchState,
    configFetchState,
    normalizedAgentId,
    ready,
    updateCache,
  ]);

  useEffect(() => {
    refresh();
  }, [agentId]);

  useEffect(() => {
    if (!catalogPoll.data) return;
    applyCatalogResult(catalogPoll.data);
  }, [applyCatalogResult, catalogPoll.data]);

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
    } catch {
      // A failed status CHECK keeps the last-known status — fabricating
      // "not connected" (in state or cache) would misreport a live auth.
      setCodexStatusError(true);
      return;
    }
    setCodexStatusError(false);
    setCodexStatus(codex || { connected: false });
    updateCache({ codexStatus: codex || { connected: false } });
    try {
      invalidateCache(kModelCatalogCacheKey);
      const catalogResult = await catalogFetchState.refresh({ force: true });
      applyCatalogResult(catalogResult);
    } catch {
      // Keep the successful auth status; catalog polling will retry discovery.
    }
  }, [applyCatalogResult, catalogFetchState, codexFetchState, updateCache]);

  return {
    catalog,
    primary,
    configuredModels,
    authProfiles,
    authOrder,
    codexStatus,
    codexStatusError,
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

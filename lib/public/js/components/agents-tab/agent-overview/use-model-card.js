import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { fetchThinkingOptions } from "../../../lib/api.js";
import {
  formatInheritedThinkingLabel,
  formatThinkingLevelLabel,
  shouldShowThinkingLevelSelect,
} from "../../../lib/thinking-levels.js";
import { useModels } from "../../models-tab/use-models.js";
import {
  buildProviderHasAuth,
  buildSyntheticModelEntry,
  getModelCatalogProvider,
  getModelsTabAuthProvider,
  getProviderSortIndex,
} from "../../models-tab/model-picker.js";

const resolveModelDisplay = (model) => {
  if (!model) return null;
  if (typeof model === "string") return model;
  return model.primary || null;
};

const resolveCatalogModel = (catalog = [], modelKey = "") =>
  catalog.find(
    (model) =>
      String(model?.key || "").trim() === String(modelKey || "").trim(),
  ) || null;

const kDefaultThinkingOptions = {
  levels: [],
  inheritedDefault: "off",
  modelDefault: "off",
};

export const useModelCard = ({
  agent = {},
  onUpdateAgent = async () => {},
}) => {
  const [updatingModel, setUpdatingModel] = useState(false);
  const [updatingThinking, setUpdatingThinking] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [thinkingOptions, setThinkingOptions] = useState(
    kDefaultThinkingOptions,
  );
  const [thinkingOptionsLoading, setThinkingOptionsLoading] = useState(false);
  const [thinkingOptionsError, setThinkingOptionsError] = useState(null);
  const [thinkingOptionsNonce, setThinkingOptionsNonce] = useState(0);
  // Optimistic thinking-level commit: null means "no commit in flight/settled";
  // "" is a real pending value (inherit). Errors keep {attempted, error} so the
  // inline chip can offer a retry after the loud revert.
  const [pendingThinkingValue, setPendingThinkingValue] = useState(null);
  const [thinkingSaveError, setThinkingSaveError] = useState(null);
  const [pendingModelKey, setPendingModelKey] = useState("");
  const [modelSaveError, setModelSaveError] = useState(null);
  // Latest-commit-wins: a stale commit (older attempt, or one from a previous
  // agent) must not revert state, set errors, or clear a newer pending value.
  const thinkingCommitIdRef = useRef(0);
  const modelCommitIdRef = useRef(0);
  const {
    catalog,
    primary: defaultPrimaryModel,
    configuredModels,
    authProfiles,
    codexStatus,
    loading: loadingModels,
    ready: modelsReady,
  } = useModels();

  const explicitModel = resolveModelDisplay(agent.model);
  const effectiveModel = explicitModel || defaultPrimaryModel || "";
  const hasDistinctModelOverride =
    !!explicitModel &&
    String(explicitModel).trim() !== String(defaultPrimaryModel || "").trim();
  const explicitThinkingDefault = String(agent.thinkingDefault || "").trim();
  const inheritedThinkingDefault = String(
    thinkingOptions.inheritedDefault || thinkingOptions.modelDefault || "off",
  ).trim();
  const hasDistinctThinkingOverride =
    !!explicitThinkingDefault &&
    explicitThinkingDefault !== inheritedThinkingDefault;
  const showThinkingSelect = shouldShowThinkingLevelSelect(
    thinkingOptions.levels,
  );

  useEffect(() => {
    const modelKey = String(effectiveModel || "").trim();
    if (!modelKey.includes("/")) {
      setThinkingOptions(kDefaultThinkingOptions);
      setThinkingOptionsError(null);
      return undefined;
    }
    let cancelled = false;
    setThinkingOptionsLoading(true);
    setThinkingOptionsError(null);
    fetchThinkingOptions(modelKey)
      .then((payload) => {
        if (cancelled || !payload?.ok) return;
        setThinkingOptions({
          levels: Array.isArray(payload.levels) ? payload.levels : [],
          inheritedDefault: String(payload.inheritedDefault || "off").trim(),
          modelDefault: String(payload.modelDefault || "off").trim(),
        });
      })
      .catch((error) => {
        if (cancelled) return;
        // A failed options fetch must not leave stale levels behind or escape
        // as an unhandled rejection; the card renders a retryable note.
        setThinkingOptions(kDefaultThinkingOptions);
        setThinkingOptionsError(error);
      })
      .finally(() => {
        if (!cancelled) setThinkingOptionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveModel, thinkingOptionsNonce]);

  const agentId = String(agent.id || "").trim();
  useEffect(() => {
    // Commits from a previous agent are stale by definition.
    thinkingCommitIdRef.current += 1;
    modelCommitIdRef.current += 1;
    setPendingThinkingValue(null);
    setThinkingSaveError(null);
    setPendingModelKey("");
    setModelSaveError(null);
    setUpdatingThinking(false);
    setUpdatingModel(false);
  }, [agentId]);

  const providerHasAuth = useMemo(
    () => buildProviderHasAuth({ authProfiles, codexStatus }),
    [authProfiles, codexStatus],
  );

  const authorizedModelOptions = useMemo(
    () =>
      Object.keys(configuredModels || {})
        .map(
          (modelKey) =>
            resolveCatalogModel(catalog, modelKey) ||
            buildSyntheticModelEntry(modelKey),
        )
        .filter((model) => {
          const provider = getModelsTabAuthProvider(model.key);
          return !!providerHasAuth[provider];
        })
        .sort((left, right) => {
          const providerCompare =
            getProviderSortIndex(getModelCatalogProvider(left)) -
            getProviderSortIndex(getModelCatalogProvider(right));
          if (providerCompare !== 0) return providerCompare;
          return String(left?.label || left?.key).localeCompare(
            String(right?.label || right?.key),
          );
        }),
    [catalog, configuredModels, providerHasAuth],
  );

  const effectiveModelEntry = useMemo(
    () =>
      resolveCatalogModel(catalog, effectiveModel) ||
      (effectiveModel ? buildSyntheticModelEntry(effectiveModel) : null),
    [catalog, effectiveModel],
  );

  const popularModels = useMemo(
    () =>
      authorizedModelOptions.filter((model) => {
        const normalizedProvider = getModelCatalogProvider(model);
        return (
          normalizedProvider === "anthropic" || normalizedProvider === "openai"
        );
      }),
    [authorizedModelOptions],
  );

  const modelEntries = useMemo(() => {
    if (!effectiveModelEntry) return [];
    const currentKey = String(effectiveModelEntry?.key || "").trim();
    const rest = authorizedModelOptions.filter(
      (model) => String(model?.key || "").trim() !== currentKey,
    );
    return [effectiveModelEntry, ...rest];
  }, [authorizedModelOptions, effectiveModelEntry]);

  const modelEntryKeySet = useMemo(
    () =>
      new Set(
        modelEntries
          .map((entry) => String(entry?.key || "").trim())
          .filter(Boolean),
      ),
    [modelEntries],
  );

  const remainingModelOptions = useMemo(
    () =>
      authorizedModelOptions.filter(
        (model) => !modelEntryKeySet.has(String(model?.key || "").trim()),
      ),
    [authorizedModelOptions, modelEntryKeySet],
  );

  const commitModelPatch = async ({ pendingKey, patch, successMessage }) => {
    const commitId = ++modelCommitIdRef.current;
    setPendingModelKey(pendingKey);
    setModelSaveError(null);
    setUpdatingModel(true);
    try {
      await onUpdateAgent(agentId, patch, successMessage, {
        toastOnError: false,
      });
    } catch (error) {
      if (modelCommitIdRef.current === commitId) {
        setModelSaveError({ attempted: pendingKey, error });
      }
    } finally {
      if (modelCommitIdRef.current === commitId) {
        setPendingModelKey("");
        setUpdatingModel(false);
      }
    }
  };

  const handleSelectModel = async (modelKey) => {
    const normalizedModelKey = String(modelKey || "").trim();
    if (!normalizedModelKey || normalizedModelKey === effectiveModel) return;
    if (updatingModel) return;
    await commitModelPatch({
      pendingKey: normalizedModelKey,
      patch: { model: { primary: normalizedModelKey } },
      successMessage: "Agent model updated",
    });
  };

  const handleClearModelOverride = async () => {
    if (!hasDistinctModelOverride || updatingModel) return;
    await commitModelPatch({
      pendingKey: "",
      patch: { model: null },
      successMessage: "Agent model reset to default",
    });
  };

  const retryModelSave = () => {
    if (!modelSaveError) return;
    if (modelSaveError.attempted) handleSelectModel(modelSaveError.attempted);
    else handleClearModelOverride();
  };

  const handleSelectThinkingDefault = async (nextValue) => {
    const normalizedValue = String(nextValue || "").trim();
    const isInherit = !normalizedValue;
    if (isInherit && !hasDistinctThinkingOverride) return;
    if (!isInherit && normalizedValue === explicitThinkingDefault) return;
    const commitId = ++thinkingCommitIdRef.current;
    // Optimistic: the select reflects the choice instantly; failure reverts
    // loudly to the server's value via the inline chip (no toast-only error).
    setPendingThinkingValue(normalizedValue);
    setThinkingSaveError(null);
    setUpdatingThinking(true);
    try {
      await onUpdateAgent(
        agentId,
        { thinkingDefault: isInherit ? null : normalizedValue },
        isInherit
          ? "Agent thinking level reset to default"
          : "Agent thinking level updated",
        { toastOnError: false },
      );
      if (thinkingCommitIdRef.current === commitId) {
        setPendingThinkingValue(null);
      }
    } catch (error) {
      if (thinkingCommitIdRef.current === commitId) {
        setPendingThinkingValue(null);
        setThinkingSaveError({ attempted: normalizedValue, error });
      }
    } finally {
      if (thinkingCommitIdRef.current === commitId) {
        setUpdatingThinking(false);
      }
    }
  };

  const retryThinkingSave = () => {
    if (!thinkingSaveError) return;
    handleSelectThinkingDefault(thinkingSaveError.attempted);
  };

  const retryThinkingOptions = () => setThinkingOptionsNonce((n) => n + 1);

  const thinkingSelectValue =
    pendingThinkingValue !== null
      ? pendingThinkingValue
      : hasDistinctThinkingOverride
        ? explicitThinkingDefault
        : "";
  const thinkingSelectOptions = useMemo(() => {
    const seen = new Set();
    const options = [];
    const addOption = (value, label) => {
      const normalizedValue = String(value || "").trim();
      if (!normalizedValue || seen.has(normalizedValue)) return;
      seen.add(normalizedValue);
      options.push({
        value: normalizedValue,
        label: String(label || formatThinkingLevelLabel(normalizedValue)).trim(),
      });
    };
    for (const entry of thinkingOptions.levels) {
      addOption(
        entry?.id,
        formatThinkingLevelLabel(entry?.label || entry?.id),
      );
    }
    if (
      explicitThinkingDefault &&
      !seen.has(explicitThinkingDefault)
    ) {
      addOption(
        explicitThinkingDefault,
        `${formatThinkingLevelLabel(explicitThinkingDefault)} (custom)`,
      );
    }
    if (pendingThinkingValue && !seen.has(pendingThinkingValue)) {
      // The optimistic value must be a renderable option or the select snaps
      // blank while the save is in flight.
      addOption(
        pendingThinkingValue,
        `${formatThinkingLevelLabel(pendingThinkingValue)} (custom)`,
      );
    }
    return options;
  }, [explicitThinkingDefault, pendingThinkingValue, thinkingOptions.levels]);

  return {
    authorizedModelOptions,
    canEditModel: modelsReady && !loadingModels,
    effectiveModel,
    effectiveModelEntry,
    handleClearModelOverride,
    handleSelectModel,
    handleSelectThinkingDefault,
    hasDistinctModelOverride,
    hasDistinctThinkingOverride,
    inheritedThinkingDefault,
    loading: !modelsReady || loadingModels,
    menuOpen,
    modelEntries,
    modelSaveError,
    pendingModelKey,
    popularModels,
    remainingModelOptions,
    retryModelSave,
    retryThinkingOptions,
    retryThinkingSave,
    setMenuOpen,
    showThinkingSelect,
    thinkingOptionsError,
    thinkingOptionsLoading,
    thinkingSaveError,
    thinkingSelectOptions,
    thinkingSelectValue,
    formatInheritedThinkingLabel,
    updatingModel,
    updatingThinking,
  };
};

import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import {
  fetchEnvVars,
  saveEnvVars,
  fetchModels,
  fetchModelStatus,
  setPrimaryModel,
  fetchCodexStatus,
  disconnectCodex,
  exchangeCodexOAuth,
} from "../lib/api.js";
import { showToast } from "./toast.js";
import { Badge } from "./badge.js";
import { SecretInput } from "./secret-input.js";
import { PageHeader } from "./page-header.js";
import { ActionButton } from "./action-button.js";
import { InlineErrorChip } from "./inline-error-chip.js";
import { invalidateCache, invalidateCachePrefix } from "../lib/api-cache.js";
import {
  kCodexStatusCacheKey,
  kEnvCacheKey,
  kModelsConfigCacheKey,
} from "../lib/cache-keys.js";
import { kModelCatalogCacheKey } from "../lib/model-catalog.js";
import {
  getModelProvider,
  getAuthProviderFromModelProvider,
  getFeaturedModels,
  kProviderAuthFields,
  kProviderLabels,
  kProviderOrder,
  kProviderFeatures,
  kCoreProviders,
} from "../lib/model-config.js";
import {
  isCodexAuthCallbackMessage,
  openCodexAuthWindow,
} from "../lib/codex-oauth-window.js";

const html = htm.bind(h);

const getKeyVal = (vars, key) => vars.find((v) => v.key === key)?.value || "";
const kAiCredentialKeys = Object.values(kProviderAuthFields)
  .flat()
  .map((field) => field.key)
  .filter((key, idx, arr) => arr.indexOf(key) === idx);
let kProvidersTabCache = null;

// Dirty-check merge (review remedy R4, stale-refresh-vs-drafts): a refresh must not clobber credential drafts typed
// while it was in flight. Server values win only where the local value still
// equals the last-saved baseline; a dirty draft the server list omits
// survives as a draft-only row.
export const mergeEnvVarsPreservingDrafts = (
  serverVars,
  draftVars,
  savedBaseline,
  credentialKeys = kAiCredentialKeys,
) => {
  const merged = serverVars.map((entry) => {
    if (!credentialKeys.includes(entry.key)) return entry;
    const draft = getKeyVal(draftVars, entry.key);
    const baseline = savedBaseline[entry.key] || "";
    return draft !== baseline ? { ...entry, value: draft } : entry;
  });
  for (const key of credentialKeys) {
    if (merged.some((entry) => entry.key === key)) continue;
    const draft = getKeyVal(draftVars, key);
    if (draft && draft !== (savedBaseline[key] || "")) {
      merged.push({ key, value: draft, editable: true });
    }
  }
  return merged;
};

const FeatureTags = ({ provider, features = null }) => {
  const resolvedFeatures = Array.isArray(features)
    ? features
    : kProviderFeatures[provider] || [];
  const uniqueFeatures = Array.from(new Set(resolvedFeatures));
  if (!uniqueFeatures.length) return null;
  return html`
    <div class="flex flex-wrap gap-1.5">
      ${uniqueFeatures.map(
        (f) => html`
          <span
            class="text-xs px-1.5 py-0.5 rounded-md bg-white/5 text-fg-muted"
            >${f}</span
          >
        `,
      )}
    </div>
  `;
};

export const Providers = ({ onRestartRequired = () => {} }) => {
  const [envVars, setEnvVars] = useState(
    () => kProvidersTabCache?.envVars || [],
  );
  const [models, setModels] = useState(() => kProvidersTabCache?.models || []);
  const [selectedModel, setSelectedModel] = useState(
    () => kProvidersTabCache?.selectedModel || "",
  );
  const [showAllModels, setShowAllModels] = useState(
    () => kProvidersTabCache?.showAllModels || false,
  );
  const [savingChanges, setSavingChanges] = useState(false);
  const [codexStatus, setCodexStatus] = useState(
    () => kProvidersTabCache?.codexStatus || { connected: false },
  );
  const [codexStatusError, setCodexStatusError] = useState(false);
  const [codexManualInput, setCodexManualInput] = useState("");
  const [codexExchanging, setCodexExchanging] = useState(false);
  const [codexAuthStarted, setCodexAuthStarted] = useState(false);
  const [codexAuthWaiting, setCodexAuthWaiting] = useState(false);
  const [codexDisconnecting, setCodexDisconnecting] = useState(false);
  const [codexDisconnectError, setCodexDisconnectError] = useState(null);
  const [modelsLoading, setModelsLoading] = useState(() => !kProvidersTabCache);
  const [modelsError, setModelsError] = useState(
    () => kProvidersTabCache?.modelsError || "",
  );
  const [ready, setReady] = useState(() => !!kProvidersTabCache);
  const [savedModel, setSavedModel] = useState(
    () => kProvidersTabCache?.savedModel || "",
  );
  const [modelDirty, setModelDirty] = useState(false);
  const [savedAiValues, setSavedAiValues] = useState(
    () => kProvidersTabCache?.savedAiValues || {},
  );
  const [showMoreProviders, setShowMoreProviders] = useState(false);
  const codexExchangeInFlightRef = useRef(false);
  const codexPopupPollRef = useRef(null);
  // Stale-guard (review remedy R4, latest-request-wins): only the latest refresh may apply; drafts are merged, not
  // clobbered. modelDirty mirrors into a ref so the async completion sees the
  // live dirty flag, not the one captured when the refresh started.
  const refreshIdRef = useRef(0);
  const modelDirtyRef = useRef(false);
  const savedAiValuesRef = useRef(kProvidersTabCache?.savedAiValues || {});

  const refresh = async () => {
    const refreshId = ++refreshIdRef.current;
    if (!ready) setModelsLoading(true);
    setModelsError("");
    try {
      const [env, modelCatalog, modelStatus, codex] = await Promise.all([
        fetchEnvVars(),
        fetchModels(),
        fetchModelStatus(),
        fetchCodexStatus(),
      ]);
      if (refreshIdRef.current !== refreshId) return;
      const serverVars = env.vars || [];
      const prevBaseline = savedAiValuesRef.current || {};
      let mergedVars = serverVars;
      setEnvVars((prevVars) => {
        mergedVars = mergeEnvVarsPreservingDrafts(
          serverVars,
          prevVars,
          prevBaseline,
        );
        return mergedVars;
      });
      const catalogModels = Array.isArray(modelCatalog.models)
        ? modelCatalog.models
        : [];
      setModels(catalogModels);
      const currentModel = modelStatus.modelKey || "";
      // Keep an in-flight model draft; the baseline still moves to server
      // truth, so a draft that now matches the server reads as clean.
      let mergedSelected = currentModel;
      setSelectedModel((prevSelected) => {
        mergedSelected = modelDirtyRef.current ? prevSelected : currentModel;
        return mergedSelected;
      });
      setSavedModel(currentModel);
      const nextModelDirty = mergedSelected !== currentModel;
      setModelDirty(nextModelDirty);
      modelDirtyRef.current = nextModelDirty;
      setCodexStatus(codex || { connected: false });
      setCodexStatusError(false);
      const nextSavedAiValues = Object.fromEntries(
        kAiCredentialKeys.map((key) => [key, getKeyVal(serverVars, key)]),
      );
      setSavedAiValues(nextSavedAiValues);
      savedAiValuesRef.current = nextSavedAiValues;
      const nextModelsError = catalogModels.length ? "" : "No models found";
      setModelsError(nextModelsError);
      kProvidersTabCache = {
        envVars: mergedVars,
        models: catalogModels,
        selectedModel: mergedSelected,
        savedModel: currentModel,
        savedAiValues: nextSavedAiValues,
        codexStatus: codex || { connected: false },
        showAllModels,
        modelsError: nextModelsError,
      };
    } catch (err) {
      if (refreshIdRef.current !== refreshId) return;
      setModelsError("Failed to load provider settings");
      showToast(`Failed to load provider settings: ${err.message}`, "error");
    } finally {
      if (refreshIdRef.current === refreshId) {
        setReady(true);
        setModelsLoading(false);
      }
    }
  };

  const refreshCodexConnection = async () => {
    try {
      const codex = await fetchCodexStatus();
      setCodexStatus(codex || { connected: false });
      setCodexStatusError(false);
      if (codex?.connected) {
        setCodexAuthStarted(false);
        setCodexAuthWaiting(false);
      }
      kProvidersTabCache = {
        ...(kProvidersTabCache || {}),
        codexStatus: codex || { connected: false },
      };
    } catch {
      // Keep the last-known status: a failed status CHECK must not fabricate
      // "Not connected" (in state or the tab cache) over a live auth.
      setCodexStatusError(true);
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  useEffect(
    () => () => {
      if (codexPopupPollRef.current) {
        clearInterval(codexPopupPollRef.current);
        codexPopupPollRef.current = null;
      }
    },
    [],
  );

  const submitCodexAuthInput = async (input) => {
    const normalizedInput = String(input || "").trim();
    if (!normalizedInput || codexExchangeInFlightRef.current) return;
    codexExchangeInFlightRef.current = true;
    setCodexManualInput(normalizedInput);
    setCodexExchanging(true);
    try {
      const result = await exchangeCodexOAuth(normalizedInput);
      if (!result.ok)
        throw new Error(result.error || "Codex OAuth exchange failed");
      setCodexManualInput("");
      showToast("Codex connected", "success");
      setCodexAuthStarted(false);
      setCodexAuthWaiting(false);
      invalidateCache(kCodexStatusCacheKey);
      await refreshCodexConnection();
    } catch (err) {
      setCodexAuthWaiting(false);
      showToast(err.message || "Codex OAuth exchange failed", "error");
    } finally {
      codexExchangeInFlightRef.current = false;
      setCodexExchanging(false);
    }
  };

  useEffect(() => {
    const onMessage = async (e) => {
      if (e.data?.codex === "success") {
        showToast("Codex connected", "success");
        await refreshCodexConnection();
      } else if (isCodexAuthCallbackMessage(e.data)) {
        await submitCodexAuthInput(e.data.input);
      } else if (e.data?.codex === "error") {
        showToast(
          `Codex auth failed: ${e.data.message || "unknown error"}`,
          "error",
        );
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [submitCodexAuthInput]);

  const setEnvValue = (key, value) => {
    setEnvVars((prev) => {
      const existing = prev.some((entry) => entry.key === key);
      const next = existing
        ? prev.map((v) => (v.key === key ? { ...v, value } : v))
        : [...prev, { key, value, editable: true }];
      kProvidersTabCache = { ...(kProvidersTabCache || {}), envVars: next };
      return next;
    });
  };

  const selectedModelProvider = getModelProvider(selectedModel);
  const selectedAuthProvider = getAuthProviderFromModelProvider(
    selectedModelProvider,
  );
  const primaryProvider = kProviderOrder.includes(selectedAuthProvider)
    ? selectedAuthProvider
    : kProviderOrder[0];
  const otherProviders = kProviderOrder.filter((p) => p !== primaryProvider);
  const featuredModels = getFeaturedModels(models);
  const baseModelOptions = showAllModels
    ? models
    : featuredModels.length > 0
      ? featuredModels
      : models;
  const selectedModelOption = models.find(
    (model) => model.key === selectedModel,
  );
  const modelOptions =
    selectedModelOption &&
    !baseModelOptions.some((model) => model.key === selectedModelOption.key)
      ? [...baseModelOptions, selectedModelOption]
      : baseModelOptions;
  const canToggleFullCatalog =
    featuredModels.length > 0 && models.length > featuredModels.length;

  const aiCredentialsDirty = kAiCredentialKeys.some(
    (key) => getKeyVal(envVars, key) !== (savedAiValues[key] || ""),
  );
  const hasSelectedProviderAuth =
    selectedModelProvider === "openai-codex"
      ? !!codexStatus.connected
      : (kProviderAuthFields[selectedAuthProvider] || []).some((field) =>
          Boolean(getKeyVal(envVars, field.key)),
        );
  const canSaveChanges =
    ready &&
    !savingChanges &&
    (aiCredentialsDirty || (modelDirty && hasSelectedProviderAuth));

  const saveChanges = async () => {
    if (savingChanges) return;
    if (!modelDirty && !aiCredentialsDirty) return;
    if (modelDirty && !hasSelectedProviderAuth) {
      showToast(
        "Add credentials for the selected model provider before saving model changes",
        "error",
      );
      return;
    }
    setSavingChanges(true);
    try {
      const targetModel = selectedModel;

      if (aiCredentialsDirty) {
        const payload = envVars
          .filter((v) => v.editable)
          .map((v) => ({ key: v.key, value: v.value }));
        const envResult = await saveEnvVars(payload);
        if (!envResult.ok)
          throw new Error(envResult.error || "Failed to save env vars");
        if (envResult.restartRequired) onRestartRequired(true);
        // Credentials feed model availability and codex discovery — drop
        // every cache a stale copy could resurface from.
        invalidateCache(kEnvCacheKey);
        invalidateCache(kModelCatalogCacheKey);
        invalidateCache(kCodexStatusCacheKey);
      }

      if (modelDirty && targetModel) {
        const modelResult = await setPrimaryModel(targetModel);
        if (!modelResult.ok)
          throw new Error(modelResult.error || "Failed to set primary model");
        // Prefix, not exact key: scoped "/api/models/config?agentId=..."
        // responses embed the GLOBAL primary this save just changed.
        invalidateCachePrefix(kModelsConfigCacheKey);
        invalidateCache(kModelCatalogCacheKey);
        const status = await fetchModelStatus();
        if (status?.ok === false) {
          throw new Error(status.error || "Failed to verify primary model");
        }
        const activeModel = status?.modelKey || "";
        if (activeModel && activeModel !== targetModel) {
          throw new Error(
            `Primary model did not apply. Expected ${targetModel} but active is ${activeModel}`,
          );
        }
        setSavedModel(targetModel);
        setModelDirty(false);
        modelDirtyRef.current = false;
        kProvidersTabCache = {
          ...(kProvidersTabCache || {}),
          selectedModel: targetModel,
          savedModel: targetModel,
        };
      }

      await refresh();
      showToast("Changes saved", "success");
    } catch (err) {
      showToast(err.message || "Failed to save changes", "error");
    } finally {
      setSavingChanges(false);
    }
  };

  // Shared by Connect AND Reconnect — no connected-guard here (Reconnect
  // exists precisely to redo the flow while connected).
  const startCodexAuth = () => {
    setCodexAuthStarted(true);
    setCodexAuthWaiting(true);
    const popup = openCodexAuthWindow();
    if (!popup || popup.closed) {
      setCodexAuthWaiting(false);
      return;
    }
    if (codexPopupPollRef.current) {
      clearInterval(codexPopupPollRef.current);
    }
    codexPopupPollRef.current = setInterval(() => {
      if (popup.closed) {
        clearInterval(codexPopupPollRef.current);
        codexPopupPollRef.current = null;
        setCodexAuthWaiting(false);
      }
    }, 500);
  };

  const completeCodexAuth = async () => {
    await submitCodexAuthInput(codexManualInput);
  };

  const handleCodexDisconnect = async () => {
    if (codexDisconnecting) return;
    setCodexDisconnecting(true);
    setCodexDisconnectError(null);
    try {
      const result = await disconnectCodex();
      if (!result.ok)
        throw new Error(result.error || "Failed to disconnect Codex");
      showToast("Codex disconnected", "success");
      setCodexAuthStarted(false);
      setCodexAuthWaiting(false);
      setCodexManualInput("");
      invalidateCache(kCodexStatusCacheKey);
      await refreshCodexConnection();
    } catch (err) {
      setCodexDisconnectError(err);
    } finally {
      setCodexDisconnecting(false);
    }
  };

  const renderCredentialField = (field) => html`
    <div class="space-y-1">
      <div class="flex items-center gap-3">
        <label class="text-xs font-medium text-fg-muted">${field.label}</label>
        ${field.url && !getKeyVal(envVars, field.key)
          ? html`<a
              href=${field.url}
              target="_blank"
              class="text-xs hover:underline"
              style="color: var(--accent-link)"
              >Get</a
            >`
          : null}
      </div>
      <${SecretInput}
        value=${getKeyVal(envVars, field.key)}
        onInput=${(e) => setEnvValue(field.key, e.target.value)}
        placeholder=${field.placeholder || ""}
        isSecret=${!field.isText}
        loading=${!ready}
        inputClass="flex-1 w-full bg-field border border-border rounded-lg px-3 py-2 text-sm text-body outline-none focus:border-fg-muted font-mono"
      />
      ${field.hint
        ? html`<p class="text-xs text-fg-dim">${field.hint}</p>`
        : null}
    </div>
  `;

  const renderCodexOAuth = () => html`
    <div class="border border-border rounded-lg p-3 space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-xs text-fg-muted">Codex OAuth</span>
        ${codexStatus.connected
          ? html`<${Badge} tone="success">Connected</${Badge}>`
          : html`<${Badge} tone="warning">Not connected</${Badge}>`}
      </div>
      ${codexStatusError
        ? html`<p class="text-xs text-status-warning-muted">
            Status check failed — showing the last known Codex status.
          </p>`
        : null}
      ${codexAuthStarted
        ? html`
            <div class="flex items-center justify-between gap-2">
              <p class="text-xs text-fg-muted">
                ${codexAuthWaiting
                  ? "Complete login in the popup. AlphaClaw should finish automatically, but you can paste the redirect URL below if it doesn't."
                  : "Paste the redirect URL from your browser to finish connecting."}
              </p>
              <button
                onclick=${startCodexAuth}
                class="text-xs font-medium px-3 py-1.5 rounded-lg ac-btn-secondary shrink-0"
              >
                Restart
              </button>
            </div>
          `
        : codexStatus.connected
        ? html`
            <div class="flex gap-2">
              <button
                onclick=${startCodexAuth}
                disabled=${codexDisconnecting}
                class="text-xs font-medium px-3 py-1.5 rounded-lg ac-btn-secondary"
              >
                Reconnect Codex
              </button>
              <${ActionButton}
                onClick=${handleCodexDisconnect}
                loading=${codexDisconnecting}
                tone="ghost"
                size="sm"
                idleLabel="Disconnect"
                loadingLabel="Disconnecting..."
                className="text-xs font-medium px-3 py-1.5"
              />
            </div>
          `
        : html`
              <button
                onclick=${startCodexAuth}
                disabled=${!ready}
                class="text-xs font-medium px-3 py-1.5 rounded-lg ac-btn-cyan"
              >
                Connect Codex OAuth
              </button>
            `}
      ${codexDisconnectError
        ? html`<${InlineErrorChip}
            error=${codexDisconnectError}
            headline="Couldn't disconnect Codex."
            onRetry=${handleCodexDisconnect}
          />`
        : null}
      ${codexAuthStarted
        ? html`
            <p class="text-xs text-fg-muted">
              After login, copy the full redirect URL (starts with
              <code class="text-xs bg-field px-1 rounded"
                >http://localhost:1455/auth/callback</code
              >) and paste it here.
            </p>
            <input
              type="text"
              value=${codexManualInput}
              onInput=${(e) => setCodexManualInput(e.target.value)}
              placeholder="http://localhost:1455/auth/callback?code=...&state=..."
              class="w-full bg-field border border-border rounded-lg px-3 py-2 text-xs text-body outline-none focus:border-fg-muted"
            />
            <${ActionButton}
              onClick=${completeCodexAuth}
              disabled=${!codexManualInput.trim() || codexExchanging}
              loading=${codexExchanging}
              tone="primary"
              size="sm"
              idleLabel="Complete Codex OAuth"
              loadingLabel="Completing..."
              className="text-xs font-medium px-3 py-1.5"
            />
          `
        : null}
    </div>
  `;

  const providerHasKey = (provider) => {
    const fields = kProviderAuthFields[provider] || [];
    return fields.some((f) => !!getKeyVal(envVars, f.key));
  };

  const renderProviderCard = (provider) => {
    const fields = kProviderAuthFields[provider] || [];
    const hasCodex = provider === "openai";
    const hasKey = providerHasKey(provider);
    const openAiFeatures = kProviderFeatures.openai || [];
    return html`
      <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
        <div class="flex items-center gap-2">
          <h3 class="font-semibold text-sm">
            ${kProviderLabels[provider] || provider}
          </h3>
          ${hasKey
            ? html`<span
                class="inline-block w-1.5 h-1.5 rounded-full bg-green-500"
              />`
            : null}
        </div>
        ${fields.map((field) => renderCredentialField(field))}
        ${provider === "openai"
          ? html`<${FeatureTags} features=${openAiFeatures} />`
          : null}
        ${hasCodex ? renderCodexOAuth() : null}
        ${provider !== "openai"
          ? html`<${FeatureTags} provider=${provider} />`
          : null}
      </div>
    `;
  };

  const renderPrimaryProviderContent = () => {
    const fields = kProviderAuthFields[primaryProvider] || [];
    const hasCodex = primaryProvider === "openai";
    return html`
      ${fields.map((field) => renderCredentialField(field))}
      ${hasCodex ? renderCodexOAuth() : null}
    `;
  };

  // Never a fetch-hostage frame (review remedy R5): the frame renders immediately — the model select is disabled and the
  // credential inputs show their loading affordance until hydration lands.
  return html`
    <div class="space-y-4">
      <${PageHeader}
        title="Providers"
        actions=${html`
          <${ActionButton}
            onClick=${saveChanges}
            disabled=${!canSaveChanges}
            loading=${savingChanges}
            tone="primary"
            size="sm"
            idleLabel="Save changes"
            loadingLabel="Saving..."
            className="transition-all"
          />
        `}
      />

      <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
        <h2 class="font-semibold text-sm">Primary Agent Model</h2>
        <select
          value=${selectedModel}
          disabled=${!ready}
          onInput=${(e) => {
            const next = e.target.value;
            setSelectedModel(next);
            const nextDirty = next !== savedModel;
            setModelDirty(nextDirty);
            modelDirtyRef.current = nextDirty;
            kProvidersTabCache = {
              ...(kProvidersTabCache || {}),
              selectedModel: next,
            };
          }}
          class="w-full bg-field border border-border rounded-lg pl-3 pr-8 py-2 text-sm text-body outline-none focus:border-fg-muted disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <option value="">Select a model</option>
          ${modelOptions.map(
            (model) =>
              html`<option value=${model.key}>
                ${model.label || model.key}
              </option>`,
          )}
        </select>
        <p class="text-xs text-fg-dim">
          ${modelsLoading
            ? "Loading model catalog..."
            : modelsError
              ? modelsError
              : ""}
        </p>
        ${canToggleFullCatalog
          ? html`
              <div>
                <button
                  type="button"
                  onclick=${() =>
                    setShowAllModels((prev) => {
                      const next = !prev;
                      kProvidersTabCache = {
                        ...(kProvidersTabCache || {}),
                        showAllModels: next,
                      };
                      return next;
                    })}
                  class="text-xs text-fg-muted hover:text-body"
                >
                  ${showAllModels
                    ? "Show recommended models"
                    : "Show full model catalog"}
                </button>
              </div>
            `
          : null}
        <div class="pt-2 border-t border-border space-y-3">
          ${renderPrimaryProviderContent()}
        </div>
      </div>

      ${otherProviders
        .filter((p) => kCoreProviders.has(p))
        .map((provider) => renderProviderCard(provider))}
      ${showMoreProviders
        ? otherProviders
            .filter((p) => !kCoreProviders.has(p))
            .map((provider) => renderProviderCard(provider))
        : null}
      ${otherProviders.some((p) => !kCoreProviders.has(p))
        ? html`
            <button
              type="button"
              onclick=${() => setShowMoreProviders((prev) => !prev)}
              class="w-full text-xs px-3 py-1.5 rounded-lg ac-btn-ghost"
            >
              ${showMoreProviders
                ? "Hide additional providers"
                : "More providers"}
            </button>
          `
        : null}
      ${modelDirty && !hasSelectedProviderAuth
        ? html`
            <p class="text-xs text-status-warning-muted">
              Set credentials for the selected provider before saving this model
              change.
            </p>
          `
        : null}
    </div>
  `;
};

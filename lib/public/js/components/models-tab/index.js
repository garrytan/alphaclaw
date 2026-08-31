import { h } from "preact";
import { useMemo } from "preact/hooks";
import htm from "htm";
import { PageHeader } from "../page-header.js";
import { LoadingSpinner } from "../loading-spinner.js";
import { ActionButton } from "../action-button.js";
import { PopActions } from "../pop-actions.js";
import { PaneShell } from "../pane-shell.js";
import { Badge } from "../badge.js";
import { TooltipBadge } from "../tooltip-badge.js";
import { useModels } from "./use-models.js";
import {
  buildProviderHasAuth,
  buildSyntheticModelEntry,
  getModelCatalogProvider,
  getModelsTabAuthProvider,
  getModelsTabRequiredAuthProviders,
  getProviderAuthDisplayOrder,
  getProviderSortIndex,
  SearchableModelPicker,
} from "./model-picker.js";
import { ProviderAuthCard } from "./provider-auth-card.js";
import {
  getFeaturedModels,
  withAlwaysAvailableModels,
} from "../../lib/model-config.js";

const html = htm.bind(h);

const deriveRequiredProviders = (configuredModels) => {
  const providers = new Set();
  for (const modelKey of Object.keys(configuredModels)) {
    for (const provider of getModelsTabRequiredAuthProviders(modelKey)) {
      providers.add(provider);
    }
  }
  return [...providers];
};

export const Models = ({ onRestartRequired = () => {}, agentId, embedded = false }) => {
  const {
    catalog,
    primary,
    configuredModels,
    authProfiles,
    authOrder,
    codexStatus,
    codexStatusError,
    codexStatusKnown,
    loading,
    saving,
    ready,
    error,
    isDirty,
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
  } = useModels(agentId);

  const configuredKeys = useMemo(
    () => new Set(Object.keys(configuredModels)),
    [configuredModels],
  );

  const selectableCatalog = useMemo(
    () => withAlwaysAvailableModels(catalog),
    [catalog],
  );

  const featuredModels = useMemo(
    () => getFeaturedModels(selectableCatalog),
    [selectableCatalog],
  );
  const popularPickerModels = useMemo(
    () => featuredModels.filter((model) => !configuredKeys.has(model.key)),
    [featuredModels, configuredKeys],
  );

  const pickerModels = useMemo(() => {
    return [...selectableCatalog]
      .filter((model) => !configuredKeys.has(model.key))
      .sort((a, b) => {
        const providerCompare =
          getProviderSortIndex(getModelCatalogProvider(a)) -
          getProviderSortIndex(getModelCatalogProvider(b));
        if (providerCompare !== 0) return providerCompare;
        return String(a.label || a.key).localeCompare(String(b.label || b.key));
      });
  }, [selectableCatalog, configuredKeys]);

  const requiredProviders = useMemo(
    () => deriveRequiredProviders(configuredModels),
    [configuredModels],
  );

  const sortedProviders = useMemo(() => {
    return getProviderAuthDisplayOrder(requiredProviders);
  }, [requiredProviders]);

  const providerHasAuth = useMemo(
    () => buildProviderHasAuth({ authProfiles, codexStatus }),
    [authProfiles, codexStatus],
  );

  const configuredModelEntries = useMemo(
    () =>
      Object.keys(configuredModels).map((key) => {
        const catalogEntry =
          selectableCatalog.find((m) => m.key === key) ||
          buildSyntheticModelEntry(key);
        const provider = getModelsTabAuthProvider(key);
        const hasAuth = !!providerHasAuth[provider];
        return {
          key,
          label: catalogEntry?.label || key,
          provider: catalogEntry?.provider || provider,
          isPrimary: key === primary,
          hasAuth,
        };
      }),
    [configuredModels, selectableCatalog, primary, providerHasAuth],
  );

  const headerActions = html`
    <${PopActions} visible=${isDirty}>
      <${ActionButton}
        onClick=${cancelChanges}
        disabled=${saving}
        tone="secondary"
        size="sm"
        idleLabel="Cancel"
        className="text-xs"
      />
      <${ActionButton}
        onClick=${saveAll}
        disabled=${saving}
        loading=${saving}
        loadingMode="inline"
        tone="primary"
        size="sm"
        idleLabel="Save changes"
        loadingLabel="Saving…"
        className="text-xs"
      />
    </${PopActions}>
  `;

  // Never a fetch-hostage frame (review remedy R5): the card structure renders immediately — while hydrating, the list
  // region shows a scoped loading line (never a confident "no models" empty
  // state) and the picker is disabled.
  const bodyContent = html`
    <!-- Configured Models -->
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <h2 class="card-label">Available Models</h2>

      ${!ready
        ? html`<div class="flex items-center gap-2 text-xs text-fg-muted">
            <${LoadingSpinner} className="h-3.5 w-3.5" />
            Loading model settings...
          </div>`
        : configuredModelEntries.length === 0
        ? html`<p class="text-xs text-fg-muted">
            No models configured. Add a model below.
          </p>`
        : html`
            <div class="space-y-1">
              ${configuredModelEntries.map(
                (entry) => html`
                  <div
                    class="flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-surface"
                  >
                    <div class="flex items-center gap-2 min-w-0">
                      <span class="text-sm text-body truncate"
                        >${entry.label}</span
                      >
                      ${entry.isPrimary
                        ? html`<${Badge} tone="cyan">Primary</${Badge}>`
                        : entry.hasAuth
                          ? html`
                              <button
                                onclick=${() => setPrimaryModel(entry.key)}
                                class="text-xs px-2 py-0.5 rounded-full text-fg-muted hover:text-body hover:bg-surface"
                              >
                                Set primary
                              </button>
                            `
                          : html`<${TooltipBadge}
                              tone="warning"
                              label="Authentication required"
                              text="This model's provider has no working credentials — connect it under Providers on this page."
                            />`}
                    </div>
                    <button
                      onclick=${() => removeModel(entry.key)}
                      class="text-xs text-fg-dim hover:text-status-error-muted shrink-0 px-1"
                    >
                      Remove
                    </button>
                  </div>
                `,
              )}
            </div>
          `}

      <div class="space-y-2">
        <${SearchableModelPicker}
          options=${pickerModels}
          popularModels=${popularPickerModels}
          configuredOptions=${configuredModelEntries}
          placeholder="Add model..."
          disabled=${!ready}
          onSelect=${(modelKey) => {
            addModel(modelKey);
            if (!primary) setPrimaryModel(modelKey);
          }}
        />
      </div>

      ${loading
        ? html`<p class="text-xs text-fg-dim">
            Loading model catalog...
          </p>`
        : error
          ? html`<p class="text-xs text-fg-dim">${error}</p>`
          : null}
    </div>

    <!-- Provider Auth -->
    ${sortedProviders.length > 0
      ? html`
          <div class="space-y-3">
            <h2 class="font-semibold text-base">
              Provider Authentication
            </h2>
            ${sortedProviders.map(
              (provider) => html`
                <${ProviderAuthCard}
                  provider=${provider}
                  authProfiles=${authProfiles}
                  authOrder=${authOrder}
                  codexStatus=${codexStatus}
                  codexStatusError=${codexStatusError}
                  codexStatusKnown=${codexStatusKnown}
                  onEditProfile=${editProfile}
                  onEditAuthOrder=${editAuthOrder}
                  getProfileValue=${getProfileValue}
                  getEffectiveOrder=${getEffectiveOrder}
                  onRefreshCodex=${refreshCodexStatus}
                />
              `,
            )}
          </div>
        `
      : null}
  `;

  if (embedded) {
    return html`
      <div class="space-y-4">
        <div class="flex items-center justify-end gap-2">
          ${headerActions}
        </div>
        ${bodyContent}
      </div>
    `;
  }

  return html`
    <${PaneShell}
      header=${html`<${PageHeader} title="Models" actions=${headerActions} />`}
    >
      ${bodyContent}
    </${PaneShell}>
  `;
};

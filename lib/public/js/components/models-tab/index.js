import { h } from "preact";
import { useMemo, useState } from "preact/hooks";
import htm from "htm";
import { RoutePageHeader } from "../page-header.js";
import { LoadingSpinner } from "../loading-spinner.js";
import { ActionButton } from "../action-button.js";
import { PopActions } from "../pop-actions.js";
import { PaneShell } from "../pane-shell.js";
import { Badge } from "../badge.js";
import { TooltipBadge } from "../tooltip-badge.js";
import { OverflowMenu, OverflowMenuItem } from "../overflow-menu.js";
import { useModels } from "./use-models.js";
import { useModelCheck } from "./use-model-check.js";
import {
  buildProviderHasAuth,
  buildSyntheticModelEntry,
  getModelCatalogProvider,
  getModelDisplayLabel,
  getModelsTabAuthProvider,
  getModelsTabRequiredAuthProviders,
  getProviderAuthDisplayOrder,
  getProviderSortIndex,
  SearchableModelPicker,
} from "./model-picker.js";
import { ProviderAuthCard } from "./provider-auth-card.js";
import { ProviderKeyGroupHeading, ProviderKeyRow } from "./provider-keys.js";
import {
  buildCheckSummary,
  buildModelRows,
  buildModelsHeadline,
  buildProviderKeyGroups,
  hasAnyProviderKey,
} from "./model.js";
import {
  getFeaturedModels,
  withAlwaysAvailableModels,
} from "../../lib/model-config.js";
import { buildStoreUnavailableLine } from "../../lib/store-availability.js";
import { formatLocaleDateTime } from "../../lib/format.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { kEnvCacheKey } from "../../lib/cache-keys.js";
import { fetchEnvVars } from "../../lib/api/envars.js";

const html = htm.bind(h);

const kAddModelInputId = "models-add-model";
const kChangeDefaultInputId = "models-change-default";

const deriveRequiredProviders = (configuredModels) => {
  const providers = new Set();
  for (const modelKey of Object.keys(configuredModels)) {
    for (const provider of getModelsTabRequiredAuthProviders(modelKey)) {
      providers.add(provider);
    }
  }
  return [...providers];
};

const focusById = (id) => globalThis.document?.getElementById?.(id)?.focus?.();

export const Models = ({ onRestartRequired = () => {}, agentId, agents = [], embedded = false }) => {
  const {
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
  } = useModels(agentId, { refreshCatalogOnMount: true });
  const modelCheck = useModelCheck();
  const envRead = useCachedFetch(kEnvCacheKey, fetchEnvVars, { maxAgeMs: 30000 });
  const [changingDefault, setChangingDefault] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

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

  const labelFor = (entry) => getModelDisplayLabel(entry?.label ? entry : buildSyntheticModelEntry(entry?.key));
  const modelRows = buildModelRows({
    configuredModels,
    catalog: selectableCatalog,
    primary,
    agents,
    lastRun: modelCheck.lastRun,
    running: modelCheck.running,
    labelFor,
  }).map((row) => ({ ...row, hasAuth: !!providerHasAuth[getModelsTabAuthProvider(row.key)] }));
  const primaryRow = modelRows.find((row) => row.isPrimary) || null;
  const defaultChoices = modelRows.filter((row) => !row.isPrimary && row.hasAuth);
  const headline = buildModelsHeadline({ ready, primary, primaryLabel: primaryRow?.label || "" });
  const checkSummary = buildCheckSummary({ lastRun: modelCheck.lastRun, loading: modelCheck.loading });

  const envVars = envRead.data?.vars || [];
  const keyGroups = buildProviderKeyGroups({
    vars: envVars,
    authProviders: sortedProviders,
    lastRun: modelCheck.lastRun,
  });
  const handleKeySaved = async (result) => {
    if (result?.restartRequired) onRestartRequired(true);
    await envRead.refresh?.({ force: true })?.catch?.(() => {});
  };

  const runCheck = () => {
    setMoreOpen(false);
    modelCheck.runCheck();
  };

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
    <${ActionButton}
      onClick=${() => focusById(kAddModelInputId)}
      disabled=${!ready}
      tone=${isDirty ? "secondary" : "solid"}
      size="sm"
      idleLabel="Add model"
      className="text-xs"
    />
    <span class="models-check-wide">
      <${ActionButton}
        onClick=${runCheck}
        disabled=${modelCheck.running}
        loading=${modelCheck.running}
        loadingMode="inline"
        tone="secondary"
        size="sm"
        idleLabel="Check models"
        loadingLabel="Checking…"
        className="text-xs"
      />
    </span>
    <span class="models-check-more">
      <${OverflowMenu}
        open=${moreOpen}
        ariaLabel="More model actions"
        onClose=${() => setMoreOpen(false)}
        onToggle=${() => setMoreOpen((open) => !open)}
      >
        <${OverflowMenuItem} onClick=${runCheck} disabled=${modelCheck.running}>
          ${modelCheck.running ? "Checking…" : "Check models"}
        </${OverflowMenuItem}>
      </${OverflowMenu}>
    </span>
  `;

  // Never a fetch-hostage frame (review remedy R5): the sections render at
  // once; while hydrating, the table shows a scoped loading line (never a
  // confident "no models" empty state) and the picker is disabled.
  const bodyContent = html`
    <section class="models-default" aria-label="Default model">
      <p class="models-headline">${headline}</p>
      ${ready && primary && defaultChoices.length > 0
        ? html`<${ActionButton}
            onClick=${() => {
              setChangingDefault(true);
              Promise.resolve().then(() => focusById(kChangeDefaultInputId));
            }}
            tone="secondary"
            size="sm"
            idleLabel="Change default"
          />`
        : null}
    </section>
    ${changingDefault
      ? html`<div class="models-change-default">
          <label class="text-xs text-fg-muted" for=${kChangeDefaultInputId}>New default model</label>
          <${SearchableModelPicker}
            inputId=${kChangeDefaultInputId}
            options=${defaultChoices}
            placeholder="Pick the new default…"
            onSelect=${(modelKey) => {
              setPrimaryModel(modelKey);
              setChangingDefault(false);
            }}
          />
          <${ActionButton} tone="ghost" size="sm" idleLabel="Cancel" onClick=${() => setChangingDefault(false)} />
        </div>`
      : null}

    <section class="models-section" aria-labelledby="models-heading">
      <h2 id="models-heading" class="models-section-title">Models</h2>
      ${!ready
        ? html`<div class="flex items-center gap-2 text-xs text-fg-muted">
            <${LoadingSpinner} className="h-3.5 w-3.5" />
            Loading model settings...
          </div>`
        : modelRows.length === 0
        ? html`<p class="text-sm text-fg-muted">
            No models yet. Add one to give your agents something to run on.
          </p>`
        : html`
            <table class="ac-table models-table">
              <thead>
                <tr>
                  <th scope="col">Model</th>
                  <th scope="col">Ref</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Used by</th>
                  <th scope="col">Check</th>
                  <th scope="col"><span class="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody>
                ${modelRows.map(
                  (entry) => html`
                    <tr key=${entry.key} data-model-key=${entry.key}>
                      <td class="ac-table-name models-cell-label">
                        <span class=${`models-label${entry.label === entry.key ? " font-mono" : ""}`}>${entry.label}</span>
                        ${entry.isPrimary
                          ? null
                          : authStoreUnavailable
                            ? html` <${Badge} tone="warning">Credential status unavailable</${Badge}>`
                            : entry.hasAuth
                              ? null
                              : html` <${TooltipBadge}
                                  tone="warning"
                                  label="Authentication required"
                                  text="This model's provider has no working credentials. Add its key under Provider keys on this page."
                                />`}
                      </td>
                      <td class="models-cell-ref"><span class="font-mono text-xs text-fg-muted">${entry.key}</span></td>
                      <td class="models-cell-meta" data-label="Provider">${entry.providerLabel}</td>
                      <td class="models-cell-meta" data-label="Used by">${entry.usedBy.length ? entry.usedBy.join(", ") : "—"}</td>
                      <td class="models-cell-meta models-cell-check" data-label="Check">
                        <span class=${"models-check models-check--" + entry.check.tone}>${entry.check.word}</span>
                        ${entry.check.fix ? html`<span class="models-check-fix">${entry.check.fix}</span>` : null}
                      </td>
                      <td class="models-cell-actions">
                        ${!entry.isPrimary && entry.hasAuth && !authStoreUnavailable
                          ? html`<button
                              type="button"
                              onclick=${() => setPrimaryModel(entry.key)}
                              class="models-row-action"
                            >
                              Make default
                            </button>`
                          : null}
                        ${entry.configured
                          ? html`<button
                              type="button"
                              onclick=${() => removeModel(entry.key)}
                              class="models-row-action"
                              aria-label=${"Remove " + entry.label}
                            >
                              Remove
                            </button>`
                          : null}
                      </td>
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
      <p class="text-xs text-fg-muted" role="status">${checkSummary}</p>
      ${modelCheck.error ? html`<p class="text-xs text-status-error-muted" role="alert">${modelCheck.error}</p>` : null}
      ${modelCheck.failures.length
        ? html`<div class="space-y-1">
            <p class="text-xs font-medium text-status-error-muted">Recent "model not found" failures</p>
            ${modelCheck.failures.slice(0, 5).map(
              (failure) => html`<p class="text-xs text-fg-muted break-words">
                <span class="font-mono text-body">${failure.model}</span> · ${formatLocaleDateTime(failure.at)}${failure.override
                  ? " · picked with /model, so fallbacks were off"
                  : ""}${failure.detail ? html`<br />${failure.detail}` : null}
              </p>`,
            )}
          </div>`
        : null}
      <div class="models-add">
        <label class="text-xs text-fg-muted" for=${kAddModelInputId}>Add a model</label>
        <${SearchableModelPicker}
          inputId=${kAddModelInputId}
          options=${pickerModels}
          popularModels=${popularPickerModels}
          configuredOptions=${modelRows}
          placeholder="Search models…"
          disabled=${!ready}
          onSelect=${(modelKey) => {
            addModel(modelKey);
            if (!primary) setPrimaryModel(modelKey);
          }}
        />
      </div>
      ${loading
        ? html`<p class="text-xs text-fg-muted">Loading model catalog...</p>`
        : error
          ? html`<p class="text-xs text-fg-muted">${error}</p>`
          : null}
    </section>

    <section class="models-section" aria-labelledby="provider-keys-heading">
      <div class="models-section-head">
        <h2 id="provider-keys-heading" class="models-section-title">Provider keys</h2>
        <a href="#/environment" class="text-xs ac-tip-link">Other variables are in Environment →</a>
      </div>
      ${authStoreUnavailable
        ? html`<p class="text-xs text-status-warning-muted" role="status">
            ${buildStoreUnavailableLine({
              payload: authStoreUnavailable,
              hasLastKnown: authProfiles.length > 0,
            })}
          </p>`
        : null}
      ${envRead.error && !envRead.data
        ? html`<p class="text-xs text-status-error-muted" role="alert">
            Couldn't load the provider keys. ${envRead.error?.message || ""}
          </p>`
        : null}
      ${envRead.data && !hasAnyProviderKey(keyGroups)
        ? html`<p class="text-sm text-fg-muted">
            No provider keys yet. Add the key for the provider of your default model.
          </p>`
        : null}
      ${!envRead.data && !envRead.error
        ? html`<p class="text-xs text-fg-muted">Loading provider keys…</p>`
        : null}
      ${keyGroups.map(
        (group) => html`
          <div key=${group.provider} class="provider-key-group" data-provider=${group.provider}>
            <${ProviderKeyGroupHeading} group=${group} />
            ${group.keys.length
              ? html`<ul class="provider-key-list">
                  ${group.keys.map(
                    (entry) => html`<${ProviderKeyRow} key=${entry.key} entry=${entry} onSaved=${handleKeySaved} />`,
                  )}
                </ul>`
              : null}
            ${group.authProviders.map(
              (provider) => html`
                <${ProviderAuthCard}
                  key=${provider}
                  provider=${provider}
                  authProfiles=${authProfiles}
                  authOrder=${authOrder}
                  authStoreUnavailable=${authStoreUnavailable}
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
        `,
      )}
    </section>
  `;

  if (embedded) {
    return html`
      <div class="models-page space-y-4">
        <div class="flex items-center justify-end gap-2">
          ${headerActions}
        </div>
        ${bodyContent}
      </div>
    `;
  }

  return html`
    <${PaneShell}
      wide=${true}
      header=${html`<${RoutePageHeader} routeId="models" actions=${headerActions} />`}
    >
      <div class="models-page">${bodyContent}</div>
    </${PaneShell}>
  `;
};

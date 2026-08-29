import { h } from "preact";
import htm from "htm";
import { Badge } from "../../badge.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import { LoadingSpinner } from "../../loading-spinner.js";
import { OverflowMenu, OverflowMenuItem } from "../../overflow-menu.js";
import { RowAccessorySelect } from "../../row-accessory-select.js";
import {
  getModelDisplayLabel,
  SearchableModelPicker,
} from "../../models-tab/model-picker.js";
import { useModelCard } from "./use-model-card.js";

const html = htm.bind(h);

export const AgentModelCard = ({
  agent = {},
  saving = false,
  onUpdateAgent = async () => {},
  onSwitchToModels = () => {},
}) => {
  const {
    authorizedModelOptions,
    canEditModel,
    effectiveModel,
    effectiveModelEntry,
    formatInheritedThinkingLabel,
    handleClearModelOverride,
    handleSelectModel,
    handleSelectThinkingDefault,
    hasDistinctModelOverride,
    hasDistinctThinkingOverride,
    inheritedThinkingDefault,
    loading,
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
    updatingModel,
    updatingThinking,
  } = useModelCard({
    agent,
    onUpdateAgent,
  });

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex items-start justify-between gap-3">
        <h3 class="card-label">Model</h3>
        <div class="flex items-center gap-2 min-h-6">
          ${!loading && effectiveModelEntry && !hasDistinctModelOverride
            ? html`<${Badge} tone="neutral">Inherited</${Badge}>`
            : null}
          <${OverflowMenu}
            open=${menuOpen}
            ariaLabel="Open model actions"
            title="Open model actions"
            onClose=${() => setMenuOpen(false)}
            onToggle=${() => setMenuOpen((current) => !current)}
          >
            ${!loading && hasDistinctModelOverride
              ? html`
                  <${OverflowMenuItem}
                    onClick=${() => {
                      setMenuOpen(false);
                      handleClearModelOverride();
                    }}
                  >
                    Inherit model from defaults
                  </${OverflowMenuItem}>
                `
              : null}
            ${!loading && hasDistinctThinkingOverride
              ? html`
                  <${OverflowMenuItem}
                    onClick=${() => {
                      setMenuOpen(false);
                      handleSelectThinkingDefault("");
                    }}
                  >
                    Inherit thinking from defaults
                  </${OverflowMenuItem}>
                `
              : null}
            <${OverflowMenuItem}
              onClick=${() => {
                setMenuOpen(false);
                onSwitchToModels();
              }}
            >
              Manage models
            </${OverflowMenuItem}>
          </${OverflowMenu}>
        </div>
      </div>
      ${loading
        ? html`
            <div class="flex items-center gap-2 text-sm text-fg-muted py-1">
              <${LoadingSpinner} className="h-4 w-4" />
              Loading model settings...
            </div>
          `
        : modelEntries.length === 0
          ? html`<p class="text-xs text-fg-muted">
              No authorized models available yet. Add one from the Models tab
              first.
            </p>`
          : html`
              <div class="space-y-1">
                ${modelEntries.map((entry) => {
                  const isPrimary = entry.key === effectiveModel;
                  const showThinkingPicker =
                    isPrimary && showThinkingSelect && !thinkingOptionsLoading;
                  return html`
                    <div
                      key=${entry.key}
                      class="flex items-center justify-between gap-3 py-1"
                    >
                      <div class="flex items-center gap-2 min-w-0">
                        <span class="text-sm text-body truncate">
                          ${getModelDisplayLabel(entry)}
                        </span>
                        ${isPrimary
                          ? html`<${Badge} tone="cyan">Primary</${Badge}>`
                          : html`
                              <button
                                type="button"
                                disabled=${saving || updatingModel}
                                onclick=${() => handleSelectModel(entry.key)}
                                class="text-xs px-2 py-0.5 rounded-full text-fg-muted hover:text-body hover:bg-surface disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                ${pendingModelKey === entry.key
                                  ? "Setting..."
                                  : "Set primary"}
                              </button>
                            `}
                      </div>
                      ${showThinkingPicker
                        ? html`
                            <div class="flex items-center gap-2 shrink-0">
                              ${updatingThinking
                                ? html`<span class="text-xs text-fg-muted"
                                    >Saving…</span
                                  >`
                                : null}
                              <${RowAccessorySelect}
                                ariaLabel="Agent thinking level"
                                title="Agent thinking level"
                                value=${thinkingSelectValue}
                                disabled=${saving ||
                                updatingModel ||
                                updatingThinking ||
                                !canEditModel}
                                onChange=${handleSelectThinkingDefault}
                              >
                                <option value="">
                                  ${formatInheritedThinkingLabel(
                                    inheritedThinkingDefault,
                                  )}
                                </option>
                                ${thinkingSelectOptions.map(
                                  (option) => html`
                                    <option value=${option.value}>
                                      ${option.label}
                                    </option>
                                  `,
                                )}
                              </${RowAccessorySelect}>
                            </div>
                          `
                        : null}
                    </div>
                  `;
                })}
                ${thinkingSaveError
                  ? html`
                      <${InlineErrorChip}
                        error=${thinkingSaveError.error}
                        headline="Couldn't confirm the thinking level — showing the server's current state."
                        onRetry=${retryThinkingSave}
                      />
                    `
                  : null}
                ${modelSaveError
                  ? html`
                      <${InlineErrorChip}
                        error=${modelSaveError.error}
                        headline="Couldn't update the agent model."
                        onRetry=${retryModelSave}
                      />
                    `
                  : null}
                ${thinkingOptionsError
                  ? html`
                      <p class="text-xs text-fg-muted">
                        Couldn't load thinking level options.
                        <button
                          type="button"
                          class="ml-1 underline hover:text-body"
                          onclick=${retryThinkingOptions}
                        >
                          Retry
                        </button>
                      </p>
                    `
                  : null}
              </div>
            `}
      ${loading
        ? null
        : remainingModelOptions.length > 0
          ? html`
              <div class="space-y-2">
                <${SearchableModelPicker}
                  options=${remainingModelOptions}
                  popularModels=${popularModels}
                  placeholder=${authorizedModelOptions.length > 0
                    ? "Add model..."
                    : "No authorized models available"}
                  onSelect=${handleSelectModel}
                  disabled=${saving ||
                  updatingModel ||
                  !canEditModel ||
                  remainingModelOptions.length === 0}
                />
                ${authorizedModelOptions.length === 0
                  ? html`
                      <p class="text-xs text-fg-muted">
                        Add and authorize models from the Models tab before
                        assigning one here.
                      </p>
                    `
                  : html`
                      <p class="text-xs text-fg-muted">
                        Only models that already have working auth are
                        available here.
                      </p>
                    `}
              </div>
            `
          : null}
    </div>
  `;
};

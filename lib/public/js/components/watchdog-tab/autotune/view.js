import { h } from "preact";
import htm from "htm";
import { copyTextToClipboard } from "../../../lib/clipboard.js";
import { ActionButton } from "../../action-button.js";
import { AsyncSection } from "../../async-section.js";
import { Badge } from "../../badge.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import { SavedToggle } from "../../saved-toggle.js";
import { showToast } from "../../toast.js";
import {
  kAutotuneEnabledContext,
  kAutotuneHeapContext,
  kAutotuneCardCopy,
  kAutotuneFootnote,
  kAutotuneMicroTierNote,
  kAutotuneOverridesExampleCommand,
  buildAutotuneMachineEcho,
  buildAutotuneCounts,
  pluralSettings,
  buildAutotuneSummaryModel,
  buildAutotuneEnvironmentNote,
  buildAutotuneRowModel,
  buildAutotuneResizeBanner,
  buildAutotuneRecommendationModel,
  buildAutotuneOverridesLine,
  buildAutotuneDisabledParagraph,
  describeAutotuneSaveError,
} from "./model.js";

const html = htm.bind(h);

const handleCopy = async (value, what) => {
  const copied = await copyTextToClipboard(value);
  showToast(
    copied ? `${what} copied` : `Could not copy ${what.toLowerCase()}`,
    copied ? "success" : "error",
  );
};

// Stacked setting row — NOT a table (tables don't survive phone widths, and
// self-hosters debug OOMs from phones). Reasons render inline, never
// tooltip-gated.
const AutotuneRow = ({ row, onRestartGateway, restartingGateway = false }) => html`
  <div class="py-2 space-y-0.5" data-knob=${row.knob}>
    <div class="flex flex-wrap items-center justify-between gap-2">
      <p class="text-sm text-body">${row.label}</p>
      <${Badge} tone=${row.chip.tone}>${row.chip.label}</${Badge}>
    </div>
    <p class="text-xs text-fg-muted">${row.valueLine}</p>
    ${row.effectiveLine
      ? html`<p class="text-xs text-fg-muted">${row.effectiveLine}</p>`
      : null}
    ${row.reasonLine
      ? html`<p
          class=${`text-xs ${row.reasonTone === "warning" ? "text-status-warning-muted" : "text-fg-muted"}`}
        >
          ${row.reasonLine}
        </p>`
      : null}
    ${row.showGatewayRestart && typeof onRestartGateway === "function"
      ? html`<button
          type="button"
          class="text-xs text-status-warning-muted hover:text-status-warning underline underline-offset-2 ${restartingGateway
            ? "opacity-50 cursor-not-allowed"
            : ""}"
          disabled=${restartingGateway}
          onclick=${onRestartGateway}
        >
          ${restartingGateway ? "Restarting gateway..." : "Restart gateway now"}
        </button>`
      : null}
  </div>
`;

// Presentational shell — every piece of state arrives as props so the
// per-state renders are directly testable (no hooks in here).
export const AutotuneCardView = ({
  ledger = null,
  error = null,
  onRetry = () => {},
  enabled = true,
  settingHydrated = false,
  settingSaving = false,
  settingSavingContext = null,
  settingSaveError = null,
  settingLoadError = null,
  onRetryLoadSetting = () => {},
  onToggleEnabled = () => {},
  heapDraftValue = "",
  heapDirty = false,
  onHeapInput = () => {},
  onHeapSave = () => {},
  reapplying = false,
  reapplyError = null,
  onReapply = () => {},
  dismissingResize = false,
  onDismissResize = () => {},
  onRestartGateway = null,
  restartingGateway = false,
}) => {
  const profile = ledger?.profile || null;
  const machineEcho = buildAutotuneMachineEcho(profile);
  const resizeBanner = ledger ? buildAutotuneResizeBanner(ledger) : null;
  const summary = ledger && enabled ? buildAutotuneSummaryModel(ledger) : null;
  const environmentNote =
    ledger && enabled ? buildAutotuneEnvironmentNote(ledger) : null;
  const recommendation =
    ledger && enabled ? buildAutotuneRecommendationModel(ledger) : null;
  const trigger = ledger?.trigger || null;
  const allRows = Array.isArray(ledger?.rows) ? ledger.rows : [];
  // The admin-heap recommendation renders as its own labeled row (item 7),
  // never among the tuned settings.
  const settingRows = allRows
    .filter((row) => row?.knob !== "adminHeapRecommendedMb")
    .map((row) => buildAutotuneRowModel(row, { trigger }));
  const counts = buildAutotuneCounts(allRows);
  const pendingNotice =
    enabled && counts.pendingGateway > 0
      ? `${pluralSettings(counts.pendingGateway)} waiting on a gateway restart.`
      : null;
  const overridesLine = buildAutotuneOverridesLine(ledger?.overrides);
  const heapSaving =
    settingSaving && settingSavingContext === kAutotuneHeapContext;
  const heapSaveError =
    settingSaveError && settingSaveError.context === kAutotuneHeapContext
      ? settingSaveError
      : null;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <h2 class="card-label">Resource autotune</h2>
        <${SavedToggle}
          value=${enabled}
          hydrated=${settingHydrated}
          saving=${settingSaving}
          savingContext=${settingSavingContext}
          saveError=${settingSaveError}
          loadError=${settingLoadError}
          onRetryLoad=${onRetryLoadSetting}
          onChange=${onToggleEnabled}
          describe=${describeAutotuneSaveError}
          context=${kAutotuneEnabledContext}
          disabled=${reapplying}
        />
      </div>

      ${ledger && error
        ? html`<${InlineErrorChip}
            error=${error}
            headline="Couldn't refresh autotune status — showing the last loaded values."
            onRetry=${onRetry}
          />`
        : null}
      ${!ledger
        ? html`<${AsyncSection}
            loading=${!error}
            loadingLabel="Loading autotune status..."
            error=${error}
            errorHeadline="Couldn't load autotune status."
            onRetry=${onRetry}
          />`
        : html`
            ${resizeBanner
              ? html`
                  <div
                    class="ac-surface-inset border border-yellow-500/35 rounded-lg px-3 py-2 flex flex-wrap items-center justify-between gap-2"
                  >
                    <p class="text-xs text-status-warning-muted min-w-0">
                      ${resizeBanner.text}
                    </p>
                    <div class="flex items-center gap-2 shrink-0">
                      ${resizeBanner.showRestart &&
                      typeof onRestartGateway === "function"
                        ? html`<button
                            type="button"
                            class="text-xs text-status-warning-muted hover:text-status-warning underline underline-offset-2 ${restartingGateway
                              ? "opacity-50 cursor-not-allowed"
                              : ""}"
                            disabled=${restartingGateway}
                            onclick=${onRestartGateway}
                          >
                            ${restartingGateway
                              ? "Restarting..."
                              : "Restart gateway"}
                          </button>`
                        : null}
                      <button
                        type="button"
                        class="text-xs text-fg-muted hover:text-body ${dismissingResize
                          ? "opacity-50 cursor-not-allowed"
                          : ""}"
                        disabled=${dismissingResize}
                        onclick=${onDismissResize}
                      >
                        ${dismissingResize ? "Dismissing..." : "Dismiss"}
                      </button>
                    </div>
                  </div>
                `
              : null}
            ${pendingNotice
              ? html`<p class="text-xs text-status-warning-muted">
                  ${pendingNotice}
                </p>`
              : null}

            <p class="text-xs text-fg-muted">${kAutotuneCardCopy}</p>

            ${machineEcho
              ? html`<p class="text-xs text-fg-muted">${machineEcho}</p>`
              : null}
            ${!enabled
              ? html`<p class="text-sm text-fg-muted">
                  ${buildAutotuneDisabledParagraph(
                    profile,
                    ledger?.activeGatewayEnv ?? null,
                  )}
                </p>`
              : html`
                  ${environmentNote
                    ? html`<p
                        class=${`text-xs ${environmentNote.tone === "warning" ? "text-status-warning-muted" : "text-fg-muted"}`}
                      >
                        ${environmentNote.text}
                      </p>`
                    : null}
                  ${summary
                    ? html`
                        <div class="flex flex-wrap items-center gap-2">
                          <p
                            class=${`text-sm ${summary.tone === "warning" ? "text-status-warning-muted" : "text-fg-muted"}`}
                          >
                            ${summary.text}
                          </p>
                          ${summary.partial
                            ? html`<${Badge} tone="warning">Partially applied</${Badge}>`
                            : null}
                        </div>
                      `
                    : html`<p class="text-sm text-fg-muted">
                        No tunings applied yet — they apply at boot.
                      </p>`}
                  ${profile?.tier === "micro"
                    ? html`<p class="text-xs text-status-warning-muted">
                        ${kAutotuneMicroTierNote}
                      </p>`
                    : null}
                  ${settingRows.length
                    ? html`
                        <div class="divide-y divide-border">
                          ${settingRows.map(
                            (row) => html`
                              <${AutotuneRow}
                                key=${row.knob}
                                row=${row}
                                onRestartGateway=${onRestartGateway}
                                restartingGateway=${restartingGateway}
                              />
                            `,
                          )}
                        </div>
                        <p class="text-xs text-fg-dim">${kAutotuneFootnote}</p>
                      `
                    : null}
                `}

            <div class="border-t border-border pt-3 space-y-2">
              ${overridesLine
                ? html`<p class="text-xs text-fg-muted">${overridesLine}</p>`
                : html`
                    <div class="flex flex-wrap items-center gap-2">
                      <p class="text-xs text-fg-muted">
                        Overrides: none set — pin a value via the API or the
                        OpenClaw agent
                      </p>
                      <button
                        type="button"
                        class="text-xs text-fg-muted hover:text-body underline underline-offset-2"
                        onclick=${() =>
                          handleCopy(
                            kAutotuneOverridesExampleCommand,
                            "Example command",
                          )}
                      >
                        Copy example command
                      </button>
                    </div>
                  `}
              <div class="flex flex-wrap items-center gap-2">
                <label class="text-xs text-fg-muted" for="autotune-heap-override">
                  Gateway heap override (MB)
                </label>
                <input
                  id="autotune-heap-override"
                  type="number"
                  min="128"
                  step="1"
                  inputmode="numeric"
                  placeholder="auto"
                  class="bg-field border border-border rounded-lg px-2 py-1 text-xs text-body w-28 focus:outline-none focus:border-fg-muted"
                  value=${heapDraftValue}
                  disabled=${!settingHydrated || settingSaving}
                  oninput=${onHeapInput}
                />
                <${ActionButton}
                  tone="secondary"
                  idleLabel="Save"
                  loadingLabel="Saving..."
                  loading=${heapSaving}
                  disabled=${!heapDirty || !settingHydrated}
                  onClick=${onHeapSave}
                />
              </div>
              <p class="text-xs text-fg-dim">
                Pins the gateway's V8 heap; leave the field empty to return to
                the derived value. Applies on the next gateway restart.
              </p>
              ${heapSaveError
                ? html`<${InlineErrorChip}
                    error=${heapSaveError.error}
                    headline="Couldn't save the gateway heap override — showing the server's current state."
                  />`
                : null}
            </div>

            ${recommendation && enabled
              ? html`
                  <div class="border-t border-border pt-3 space-y-1">
                    <p class="text-xs text-body">Recommendation</p>
                    <div class="flex flex-wrap items-center gap-2">
                      <p class="text-xs text-fg-muted min-w-0">
                        ${recommendation.text}
                      </p>
                      <button
                        type="button"
                        class="text-xs text-fg-muted hover:text-body underline underline-offset-2 shrink-0"
                        onclick=${() =>
                          handleCopy(recommendation.command, "Start command")}
                      >
                        Copy
                      </button>
                    </div>
                    <p class="text-xs text-fg-dim">${recommendation.owner}</p>
                  </div>
                `
              : null}
            ${enabled
              ? html`
                  <div class="border-t border-border pt-3 space-y-2">
                    <${ActionButton}
                      tone="secondary"
                      idleLabel="Recalculate and apply settings"
                      loadingLabel="Recalculating..."
                      loading=${reapplying}
                      disabled=${settingSaving}
                      onClick=${onReapply}
                    />
                    <p class="text-xs text-fg-dim">
                      Re-reads container limits and reapplies. Manual overrides
                      stay in place. Settings that need a gateway restart will
                      say so.
                    </p>
                    ${reapplyError
                      ? html`<${InlineErrorChip}
                          error=${reapplyError}
                          headline="Couldn't recalculate autotune settings."
                          onRetry=${onReapply}
                        />`
                      : null}
                  </div>
                `
              : null}
          `}
    </div>
  `;
};

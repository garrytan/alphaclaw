import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { LoadingSpinner } from "../loading-spinner.js";
import { DevCommitRow, VersionRow } from "./version-row.js";
import {
  buildStalenessLabel,
  kDevApplyImpactNote,
  kDevRequirementsNote,
} from "./helpers.js";

const html = htm.bind(h);

const CatalogSection = ({
  title = "",
  rows = [],
  channel = "stable",
  installedVersion = null,
  rowProps = {},
}) => html`
  <div>
    <h3 class="text-xs uppercase tracking-[0.18em] text-fg-muted mb-1">
      ${title}
    </h3>
    ${rows.length === 0
      ? html`<p class="text-xs text-fg-muted py-2">No versions listed.</p>`
      : rows.map(
          (row) => html`
            <${VersionRow}
              key=${row.version}
              row=${row}
              rows=${rows}
              channel=${channel}
              installedVersion=${installedVersion}
              ...${rowProps}
            />
          `,
        )}
  </div>
`;

const DevSection = ({
  dev = null,
  actionsDisabled = false,
  devAdvancedOpen = false,
  onToggleDevAdvanced = () => {},
  onRequestApply = () => {},
  rowProps = {},
}) => {
  const commits = Array.isArray(dev?.commits) ? dev.commits : [];
  return html`
    <div>
      <h3 class="text-xs uppercase tracking-[0.18em] text-fg-muted mb-1">Dev</h3>
      <div class="ac-surface-inset border border-border rounded-lg p-3 space-y-2">
        <p class="text-xs text-fg-muted">Requirements: ${kDevRequirementsNote}</p>
        <div class="flex flex-wrap items-center gap-2">
          <${ActionButton}
            onClick=${() =>
              onRequestApply({
                payload: { channel: "dev", devHead: true },
                label: "latest dev (main HEAD)",
                isDowngrade: false,
              })}
            tone="primary"
            idleLabel="Latest dev (main HEAD)"
            disabled=${actionsDisabled}
          />
          <span class="text-xs text-fg-muted">${kDevApplyImpactNote}</span>
        </div>
      </div>
      <div class="mt-2">
        <button
          type="button"
          class="text-xs text-fg-muted hover:text-body"
          onclick=${onToggleDevAdvanced}
          aria-expanded=${devAdvancedOpen ? "true" : "false"}
        >
          ${devAdvancedOpen ? "▾" : "▸"} Advanced: pin a specific commit
        </button>
        ${devAdvancedOpen
          ? html`
              <div class="mt-1">
                ${commits.length === 0
                  ? html`<p class="text-xs text-fg-muted py-2">
                      No dev commits listed.
                    </p>`
                  : commits.map(
                      (commit) => html`
                        <${DevCommitRow}
                          key=${commit.sha}
                          commit=${commit}
                          onRequestApply=${onRequestApply}
                          ...${rowProps}
                        />
                      `,
                    )}
                ${dev?.truncated
                  ? html`<p class="text-xs text-fg-muted mt-1">
                      List truncated — older commits are not shown.
                    </p>`
                  : null}
              </div>
            `
          : null}
      </div>
    </div>
  `;
};

export const UpgradeCatalogCard = ({
  catalog = null,
  catalogError = null,
  loadingCatalog = false,
  refreshingCatalog = false,
  nowMs = Date.now(),
  installedVersion = null,
  actionsDisabled = false,
  onCheckNow = () => {},
  devAdvancedOpen = false,
  onToggleDevAdvanced = () => {},
  onRequestApply = () => {},
  onClearBlocklist = () => {},
  clearingBlocklistId = null,
  lastClearedId = null,
  expandedNotesId = null,
  onToggleNotes = () => {},
}) => {
  const rowProps = {
    actionsDisabled,
    lastClearedId,
    clearingBlocklistId,
    onRequestApply,
    onClearBlocklist,
    expandedNotesId,
    onToggleNotes,
  };
  const degraded = catalog?.degraded || null;
  const isDegraded = Boolean(degraded?.github || degraded?.npm);
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <h2 class="card-label">Version catalog</h2>
          ${catalog
            ? html`<span class="text-xs text-fg-muted">
                ${buildStalenessLabel(catalog.staleAsOf, nowMs)}
              </span>`
            : null}
        </div>
        <${ActionButton}
          onClick=${onCheckNow}
          tone="subtle"
          idleLabel="Check now"
          loadingLabel="Checking..."
          loading=${refreshingCatalog}
          disabled=${actionsDisabled && !refreshingCatalog}
        />
      </div>

      ${loadingCatalog && !catalog && !catalogError
        ? html`
            <div class="flex items-center gap-2 text-sm text-fg-muted py-4">
              <${LoadingSpinner} className="h-4 w-4" />
              Loading version catalog...
            </div>
          `
        : null}

      ${catalogError && !catalog
        ? html`
            <div class="ac-surface-inset border border-border rounded-lg p-3 space-y-1">
              <p class="text-sm text-status-error">${catalogError.message}</p>
              ${catalogError.hint
                ? html`<p class="text-xs text-fg-muted">${catalogError.hint}</p>`
                : null}
            </div>
          `
        : null}

      ${catalog && isDegraded
        ? html`<p class="text-xs text-status-warning-muted">
            Catalog sources are degraded
            (${[degraded?.github ? "github" : null, degraded?.npm ? "npm" : null]
              .filter(Boolean)
              .join(", ")}) — showing the last data we have.
          </p>`
        : null}

      ${catalog
        ? html`
            <${CatalogSection}
              title="Stable"
              rows=${Array.isArray(catalog.stable) ? catalog.stable : []}
              channel="stable"
              installedVersion=${installedVersion}
              rowProps=${rowProps}
            />
            <${CatalogSection}
              title="Beta"
              rows=${Array.isArray(catalog.beta) ? catalog.beta : []}
              channel="beta"
              installedVersion=${installedVersion}
              rowProps=${rowProps}
            />
            <${DevSection}
              dev=${catalog.dev}
              actionsDisabled=${actionsDisabled}
              devAdvancedOpen=${devAdvancedOpen}
              onToggleDevAdvanced=${onToggleDevAdvanced}
              onRequestApply=${onRequestApply}
              rowProps=${rowProps}
            />
          `
        : null}
    </div>
  `;
};

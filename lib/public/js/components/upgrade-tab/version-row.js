import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { renderMarkdownSafe } from "../../lib/safe-markdown.js";
import {
  buildBlocklistDetail,
  buildRowBadges,
  formatDateOnly,
  formatShortSha,
  getRowActionModel,
  kDevUntestedCaveat,
  kNotesUnavailableLabel,
} from "./helpers.js";

const html = htm.bind(h);

const RowBadges = ({ badges = [] }) =>
  badges.map(
    (badge) => html`
      <${Badge} key=${badge.id} tone=${badge.tone}>${badge.label}</${Badge}>
    `,
  );

const BlocklistNotice = ({
  blocklisted = null,
  rowId = "",
  clearing = false,
  onClearBlocklist = () => {},
  disabled = false,
}) => {
  if (!blocklisted) return null;
  return html`
    <div class="mt-1 flex flex-wrap items-center gap-2">
      <span class="text-xs text-status-error-muted">
        Blocklisted — ${buildBlocklistDetail(blocklisted)}
      </span>
      <${ActionButton}
        onClick=${() => onClearBlocklist(rowId)}
        tone="subtle"
        idleLabel="Clear"
        loadingLabel="Clearing..."
        loading=${clearing}
        disabled=${disabled && !clearing}
      />
    </div>
  `;
};

const ReleaseNotes = ({
  row = {},
  rowId = "",
  expandedNotesId = null,
  onToggleNotes = () => {},
}) => {
  if (row.notesUnavailable) {
    return html`<p class="mt-1 text-xs text-fg-muted italic">
      ${kNotesUnavailableLabel}
    </p>`;
  }
  if (!row.notes) return null;
  const expanded = expandedNotesId === rowId;
  return html`
    <div class="mt-1">
      <button
        type="button"
        class="text-xs text-fg-muted hover:text-body"
        onclick=${() => onToggleNotes(rowId)}
        aria-expanded=${expanded ? "true" : "false"}
      >
        ${expanded ? "Hide release notes" : "Release notes"}
      </button>
      ${expanded
        ? html`<div
            class="mt-2 bg-field rounded p-2 text-xs break-words max-h-64 overflow-auto release-notes-preview"
            dangerouslySetInnerHTML=${{ __html: renderMarkdownSafe(row.notes) }}
          ></div>`
        : null}
    </div>
  `;
};

// One stable/beta catalog row: version, publish date, badges, notes, action.
export const VersionRow = ({
  row = {},
  rows = [],
  channel = "stable",
  installedVersion = null,
  actionsDisabled = false,
  applyDisabled = false,
  lastClearedId = null,
  clearingBlocklistId = null,
  onRequestApply = () => {},
  onClearBlocklist = () => {},
  expandedNotesId = null,
  onToggleNotes = () => {},
}) => {
  const badges = buildRowBadges(row);
  const action = getRowActionModel({ row, rows, installedVersion });
  const rowId = row.version || "";
  const isBlocklisted = Boolean(row.blocklisted);
  const actionLabel =
    lastClearedId && lastClearedId === rowId ? "Try again" : action.label;
  return html`
    <div class="py-2.5 border-t border-border first:border-t-0">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex flex-wrap items-center gap-2 min-w-0">
          <span class="text-sm font-medium text-body">${row.version}</span>
          <span class="text-xs text-fg-muted">
            ${formatDateOnly(row.publishedAt, "")}
          </span>
          <${RowBadges} badges=${badges} />
        </div>
        ${!row.current && !isBlocklisted
          ? html`
              <${ActionButton}
                onClick=${() =>
                  onRequestApply({
                    payload:
                      row.applyPayload || { channel, version: row.version },
                    label: row.version,
                    isDowngrade: action.isDowngrade,
                  })}
                tone=${action.isDowngrade ? "warning" : "secondary"}
                idleLabel=${actionLabel}
                disabled=${actionsDisabled || applyDisabled}
              />
            `
          : null}
      </div>
      <${BlocklistNotice}
        blocklisted=${row.blocklisted}
        rowId=${rowId}
        clearing=${clearingBlocklistId === rowId}
        onClearBlocklist=${onClearBlocklist}
        disabled=${actionsDisabled}
      />
      <${ReleaseNotes}
        row=${row}
        rowId=${rowId}
        expandedNotesId=${expandedNotesId}
        onToggleNotes=${onToggleNotes}
      />
    </div>
  `;
};

// One dev commit row (inside "Advanced: pin a specific commit").
export const DevCommitRow = ({
  commit = {},
  actionsDisabled = false,
  applyDisabled = false,
  lastClearedId = null,
  clearingBlocklistId = null,
  onRequestApply = () => {},
  onClearBlocklist = () => {},
}) => {
  const badges = buildRowBadges(commit);
  const rowId = commit.sha || "";
  const shortSha = commit.shortSha || formatShortSha(commit.sha);
  const isBlocklisted = Boolean(commit.blocklisted);
  const actionLabel =
    lastClearedId && lastClearedId === rowId ? "Try again" : "Switch";
  return html`
    <div class="py-2.5 border-t border-border first:border-t-0">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="flex flex-wrap items-center gap-2">
            <code class="text-xs font-mono text-body">${shortSha}</code>
            <span class="text-xs text-fg-muted">
              ${formatDateOnly(commit.date, "")}
            </span>
            <${RowBadges} badges=${badges} />
            <${Badge} tone="neutral">${kDevUntestedCaveat}</${Badge}>
          </div>
          <p class="mt-0.5 text-xs text-fg-muted truncate">${commit.subject || ""}</p>
        </div>
        ${!commit.current && !isBlocklisted
          ? html`
              <${ActionButton}
                onClick=${() =>
                  onRequestApply({
                    payload:
                      commit.applyPayload || { channel: "dev", sha: commit.sha },
                    label: `dev ${shortSha}`,
                    isDowngrade: false,
                  })}
                tone="secondary"
                idleLabel=${actionLabel}
                disabled=${actionsDisabled || applyDisabled}
              />
            `
          : null}
      </div>
      <${BlocklistNotice}
        blocklisted=${commit.blocklisted}
        rowId=${rowId}
        clearing=${clearingBlocklistId === rowId}
        onClearBlocklist=${onClearBlocklist}
        disabled=${actionsDisabled}
      />
    </div>
  `;
};

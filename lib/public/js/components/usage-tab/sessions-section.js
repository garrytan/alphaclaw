import { h } from "preact";
import htm from "htm";
import {
  formatDurationCompactMs,
  formatInteger,
  formatLocaleDateTimeWithTodayTime,
  formatUsd,
} from "../../lib/format.js";
import { kBadgeToneClass } from "./constants.js";
import { AsyncSection } from "../async-section.js";
import { InlineErrorChip } from "../inline-error-chip.js";

const html = htm.bind(h);

const formatCountLabel = (value, singular, plural) => {
  const count = Number(value || 0);
  const label = count === 1 ? singular : plural;
  return `${formatInteger(count)} ${label}`;
};

const SessionBadges = ({ session }) => {
  const labels = session?.labels;
  if (!Array.isArray(labels) || labels.length === 0) {
    const fallback = String(session?.sessionKey || session?.sessionId || "");
    return html`<span class="truncate">${fallback}</span>`;
  }
  return html`
    <span class="inline-flex items-center gap-1.5 flex-wrap">
      ${labels.map(
        (badge) => html`
          <span
            class=${`inline-flex items-center px-1.5 py-0.5 rounded border text-xs leading-tight ${kBadgeToneClass[badge.tone] || kBadgeToneClass.gray}`}
          >
            ${badge.label}
          </span>
        `,
      )}
    </span>
  `;
};

const SessionInlineDetail = ({
  item,
  expandedSessionIds,
  loadingDetailById,
  sessionDetailById,
}) => {
  const itemSessionId = String(item.sessionId || "");
  const isExpanded = expandedSessionIds.includes(itemSessionId);
  if (!isExpanded) return null;
  const detail = sessionDetailById[itemSessionId];
  const loadingDetail = !!loadingDetailById[itemSessionId];
  if (loadingDetail) {
    return html`
      <div class="ac-history-body">
        <p class="text-xs text-fg-muted">Loading session detail…</p>
      </div>
    `;
  }
  if (detail?.status === "error") {
    return html`
      <div class="ac-history-body">
        <p class="text-xs text-status-error-muted">
          ${detail.message || "Could not load session detail."} Close and
          reopen to retry.
        </p>
      </div>
    `;
  }
  if (!detail) {
    return html`
      <div class="ac-history-body">
        <p class="text-xs text-fg-muted">Session detail not available.</p>
      </div>
    `;
  }
  const sessionKeyValue = String(
    detail.sessionKey || item.sessionKey || detail.sessionId || item.sessionId || "",
  ).trim();
  return html`
    <div class="ac-history-body space-y-3 border-0 pt-0 mt-0">
      <div>
        <p class="text-xs text-fg-muted mb-1">Session key</p>
        <p class="text-xs text-body font-mono break-all">${sessionKeyValue || "n/a"}</p>
      </div>
      <div class="mt-1.5">
        <p class="text-xs text-fg-muted mb-1">Model breakdown</p>
        ${(detail.modelBreakdown || []).length === 0
          ? html`<p class="text-xs text-fg-muted">No model usage recorded.</p>`
          : html`
              <div class="space-y-1.5">
                ${(detail.modelBreakdown || []).map(
                  (row) => html`
                    <div class="flex items-center justify-between gap-3 text-xs px-1 py-0.5 rounded hover:bg-surface transition-colors">
                      <span class="text-body truncate">${row.model || "unknown"}</span>
                      <span class="inline-flex items-center gap-3 text-fg-muted shrink-0">
                        <span>${formatInteger(row.totalTokens)} tok</span>
                        <span>${formatUsd(row.totalCost)}</span>
                        <span>${formatCountLabel(row.turnCount, "turn", "turns")}</span>
                      </span>
                    </div>
                  `,
                )}
              </div>
            `}
      </div>
      <div>
        <p class="text-xs text-fg-muted mb-1">Tool usage</p>
        ${(detail.toolUsage || []).length === 0
          ? html`<p class="text-xs text-fg-muted">No tool calls recorded.</p>`
          : html`
              <div class="space-y-1.5">
                ${(detail.toolUsage || []).map(
                  (row) => html`
                    <div class="flex items-center justify-between gap-3 text-xs px-1 py-0.5 rounded hover:bg-surface transition-colors">
                      <span class="text-body truncate">${row.toolName}</span>
                      <span class="inline-flex items-center gap-3 text-fg-muted shrink-0">
                        <span>${formatCountLabel(row.callCount, "call", "calls")}</span>
                        <span>${(Number(row.errorRate || 0) * 100).toFixed(1)}% err</span>
                        <span>${formatDurationCompactMs(row.avgDurationMs)}</span>
                      </span>
                    </div>
                  `,
                )}
              </div>
            `}
      </div>
    </div>
  `;
};

// Sessions as a real table: the first cell toggles the row's detail, which
// opens on its own full-width row beneath it.
export const SessionsSection = ({
  sessions = [],
  loadingSessions = false,
  sessionsError = null,
  onRetry = () => {},
  expandedSessionIds = [],
  loadingDetailById = {},
  sessionDetailById = {},
  onToggleSession = () => {},
}) => html`
  <section class="usage-card" aria-labelledby="usage-sessions-title">
    <div class="usage-card-head">
      <h2 class="usage-card-title" id="usage-sessions-title">Sessions</h2>
    </div>
    ${sessions.length > 0 && sessionsError
      ? html`<${InlineErrorChip}
          error=${sessionsError}
          headline="Couldn't refresh sessions — showing the last loaded list."
          onRetry=${onRetry}
        />`
      : null}
    <${AsyncSection}
      loading=${loadingSessions && sessions.length === 0}
      loadingLabel="Loading…"
      error=${sessions.length === 0 ? sessionsError : null}
      errorHeadline="Couldn't load sessions."
      onRetry=${onRetry}
      empty=${sessions.length === 0}
      emptyTitle="No sessions yet"
      emptyBody="Sessions appear here after your agents' first turns."
    >
      <table class="ac-table usage-sessions-table">
        <thead>
          <tr>
            <th scope="col">Session</th>
            <th scope="col" class="ac-table-num">Tokens</th>
            <th scope="col" class="ac-table-num">Spend</th>
            <th scope="col" class="ac-table-num">Last activity</th>
          </tr>
        </thead>
        <tbody>
          ${sessions.map((item) => {
            const itemSessionId = String(item.sessionId || "");
            const expanded = expandedSessionIds.includes(itemSessionId);
            return html`
              <tr key=${itemSessionId} class=${expanded ? "is-expanded" : ""}>
                <td data-label="Session" class="ac-table-name">
                  <button
                    type="button"
                    class="usage-session-toggle"
                    aria-expanded=${expanded ? "true" : "false"}
                    onclick=${() => onToggleSession(itemSessionId, !expanded)}
                  >
                    <span class="ac-history-toggle shrink-0" aria-hidden="true">${expanded ? "▾" : "▸"}</span>
                    <${SessionBadges} session=${item} />
                  </button>
                </td>
                <td data-label="Tokens" class="ac-table-num">${formatInteger(item.totalTokens)}</td>
                <td data-label="Spend" class="ac-table-num">${formatUsd(item.totalCost)}</td>
                <td data-label="Last activity" class="ac-table-num">
                  ${formatLocaleDateTimeWithTodayTime(item.lastActivityMs, {
                    fallback: "n/a",
                    valueIsEpochMs: true,
                  })}
                </td>
              </tr>
              ${expanded
                ? html`<tr key=${itemSessionId + "-detail"} class="ac-table-detail">
                    <td colspan="4">
                      <${SessionInlineDetail}
                        item=${item}
                        expandedSessionIds=${expandedSessionIds}
                        loadingDetailById=${loadingDetailById}
                        sessionDetailById=${sessionDetailById}
                      />
                    </td>
                  </tr>`
                : null}
            `;
          })}
        </tbody>
      </table>
    </${AsyncSection}>
  </section>
`;

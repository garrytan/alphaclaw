import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import htm from "htm";
import { Badge } from "../../badge.js";
import { PillTabs } from "../../pill-tabs.js";
import { getIncidentStatusTone } from "../helpers.js";
import { buildIncidentCardModel, describeEvent } from "./helpers.js";
import {
  kIncidentsTabEvents,
  kIncidentsTabIncidents,
} from "./use-incidents.js";
import {
  formatLocaleDateTimeWithTodayTime,
  formatRelativeTime,
} from "../../../lib/format.js";

const html = htm.bind(h);

// Timeline dot tones (same palette as upgrade-tab/timeline-card.js).
const kDotClassByTone = {
  success: "bg-green-500/90",
  danger: "bg-red-500/90",
  warning: "bg-yellow-400/90",
  info: "bg-cyan-400/90",
  neutral: "bg-gray-500/60",
};

const IncidentTimeline = ({ detail = null }) => {
  if (!detail || detail.loading) {
    return html`<p class="text-xs text-fg-muted mt-2">Loading events...</p>`;
  }
  if (detail.error) {
    return html`<p class="text-xs text-status-error-muted mt-2">
      ${detail.error}
    </p>`;
  }
  const events = detail.events || [];
  if (!events.length) {
    return html`<p class="text-xs text-fg-muted mt-2">
      Events for this incident have been pruned; the summary above is the
      surviving record.
    </p>`;
  }
  return html`
    <div class="mt-2 space-y-1.5">
      ${events.map((event) => {
        const described = describeEvent(event);
        return html`
          <div key=${event.id} class="flex items-start gap-2 text-xs">
            <span
              class=${`mt-1 h-2 w-2 shrink-0 rounded-full ${kDotClassByTone[described.tone] || kDotClassByTone.neutral}`}
              aria-label=${described.tone}
            ></span>
            <span class="text-fg-muted min-w-0">
              <span class="text-body">${described.label}</span>
              ${described.detail
                ? html`<span> — ${described.detail}</span>`
                : null}
              <span
                class="ml-1 text-fg-dim"
                title=${event.createdAt || ""}
              >
                ${formatLocaleDateTimeWithTodayTime(event.createdAt)}
              </span>
            </span>
          </div>
        `;
      })}
      ${detail.truncated
        ? html`<p class="text-xs text-fg-dim">
            ${detail.omittedCount} later event${detail.omittedCount === 1 ? "" : "s"}
            omitted — the summary carries the outcome.
          </p>`
        : null}
    </div>
  `;
};

const IncidentCard = ({
  incident = null,
  nowMs = Date.now(),
  expanded = false,
  highlighted = false,
  detail = null,
  overseerChip = null,
  onToggle = () => {},
}) => {
  const model = buildIncidentCardModel(incident, nowMs);
  const cardRef = useRef(null);

  // Deep-link arrival: scroll to and visibly mark the anchored incident.
  useEffect(() => {
    if (highlighted && cardRef.current?.scrollIntoView) {
      cardRef.current.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [highlighted]);

  if (!model) return null;
  return html`
    <details
      ref=${cardRef}
      class=${`ac-surface-inset border rounded-lg p-3 ${
        highlighted ? "border-cyan-500/60" : "border-border"
      }`}
      open=${expanded}
      ontoggle=${(event) => onToggle(model.id, !!event.target?.open)}
    >
      <summary class="cursor-pointer list-none">
        <div class="flex items-center justify-between gap-2">
          <span class="inline-flex items-center gap-2 min-w-0">
            ${model.open
              ? html`<span
                  class="h-2 w-2 shrink-0 rounded-full bg-yellow-400 animate-pulse"
                  aria-label="ongoing incident"
                ></span>`
              : null}
            <span class="text-sm text-body truncate">${model.title}</span>
            <${Badge} tone=${model.badgeTone}>${model.badgeLabel}</${Badge}>
          </span>
          <span
            class="text-xs text-fg-muted shrink-0"
            title=${model.openedAt || ""}
          >
            ${model.openedAgo}
          </span>
        </div>
        <div class="mt-1 text-xs text-fg-muted">
          ${model.outcome}
          ${model.eventCount ? ` · ${model.eventCount} events` : ""}
          ${model.eventsPruned ? " · events pruned" : ""}
        </div>
        ${overseerChip}
      </summary>
      <${IncidentTimeline} detail=${detail} />
    </details>
  `;
};

const kHistoryTabs = [
  { value: kIncidentsTabIncidents, label: "Incidents" },
  { value: kIncidentsTabEvents, label: "All events" },
];

export const WatchdogIncidentsCard = ({
  activeTab = kIncidentsTabIncidents,
  onSelectTab = () => {},
  incidents = [],
  incidentsLoading = false,
  incidentsError = null,
  detailById = {},
  expandedIds = {},
  onToggleIncident = () => {},
  onLoadMore = () => {},
  loadingMore = false,
  hasMore = true,
  highlightIncidentId = null,
  events = [],
  includeRoutine = false,
  onSetIncludeRoutine = () => {},
  onRefresh = () => {},
}) => {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  return html`
    <div class="bg-surface border border-border rounded-xl p-4">
      <div class="flex items-center justify-between gap-2 mb-3">
        <h2 class="card-label">Incident history</h2>
        <button class="text-xs text-fg-muted hover:text-body" onclick=${onRefresh}>
          Refresh
        </button>
      </div>
      <div class="mb-3">
        <${PillTabs}
          tabs=${kHistoryTabs}
          activeTab=${activeTab}
          onSelectTab=${onSelectTab}
        />
      </div>

      ${activeTab === kIncidentsTabIncidents
        ? html`
            <div class="space-y-2">
              ${incidentsLoading
                ? html`<p class="text-xs text-fg-muted">Loading incidents...</p>`
                : null}
              ${!incidentsLoading && incidentsError
                ? html`<p class="text-xs text-status-error-muted">
                    ${incidentsError.message || "Could not load incidents"}
                  </p>`
                : null}
              ${!incidentsLoading && !incidentsError && incidents.length === 0
                ? html`<p class="text-xs text-fg-muted">
                    No incidents recorded — the watchdog is quiet.
                  </p>`
                : null}
              ${incidents.map(
                (incident) => html`
                  <${IncidentCard}
                    key=${incident.id}
                    incident=${incident}
                    nowMs=${nowMs}
                    expanded=${!!expandedIds[incident.id]}
                    highlighted=${incident.id === highlightIncidentId}
                    detail=${detailById[incident.id] || null}
                    onToggle=${onToggleIncident}
                  />
                `,
              )}
              ${incidents.length > 0 && hasMore
                ? html`
                    <button
                      class="text-xs px-2 py-1 rounded-lg ac-btn-ghost disabled:opacity-50"
                      disabled=${loadingMore}
                      onclick=${onLoadMore}
                    >
                      ${loadingMore ? "Loading..." : "Load more"}
                    </button>
                  `
                : null}
            </div>
          `
        : html`
            <div class="space-y-2">
              <label class="inline-flex items-center gap-2 text-xs text-fg-muted">
                <input
                  type="checkbox"
                  checked=${includeRoutine}
                  onchange=${(event) =>
                    onSetIncludeRoutine(!!event.target?.checked)}
                />
                Include routine health checks
              </label>
              <div class="ac-history-list">
                ${events.length === 0 &&
                html`<p class="text-xs text-fg-muted">No events recorded.</p>`}
                ${events.map((event) => {
                  const tone = getIncidentStatusTone(event);
                  const described = describeEvent(event);
                  return html`
                    <details class="ac-history-item" key=${event.id}>
                      <summary class="ac-history-summary">
                        <div class="ac-history-summary-row">
                          <span class="inline-flex items-center gap-2 min-w-0">
                            <span class="ac-history-toggle shrink-0" aria-hidden="true"
                              >▸</span
                            >
                            <span class="truncate">
                              ${described.summary}
                              <span
                                class="ml-1 text-fg-dim"
                                title=${event.createdAt || ""}
                              >
                                ${formatRelativeTime(event.createdAt, { nowMs })}
                              </span>
                            </span>
                          </span>
                          <span
                            class=${`h-2.5 w-2.5 shrink-0 rounded-full ${tone.dotClass}`}
                            title=${tone.label}
                            aria-label=${tone.label}
                          ></span>
                        </div>
                      </summary>
                      <div class="ac-history-body text-xs text-fg-muted">
                        <div>Source: ${event.source || "unknown"}</div>
                        <pre class="mt-2 bg-field rounded p-2 whitespace-pre-wrap break-words">
${typeof event.details === "string"
                          ? event.details
                          : JSON.stringify(event.details || {}, null, 2)}</pre
                        >
                      </div>
                    </details>
                  `;
                })}
              </div>
            </div>
          `}
    </div>
  `;
};

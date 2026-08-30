import { h } from "preact";
import { useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { useNowMs } from "../../../hooks/use-now-ms.js";
import { ActionButton } from "../../action-button.js";
import { AsyncSection } from "../../async-section.js";
import { Badge } from "../../badge.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import { PillTabs } from "../../pill-tabs.js";
import { ToggleSwitch } from "../../toggle-switch.js";
import { kOverseerVerdictBadge } from "../overseer-card.js";
import {
  buildIncidentCardModel,
  buildIncidentTimeTooltip,
  describeEvent,
} from "./helpers.js";
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

// Timeline times opt into seconds (withSeconds) — watchdog events land
// seconds apart, and causality must stay readable.
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
              aria-label=${described.toneLabel}
              title=${described.toneLabel}
            ></span>
            <span class="text-fg-muted min-w-0">
              <span class="text-body">${described.label}</span>
              ${described.detail
                ? html`<span> — ${described.detail}</span>`
                : null}
              <span
                class="ml-1 text-fg-dim"
                title=${buildIncidentTimeTooltip(event.createdAt)}
              >
                ${formatLocaleDateTimeWithTodayTime(event.createdAt, {
                  withSeconds: true,
                })}
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
  const overseerCurrent = incident?.overseer?.current || null;
  // Shared verdict→tone/label map (overseer-card.js). A stale review's
  // verdict describes a version of the incident that gained events afterwards
  // — keep it visible but never with a live-verdict tone.
  const verdictBadge = kOverseerVerdictBadge[overseerCurrent?.verdict] || null;
  const overseerChip = verdictBadge
    ? overseerCurrent?.state === "stale"
      ? { tone: "neutral", label: `Overseer: ${verdictBadge.label} (stale)` }
      : { tone: verdictBadge.tone, label: `Overseer: ${verdictBadge.label}` }
    : null;
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
            <span
              class=${`shrink-0 text-fg-dim transition-transform ${expanded ? "rotate-90" : ""}`}
              aria-hidden="true"
              >▸</span
            >
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
            title=${buildIncidentTimeTooltip(model.openedAt)}
          >
            ${model.openedAgo}
          </span>
        </div>
        <div class="mt-1 text-xs text-fg-muted flex flex-wrap items-center gap-2">
          <span>
            ${model.outcome}
            ${model.eventCount ? ` · ${model.eventCount} events` : ""}
            ${model.eventsPruned ? " · events pruned" : ""}
          </span>
          ${overseerChip
            ? html`<${Badge} tone=${overseerChip.tone}>${overseerChip.label}</${Badge}>`
            : null}
        </div>
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
  incidentsLoaded = false,
  incidentsError = null,
  detailById = {},
  expandedIds = {},
  onToggleIncident = () => {},
  onLoadMore = () => {},
  loadingMore = false,
  hasMore = true,
  highlightIncidentId = null,
  events = [],
  eventsLoaded = false,
  eventsError = null,
  includeRoutine = false,
  onSetIncludeRoutine = () => {},
  isRefreshing = false,
  onRefresh = () => {},
}) => {
  // Relative "Nm ago" labels only need coarse ticks; pauses when hidden.
  const nowMs = useNowMs(30_000);

  return html`
    <div class="bg-surface border border-border rounded-xl p-4">
      <div class="flex items-center justify-between gap-2 mb-3">
        <h2 class="card-label">Incident history</h2>
        <${ActionButton}
          onClick=${onRefresh}
          tone="subtle"
          idleLabel="Refresh"
          loadingLabel="Refreshing..."
          loading=${isRefreshing}
        />
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
              ${incidents.length > 0 && incidentsError
                ? html`<${InlineErrorChip}
                    error=${incidentsError}
                    headline="Couldn't refresh incidents — showing the last loaded list."
                    onRetry=${onRefresh}
                  />`
                : null}
              <${AsyncSection}
                loading=${!incidentsLoaded && !incidentsError}
                loadingLabel="Loading incidents..."
                error=${incidents.length > 0 ? null : incidentsError}
                errorHeadline="Couldn't load incidents."
                onRetry=${onRefresh}
                empty=${incidents.length === 0}
                emptyLabel="No incidents recorded — the watchdog is quiet."
              >
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
                    <${ActionButton}
                      onClick=${onLoadMore}
                      tone="ghost"
                      size="sm"
                      idleLabel="Load more"
                      loadingLabel="Loading..."
                      loading=${loadingMore}
                    />
                  `
                : null}
              </${AsyncSection}>
            </div>
          `
        : html`
            <div class="space-y-2">
              <div class="flex items-center justify-between gap-3">
                <span class="text-xs text-fg-muted">Include routine health checks</span>
                <${ToggleSwitch}
                  checked=${includeRoutine}
                  onChange=${onSetIncludeRoutine}
                  label=""
                  ariaLabel="Include routine health checks"
                />
              </div>
              ${events.length > 0 && eventsError
                ? html`<${InlineErrorChip}
                    error=${eventsError}
                    headline="Couldn't refresh events — showing the last loaded list."
                    onRetry=${onRefresh}
                  />`
                : null}
              <${AsyncSection}
                loading=${!eventsLoaded && !eventsError}
                loadingLabel="Loading events..."
                error=${events.length > 0 ? null : eventsError}
                errorHeadline="Couldn't load events."
                onRetry=${onRefresh}
                empty=${events.length === 0}
                emptyLabel="No events recorded."
              >
              <div class="ac-history-list">
                ${events.map((event) => {
                  // Single tone source: describeEvent drives BOTH the text and
                  // the dot (skipped probes must not get a green "OK" dot
                  // beside routine-toned copy).
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
                                title=${buildIncidentTimeTooltip(event.createdAt)}
                              >
                                ${formatRelativeTime(event.createdAt, { nowMs })}
                              </span>
                            </span>
                          </span>
                          <span
                            class=${`h-2.5 w-2.5 shrink-0 rounded-full ${kDotClassByTone[described.tone] || kDotClassByTone.neutral}`}
                            title=${described.toneLabel}
                            aria-label=${described.toneLabel}
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
              </${AsyncSection}>
            </div>
          `}
    </div>
  `;
};

import { h } from "preact";
import { useEffect, useRef } from "preact/hooks";
import htm from "htm";
import { useNowMs } from "../../../hooks/use-now-ms.js";
import { ActionButton } from "../../action-button.js";
import { AsyncSection } from "../../async-section.js";
import { Badge } from "../../badge.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import { Tabs, getTabPanelProps } from "../../tabs.js";
import { ToggleSwitch } from "../../toggle-switch.js";
import { kOverseerVerdictBadge, serverInFlightOf } from "../overseer/model.js";
import { kOverseerSharedCopy } from "../helpers.js";
import { formatDurationCompactMs } from "../../../lib/format.js";
import {
  buildIncidentCardModel,
  buildIncidentTimeTooltip,
  describeEvent,
  kDotClassByTone,
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
              role="img"
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

// Row action model for "Review this incident" (DD15), exported for tests.
// Hidden (null) on open rows, unreadable records, or with the overseer off;
// otherwise disabled-with-a-reason while claude is unavailable or another
// review (either kind — one shared `reviewInFlight`) is running.
export const buildIncidentReviewAction = ({
  incident = null,
  overseerEnabled = false,
  availability = null,
  reviewInFlight = null,
  incidentReviewError = null,
  // The situation poll carries the server mutex holder and the shared manual
  // rate limit — both review kinds spend the same 2-minute budget.
  situation = null,
  nowMs = Date.now(),
} = {}) => {
  if (!overseerEnabled || !incident || incident.status === "open") return null;
  if (incident.summary && incident.summary.unreadable) return null;
  const loading = reviewInFlight != null && reviewInFlight === incident.id;
  const available = availability?.available === true;
  const serverRunning = serverInFlightOf(situation);
  const busy =
    (reviewInFlight != null && !loading) ||
    (!!serverRunning && !loading && serverRunning.incidentId !== incident.id);
  const rateLimitRemainingMs = Math.max(0, (Number(situation?.nextManualAt) || 0) - nowMs);
  const rateLimited = !loading && rateLimitRemainingMs > 0;
  return {
    loading,
    disabled: !available || busy || rateLimited,
    title: !available
      ? kOverseerSharedCopy.waitingForClaude
      : busy
        ? kOverseerSharedCopy.reviewRunning
        : rateLimited
          ? `Available in ${formatDurationCompactMs(rateLimitRemainingMs)}`
          : "",
    error:
      incidentReviewError && incidentReviewError.incidentId === incident.id
        ? incidentReviewError
        : null,
  };
};

const IncidentCard = ({
  incident = null,
  nowMs = Date.now(),
  expanded = false,
  highlighted = false,
  detail = null,
  onToggle = () => {},
  reviewAction = null,
  onReviewIncident = () => {},
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
  // Shared verdict→tone/label map (overseer/model.js). A stale review's
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
      class=${`health-incident${highlighted ? " is-highlighted" : ""}`}
      open=${expanded}
      ontoggle=${(event) => onToggle(model.id, !!event.target?.open)}
    >
      <summary class="health-incident-summary">
        <span class="health-incident-line">
          <span class="health-incident-caret" aria-hidden="true">▸</span>
          ${model.open
            ? html`<span
                class="h-2 w-2 shrink-0 rounded-full bg-yellow-400 animate-pulse"
                role="img"
                aria-label="ongoing incident"
              ></span>`
            : null}
          <span class="health-incident-time" title=${buildIncidentTimeTooltip(model.openedAt)}>
            ${formatLocaleDateTimeWithTodayTime(model.openedAt, { fallback: "—" })}
          </span>
          <span class="health-incident-title">${model.title}</span>
          <span class="health-incident-ago">${model.openedAgo}</span>
        </span>
        <span class="health-incident-line health-incident-meta">
          <${Badge} tone=${model.badgeTone}>${model.badgeLabel}</${Badge}>
          <span>
            ${model.outcome}
            ${model.eventCount ? ` · ${model.eventCount} events` : ""}
            ${model.eventsPruned ? " · events pruned" : ""}
          </span>
          ${overseerChip
            ? html`<${Badge} tone=${overseerChip.tone}>${overseerChip.label}</${Badge}>`
            : null}
        </span>
      </summary>
      <${IncidentTimeline} detail=${detail} />
      ${expanded && reviewAction
        ? html`
            <div class="mt-2 flex flex-wrap items-center gap-2">
              <${ActionButton}
                onClick=${() => onReviewIncident(model.id)}
                tone="subtle"
                size="sm"
                idleLabel="Review this incident"
                loadingLabel="Reviewing..."
                loading=${reviewAction.loading}
                disabled=${reviewAction.disabled}
                title=${reviewAction.title}
              />
              ${reviewAction.disabled && reviewAction.title
                ? html`<span class="text-xs text-fg-muted" role="status">
                    ${reviewAction.title}
                  </span>`
                : null}
            </div>
            ${reviewAction.error
              ? html`<div class="mt-2">
                  <${InlineErrorChip}
                    error=${reviewAction.error.error}
                    headline=${reviewAction.error.message}
                  />
                </div>`
              : null}
          `
        : null}
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
  overseerEnabled = false,
  overseerAvailability = null,
  overseerSituation = null,
  reviewInFlight = null,
  incidentReviewError = null,
  onReviewIncident = () => {},
}) => {
  // Relative "Nm ago" labels only need coarse ticks; pauses when hidden. The
  // row action's rate-limit countdown ticks faster only while one is running.
  const countingDown = (Number(overseerSituation?.nextManualAt) || 0) > Date.now();
  const nowMs = useNowMs(countingDown ? 1000 : 30_000);

  return html`
    <section class="briefing-section" aria-labelledby="health-incidents-title">
      <div class="briefing-section-head">
        <h2 class="briefing-section-title" id="health-incidents-title">Incidents</h2>
        <div class="briefing-section-actions">
          <${Tabs}
            tabs=${kHistoryTabs}
            activeTab=${activeTab}
            onSelectTab=${onSelectTab}
            idBase="watchdog-history"
            ariaLabel="Incident history views"
            variant="segmented"
          />
          <${ActionButton}
            onClick=${onRefresh}
            tone="ghost"
            idleLabel="Refresh"
            loadingLabel="Refreshing..."
            loading=${isRefreshing}
          />
        </div>
      </div>

      <div ...${getTabPanelProps("watchdog-history", activeTab)}>
      ${activeTab === kIncidentsTabIncidents
        ? html`
            <div class="health-incidents">
              ${incidents.length > 0 && incidentsError
                ? html`<${InlineErrorChip}
                    error=${incidentsError}
                    headline="Couldn't refresh incidents — showing the last loaded list."
                    onRetry=${onRefresh}
                  />`
                : null}
              <${AsyncSection}
                loading=${!incidentsLoaded && !incidentsError}
                loadingLabel="Loading…"
                error=${incidents.length > 0 ? null : incidentsError}
                errorHeadline="Couldn't load incidents."
                onRetry=${onRefresh}
                empty=${incidents.length === 0}
                emptyTitle="No incidents in the last 30 days"
                emptyBody="The watchdog has not had to step in."
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
                    reviewAction=${buildIncidentReviewAction({
                      incident,
                      overseerEnabled,
                      availability: overseerAvailability,
                      reviewInFlight,
                      incidentReviewError,
                      situation: overseerSituation,
                      nowMs,
                    })}
                    onReviewIncident=${onReviewIncident}
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
                            role="img"
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
    </section>
  `;
};

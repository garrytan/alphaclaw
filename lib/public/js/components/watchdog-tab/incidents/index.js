import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../../action-button.js";
import { AsyncSection } from "../../async-section.js";
import { InlineErrorChip } from "../../inline-error-chip.js";
import { getIncidentStatusTone } from "../helpers.js";

const html = htm.bind(h);

export const WatchdogIncidentsCard = ({
  events = [],
  hasLoaded = false,
  error = null,
  isRefreshing = false,
  onRefresh = () => {},
}) => html`
  <div class="bg-surface border border-border rounded-xl p-4">
    <div class="flex items-center justify-between gap-2 mb-3">
      <h2 class="card-label">Recent incidents</h2>
      <${ActionButton}
        onClick=${onRefresh}
        tone="subtle"
        idleLabel="Refresh"
        loadingLabel="Refreshing..."
        loading=${isRefreshing}
      />
    </div>
    ${hasLoaded && error
      ? html`
          <div class="mb-3">
            <${InlineErrorChip}
              error=${error}
              headline="Couldn't refresh incidents — showing the last loaded list."
              onRetry=${onRefresh}
            />
          </div>
        `
      : null}
    <${AsyncSection}
      loading=${!hasLoaded && !error}
      loadingLabel="Loading incidents..."
      error=${hasLoaded ? null : error}
      errorHeadline="Couldn't load incidents."
      onRetry=${onRefresh}
      empty=${events.length === 0}
      emptyLabel="No incidents recorded."
    >
      <div class="ac-history-list">
        ${events.map((event) => {
          const tone = getIncidentStatusTone(event);
          return html`
            <details class="ac-history-item">
              <summary class="ac-history-summary">
                <div class="ac-history-summary-row">
                  <span class="inline-flex items-center gap-2 min-w-0">
                    <span class="ac-history-toggle shrink-0" aria-hidden="true"
                      >▸</span
                    >
                    <span class="truncate">
                      ${event.createdAt || ""} · ${event.eventType || "event"} ·
                      ${event.status || "unknown"}
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
    </${AsyncSection}>
  </div>
`;

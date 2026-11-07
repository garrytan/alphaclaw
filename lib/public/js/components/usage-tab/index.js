import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { RoutePageHeader } from "../page-header.js";
import { StatusStrip } from "../status-strip.js";
import { OverviewSection } from "./overview-section.js";
import { SessionsSection } from "./sessions-section.js";
import { buildUsageStripCells } from "./strip-model.js";
import { useUsageTab } from "./use-usage-tab.js";

const html = htm.bind(h);

// Usage (ALPH-69 PR 3b), a Console page: the header, the strip (spend, turns,
// tokens, most used model), the chart with its empty state, then the
// by-agent and sessions tables.
export const UsageTab = ({ sessionId = "" }) => {
  const { state, actions } = useUsageTab({ sessionId });

  const handleToggleSession = (itemSessionId, isOpen) => {
    if (isOpen) {
      actions.setExpandedSessionIds((currentValue) =>
        currentValue.includes(itemSessionId) ? currentValue : [...currentValue, itemSessionId],
      );
      // Reopening retries a failed detail load ({status:"error"} sentinel);
      // a stored null is a terminal "not available" and is not refetched.
      const detail = state.sessionDetailById[itemSessionId];
      const shouldLoadDetail = detail === undefined || detail?.status === "error";
      if (shouldLoadDetail && !state.loadingDetailById[itemSessionId]) {
        actions.loadSessionDetail(itemSessionId);
      }
      return;
    }
    actions.setExpandedSessionIds((currentValue) =>
      currentValue.filter((value) => value !== itemSessionId),
    );
  };

  return html`
    <div class="usage">
      <${RoutePageHeader}
        routeId="usage"
        actions=${html`
          <${ActionButton}
            onClick=${actions.loadSummary}
            loading=${state.loadingSummary}
            tone="secondary"
            size="sm"
            idleLabel="Refresh"
            loadingMode="inline"
          />
        `}
      />
      <${StatusStrip}
        ariaLabel="Usage"
        cells=${buildUsageStripCells({
          summary: state.summary,
          loading: state.loadingSummary,
          error: state.summaryError,
          days: state.days,
        })}
      />
      <${OverviewSection}
        summary=${state.summary}
        summaryLoading=${state.loadingSummary}
        summaryError=${state.summaryError}
        onRetry=${actions.loadSummary}
        metric=${state.metric}
        breakdown=${state.breakdown}
        days=${state.days}
        overviewCanvasRef=${state.overviewCanvasRef}
        onDaysChange=${actions.setDays}
        onMetricChange=${actions.setMetric}
        onBreakdownChange=${actions.setBreakdown}
      />
      <${SessionsSection}
        sessions=${state.sessions}
        loadingSessions=${state.loadingSessions}
        sessionsError=${state.sessionsError}
        onRetry=${actions.loadSessions}
        expandedSessionIds=${state.expandedSessionIds}
        loadingDetailById=${state.loadingDetailById}
        sessionDetailById=${state.sessionDetailById}
        onToggleSession=${handleToggleSession}
      />
    </div>
  `;
};

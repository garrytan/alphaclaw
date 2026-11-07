import { h } from "preact";
import { useEffect, useMemo, useRef } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { AsyncSection } from "../async-section.js";
import { EmptyState } from "../empty-state.js";
import { PaneShell } from "../pane-shell.js";
import { RoutePageHeader } from "../page-header.js";
import { CronJobList } from "./cron-job-list.js";
import { CronJobDetail } from "./cron-job-detail.js";
import { CronOverview } from "./cron-overview.js";
import { kAllCronJobsRouteKey } from "./cron-helpers.js";
import { isRoutingDirty, useCronTab } from "./use-cron-tab.js";

const html = htm.bind(h);

// Schedules (ALPH-69 PR 3b) on PaneShell: the header stays pinned while the
// list pane and the detail scroll. On a phone the list comes first and a
// job opens as its own view with Back, which returns to the same place in
// the list.
export const CronTab = ({ jobId = "", agents = [], onSetLocation = () => {} }) => {
  const { state, actions } = useCronTab({ jobId, onSetLocation });
  const listPaneRef = useRef(null);
  const listScrollTopRef = useRef(null);
  const isAllJobsSelected = state.selectedRouteKey === kAllCronJobsRouteKey;
  const noJobs = state.jobs.length === 0;
  const selectedJob = state.selectedJob;
  const hasUnsavedDetailChanges = useMemo(() => {
    if (isAllJobsSelected || !selectedJob) return false;
    const isPromptDirty = state.promptValue !== state.savedPromptValue;
    return isRoutingDirty(state.routingDraft, selectedJob) || isPromptDirty;
  }, [
    isAllJobsSelected,
    selectedJob,
    state.promptValue,
    state.routingDraft,
    state.savedPromptValue,
  ]);

  const scrollBody = () => listPaneRef.current?.closest?.(".ac-pane-body") || null;

  // Each job opens at its top, including a switch from one job to another;
  // Back lands where the list was left.
  useEffect(() => {
    const body = scrollBody();
    if (!body) return;
    if (!isAllJobsSelected) {
      body.scrollTop = 0;
      return;
    }
    if (listScrollTopRef.current == null) return;
    body.scrollTop = listScrollTopRef.current;
    listScrollTopRef.current = null;
  }, [state.selectedRouteKey]);

  const handleSelectAllJobs = () => {
    actions.selectAllJobs();
  };

  // Only leaving the list records its position: from a job's detail the
  // body's scroll is that job's, not the list's.
  const handleSelectJob = (nextJobId) => {
    if (isAllJobsSelected) listScrollTopRef.current = scrollBody()?.scrollTop ?? null;
    actions.selectJob(nextJobId);
  };

  const header = html`
    <${RoutePageHeader}
      routeId="schedules"
      actions=${isAllJobsSelected || noJobs
        ? html`
            <${ActionButton}
              onClick=${actions.refreshAll}
              tone="secondary"
              size="sm"
              idleLabel="Refresh"
            />
          `
        : html`
            <${ActionButton}
              onClick=${actions.saveChanges}
              loading=${state.savingChanges}
              disabled=${!hasUnsavedDetailChanges}
              tone="primary"
              size="sm"
              idleLabel="Save changes"
              loadingLabel="Saving..."
            />
          `}
    />
  `;

  return html`
    <${PaneShell} header=${header} wide=${true}>
      <${AsyncSection}
        loading=${!state.hasLoadedJobs}
        loadingLabel="Loading…"
        error=${state.hasLoadedJobs ? null : state.jobsError}
        errorHeadline="Couldn't load schedules."
        onRetry=${actions.refreshAll}
      >
        ${noJobs
          ? html`<${EmptyState}
              title="No schedules yet"
              body="Agents add schedules when you ask them to run something on a timetable."
            />`
          : html`
              <div class="schedules-panes" data-view=${isAllJobsSelected ? "list" : "detail"}>
                <div class="schedules-list-pane" ref=${listPaneRef}>
                  <${CronJobList}
                    jobs=${state.jobs}
                    agents=${agents}
                    selectedRouteKey=${state.selectedRouteKey}
                    onSelectAllJobs=${handleSelectAllJobs}
                    onSelectJob=${handleSelectJob}
                  />
                </div>
                <div class="schedules-detail-pane cron-detail-panel">
                  ${isAllJobsSelected
                    ? html`
                        <${CronOverview}
                          jobs=${state.jobs}
                          status=${state.status}
                          bulkUsageByJobId=${state.bulkUsageByJobId}
                          bulkRunsByJobId=${state.bulkRunsByJobId}
                          onSelectJob=${handleSelectJob}
                        />
                      `
                    : html`
                        <button type="button" class="schedules-back" onclick=${handleSelectAllJobs}>
                          <span aria-hidden="true">‹</span> All schedules
                        </button>
                        <${CronJobDetail}
                          job=${state.selectedJob}
                          runEntries=${state.runEntries}
                          filteredRunEntries=${state.filteredRunEntries}
                          runTotal=${state.runTotal}
                          runHasMore=${state.runHasMore}
                          loadingMoreRuns=${state.loadingMoreRuns}
                          runStatusFilter=${state.runStatusFilter}
                          onSetRunStatusFilter=${actions.setRunStatusFilter}
                          onLoadMoreRuns=${actions.loadMoreRuns}
                          onRunNow=${actions.runSelectedJobNow}
                          runningJob=${state.runningJob}
                          onToggleEnabled=${actions.setSelectedJobEnabled}
                          togglingJobEnabled=${state.togglingJobEnabled}
                          jobEnabled=${state.selectedJobEnabled}
                          enableSaveError=${state.enableSaveError}
                          runsError=${state.runsError}
                          usageError=${state.usageError}
                          trendsError=${state.trendsError}
                          onRetryLoads=${actions.refreshAll}
                          usage=${state.usage}
                          jobTrends=${state.jobTrends}
                          jobTrendRange=${state.jobTrendRange}
                          selectedJobTrendBucketFilter=${state.selectedJobTrendBucketFilter}
                          usageDays=${state.usageDays}
                          onSetUsageDays=${actions.setUsageDays}
                          onSetJobTrendRange=${actions.setJobTrendRange}
                          onSetSelectedJobTrendBucketFilter=${actions.setSelectedJobTrendBucketFilter}
                          promptValue=${state.promptValue}
                          savedPromptValue=${state.savedPromptValue}
                          onChangePrompt=${actions.setPromptValue}
                          onSaveChanges=${actions.saveChanges}
                          savingChanges=${state.savingChanges}
                          routingDraft=${state.routingDraft}
                          onChangeRoutingDraft=${actions.setRoutingDraft}
                          deliverySessions=${state.deliverySessions}
                          loadingDeliverySessions=${state.loadingDeliverySessions}
                          deliverySessionsError=${state.deliverySessionsError}
                          destinationSessionKey=${state.destinationSessionKey}
                          onChangeDestinationSessionKey=${actions.setDestinationSessionKey}
                        />
                      `}
                </div>
              </div>
            `}
      </${AsyncSection}>
    </${PaneShell}>
  `;
};

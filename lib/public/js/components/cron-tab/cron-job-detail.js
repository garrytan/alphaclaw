import { h } from "preact";
import { useMemo } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { InlineErrorChip } from "../inline-error-chip.js";
import { formatTokenCount } from "./cron-helpers.js";
import { isRoutingDirty } from "./use-cron-tab.js";
import { CronJobUsage } from "./cron-job-usage.js";
import { CronJobTrendsPanel } from "./cron-job-trends-panel.js";
import { CronRunHistoryPanel } from "./cron-run-history-panel.js";
import { CronPromptEditor } from "./cron-prompt-editor.js";
import { CronJobSettingsCard } from "./cron-job-settings-card.js";

const html = htm.bind(h);
const kRunStatusFilterOptions = [
  { label: "all", value: "all" },
  { label: "ok", value: "ok" },
  { label: "error", value: "error" },
  { label: "skipped", value: "skipped" },
];

export const CronJobDetail = ({
  job = null,
  runEntries = [],
  filteredRunEntries = [],
  runTotal = 0,
  runHasMore = false,
  loadingMoreRuns = false,
  runStatusFilter = "all",
  onSetRunStatusFilter = () => {},
  onLoadMoreRuns = () => {},
  onRunNow = () => {},
  runningJob = false,
  onToggleEnabled = () => {},
  togglingJobEnabled = false,
  jobEnabled = true,
  enableSaveError = null,
  runsError = null,
  usageError = null,
  trendsError = null,
  onRetryLoads = null,
  usage = null,
  jobTrends = null,
  jobTrendRange = "7d",
  selectedJobTrendBucketFilter = null,
  usageDays = 30,
  onSetUsageDays = () => {},
  onSetJobTrendRange = () => {},
  onSetSelectedJobTrendBucketFilter = () => {},
  promptValue = "",
  savedPromptValue = "",
  onChangePrompt = () => {},
  onSaveChanges = () => {},
  savingChanges = false,
  routingDraft = null,
  onChangeRoutingDraft = () => {},
  deliverySessions = [],
  loadingDeliverySessions = false,
  deliverySessionsError = "",
  destinationSessionKey = "",
  onChangeDestinationSessionKey = () => {},
}) => {
  if (!job) {
    return html`
      <div class="h-full flex items-center justify-center text-sm text-fg-muted">
        Select a cron job to view details.
      </div>
    `;
  }

  const routingDirty = useMemo(
    () => isRoutingDirty(routingDraft, job),
    [job, routingDraft],
  );
  const isPromptDirty = promptValue !== savedPromptValue;
  const hasUnsavedChanges = routingDirty || isPromptDirty;

  return html`
    <div class="cron-detail-scroll">
      <div class="cron-detail-content">
        <${CronJobSettingsCard}
          job=${job}
          routingDraft=${routingDraft}
          onChangeRoutingDraft=${onChangeRoutingDraft}
          destinationSessionKey=${destinationSessionKey}
          onChangeDestinationSessionKey=${onChangeDestinationSessionKey}
          deliverySessions=${deliverySessions}
          loadingDeliverySessions=${loadingDeliverySessions}
          deliverySessionsError=${deliverySessionsError}
          savingChanges=${savingChanges}
          jobEnabled=${jobEnabled}
          togglingJobEnabled=${togglingJobEnabled}
          enableSaveError=${enableSaveError}
          onToggleEnabled=${onToggleEnabled}
          onRunNow=${onRunNow}
          runningJob=${runningJob}
          hasUnsavedChanges=${hasUnsavedChanges}
        />

        <${CronPromptEditor}
          promptValue=${promptValue}
          savedPromptValue=${savedPromptValue}
          onChangePrompt=${onChangePrompt}
          onSaveChanges=${onSaveChanges}
        />

        ${usageError
          ? html`<${InlineErrorChip}
              error=${usageError}
              headline="Couldn't load usage."
              onRetry=${onRetryLoads}
            />`
          : null}
        <${CronJobUsage}
          usage=${usage}
          usageDays=${usageDays}
          onSetUsageDays=${onSetUsageDays}
        />
        ${trendsError
          ? html`<${InlineErrorChip}
              error=${trendsError}
              headline="Couldn't load trends."
              onRetry=${onRetryLoads}
            />`
          : null}
        <${CronJobTrendsPanel}
          trends=${jobTrends}
          range=${jobTrendRange}
          onChangeRange=${onSetJobTrendRange}
          selectedBucketFilter=${selectedJobTrendBucketFilter}
          onChangeSelectedBucketFilter=${onSetSelectedJobTrendBucketFilter}
        />

        ${runsError
          ? html`<${InlineErrorChip}
              error=${runsError}
              headline="Couldn't load run history."
              onRetry=${onRetryLoads}
            />`
          : null}
        <${CronRunHistoryPanel}
          entryCountLabel=${`${formatTokenCount(selectedJobTrendBucketFilter ? filteredRunEntries.length : runTotal)} entries`}
          primaryFilterOptions=${kRunStatusFilterOptions}
          primaryFilterValue=${runStatusFilter}
          onChangePrimaryFilter=${onSetRunStatusFilter}
          activeFilterLabel=${selectedJobTrendBucketFilter?.label || ""}
          onClearActiveFilter=${() => onSetSelectedJobTrendBucketFilter(null)}
          rows=${selectedJobTrendBucketFilter ? filteredRunEntries : runEntries}
          variant="detail"
          footer=${runHasMore
            ? html`
                <div class="pt-2">
                  <${ActionButton}
                    onClick=${onLoadMoreRuns}
                    loading=${loadingMoreRuns}
                    tone="secondary"
                    size="sm"
                    idleLabel="Load More"
                    loadingLabel="Loading..."
                  />
                </div>
              `
            : null}
        />
      </div>
    </div>
  `;
};

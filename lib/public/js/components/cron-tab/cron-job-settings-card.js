import { h } from "preact";
import { useMemo } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { SavedToggle } from "../saved-toggle.js";
import { SegmentedControl } from "../segmented-control.js";
import { getSessionDisplayLabel } from "../../lib/session-keys.js";
import {
  formatLocaleDateTime,
  formatLocaleTime,
  isSameLocalDay,
} from "../../lib/format.js";
import {
  formatCronScheduleLabel,
  formatNextRunRelativeMs,
} from "./cron-helpers.js";

const html = htm.bind(h);
const kMetaCardClassName = "ac-surface-inset rounded-lg p-2.5 space-y-1.5";
const kSessionTargetOptions = [
  { label: "main", value: "main" },
  { label: "isolated", value: "isolated" },
];
const kWakeModeOptions = [
  { label: "now", value: "now" },
  { label: "next-heartbeat", value: "next-heartbeat" },
];
const kDeliveryNoneValue = "__none__";

const formatNextRunAbsolute = (value) => {
  const timestamp = Number(value || 0);
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "—";
  const dateValue = new Date(timestamp);
  if (Number.isNaN(dateValue.getTime())) return "—";
  const nowValue = new Date();
  const tomorrowValue = new Date(nowValue);
  tomorrowValue.setDate(nowValue.getDate() + 1);
  if (isSameLocalDay(dateValue, nowValue)) return formatLocaleTime(dateValue);
  if (isSameLocalDay(dateValue, tomorrowValue)) {
    return `Tomorrow ${formatLocaleTime(dateValue)}`;
  }
  return formatLocaleDateTime(dateValue);
};

export const CronJobSettingsCard = ({
  job = null,
  routingDraft = null,
  onChangeRoutingDraft = () => {},
  destinationSessionKey = "",
  onChangeDestinationSessionKey = () => {},
  deliverySessions = [],
  loadingDeliverySessions = false,
  deliverySessionsError = "",
  savingChanges = false,
  jobEnabled = true,
  togglingJobEnabled = false,
  enableSaveError = null,
  onToggleEnabled = () => {},
  onRunNow = () => {},
  runningJob = false,
  hasUnsavedChanges = false,
}) => {
  if (!job) return null;

  const sessionTarget = String(
    routingDraft?.sessionTarget || job?.sessionTarget || "main",
  );
  const wakeMode = String(routingDraft?.wakeMode || job?.wakeMode || "now");
  const deliveryMode = String(
    routingDraft?.deliveryMode || job?.delivery?.mode || "none",
  );
  const deliverySessionOptions = useMemo(() => {
    const seenLabels = new Set();
    const deduped = [];
    const selectedKey = String(destinationSessionKey || "").trim();
    let selectedPresent = false;
    (Array.isArray(deliverySessions) ? deliverySessions : []).forEach(
      (sessionRow) => {
        const key = String(sessionRow?.key || "").trim();
        if (!key) return;
        if (key === selectedKey) selectedPresent = true;
        const label = String(
          getSessionDisplayLabel(sessionRow) ||
            sessionRow?.key ||
            "Session",
        ).trim();
        const dedupeKey = label.toLowerCase();
        if (seenLabels.has(dedupeKey)) return;
        seenLabels.add(dedupeKey);
        deduped.push(sessionRow);
      },
    );
    if (!selectedPresent && selectedKey) {
      const selectedRow = (
        Array.isArray(deliverySessions) ? deliverySessions : []
      ).find((sessionRow) => String(sessionRow?.key || "").trim() === selectedKey);
      if (selectedRow) deduped.unshift(selectedRow);
    }
    return deduped;
  }, [deliverySessions, destinationSessionKey]);
  const deliverySelectValue =
    deliveryMode === "announce" && String(destinationSessionKey || "").trim()
      ? String(destinationSessionKey || "")
      : kDeliveryNoneValue;

  return html`
    <section class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <div class="flex items-center justify-between gap-3">
        <div class="text-xs text-fg-muted">ID: <code>${job.id}</code></div>
      </div>
      <div class="grid grid-cols-2 gap-2 text-xs">
        <div class=${kMetaCardClassName}>
          <div class="text-fg-muted">Schedule</div>
          <div class="text-body font-mono">
            ${formatCronScheduleLabel(job.schedule, {
              includeTimeZoneWhenDifferent: true,
            })}
          </div>
        </div>
        <div class=${kMetaCardClassName}>
          <div class="text-fg-muted">Next run</div>
          <div class="text-body font-mono">
            ${formatNextRunAbsolute(job?.state?.nextRunAtMs)}
            ${Number(job?.state?.nextRunAtMs || 0) > 0
              ? html`<span class="block text-fg-muted">
                  ${`(${formatNextRunRelativeMs(job?.state?.nextRunAtMs)})`}
                </span>`
              : null}
          </div>
        </div>
      </div>
      <div class="grid grid-cols-3 gap-2 text-xs">
        <div class=${kMetaCardClassName}>
          <div class="text-fg-muted">Session target</div>
          <div class="pt-1">
            <${SegmentedControl}
              options=${kSessionTargetOptions}
              value=${sessionTarget}
              onChange=${(value) =>
                onChangeRoutingDraft((currentValue = {}) => ({
                  ...currentValue,
                  sessionTarget: String(value || "main"),
                }))}
            />
          </div>
        </div>
        <div class=${kMetaCardClassName}>
          <div class="text-fg-muted">Wake mode</div>
          <div class="pt-1">
            <${SegmentedControl}
              options=${kWakeModeOptions}
              value=${wakeMode}
              onChange=${(value) =>
                onChangeRoutingDraft((currentValue = {}) => ({
                  ...currentValue,
                  wakeMode: String(value || "now"),
                }))}
            />
          </div>
        </div>
        <div class=${kMetaCardClassName}>
          <div class="text-fg-muted">Delivery</div>
          <div class="pt-1">
            <select
              value=${deliverySelectValue}
              onInput=${(event) => {
                const nextValue = String(event.currentTarget?.value || "");
                if (!nextValue || nextValue === kDeliveryNoneValue) {
                  onChangeRoutingDraft((currentValue = {}) => ({
                    ...currentValue,
                    deliveryMode: "none",
                    deliveryChannel: "",
                    deliveryTo: "",
                  }));
                  onChangeDestinationSessionKey("");
                  return;
                }
                onChangeDestinationSessionKey(nextValue);
                onChangeRoutingDraft((currentValue = {}) => ({
                  ...currentValue,
                  deliveryMode: "announce",
                }));
              }}
              disabled=${savingChanges}
              class="w-full bg-field border border-border rounded-lg px-2 py-1.5 text-[11px] text-body focus:border-fg-muted"
            >
              <option value=${kDeliveryNoneValue}>None</option>
              ${deliverySessionOptions.map(
                (sessionRow) => html`
                  <option value=${String(sessionRow?.key || "")}>
                    ${String(
                      getSessionDisplayLabel(sessionRow) ||
                        sessionRow?.key ||
                        "Session",
                    )}
                  </option>
                `,
              )}
            </select>
          </div>
          ${loadingDeliverySessions
            ? html`<div class="text-[11px] text-fg-muted pt-1">
                Loading delivery sessions...
              </div>`
            : null}
          ${deliverySessionsError
            ? html`<div class="text-[11px] text-status-error-muted pt-1">
                ${deliverySessionsError}
              </div>`
            : null}
        </div>
      </div>
      <div class="flex items-start justify-between gap-3">
        <${SavedToggle}
          value=${jobEnabled}
          hydrated=${true}
          saving=${togglingJobEnabled}
          saveError=${enableSaveError}
          onChange=${onToggleEnabled}
          describe=${(attempted) =>
            `Couldn't confirm ${attempted ? "enable" : "disable"} — showing the server's current state.`}
          disabled=${savingChanges}
        />
        <${ActionButton}
          onClick=${onRunNow}
          loading=${runningJob}
          disabled=${hasUnsavedChanges || savingChanges}
          tone="secondary"
          size="sm"
          idleLabel="Run now"
          loadingLabel="Running..."
        />
      </div>
    </section>
  `;
};

import { h } from "preact";
import htm from "htm";
import { useSavedSetting } from "../../hooks/use-saved-setting.js";
import { fetchDoctorSettings, updateDoctorSettings } from "../../lib/api.js";
import { SavedToggle } from "../saved-toggle.js";
import { showToast } from "../toast.js";
import { getDoctorAutoRunStatusLine } from "./helpers.js";

const html = htm.bind(h);

const kDoctorSettingsCacheKey = "/api/doctor/settings";

// Chip headline after a failed save (SavedToggle renders it inline).
const describeScheduledScansSaveError = (attempted) =>
  attempted
    ? "Couldn't enable scheduled scans — still disabled."
    : "Couldn't disable scheduled scans — still enabled.";

export const DoctorScheduledScans = ({ doctorStatus = null }) => {
  const setting = useSavedSetting({
    cacheKey: kDoctorSettingsCacheKey,
    load: fetchDoctorSettings,
    select: (data) => data?.settings?.autoRunEnabled === true,
    selectSaved: (response) =>
      typeof response?.settings?.autoRunEnabled === "boolean"
        ? response.settings.autoRunEnabled
        : undefined,
    save: (next) => updateDoctorSettings({ autoRunEnabled: !!next }),
    label: "doctor scheduled scans",
  });
  if (!doctorStatus) return null;

  // Until the settings GET resolves, seed the checkbox position from the
  // status payload (SavedToggle still renders it disabled + "Loading...").
  const enabled = setting.hydrated
    ? setting.value === true
    : doctorStatus?.autoRun?.enabled === true;
  const autoRunLine = enabled
    ? getDoctorAutoRunStatusLine(doctorStatus?.autoRun)
    : "";

  const handleToggle = async (next) => {
    // No manual checkbox rollback needed: commit() flips optimistically and,
    // on failure, reverts the value and re-loads server truth — SavedToggle
    // re-renders the switch back and surfaces an inline error chip.
    const outcome = await setting.commit(next === true);
    if (outcome.ok) {
      showToast(
        next ? "Scheduled scans enabled" : "Scheduled scans disabled",
        "success",
      );
    }
  };

  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="space-y-1 min-w-0">
          <h2 class="card-label">Scheduled scans</h2>
          <p class="text-xs text-fg-muted leading-5">
            Runs Drift Doctor automatically when the workspace goes stale.
            Uses your agent's tokens.
          </p>
        </div>
        <${SavedToggle}
          value=${enabled}
          hydrated=${setting.hydrated}
          saving=${setting.saving}
          savingContext=${setting.savingContext}
          saveError=${setting.saveError}
          loadError=${setting.loadError}
          onRetryLoad=${setting.retryLoad}
          onChange=${handleToggle}
          describe=${describeScheduledScansSaveError}
        />
      </div>
      ${autoRunLine
        ? html`<p class="text-xs text-fg-dim">${autoRunLine}</p>`
        : null}
    </div>
  `;
};

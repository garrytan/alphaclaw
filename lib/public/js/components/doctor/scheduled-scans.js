import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { invalidateCache } from "../../lib/api-cache.js";
import { fetchDoctorSettings, updateDoctorSettings } from "../../lib/api.js";
import { showToast } from "../toast.js";
import { ToggleSwitch } from "../toggle-switch.js";
import { getDoctorAutoRunStatusLine } from "./helpers.js";

const html = htm.bind(h);

const kDoctorSettingsCacheKey = "/api/doctor/settings";

export const DoctorScheduledScans = ({ doctorStatus = null }) => {
  const settingsFetch = useCachedFetch(
    kDoctorSettingsCacheKey,
    fetchDoctorSettings,
    { enabled: !!doctorStatus },
  );
  const [saving, setSaving] = useState(false);
  if (!doctorStatus) return null;

  const settings = settingsFetch.data?.settings || null;
  const hydrated = !!settings;
  const enabled = hydrated
    ? settings.autoRunEnabled === true
    : doctorStatus?.autoRun?.enabled === true;
  const autoRunLine = enabled
    ? getDoctorAutoRunStatusLine(doctorStatus?.autoRun)
    : "";

  const handleToggle = async (nextChecked, event = null) => {
    if (saving) return;
    try {
      setSaving(true);
      await updateDoctorSettings({ autoRunEnabled: !!nextChecked });
      invalidateCache(kDoctorSettingsCacheKey);
      await settingsFetch.refresh({ force: true });
      showToast(
        nextChecked ? "Scheduled scans enabled" : "Scheduled scans disabled",
        "success",
      );
    } catch (error) {
      // The server state did not change, but the checkbox already flipped in
      // the DOM — and checked=${enabled} is unchanged across re-render, so
      // Preact skips the DOM write. Restore the checkbox by hand.
      if (event?.target) event.target.checked = enabled;
      showToast(error.message || "Could not save Doctor settings", "error");
    } finally {
      setSaving(false);
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
        <${ToggleSwitch}
          checked=${enabled}
          disabled=${saving || (!hydrated && settingsFetch.loading)}
          label=${saving ? "Saving..." : enabled ? "Enabled" : "Disabled"}
          onChange=${handleToggle}
        />
      </div>
      ${autoRunLine
        ? html`<p class="text-xs text-fg-dim">${autoRunLine}</p>`
        : null}
    </div>
  `;
};

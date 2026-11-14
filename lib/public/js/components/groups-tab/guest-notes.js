import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import htm from "htm";
import { ToggleSwitch } from "../toggle-switch.js";
import { showToast } from "../toast.js";
import { fetchGuestNotes, setGuestNotesForGroup } from "../../lib/api.js";
import { BriefingSection, FactRow } from "../relay-tab/parts.js";
import { describeGuestNotes } from "./guest-notes-model.js";
import { groupName } from "./model.js";

const html = htm.bind(h);

// Guest notes (GST-2662): when a group member asks your agent to write
// something down, it is saved in your brain as an outside guest's note,
// tagged so your agent is always warned where it came from. Off for every
// group until you turn it on here.
export const GuestNotesSection = ({ groups }) => {
  const [status, setStatus] = useState(null);
  const [saving, setSaving] = useState("");
  const load = () =>
    fetchGuestNotes()
      .then(setStatus)
      .catch(() => setStatus(null));
  useEffect(() => {
    load();
  }, []);
  const view = describeGuestNotes({ status, groups });
  if (!view.rows.length) return null;
  const toggle = async (row, enabled) => {
    setSaving(row.key);
    try {
      await setGuestNotesForGroup(row.key, enabled);
      showToast((enabled ? "Guest notes on for " : "Guest notes off for ") + groupName(row.group), "success");
      await load();
    } catch (error) {
      showToast(error.message || "Could not save the guest notes setting", "error");
    } finally {
      setSaving("");
    }
  };
  return html`
    <${BriefingSection}
      id="groups-guest-notes-title"
      title="Guest notes"
      caption=${"When someone other than you asks your agent to write something down in a group, it is saved in your brain as an outside guest's note. Your agent is always told it came from a guest, never from you. Notes are kept " + view.retentionDays + " days unless you keep them."}
    >
      ${view.unavailable ? html`<ul class="relay-facts"><${FactRow} tone="warn" word="Not available yet">${view.unavailable}</${FactRow}></ul>` : null}
      <ul class="groups-list">
        ${view.rows.map(
          (row) => html`
            <li key=${row.key} class="groups-guest-notes-row">
              <${ToggleSwitch}
                checked=${row.enabled}
                disabled=${saving === row.key || (!view.available && !row.enabled)}
                busy=${saving === row.key}
                label=${groupName(row.group)}
                onChange=${(enabled) => toggle(row, enabled)}
              />
              <span class="text-sm text-fg-muted">
                ${row.enabled ? row.live + " kept · up to " + row.dailyCap + " a day and " + row.liveCap + " kept per person" : "Off"}
              </span>
            </li>
          `,
        )}
      </ul>
    </${BriefingSection}>
  `;
};

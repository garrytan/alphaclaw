import { h } from "preact";
import htm from "htm";
import { InlineErrorChip } from "./inline-error-chip.js";
import { ToggleSwitch } from "./toggle-switch.js";

const html = htm.bind(h);

// Standard boolean persisted-setting control: wire it to useSavedSetting.
// Optimistic flip + "Saving..." while the PUT is in flight, "Loading..."
// until hydrated, a load-failure state (disabled + Retry chip — NEVER the
// default value presented as fact), and a persistent inline error chip on
// revert. `context` scopes saving/error display when several controls share
// one document-level hook; `describe(attempted)` supplies the chip headline
// ("Couldn't enable X — still disabled.").
export const SavedToggle = ({
  value = false,
  hydrated = false,
  saving = false,
  savingContext = null,
  saveError = null,
  loadError = null,
  onRetryLoad = null,
  onChange = () => {},
  describe = null,
  labels = {},
  context = null,
  disabled = false,
}) => {
  const onLabel = labels.on || "Enabled";
  const offLabel = labels.off || "Disabled";
  const mine = (tag) => context == null || tag === context;
  const showSaving = saving && (context == null ? true : savingContext === context);
  const myError = saveError && mine(saveError.context) ? saveError : null;
  const label = showSaving
    ? "Saving..."
    : !hydrated
      ? "Loading..."
      : value === true
        ? onLabel
        : offLabel;
  return html`
    <div class="space-y-2">
      <${ToggleSwitch}
        checked=${value === true}
        disabled=${saving || !hydrated || Boolean(loadError) || disabled}
        busy=${showSaving}
        onChange=${onChange}
        label=${label}
      />
      ${loadError
        ? html`<${InlineErrorChip}
            error=${loadError}
            headline="Couldn't load this setting."
            onRetry=${onRetryLoad}
          />`
        : null}
      ${myError
        ? html`<${InlineErrorChip}
            error=${myError.error}
            headline=${describe
              ? describe(myError.attempted)
              : `Couldn't save this setting — still ${value === true ? onLabel.toLowerCase() : offLabel.toLowerCase()}.`}
          />`
        : null}
    </div>
  `;
};

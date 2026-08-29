import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

export const ToggleSwitch = ({
  checked = false,
  disabled = false,
  busy = false,
  onChange = () => {},
  label = "Enabled",
  // Accessible name when the visible text lives OUTSIDE this component
  // (label="" would otherwise leave assistive tech an unnamed switch).
  ariaLabel = null,
}) => html`
  <label
    class=${disabled ? "ac-toggle ac-toggle-disabled" : "ac-toggle"}
    aria-busy=${busy ? "true" : undefined}
  >
    <input
      class="ac-toggle-input"
      type="checkbox"
      checked=${!!checked}
      disabled=${!!disabled}
      aria-label=${ariaLabel || undefined}
      onchange=${(e) => onChange(!!e.target.checked)}
    />
    <span class="ac-toggle-track" aria-hidden="true">
      <span class="ac-toggle-thumb"></span>
    </span>
    ${label ? html`<span class="ac-toggle-label">${label}</span>` : null}
  </label>
`;

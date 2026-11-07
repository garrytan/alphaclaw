import { h } from "preact";
import htm from "htm";
import { resourceLevel } from "./helpers.js";

const html = htm.bind(h);

const kFillClass = { crit: "health-meter-fill--bad", warn: "health-meter-fill--warn" };

// One Resources meter (Health B): the label, a role="meter" bar and the
// value as text beside it, so the reading never depends on colour. A meter
// with onToggle labels itself with a button that opens its details.
export const ResourceBar = ({
  label = "",
  percent = null,
  detail = "",
  expanded = false,
  onToggle = null,
}) => {
  const value = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : 0;
  return html`
    <div class="health-meter" data-meter=${String(label).toLowerCase()}>
      <span class="health-meter-label">
        ${onToggle
          ? html`<button
              type="button"
              class="health-meter-toggle"
              aria-expanded=${expanded ? "true" : "false"}
              onclick=${onToggle}
            >
              <span class="health-meter-caret" aria-hidden="true">${expanded ? "▾" : "▸"}</span>
              ${label}
            </button>`
          : label}
      </span>
      <div
        class="health-meter-track"
        role="meter"
        aria-label=${label}
        aria-valuenow=${String(Math.round(value * 10) / 10)}
        aria-valuemin="0"
        aria-valuemax="100"
        aria-valuetext=${detail}
      >
        <div
          class=${`health-meter-fill ${kFillClass[resourceLevel(value)] || ""}`.trim()}
          style=${{ width: `${value}%` }}
        ></div>
      </div>
      <span class="health-meter-value">${detail}</span>
    </div>
  `;
};

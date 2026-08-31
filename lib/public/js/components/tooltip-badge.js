import { h } from "preact";
import htm from "htm";
import { Badge } from "./badge.js";
import { Tooltip } from "./tooltip.js";

const html = htm.bind(h);

// Props-derived id (no hooks — keeps the component callable as a plain
// function in the node-env test suite). The id only has to match between the
// trigger and ITS tooltip panel, which render from the same invocation;
// identical-prop chips sharing an id is harmless because a panel exists only
// while its own tooltip is open.
const deriveTooltipId = (label, text) => {
  const input = `${label}|${text}`;
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  return `ac-tooltip-${(hash >>> 0).toString(36)}`;
};

// The doctrine primitive for warning/danger status chips (AGENTS.md →
// Feedback and state): a Badge whose LABEL names the condition on its own,
// with supplementary cause detail in a shared Tooltip. Tooltips do NOT open
// on touch (tooltip.js suppresses focus-open on tap), so `text` must never
// be the sole carrier of a required action — it is description, wired via
// aria-describedby; the visible label stays the accessible name.
export const TooltipBadge = ({
  tone = "neutral",
  label = "",
  text = "",
  widthClass = "w-auto max-w-80",
}) => {
  if (!text) return html`<${Badge} tone=${tone}>${label}<//>`;
  const tooltipId = deriveTooltipId(label, text);
  return html`
    <${Tooltip}
      text=${text}
      widthClass=${widthClass}
      tooltipClassName="whitespace-pre-line"
      tooltipId=${tooltipId}
    >
      <span class="inline-flex" tabindex="0" aria-describedby=${tooltipId}>
        <${Badge} tone=${tone}>${label}<//>
      </span>
    </${Tooltip}>
  `;
};

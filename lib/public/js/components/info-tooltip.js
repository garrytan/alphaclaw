import { h } from "preact";
import htm from "htm";
import { Tooltip } from "./tooltip.js";

const html = htm.bind(h);

// The "?" is a tab stop named by its text. Space on it is swallowed, so a
// keyboard user reading the tip never scrolls the page. No text, no tab stop.
export const InfoTooltip = ({ text = "", widthClass = "w-64" }) => {
  if (!String(text || "").trim()) return null;
  return html`
    <${Tooltip} text=${text} widthClass=${widthClass}>
      <span
        class="inline-flex h-4 w-4 items-center justify-center rounded-full border border-fg-muted text-[10px] text-fg-muted cursor-default select-none"
        role="img"
        tabindex="0"
        aria-label=${text}
        onKeyDown=${(event) => {
          if (event.key === " ") event.preventDefault();
        }}
        >?</span
      >
    </${Tooltip}>
  `;
};

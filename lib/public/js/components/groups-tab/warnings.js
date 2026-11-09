import { h } from "preact";
import htm from "htm";
import { FactRow } from "../relay-tab/parts.js";

const html = htm.bind(h);

// Server warnings on a group or a change ({code, title, detail}); an entry
// missing a field still renders what it has.
export const GroupWarnings = ({ warnings }) => {
  const list = (Array.isArray(warnings) ? warnings : []).filter((warning) => warning && (warning.title || warning.detail || warning.code));
  if (!list.length) return null;
  return html`
    <ul class="relay-facts">
      ${list.map(
        (warning, index) => html`
          <${FactRow} key=${warning.code || index} tone="warn" word=${warning.title || warning.code}>
            ${warning.title ? warning.detail || null : warning.detail || null}
          </${FactRow}>
        `,
      )}
    </ul>
  `;
};

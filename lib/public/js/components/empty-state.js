import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

// The state contract's empty state: a title, one sentence saying why, and
// one action when an action exists. Never a bare "No items found."
export const EmptyState = ({ title = "", body = "", action = null }) => html`
  <div class="ac-empty-state" data-empty-state="">
    <p class="ac-empty-state-title">${title}</p>
    ${body ? html`<p class="ac-empty-state-body">${body}</p>` : null}
    ${action ? html`<div class="ac-empty-state-action">${action}</div>` : null}
  </div>
`;

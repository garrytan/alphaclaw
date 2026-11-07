import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

/**
 * Shared layout shell for pages that need a fixed header with a
 * separately scrollable body. The header stays pinned at the top
 * while body content scrolls underneath.
 *
 * @param {preact.ComponentChildren} props.header  Content rendered in the fixed header area.
 * @param {preact.ComponentChildren} props.children  Content rendered in the scrollable body.
 * @param {boolean} props.wide  Use the content width (1,120 px) instead of the reading column.
 */
export const PaneShell = ({ header, children, wide = false }) => html`
  <div class=${wide ? "ac-pane-shell ac-pane-shell--wide" : "ac-pane-shell"}>
    <div class="ac-pane-header">
      <div class="ac-pane-header-content">
        ${header}
      </div>
    </div>
    <div class="ac-pane-body">
      <div class="ac-pane-body-content">
        ${children}
      </div>
    </div>
  </div>
`;

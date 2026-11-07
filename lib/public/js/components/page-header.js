import { h } from "preact";
import htm from "htm";
import { getRoute } from "../lib/routes.js";

const html = htm.bind(h);

// A section or dialog title row.
export const PageHeader = ({ title = "", actions = null, leading = null }) => html`
  <div class="flex items-center justify-between gap-3">
    <div>
      ${leading || html`<h2 class="font-semibold text-base">${title}</h2>`}
    </div>
    <div class="flex items-center gap-2">${actions}</div>
  </div>
`;

// The page's one h1: the route table's title and purpose line, an optional
// row above the title (a back link) and the page actions on the right.
export const RoutePageHeader = ({ routeId, title = "", actions = null, leading = null }) => {
  const route = getRoute(routeId);
  const purpose = route?.purpose || "";
  return html`
    <header class="ac-page-header" data-route-id=${routeId}>
      <div class="ac-page-header-text">
        ${leading}
        <h1 class="ac-page-title">${title || route?.title || ""}</h1>
        ${purpose ? html`<p class="ac-page-purpose">${purpose}</p>` : null}
      </div>
      ${actions ? html`<div class="ac-page-header-actions">${actions}</div>` : null}
    </header>
  `;
};

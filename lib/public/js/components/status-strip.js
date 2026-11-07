import { h } from "preact";
import htm from "htm";

const html = htm.bind(h);

const StatusDot = ({ state }) =>
  html`<span class=${"status-chip-dot status-chip-dot--" + state} aria-hidden="true"></span>`;

// The Console layout's status strip (Home, Usage): four independent cells,
// each a label, a value and one line of detail. A cell with href links to
// the page that explains it; a cell whose source failed shows "—" and a warn
// glyph beside the cause.
export const StatusStrip = ({ cells = [], ariaLabel = "Box status" }) => html`
  <ul class="home-strip" aria-label=${ariaLabel}>
    ${cells.map((cell) => {
      const body = html`
        <span class="home-strip-label">${cell.label}</span>
        <span class=${"home-strip-value" + (cell.mono ? " home-strip-value--mono" : "")} title=${cell.title || undefined}>
          ${cell.dot ? html`<${StatusDot} state=${cell.dot} />` : null}
          <span>${cell.value}</span>
        </span>
        <span class="home-strip-detail">
          ${cell.error ? html`<${StatusDot} state="degraded" />` : null}
          <span>${cell.detail || " "}</span>
        </span>
      `;
      return html`
        <li
          key=${cell.key}
          class="home-strip-cell"
          data-cell=${cell.key}
          data-state=${cell.loading ? "loading" : cell.error ? "error" : "loaded"}
        >
          ${cell.href
            ? html`<a href=${cell.href} class="home-strip-link">${body}</a>`
            : html`<div class="home-strip-link">${body}</div>`}
        </li>
      `;
    })}
  </ul>
`;

import { h } from "preact";
import htm from "htm";
import { RelayTab } from "../relay-tab/index.js";

const html = htm.bind(h);

export const RelayRoute = () => html`
  <div class="pt-4">
    <${RelayTab} />
  </div>
`;

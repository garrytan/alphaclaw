import { h } from "preact";
import htm from "htm";
import { GroupsTab } from "../groups-tab/index.js";

const html = htm.bind(h);

export const GroupsRoute = ({ accountId = "default" }) => html`
  <div class="pt-4">
    <${GroupsTab} accountId=${accountId} />
  </div>
`;

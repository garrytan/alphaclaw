import { h } from "preact";
import htm from "htm";
import { UpgradeTab } from "../upgrade-tab/index.js";

const html = htm.bind(h);

export const UpgradeRoute = ({
  statusData = null,
  onRefreshStatuses = () => {},
}) => html`
  <div class="pt-4">
    <${UpgradeTab}
      statusData=${statusData}
      onRefreshStatuses=${onRefreshStatuses}
    />
  </div>
`;

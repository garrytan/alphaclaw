import { h } from "preact";
import htm from "htm";
import { TeamTab } from "../team-tab/index.js";

const html = htm.bind(h);

export const TeamRoute = ({
  onRefreshStatuses = () => {},
  onSetLocation = () => {},
}) => html`
  <div class="pt-4">
    <${TeamTab}
      onRefreshStatuses=${onRefreshStatuses}
      onSwitchTab=${(nextTab) => onSetLocation(`/${nextTab}`)}
    />
  </div>
`;

import { h } from "preact";
import htm from "htm";
import { WatchdogTab } from "../watchdog-tab/index.js";

const html = htm.bind(h);

// Health renders its own PageHeader: its actions are the gateway controls.
export const WatchdogRoute = ({
  statusData = null,
  watchdogStatus = null,
  onRefreshStatuses = () => {},
  restartingGateway = false,
  onRestartGateway = () => {},
  restartSignal = 0,
}) => html`
  <div class="pt-4">
    <${WatchdogTab}
      gatewayStatus=${statusData?.gateway || null}
      watchdogStatus=${watchdogStatus}
      onRefreshStatuses=${onRefreshStatuses}
      restartingGateway=${restartingGateway}
      onRestartGateway=${onRestartGateway}
      restartSignal=${restartSignal}
    />
  </div>
`;

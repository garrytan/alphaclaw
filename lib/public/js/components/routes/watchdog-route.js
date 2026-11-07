import { h } from "preact";
import htm from "htm";
import { WatchdogTab } from "../watchdog-tab/index.js";
import { RoutePageHeader } from "../page-header.js";

const html = htm.bind(h);

export const WatchdogRoute = ({
  statusData = null,
  watchdogStatus = null,
  onRefreshStatuses = () => {},
  restartingGateway = false,
  onRestartGateway = () => {},
  restartSignal = 0,
}) => html`
  <div class="pt-4 space-y-4">
    <${RoutePageHeader} routeId="health" />
    <${WatchdogTab}
      gatewayStatus=${statusData?.gateway || null}
      openclawVersion=${statusData?.openclawVersion || null}
      watchdogStatus=${watchdogStatus}
      onRefreshStatuses=${onRefreshStatuses}
      restartingGateway=${restartingGateway}
      onRestartGateway=${onRestartGateway}
      restartSignal=${restartSignal}
    />
  </div>
`;

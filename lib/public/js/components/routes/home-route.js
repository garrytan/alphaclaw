import { h } from "preact";
import htm from "htm";
import { HomeTab } from "../home/index.js";
import { RoutePageHeader } from "../page-header.js";

const html = htm.bind(h);

export const HomeRoute = ({
  statusData = null,
  watchdogData = null,
  doctorStatusData = null,
  agents = [],
  doctorWarningDismissedUntilMs = 0,
  onRefreshStatuses = () => {},
  onSetLocation = () => {},
  onAddAgent = () => {},
  restartSignal = 0,
  onDismissDoctorWarning = () => {},
  update = {},
}) => html`
  <div class="pt-4 space-y-4">
    <${RoutePageHeader} routeId="home" />
    <${HomeTab}
      statusData=${statusData}
      watchdogData=${watchdogData}
      doctorStatusData=${doctorStatusData}
      agents=${agents}
      doctorWarningDismissedUntilMs=${doctorWarningDismissedUntilMs}
      onRefreshStatuses=${onRefreshStatuses}
      onSwitchTab=${(nextTab) => onSetLocation(`/${nextTab}`)}
      onAddAgent=${onAddAgent}
      isActive=${true}
      restartSignal=${restartSignal}
      onDismissDoctorWarning=${onDismissDoctorWarning}
      update=${update}
    />
  </div>
`;

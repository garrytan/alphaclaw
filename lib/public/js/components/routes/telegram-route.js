import { h } from "preact";
import htm from "htm";
import { TelegramWorkspace } from "../telegram-workspace/index.js";
import { RoutePageHeader } from "../page-header.js";

const html = htm.bind(h);

export const TelegramRoute = ({ accountId = "default", onBack = () => {} }) => html`
  <div class="pt-4 space-y-4">
    <${RoutePageHeader} routeId="telegram" />
    <${TelegramWorkspace} key=${accountId} accountId=${accountId} onBack=${onBack} />
  </div>
`;

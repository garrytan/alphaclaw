import { h } from "preact";
import htm from "htm";
import { AgentAdminPanel } from "../agent-admin-panel.js";
import { ApiFeaturePanel } from "../api-feature-panel.js";
import { Features } from "../features.js";
import { Google } from "../google/index.js";
import { RoutePageHeader } from "../page-header.js";
import { ChevronRightIcon } from "../icons.js";
import { useGeneralTab } from "../general/use-general-tab.js";
import { useConnectedNodes } from "../nodes-tab/connected-nodes/user-connected-nodes.js";
import { useCachedFetch } from "../../hooks/use-cached-fetch.js";
import { fetchWebhooks } from "../../lib/api.js";

const html = htm.bind(h);

const countLabel = (count, one, many) => (count === null ? "—" : count + " " + (count === 1 ? one : many));

// One link row per page Integrations reaches (Webhooks, Nodes).
export const IntegrationLinkRow = ({ href, title, detail }) => html`
  <a href=${href} class="ac-link-row bg-surface border border-border rounded-xl">
    <span class="ac-link-row-title">${title}</span>
    <span class="ac-link-row-detail">${detail}</span>
    <${ChevronRightIcon} className="text-fg-muted shrink-0" />
  </a>
`;

export const IntegrationsRoute = ({
  statusData = null,
  watchdogData = null,
  doctorStatusData = null,
  onRefreshStatuses = () => {},
  onSetLocation = () => {},
  onRestartRequired = () => {},
  restartSignal = 0,
}) => {
  const { state, actions } = useGeneralTab({
    statusData,
    watchdogData,
    doctorStatusData,
    onRefreshStatuses,
    isActive: true,
    restartSignal,
  });
  const webhooksRead = useCachedFetch("/api/webhooks", fetchWebhooks, { maxAgeMs: 30_000 });
  const nodes = useConnectedNodes({ enabled: true });
  const hookCount = Array.isArray(webhooksRead.data?.webhooks) ? webhooksRead.data.webhooks.length : null;
  const connectedCount = nodes.loading ? null : nodes.nodes.filter((node) => node?.connected === true).length;
  return html`
    <div class="pt-4 space-y-4">
      <${RoutePageHeader} routeId="integrations" />
      <div class="ac-page-grid">
        <div class="ac-page-col">
          <${Google}
            gatewayStatus=${state.gatewayStatus}
            onRestartRequired=${onRestartRequired}
            onOpenGmailWebhook=${() => onSetLocation("/webhooks/gmail")}
          />
          <${Features} onSwitchTab=${(nextTab) => onSetLocation(`/${nextTab}`)} />
        </div>
        <div class="ac-page-col">
          <${ApiFeaturePanel}
            openAiCompatApi=${state.openAiCompatApi}
            savingOpenAiCompatApi=${state.savingOpenAiCompatApi}
            openAiCompatApiError=${state.openAiCompatApiError}
            onToggleOpenAiCompatApi=${actions.handleOpenAiCompatApiToggle}
          />
          <${AgentAdminPanel}
            agentAdmin=${statusData?.agentAdmin || null}
            isActive=${true}
            onToggle=${() => onRefreshStatuses()}
            onRotated=${() => onRefreshStatuses()}
          />
          <${IntegrationLinkRow}
            href="#/webhooks"
            title="Webhooks"
            detail=${countLabel(hookCount, "hook", "hooks")}
          />
          <${IntegrationLinkRow}
            href="#/nodes"
            title="Nodes"
            detail=${connectedCount === null ? "—" : connectedCount + " connected"}
          />
        </div>
      </div>
    </div>
  `;
};

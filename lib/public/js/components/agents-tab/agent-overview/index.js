import { h } from "preact";
import htm from "htm";
import { AgentModelCard } from "./model-card.js";
import { AgentToolsCard } from "./tools-card.js";
import { AgentActivityCard } from "./activity-card.js";
import { AgentSessionsList } from "../agent-sessions-list.js";

const html = htm.bind(h);

const ChannelsCard = ({ accounts = [], known = false, error = null, relay = false, onOpen = () => {} }) => html`
  <section class="bg-surface border border-border rounded-xl p-4 space-y-2">
    <div class="flex items-center justify-between gap-2">
      <h2 class="card-label">Channels</h2>
      <button type="button" class="text-xs ac-tip-link" onclick=${onOpen}>Manage</button>
    </div>
    ${!known
      ? html`<p class=${"text-xs " + (error ? "text-status-error-muted" : "text-fg-muted")}>
          ${error ? "Couldn't load channels." : "Loading channels…"}
        </p>`
      : accounts.length === 0 && !relay
        ? html`<p class="text-sm text-fg-muted">No channels yet.</p>`
        : html`<ul class="space-y-1">
            ${accounts.map(
              (account) => html`<li key=${account.channel + ":" + account.accountId} class="text-sm text-body">
                ${account.label}${account.accountId !== "default" ? html` <span class="font-mono text-xs text-fg-muted">${account.accountId}</span>` : null}
              </li>`,
            )}
            ${relay ? html`<li class="text-sm text-body">Relay</li>` : null}
          </ul>`}
  </section>
`;

export const AgentOverview = ({
  agent = {},
  saving = false,
  toolsSummary = {},
  channelAccounts = [],
  channelsKnown = false,
  channelsError = null,
  relay = false,
  sessions = [],
  onUpdateAgent = async () => {},
  onSwitchToModels = () => {},
  onSelectTab = () => {},
}) => html`
  <div class="agents-overview">
    <div class="agents-overview-model">
      <${AgentModelCard}
        agent=${agent}
        saving=${saving}
        onUpdateAgent=${onUpdateAgent}
        onSwitchToModels=${onSwitchToModels}
      />
    </div>
    <div class="agents-overview-side">
      <${AgentToolsCard}
        profile=${toolsSummary.profile || "full"}
        enabledCount=${toolsSummary.enabledCount || 0}
        totalCount=${toolsSummary.totalCount || 0}
        onSwitchToTools=${() => onSelectTab("tools")}
      />
      <${ChannelsCard}
        accounts=${channelAccounts}
        known=${channelsKnown}
        error=${channelsError}
        relay=${relay}
        onOpen=${() => onSelectTab("channels")}
      />
    </div>
    <div class="agents-overview-wide">
      <${AgentActivityCard} agent=${agent} />
    </div>
    <section class="agents-overview-wide bg-surface border border-border rounded-xl p-4 space-y-2">
      <div class="flex items-center justify-between gap-2">
        <h2 class="card-label">Sessions</h2>
        ${sessions.length > 3
          ? html`<button type="button" class="text-xs ac-tip-link" onclick=${() => onSelectTab("sessions")}>All ${sessions.length} sessions</button>`
          : null}
      </div>
      <${AgentSessionsList} sessions=${sessions} limit=${3} />
    </section>
  </div>
`;

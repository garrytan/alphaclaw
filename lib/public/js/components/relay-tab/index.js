import { h } from "preact";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { Badge } from "../badge.js";
import { PageHeader } from "../page-header.js";
import { formatBytes, formatRelativeTime } from "../../lib/format.js";
import { RelayAuditLog } from "./audit-log.js";
import { RelayConnections } from "./connections.js";
import { buildRelayPageModel, kRunStateCopy } from "./model.js";
import { useRelayTab } from "./use-relay-tab.js";

const html = htm.bind(h);

const Card = ({ title, children }) => html`
  <div class="bg-surface border border-border rounded-xl p-4 space-y-2">
    ${title ? html`<h3 class="font-semibold text-sm">${title}</h3>` : null}
    ${children}
  </div>
`;

const RunRow = ({ run }) => {
  const copy = kRunStateCopy[run.state] || { label: run.state, tone: "neutral" };
  return html`
    <li class="flex flex-wrap items-center gap-2 text-sm py-1">
      <span class="font-medium">@${run.from}</span>
      <${Badge} tone=${copy.tone}>${run.code && run.state !== "answered" ? run.code : copy.label}</${Badge}>
      ${run.hop ? html`<span class="text-xs text-fg-muted">hop ${run.hop}</span>` : null}
      <span class="text-xs text-fg-muted ml-auto" title=${run.receivedAt}>${formatRelativeTime(run.receivedAt, { style: "compact" })}</span>
    </li>
  `;
};

export const RelayTab = () => {
  const { status, statusError, runs, messages, messagesError, remote, remoteError, refresh } = useRelayTab();
  const model = buildRelayPageModel({ status, runs, messages });
  const bridge = status?.bridge || null;
  const settings = status?.settings || {};
  return html`
    <div class="space-y-4">
      <${PageHeader}
        title="Agent Relay"
        actions=${html`<${ActionButton} onClick=${refresh} tone="subtle" idleLabel="Refresh" />`}
      />
      ${statusError && !status
        ? html`<${Card}><p class="text-sm text-status-error-muted">${String(statusError?.message || statusError)}</p></${Card}>`
        : null}
      ${model.waitingOnOwner.length
        ? html`
            <${Card} title="Waiting on you">
              <p class="text-xs text-fg-muted">
                Changes another agent asked for. ${model.agentName ? "@" + model.agentName : "The agent"} asked you in your owner channel and acts only after your yes.
              </p>
              <ul>
                ${model.waitingOnOwner.map(
                  (item) => html`<li class="text-sm py-1"><code>${item.approvalId}</code> for @${item.to || "?"} · ${formatRelativeTime(item.at, { style: "compact" })}</li>`,
                )}
              </ul>
            </${Card}>
          `
        : null}
      ${model.problems.length || model.open.length
        ? html`
            <${Card} title=${model.problems.length ? "Failed or unanswered" : "In progress"}>
              <ul>
                ${[...model.open, ...model.problems].map((run) => html`<${RunRow} key=${run.messageId} run=${run} />`)}
              </ul>
            </${Card}>
          `
        : null}
      <${Card} title="Health">
        <div class="flex items-center gap-2">
          <${Badge} tone=${model.phaseTone}>${model.phaseLabel}</${Badge}>
          <span class="text-sm">${model.phaseText}</span>
        </div>
        ${model.error
          ? html`<p class="text-sm"><span class="font-medium">Fix:</span> ${model.error.fix} <span class="text-xs text-fg-muted">(code ${model.error.code}${model.retryAt ? ", next try " + formatRelativeTime(model.retryAt, { style: "compact", allowFuture: true }) : ""})</span></p>`
          : null}
        ${model.exposureWarning ? html`<p class="text-sm text-status-warning-muted">${model.exposureWarning}</p>` : null}
        ${status?.enabled
          ? html`
              <dl class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-fg-muted">
                <dt>Engine</dt><dd>${status.engine?.version} (${status.engine?.target || "?"}) · ${status.engine?.process?.status || "not started"}</dd>
                <dt>This box's agent</dt><dd>${model.agentName ? "@" + model.agentName : "—"}</dd>
                <dt>Bridged runs</dt><dd>at most ${settings.maxConcurrent} at once · ${settings.hourlyCap} per sender per hour</dd>
                <dt>Retention</dt><dd>${settings.retentionDays ? settings.retentionDays + " days" : "kept forever"}</dd>
                <dt>Storage</dt><dd>${formatBytes((status.dbBytes?.engine || 0) + (status.dbBytes?.bridge || 0))}</dd>
                ${bridge?.lastPollError ? html`<dt>Last poll</dt><dd class="text-status-warning-muted">${bridge.lastPollError}</dd>` : null}
              </dl>
            `
          : null}
      </${Card}>
      <${Card} title="Agents">
        ${model.agents.length
          ? html`<ul>${model.agents.map(
              (agent) => html`
                <li class="flex items-center gap-2 text-sm py-1">
                  <span class=${"inline-block h-2 w-2 rounded-full " + (agent.online ? "bg-green-500" : "bg-gray-500")}></span>
                  <span class="font-medium">@${agent.name}</span>
                  ${agent.name === model.agentName ? html`<${Badge} tone="neutral">this box</${Badge}>` : null}
                  <span class="text-xs text-fg-muted ml-auto">${agent.lastSeen ? "seen " + formatRelativeTime(agent.lastSeen, { style: "compact" }) : ""}</span>
                </li>
              `,
            )}</ul>`
          : html`<p class="text-sm text-fg-muted">${model.phase === "ready" ? "Only this box's agent so far." : "The roster appears once the relay is ready."}</p>`}
      </${Card}>
      <${RelayConnections} remote=${remote} error=${remoteError} onChanged=${refresh} />
      <${RelayAuditLog} messages=${messages} error=${messagesError} ready=${model.phase === "ready"} />
    </div>
  `;
};

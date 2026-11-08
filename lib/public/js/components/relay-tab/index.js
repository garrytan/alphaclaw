import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { ActionButton } from "../action-button.js";
import { OverflowMenu, OverflowMenuItem } from "../overflow-menu.js";
import { RoutePageHeader } from "../page-header.js";
import { formatBytes, formatRelativeTime } from "../../lib/format.js";
import { RelayConversations, StateWord, isFiltered } from "./conversations.js";
import { useRelayConversations } from "./use-relay-conversations.js";
import { RelayAllowConnectionButton, RelayConnectionFacts, RelayConnections, useRelayConnections } from "./connections.js";
import { RelayBrainArchive } from "./brain-archive.js";
import { buildRelayHeadline } from "./headline-model.js";
import { buildRelayPageModel } from "./model.js";
import { BriefingSection, FactRow, StatusDot, withLiterals } from "./parts.js";
import { useRelayTab } from "./use-relay-tab.js";

const html = htm.bind(h);

const RunRow = ({ run }) => html`
  <li class="relay-row">
    <span class="relay-handle">@${run.from}</span>
    <span class="relay-row-meta">
      <${StateWord} state=${run.state} code=${run.code} />
      ${run.hop ? html`<span>hop ${run.hop}</span>` : null}
      <span title=${run.receivedAt}>${formatRelativeTime(run.receivedAt, { style: "compact" })}</span>
    </span>
  </li>
`;

const KeyValue = ({ label, children }) => html`<div class="relay-kv-row"><dt>${label}</dt><dd>${children}</dd></div>`;

// The Relay page, a Briefing: the headline, facts as dot-plus-word rows,
// then what waits on the owner, Conversations, Agents, Connections, Engine
// and the brain archive. Every control keeps its handler; only the layout
// changed. While the status read fails, nothing read from an earlier status
// is shown.
export const RelayTab = () => {
  const { status, statusError, runs, messages, remote, remoteError, refresh } = useRelayTab();
  const model = buildRelayPageModel({ status, runs, messages });
  const conversations = useRelayConversations({ ready: model.phase === "ready" });
  const connections = useRelayConnections({ remote, error: remoteError, onChanged: refresh });
  const [moreOpen, setMoreOpen] = useState(false);
  const refreshAll = () => {
    refresh();
    conversations.refresh();
  };
  const headline = buildRelayHeadline({
    status,
    statusError,
    conversations: conversations.conversations,
    listError: conversations.listError,
    listLoading: conversations.listLoading,
    hasMore: conversations.hasMoreConversations,
    filtered: isFiltered(conversations.filters),
  });
  const shownStatus = statusError ? null : status;
  const bridge = shownStatus?.bridge || null;
  const settings = shownStatus?.settings || {};
  return html`
    <div class="relay briefing">
      <${RoutePageHeader}
        routeId="relay"
        actions=${html`
          <${RelayAllowConnectionButton} connections=${connections} />
          <${ActionButton} onClick=${refreshAll} tone="subtle" size="md" idleLabel="Refresh" className="relay-refresh-wide" />
          <span class="relay-more">
            <${OverflowMenu}
              open=${moreOpen}
              ariaLabel="More relay actions"
              onClose=${() => setMoreOpen(false)}
              onToggle=${() => setMoreOpen((open) => !open)}
            >
              <${OverflowMenuItem}
                onClick=${() => {
                  setMoreOpen(false);
                  refreshAll();
                }}
              >
                Refresh
              </${OverflowMenuItem}>
            </${OverflowMenu}>
          </span>
        `}
      />
      <div class="relay-lead">
        <p class="briefing-headline">${headline}</p>
        <ul class="relay-facts">
          ${statusError
            ? html`<${FactRow} tone="danger" word="Status unavailable">${String(statusError?.message || statusError)}</${FactRow}>`
            : null}
          ${shownStatus
            ? html`
                <${FactRow} tone=${model.phaseTone} word=${model.phaseLabel}>
                  ${model.phase === "ready" && !model.bridgeFailure ? null : withLiterals(model.phaseText)}
                  ${model.error
                    ? html`<span class="block">
                        Fix: ${model.error.fix}
                        <span class="text-fg-dim">
                          (code <code class="font-mono">${model.error.code}</code>${model.retryAt ? ", next try " + formatRelativeTime(model.retryAt, { style: "compact", allowFuture: true }) : ""})
                        </span>
                      </span>`
                    : null}
                </${FactRow}>
                ${model.exposureWarning ? html`<${FactRow} tone="warning">${withLiterals(model.exposureWarning)}</${FactRow}>` : null}
              `
            : null}
          <${RelayConnectionFacts} remote=${remote} error=${remoteError} connections=${connections} />
        </ul>
      </div>
      ${model.waitingOnOwner.length
        ? html`
            <${BriefingSection}
              id="relay-waiting-title"
              title="Waiting on you"
              caption=${"Changes another agent asked for. " + (model.agentName ? "@" + model.agentName : "The agent") + " asked you in your owner channel and acts only after your yes."}
            >
              <ul class="relay-rows">
                ${model.waitingOnOwner.map(
                  (item) => html`<li key=${item.approvalId} class="relay-row">
                    <code class="font-mono text-bright">${item.approvalId}</code>
                    <span>for <span class="relay-handle">@${item.to || "?"}</span></span>
                    <span class="relay-row-meta"><span title=${item.at}>${formatRelativeTime(item.at, { style: "compact" })}</span></span>
                  </li>`,
                )}
              </ul>
            </${BriefingSection}>
          `
        : null}
      ${model.problems.length || model.open.length
        ? html`
            <${BriefingSection} id="relay-runs-title" title=${model.problems.length ? "Failed or unanswered" : "In progress"}>
              <ul class="relay-rows">
                ${[...model.open, ...model.problems].map((run) => html`<${RunRow} key=${run.messageId} run=${run} />`)}
              </ul>
            </${BriefingSection}>
          `
        : null}
      <${RelayConversations} conversations=${conversations} agents=${model.agents} ready=${model.phase === "ready"} />
      ${statusError
        ? null
        : html`
            <${BriefingSection} id="relay-agents-title" title="Agents">
              ${model.agents.length
                ? html`<ul class="relay-rows">${model.agents.map(
                    (agent) => html`
                      <li key=${agent.name} class="relay-row">
                        <${StatusDot} tone=${agent.online ? "success" : "neutral"} />
                        <span class="relay-handle">@${agent.name}</span>
                        ${agent.name === model.agentName ? html`<span class="text-fg-muted">(this box)</span>` : null}
                        <span class="relay-row-meta">
                          <span>${agent.online ? "online" : "offline"}</span>
                          ${agent.lastSeen ? html`<span title=${agent.lastSeen}>seen ${formatRelativeTime(agent.lastSeen, { style: "compact" })}</span>` : null}
                        </span>
                      </li>
                    `,
                  )}</ul>`
                : html`<p class="text-sm text-fg-muted">${model.phase === "ready" ? "Only this box's agent so far." : "The roster appears once the relay is ready."}</p>`}
            </${BriefingSection}>
          `}
      <${RelayConnections} remote=${remote} error=${remoteError} connections=${connections} />
      ${shownStatus?.enabled
        ? html`
            <${BriefingSection} id="relay-engine-title" title="Engine">
              <dl class="relay-kv">
                <${KeyValue} label="Engine">
                  <span class="font-mono">${shownStatus.engine?.version} (${shownStatus.engine?.target || "?"})</span> · ${shownStatus.engine?.process?.status || "not started"}
                </${KeyValue}>
                <${KeyValue} label="This box's agent">
                  ${model.agentName ? html`<span class="relay-handle">@${model.agentName}</span>` : "—"}
                </${KeyValue}>
                <${KeyValue} label="Bridged runs">at most ${settings.maxConcurrent} at once · ${settings.hourlyCap} per sender per hour</${KeyValue}>
                <${KeyValue} label="Retention">${settings.retentionDays ? settings.retentionDays + " days" : "kept forever"}</${KeyValue}>
                <${KeyValue} label="Storage">
                  ${formatBytes((shownStatus.dbBytes?.engine || 0) + (shownStatus.dbBytes?.bridge || 0) + (shownStatus.dbBytes?.archive || 0))}
                </${KeyValue}>
                ${bridge?.lastPollError
                  ? html`<${KeyValue} label="Last poll"><span class="text-tone-warn">${bridge.lastPollError}</span></${KeyValue}>`
                  : null}
              </dl>
            </${BriefingSection}>
          `
        : null}
      ${shownStatus ? html`<${RelayBrainArchive} archive=${shownStatus.archive} onChanged=${refresh} />` : null}
    </div>
  `;
};

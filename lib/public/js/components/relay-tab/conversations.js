import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { Badge } from "../badge.js";
import { formatLocaleDateTime, formatRelativeTime } from "../../lib/format.js";
import { kRunStateCopy } from "./model.js";
import { hasRelayLog } from "./use-relay-conversations.js";

const html = htm.bind(h);

const chatLink = (sessionKey) => "#/chat/" + encodeURIComponent(sessionKey);

const pairLabel = (item) => {
  if (item.peer) return "@" + item.peer;
  return (item.participants || []).map((name) => "@" + name).join(" ↔ ") || "conversation";
};

const StatusBadge = ({ state, code }) => {
  if (!state) return null;
  const copy = kRunStateCopy[state] || { label: state, tone: "neutral" };
  return html`<${Badge} tone=${copy.tone}>${code && state !== "answered" ? code : copy.label}</${Badge}>`;
};

const kFieldClass = "bg-field border border-border rounded-lg px-2 py-1 text-sm";

const Filters = ({ filters, agents, onApply }) => {
  const [draft, setDraft] = useState(filters);
  const change = (key, value, applyNow = false) => {
    const next = { ...draft, [key]: value };
    setDraft(next);
    if (applyNow) onApply(next);
  };
  return html`
    <form
      class="flex flex-wrap items-center gap-2"
      onsubmit=${(event) => {
        event.preventDefault();
        onApply(draft);
      }}
    >
      <input
        type="search"
        class=${kFieldClass + " flex-1 min-w-[10rem]"}
        placeholder="Search text or agent"
        aria-label="Search relay conversations"
        value=${draft.q}
        oninput=${(event) => change("q", event.target.value)}
      />
      <select class=${kFieldClass} aria-label="Agent" value=${draft.agent} onchange=${(event) => change("agent", event.target.value, true)}>
        <option value="">All agents</option>
        ${agents.map((name) => html`<option value=${name}>@${name}</option>`)}
      </select>
      <input type="date" class=${kFieldClass} aria-label="From date" value=${draft.from} onchange=${(event) => change("from", event.target.value, true)} />
      <input type="date" class=${kFieldClass} aria-label="To date" value=${draft.to} onchange=${(event) => change("to", event.target.value, true)} />
      <button type="submit" class="text-xs text-fg-muted hover:text-body underline">Search</button>
    </form>
  `;
};

const RowContent = ({ item }) => html`
  <span class="font-medium">${pairLabel(item)}</span>
  ${item.sessionOnly ? html`<${Badge} tone="neutral">session only</${Badge}>` : null}
  <${StatusBadge} state=${item.lastStatus} code=${item.lastCode} />
  <span class="text-xs text-fg-muted ml-auto" title=${item.lastMessageAt || ""}>
    ${item.messageCount != null ? item.messageCount + " · " : ""}${formatRelativeTime(item.lastMessageAt, { style: "compact" })}
  </span>
  ${item.sessionKey ? html`<span class="text-fg-muted" aria-hidden="true">›</span>` : null}
  ${item.lastText
    ? html`<span class="basis-full min-w-0 text-xs text-fg-muted truncate">${item.lastFrom ? "@" + item.lastFrom + ": " : ""}${item.lastText}</span>`
    : null}
`;

const kRowClass = "w-full text-left py-2 px-2 rounded-lg flex flex-wrap items-center gap-2 text-sm";

// Space opens the conversation too, as it would on a button.
const openOnSpace = (event) => {
  if (event.key !== " ") return;
  event.preventDefault();
  event.currentTarget.click();
};

const MessageRow = ({ message, agentName }) => {
  const fromBox = message.from === agentName;
  const status = message.relayStatus || message.bridge?.state || null;
  const code = message.relayCode || message.bridge?.code || null;
  return html`
    <li class=${"flex " + (fromBox ? "justify-start" : "justify-end")}>
      <div class=${"max-w-[85%] min-w-0 rounded-xl border border-border px-3 py-2 space-y-1 " + (fromBox ? "bg-surface" : "bg-field")}>
        <div class="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
          <span class="font-medium text-body">@${message.from || "?"}</span>
          <span title=${message.createdAt || ""}>${formatLocaleDateTime(message.createdAt)}</span>
          ${status ? html`<${StatusBadge} state=${status} code=${code} />` : null}
          ${message.bridge?.hop ? html`<span>hop ${message.bridge.hop}</span>` : null}
        </div>
        <pre class="text-sm whitespace-pre-wrap break-words font-sans">${message.text || "(empty)"}</pre>
      </div>
    </li>
  `;
};

// The relay log: the messages as they crossed the relay, read-only. It is
// the wire record, so it also holds answers to messages this box sent and
// messages the bridge refused, which never reach the box's session.
const RelayLog = ({ id, log, agentName }) => {
  let body;
  if (!log || log.loading) body = html`<p class="text-xs text-fg-muted">Loading…</p>`;
  else if (log.error) body = html`<p class="text-xs text-status-error-muted">${String(log.error?.message || log.error)}</p>`;
  else if (log.messages.length === 0) body = html`<p class="text-xs text-fg-muted">No relay messages in this conversation.</p>`;
  else {
    body = html`
      ${log.hasEarlier
        ? html`<button type="button" class="text-xs underline text-fg-muted" disabled=${log.loadingEarlier} onclick=${log.loadEarlier}>${log.loadingEarlier ? "Loading…" : "Load earlier"}</button>`
        : null}
      <ul class="space-y-2">
        ${log.messages.map((message) => html`<${MessageRow} key=${message.id} message=${message} agentName=${agentName} />`)}
      </ul>
    `;
  }
  return html`<div id=${id} class="mt-1 mb-2 ml-2 pl-3 border-l border-border space-y-2">${body}</div>`;
};

const logDomId = (item) => "relay-log-" + String(item.id).replace(/[^a-zA-Z0-9_-]/g, "_");

const LogToggle = ({ item, expanded, onToggle }) => html`
  <button
    type="button"
    class="shrink-0 self-start mt-1 text-xs px-2 py-1 rounded-lg border border-border text-fg-muted hover:text-body hover:bg-field"
    aria-expanded=${expanded ? "true" : "false"}
    aria-controls=${logDomId(item)}
    onclick=${() => onToggle(item.id)}
  >
    Relay log
  </button>
`;

// A conversation with this box's agent opens its session in Chat, where it
// is read. Beside it, the relay log shows the messages as they crossed the
// relay. One between two other agents has no session on this box, so its
// relay log is the only view.
const ConversationRow = ({ item, expanded, onToggleLog, log, agentName }) => {
  const withLog = hasRelayLog(item);
  const logPane = withLog && expanded ? html`<${RelayLog} id=${logDomId(item)} log=${log} agentName=${agentName} />` : null;
  if (!item.sessionKey) {
    return html`
      <li>
        <div class="flex items-start gap-2">
          <div class=${kRowClass + " min-w-0"}>
            <${RowContent} item=${item} />
            <span class="basis-full text-xs text-fg-muted">Between two other agents, so this box has no session in Chat. Read it in the relay log.</span>
          </div>
          ${withLog ? html`<${LogToggle} item=${item} expanded=${expanded} onToggle=${onToggleLog} />` : null}
        </div>
        ${logPane}
      </li>
    `;
  }
  return html`
    <li>
      <div class="flex items-start gap-2">
        <a
          href=${chatLink(item.sessionKey)}
          class=${kRowClass + " min-w-0 no-underline text-body hover:bg-field focus-visible:bg-field"}
          title="Open in Chat"
          onkeydown=${openOnSpace}
        >
          <${RowContent} item=${item} />
        </a>
        ${withLog ? html`<${LogToggle} item=${item} expanded=${expanded} onToggle=${onToggleLog} />` : null}
      </div>
      ${logPane}
    </li>
  `;
};

const isFiltered = (filters) => Boolean(filters.q || filters.agent || filters.from || filters.to);

// The relay conversations: every DM conversation by agent pair, searchable
// and paged. Each one opens in Chat, and its relay log expands under it.
// Text is shown only to signed-in people.
export const RelayConversations = ({ conversations: c, agents = [], ready = false }) => {
  let list;
  if (c.listLoading) list = html`<p class="text-sm text-fg-muted">Loading…</p>`;
  else if (c.conversations.length === 0) list = html`<p class="text-sm text-fg-muted">${isFiltered(c.filters) ? "No relay conversations match." : "No relay conversations yet."}</p>`;
  else {
    list = html`<ul class="space-y-1">
      ${c.conversations.map(
        (item) => html`<${ConversationRow}
          key=${item.id}
          item=${item}
          expanded=${item.id === c.expandedId}
          onToggleLog=${c.toggleLog}
          log=${item.id === c.expandedId ? c.log : null}
          agentName=${c.agentName}
        />`,
      )}
    </ul>`;
  }
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <h3 class="font-semibold text-sm">Conversations</h3>
      <p class="text-xs text-fg-muted">
        Every relay conversation, both sides, kept for the retention period. Open one to read it in Chat. Its relay log is the wire record, including answers to messages this box sent. Message text is shown only to signed-in people.
      </p>
      ${!ready
        ? html`<p class="text-sm text-fg-muted">Conversations appear once the relay is ready.</p>`
        : html`
            <${Filters} filters=${c.filters} agents=${agents.map((agent) => agent.name)} onApply=${c.setFilters} />
            ${c.listError ? html`<p class="text-sm text-status-error-muted">${String(c.listError?.message || c.listError)}</p>` : null}
            ${c.moreError ? html`<p class="text-sm text-status-error-muted">${String(c.moreError?.message || c.moreError)}</p>` : null}
            ${list}
            ${c.hasMoreConversations
              ? html`<button type="button" class="text-xs underline text-fg-muted" disabled=${c.loadingMore} onclick=${c.loadMoreConversations}>
                  ${c.loadingMore ? "Loading…" : "Load more conversations"}
                </button>`
              : null}
          `}
    </div>
  `;
};

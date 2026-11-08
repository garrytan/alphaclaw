import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { formatLocaleDateTime, formatRelativeTime } from "../../lib/format.js";
import { kRunStateCopy } from "./model.js";
import { hasRelayLog } from "./use-relay-conversations.js";
import { BriefingSection, ToneWord } from "./parts.js";

const html = htm.bind(h);

const chatLink = (sessionKey) => "#/chat/" + encodeURIComponent(sessionKey);

const pairLabel = (item) => {
  if (item.peer) return "@" + item.peer;
  return (item.participants || []).map((name) => "@" + name).join(" ↔ ") || "conversation";
};

// The state word: a failure's code is a literal value, so it is mono.
export const StateWord = ({ state, code }) => {
  if (!state) return null;
  const copy = kRunStateCopy[state] || { label: state, tone: "neutral" };
  const showCode = Boolean(code) && state !== "answered";
  return html`<${ToneWord} tone=${state === "answered" ? "neutral" : copy.tone} mono=${showCode}>${showCode ? code : copy.label}</${ToneWord}>`;
};

const kFieldClass = "bg-field border rounded-lg px-2 py-1 text-sm min-h-[40px]";

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
      <button type="submit" class="relay-row-action">Search</button>
    </form>
  `;
};

// One conversation: the handle and the last message on the left, then its
// count, state word, time and (for a conversation with this box) Open in
// Chat.
const RowContent = ({ item }) => html`
  <span class="relay-conv-main">
    <span class="relay-handle">${pairLabel(item)}</span>
    ${item.lastText
      ? html`<span class="relay-conv-preview">${item.lastFrom ? html`<span class="font-mono">@${item.lastFrom}</span>: ` : ""}${item.lastText}</span>`
      : null}
  </span>
  <span class="relay-row-meta">
    ${item.messageCount != null ? html`<span>${item.messageCount} ${item.messageCount === 1 ? "message" : "messages"}</span>` : null}
    ${item.sessionOnly ? html`<${ToneWord} tone="neutral">session only</${ToneWord}>` : null}
    <${StateWord} state=${item.lastStatus} code=${item.lastCode} />
    <span title=${item.lastMessageAt || ""}>${formatRelativeTime(item.lastMessageAt, { style: "compact" })}</span>
    ${item.sessionKey ? html`<span class="relay-conv-open">Open in Chat <span aria-hidden="true">→</span></span>` : null}
  </span>
`;

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
          <span class="font-mono text-body">@${message.from || "?"}</span>
          <span title=${message.createdAt || ""}>${formatLocaleDateTime(message.createdAt)}</span>
          ${status ? html`<${StateWord} state=${status} code=${code} />` : null}
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
    class="relay-log-toggle"
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
        <div class="relay-conv">
          <div class="relay-conv-link">
            <${RowContent} item=${item} />
            <span class="relay-conv-note">Between two other agents, so this box has no session in Chat. Read it in the relay log.</span>
          </div>
          ${withLog ? html`<${LogToggle} item=${item} expanded=${expanded} onToggle=${onToggleLog} />` : null}
        </div>
        ${logPane}
      </li>
    `;
  }
  return html`
    <li>
      <div class="relay-conv">
        <a
          href=${chatLink(item.sessionKey)}
          class="relay-conv-link is-link"
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

export const isFiltered = (filters) => Boolean(filters.q || filters.agent || filters.from || filters.to);

// The relay conversations: every DM conversation by agent pair, searchable
// and paged. Each one opens in Chat, and its relay log expands under it.
// Text is shown only to signed-in people.
export const RelayConversations = ({ conversations: c, agents = [], ready = false }) => {
  let list;
  if (c.listError) list = html`<p class="text-sm text-status-error-muted">${String(c.listError?.message || c.listError)}</p>`;
  else if (c.listLoading) list = html`<p class="text-sm text-fg-muted">Loading…</p>`;
  else if (c.conversations.length === 0) list = html`<p class="text-sm text-fg-muted">${isFiltered(c.filters) ? "No relay conversations match." : "No relay conversations yet."}</p>`;
  else {
    list = html`<ul class="relay-rows">
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
    <${BriefingSection}
      id="relay-conversations-title"
      title="Conversations"
      caption="Every relay conversation, both sides, kept for the retention period. Open one to read it in Chat. Its relay log is the wire record, including answers to messages this box sent. Message text is shown only to signed-in people."
    >
      ${!ready
        ? html`<p class="text-sm text-fg-muted">Conversations appear once the relay is ready.</p>`
        : html`
            <${Filters} filters=${c.filters} agents=${agents.map((agent) => agent.name)} onApply=${c.setFilters} />
            ${c.moreError ? html`<p class="text-sm text-status-error-muted">${String(c.moreError?.message || c.moreError)}</p>` : null}
            ${list}
            ${c.hasMoreConversations && !c.listError
              ? html`<button type="button" class="relay-row-action self-start" disabled=${c.loadingMore} onclick=${c.loadMoreConversations}>
                  ${c.loadingMore ? "Loading…" : "Load more conversations"}
                </button>`
              : null}
          `}
    </${BriefingSection}>
  `;
};

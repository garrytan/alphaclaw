import { h } from "preact";
import { useState } from "preact/hooks";
import htm from "htm";
import { Badge } from "../badge.js";
import { formatLocaleDateTime, formatRelativeTime } from "../../lib/format.js";
import { kRunStateCopy } from "./model.js";

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

const ConversationRow = ({ item, active, onSelect }) => html`
  <li>
    <button
      type="button"
      class=${"w-full text-left py-2 px-2 rounded-lg flex flex-wrap items-center gap-2 text-sm " + (active ? "bg-field" : "hover:bg-field")}
      onclick=${() => onSelect(item.id)}
      aria-current=${active ? "true" : "false"}
    >
      <span class="font-medium">${pairLabel(item)}</span>
      ${item.sessionOnly ? html`<${Badge} tone="neutral">session only</${Badge}>` : null}
      <${StatusBadge} state=${item.lastStatus} code=${item.lastCode} />
      <span class="text-xs text-fg-muted ml-auto" title=${item.lastMessageAt || ""}>
        ${item.messageCount != null ? item.messageCount + " · " : ""}${formatRelativeTime(item.lastMessageAt, { style: "compact" })}
      </span>
      ${item.lastText
        ? html`<span class="basis-full text-xs text-fg-muted truncate">${item.lastFrom ? "@" + item.lastFrom + ": " : ""}${item.lastText}</span>`
        : null}
    </button>
  </li>
`;

const MessageRow = ({ message, agentName }) => {
  const fromBox = message.from === agentName;
  const status = message.relayStatus || message.bridge?.state || null;
  const code = message.relayCode || message.bridge?.code || null;
  return html`
    <li class=${"flex " + (fromBox ? "justify-start" : "justify-end")}>
      <div class=${"max-w-[85%] rounded-xl border border-border px-3 py-2 space-y-1 " + (fromBox ? "bg-surface" : "bg-field")}>
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

const Transcript = ({ conversations: c }) => {
  const { selected, transcript, transcriptError, agentName } = c;
  if (!selected) return html`<p class="text-sm text-fg-muted">Pick a conversation to read it.</p>`;
  const sessionKey = transcript?.sessionKey || selected.sessionKey;
  let body = null;
  if (selected.sessionOnly) {
    body = html`<p class="text-sm text-fg-muted">This conversation's relay messages are past the retention period. The box's session transcript is still in Chat.</p>`;
  } else if (transcriptError) {
    body = html`<p class="text-sm text-status-error-muted">${String(transcriptError?.message || transcriptError)}</p>`;
  } else if (!transcript) {
    body = html`<p class="text-sm text-fg-muted">Loading…</p>`;
  } else {
    body = html`
      ${c.hasEarlierMessages
        ? html`<button type="button" class="text-xs underline text-fg-muted" disabled=${c.loadingMore} onclick=${c.loadEarlierMessages}>
            ${c.loadingMore ? "Loading…" : "Load earlier messages"}
          </button>`
        : null}
      <ul class="space-y-2">
        ${transcript.messages.map((message) => html`<${MessageRow} key=${message.id} message=${message} agentName=${agentName} />`)}
      </ul>
    `;
  }
  return html`
    <div class="space-y-2">
      <div class="flex flex-wrap items-center gap-2">
        <h4 class="font-semibold text-sm">${pairLabel(selected)}</h4>
        ${sessionKey ? html`<a class="text-xs underline ml-auto" href=${chatLink(sessionKey)}>Open session in Chat</a>` : null}
      </div>
      ${body}
    </div>
  `;
};

const isFiltered = (filters) => Boolean(filters.q || filters.agent || filters.from || filters.to);

// The relay conversations: every DM conversation by agent pair, searchable
// and paged, with the chat transcript of the one picked. Text is shown only
// to signed-in people.
export const RelayConversations = ({ conversations: c, agents = [], ready = false }) => {
  let list;
  if (c.listLoading) list = html`<p class="text-sm text-fg-muted">Loading…</p>`;
  else if (c.conversations.length === 0) list = html`<p class="text-sm text-fg-muted">${isFiltered(c.filters) ? "No relay conversations match." : "No relay conversations yet."}</p>`;
  else {
    list = html`<ul class="space-y-1">
      ${c.conversations.map((item) => html`<${ConversationRow} key=${item.id} item=${item} active=${item.id === c.selectedId} onSelect=${c.select} />`)}
    </ul>`;
  }
  return html`
    <div class="bg-surface border border-border rounded-xl p-4 space-y-3">
      <h3 class="font-semibold text-sm">Conversations</h3>
      <p class="text-xs text-fg-muted">
        Every relay conversation, both sides, kept for the retention period. Message text is shown only to signed-in people.
      </p>
      ${!ready
        ? html`<p class="text-sm text-fg-muted">Conversations appear once the relay is ready.</p>`
        : html`
            <${Filters} filters=${c.filters} agents=${agents.map((agent) => agent.name)} onApply=${c.setFilters} />
            ${c.listError ? html`<p class="text-sm text-status-error-muted">${String(c.listError?.message || c.listError)}</p>` : null}
            ${c.moreError ? html`<p class="text-sm text-status-error-muted">${String(c.moreError?.message || c.moreError)}</p>` : null}
            <div class="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
              <div class="min-w-0">
                ${list}
                ${c.hasMoreConversations
                  ? html`<button type="button" class="mt-2 text-xs underline text-fg-muted" disabled=${c.loadingMore} onclick=${c.loadMoreConversations}>
                      ${c.loadingMore ? "Loading…" : "Load more conversations"}
                    </button>`
                  : null}
              </div>
              <div class="min-w-0"><${Transcript} conversations=${c} /></div>
            </div>
          `}
    </div>
  `;
};

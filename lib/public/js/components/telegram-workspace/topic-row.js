import { h } from "preact";
import htm from "htm";
import { InlineErrorChip } from "../inline-error-chip.js";
import { Badge } from "../badge.js";
import { TooltipBadge } from "../tooltip-badge.js";

const html = htm.bind(h);

// Shared badge tooltip copy — two render sites (topics table + discovered
// list) must never drift. The discovered list has NO per-row verify action,
// so its stale copy points at registering the topic instead.
const kStaleTopicTooltip =
  "Not seen in the latest sync — the topic may have been renamed or deleted in Telegram. Use the row's verify action to check reachability.";
export const kStaleDiscoveredTooltip =
  "Not seen in the latest sync — the topic may have been renamed or deleted in Telegram. Name the topic to register it, then verify reachability from the topics table.";
export const kUnattributedTooltip =
  "No Telegram account is attributed to this topic, so replies may fail — re-run discovery or assign an account.";

export const QuietDot = () => html`
  <span
    class="inline-block w-1.5 h-1.5 rounded-full bg-gray-500/70 shrink-0"
    title="No activity in over 30 days"
  ></span>
`;

const TopicHealthCell = ({ model }) => html`
  <td class="px-3 py-2 text-fg-muted w-44">
    ${model
      ? html`
          <div class="flex items-center gap-1.5">
            ${model.health.quiet && html`<${QuietDot} />`}
            <span>${model.health.lastSeenLabel}</span>
          </div>
          ${model.health.seenByLabel &&
          html`
            <p class="text-xs text-fg-dim mt-0.5">
              ${model.health.seenByLabel}
            </p>
          `}
        `
      : html`<span class="text-fg-dim">—</span>`}
  </td>
`;

export const AgentSelect = ({ value, agents, onChange, className = "" }) => html`
  <select
    value=${value}
    onChange=${(e) => onChange(e.target.value)}
    class="bg-field border rounded-lg px-2 py-1.5 text-xs text-body focus:outline-none focus:border-fg-muted ${className}"
  >
    <option value="">Default</option>
    ${agents.map(
      (a) => html`<option value=${a.id}>${a.name || a.id}</option>`,
    )}
  </select>
`;

export const TopicEditRow = ({ id, colSpan, agents, edit }) => html`
  <tr class="border-b border-border last:border-0 align-top">
    <td class="px-3 py-2" colspan=${colSpan}>
      <div class="space-y-2">
        <input
          type="text"
          value=${edit.name}
          onInput=${(e) => edit.setName(e.target.value)}
          onKeyDown=${(e) => {
            if (e.key === "Enter") edit.save(id);
            if (e.key === "Escape") edit.cancel();
          }}
          class="w-full bg-field border rounded-lg px-2 py-1.5 text-xs text-body placeholder-fg-dim focus:outline-none focus:border-fg-muted"
        />
        <textarea
          value=${edit.instructions}
          onInput=${(e) => edit.setInstructions(e.target.value)}
          placeholder="System instructions (optional)"
          rows="6"
          class="w-full bg-field border rounded-lg px-2 py-1.5 text-xs text-body placeholder-fg-dim focus:outline-none focus:border-fg-muted resize-y"
        />
        ${agents.length > 0 &&
        html`
          <div class="flex items-center gap-2">
            <label class="text-xs text-fg-muted">Agent:</label>
            <${AgentSelect}
              value=${edit.agentId}
              agents=${agents}
              onChange=${edit.setAgentId}
            />
          </div>
        `}
        <div class="flex items-center gap-2">
          <button
            onclick=${() => edit.save(id)}
            disabled=${edit.savingTopicId === String(id)}
            class="text-xs px-2 py-1 rounded transition-all ac-btn-cyan ${edit.savingTopicId ===
            String(id)
              ? "opacity-50 cursor-not-allowed"
              : ""}"
          >
            ${edit.savingTopicId === String(id) ? "Saving…" : "Save"}
          </button>
          <button
            onclick=${edit.cancel}
            class="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:text-body hover:border-fg-muted"
          >
            Cancel
          </button>
        </div>
        ${edit.error &&
        html`
          <${InlineErrorChip}
            error=${edit.error}
            headline="Couldn't save this topic."
          />
        `}
      </div>
    </td>
  </tr>
`;

export const TopicRow = ({
  id,
  topic,
  rowModel,
  agents,
  hasRegistryData,
  verifying,
  deleting,
  onEdit,
  onVerify,
  onDelete,
}) => html`
  <tr class="border-b border-border last:border-0 align-middle">
    <td class="px-3 py-2 text-body">
      <div class="flex items-center gap-2 flex-wrap">
        <span>${topic.name}</span>
        ${rowModel?.discovered &&
        html`<${Badge} tone="info">discovered</${Badge}>`}
        ${rowModel?.stale &&
        html`<${TooltipBadge}
          tone="warning"
          label="stale"
          text=${kStaleTopicTooltip}
        />`}
        ${rowModel?.unattributed &&
        html`<${TooltipBadge}
          tone="warning"
          label="no account attributed"
          text=${kUnattributedTooltip}
        />`}
        <button
          onclick=${() =>
            onEdit(id, topic.name, topic.systemInstructions, topic.agentId)}
          class="inline-flex items-center justify-center text-white/80 hover:text-white transition-colors"
          title="Edit topic"
          aria-label="Edit topic"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 16 16"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              d="M11.854 1.146a.5.5 0 00-.708 0L3 9.293V13h3.707l8.146-8.146a.5.5 0 000-.708l-3-3zM3.5 12.5v-2.793l7-7L13.793 6l-7 7H3.5z"
            />
          </svg>
        </button>
      </div>
      ${topic.systemInstructions &&
      html`
        <p class="text-xs text-fg-muted mt-1 line-clamp-1">
          ${topic.systemInstructions}
        </p>
      `}
    </td>
    <td class="px-3 py-2 text-fg-muted font-mono w-36">${id}</td>
    ${agents.length > 0 &&
    html`
      <td class="px-3 py-2 text-fg-muted w-32">
        ${topic.agentId
          ? html`<span class="text-body">${agents.find((a) => a.id === topic.agentId)?.name || topic.agentId}</span>`
          : html`<span class="text-fg-dim">default</span>`}
      </td>
    `}
    ${hasRegistryData && html`<${TopicHealthCell} model=${rowModel} />`}
    <td class="px-3 py-2">
      <div class="flex items-center gap-2 justify-end">
        ${rowModel?.stale &&
        html`
          <button
            onclick=${() => onVerify(id)}
            disabled=${verifying}
            class="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:text-body hover:border-fg-muted ${verifying
              ? "opacity-50 cursor-not-allowed"
              : ""}"
            title="Check whether this topic is still reachable"
          >
            ${verifying ? "Verifying…" : "Verify now"}
          </button>
        `}
        <button
          onclick=${() =>
            onDelete({ id: String(id), name: String(topic.name || "") })}
          disabled=${deleting}
          class="text-xs px-2 py-1 rounded border border-border text-fg-muted hover:text-status-error hover:border-red-500 ${deleting
            ? "opacity-50 cursor-not-allowed"
            : ""}"
          title="Delete topic"
        >
          Delete
        </button>
      </div>
    </td>
  </tr>
`;

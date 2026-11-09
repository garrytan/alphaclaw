import { h } from "preact";
import htm from "htm";
import { getChannelMeta } from "../../lib/channel-registry.js";
import { ChevronRightIcon } from "../icons.js";

const html = htm.bind(h);

// The card that lists channel accounts: the Channels page, and the agent
// detail's bindings section with its own rows (`renderItem`).
export const ChannelsCard = ({
  title = "Channels",
  items = [],
  loadingLabel = "Loading…",
  actions = null,
  renderItem = null,
}) => html`
  <div class="bg-surface border border-border rounded-xl p-4">
    <div class="flex items-center justify-between gap-3 mb-3">
      <h2 class="card-label">${title}</h2>
      ${actions ? html`<div class="shrink-0">${actions}</div>` : null}
    </div>
    <div class="space-y-2">
      ${items.length > 0
        ? items.map((item) => {
            const channelMeta = getChannelMeta(item.channel || item.id);
            const clickable = !!item.clickable;
            const customItem = renderItem
              ? renderItem({ item, channelMeta, clickable })
              : null;
            if (customItem) return customItem;
            return html`
              <div
                key=${item.id || item.channel}
                class="flex justify-between items-center py-1.5 ${clickable
                  ? "cursor-pointer hover:bg-surface -mx-2 px-2 rounded-lg transition-colors"
                  : ""}"
                onclick=${clickable ? item.onClick : undefined}
              >
                <span
                  class="font-medium text-sm flex items-center gap-2 min-w-0"
                >
                  ${channelMeta.icon
                    ? html`
                        <${channelMeta.icon} className="w-4 h-4 rounded-sm" />
                      `
                    : null}
                  <span
                    class="truncate ${item.dimmedLabel ? "text-fg-muted" : ""} ${item.labelClassName || ""}"
                    >${item.label || channelMeta.label}</span
                  >
                  ${item.detailText
                    ? html`
                        <span class="text-xs text-fg-muted ml-1 shrink-0">
                          ${item.detailText}
                        </span>
                      `
                    : null}
                  ${item.detailChevron
                    ? html`
                        <${ChevronRightIcon} className="text-fg-dim shrink-0" />
                      `
                    : null}
                </span>
                <span class="flex items-center gap-2 shrink-0">
                  ${item.trailing || null}
                </span>
              </div>
            `;
          })
        : html`<div class="text-fg-muted text-sm text-center py-2">
            ${loadingLabel}
          </div>`}
    </div>
  </div>
`;

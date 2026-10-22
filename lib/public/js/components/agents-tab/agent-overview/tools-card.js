import { h } from "preact";
import htm from "htm";
import { kProfileLabels } from "../agent-tools/tool-catalog.js";
import { ChevronRightIcon } from "../../icons.js";

const html = htm.bind(h);

export const AgentToolsCard = ({
  profile = "full",
  enabledCount = 0,
  totalCount = 0,
  onSwitchToTools = () => {},
}) => {
  const profileLabel = kProfileLabels[profile] || profile;

  return html`
    <div class="bg-surface border border-border rounded-xl p-4">
      <h2 class="card-label mb-3">Tools</h2>
      <div
        class="flex items-center justify-between gap-3 cursor-pointer hover:bg-surface -mx-2 px-2 py-1.5 rounded-lg transition-colors"
        role="button"
        tabindex="0"
        onclick=${onSwitchToTools}
        onKeyDown=${(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSwitchToTools();
          }
        }}
      >
        <span class="font-medium text-sm">${profileLabel}</span>
        <span class="flex items-center gap-2 shrink-0">
          <span class="text-xs text-fg-muted">
            ${enabledCount}/${totalCount} enabled
          </span>
          <${ChevronRightIcon} className="text-fg-dim" />
        </span>
      </div>
    </div>
  `;
};

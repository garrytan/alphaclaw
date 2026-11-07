import { h } from "preact";
import htm from "htm";
import { useState } from "preact/hooks";
import { SegmentedControl } from "../segmented-control.js";
import { ContextBudgetMeter, buildContextBudgetMeterModel } from "./context-budget-meter.js";
import { MeasuredContextCard } from "./context-measured.js";
import { useMeasuredContext } from "./use-measured-context.js";

const html = htm.bind(h);

// Measured (what OpenClaw recorded on the agent's last run) and Estimate (the
// Doctor's model of the loader, main agent only). Measured is the default
// once a run report exists.
export const ContextInjectionPanel = ({
  doctorStatus = null,
  onOpenFile = () => {},
  highlighted = false,
}) => {
  const { agentId, setAgentId, agents, measured, loading, error, refresh } = useMeasuredContext();
  const [view, setView] = useState(null);
  const hasEstimate = !!buildContextBudgetMeterModel(doctorStatus);
  const effectiveView = !hasEstimate ? "measured" : view || (measured?.available ? "measured" : "estimate");
  const agentOptions = agents.length > 0 ? agents : [{ id: "main", name: "" }];
  return html`
    <div class="space-y-2">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <${SegmentedControl}
          options=${hasEstimate
            ? [
                { label: "Measured", value: "measured" },
                { label: "Estimate", value: "estimate" },
              ]
            : [{ label: "Measured", value: "measured" }]}
          value=${effectiveView}
          onChange=${(next) => setView(next)}
        />
        ${effectiveView === "measured"
          ? html`
              <span class="flex items-center gap-2">
                <select
                  class="bg-field border rounded-lg px-2 py-1 text-xs text-body"
                  aria-label="Agent"
                  value=${agentId}
                  onChange=${(event) => {
                    setView("measured");
                    setAgentId(event.currentTarget.value);
                  }}
                >
                  ${agentOptions.map(
                    (agent) => html`<option key=${agent.id} value=${agent.id}>${agent.name || agent.id}</option>`,
                  )}
                </select>
                <button
                  type="button"
                  class="text-xs text-fg-muted hover:text-body"
                  onClick=${() => refresh().catch(() => {})}
                >
                  Refresh
                </button>
              </span>
            `
          : null}
      </div>
      ${effectiveView === "measured"
        ? html`<${MeasuredContextCard}
            measured=${measured}
            loading=${loading}
            error=${error}
            onOpenFile=${onOpenFile}
            highlighted=${highlighted}
          />`
        : html`<${ContextBudgetMeter}
            doctorStatus=${doctorStatus}
            onOpenFile=${onOpenFile}
            highlighted=${highlighted}
          />`}
    </div>
  `;
};

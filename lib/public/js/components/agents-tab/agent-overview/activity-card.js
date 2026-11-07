import { h } from "preact";
import htm from "htm";
import { useCachedFetch } from "../../../hooks/use-cached-fetch.js";
import { fetchUsageSummary } from "../../../lib/api/usage.js";
import { formatInteger, formatUsd } from "../../../lib/format.js";
import { buildAgentActivity } from "../agent-detail-model.js";

const html = htm.bind(h);

export const kAgentActivityReadKey = "/api/usage/summary?days=7";

// 7-day activity for one agent from the usage summary's daily[].agents.
// A failed read shows the error, never the previous numbers.
export const AgentActivityCard = ({ agent = {} }) => {
  const read = useCachedFetch(kAgentActivityReadKey, () => fetchUsageSummary(7), { maxAgeMs: 60000 });
  const name = agent.name || agent.id;
  const activity = read.data && !read.error
    ? buildAgentActivity({ summary: read.data?.summary || read.data, agentId: agent.id })
    : null;
  return html`
    <section class="bg-surface border border-border rounded-xl p-4 space-y-3 agents-activity" aria-labelledby="agent-activity-title">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="agent-activity-title" class="card-label">7-day activity for ${name}</h2>
        ${activity && activity.totalTurns > 0
          ? html`<span class="text-xs text-fg-muted">${formatInteger(activity.totalTurns)} turn${activity.totalTurns === 1 ? "" : "s"} · ${formatUsd(activity.totalCost)}</span>`
          : null}
      </div>
      ${read.error
        ? html`<p class="text-xs text-status-error-muted" role="alert">Couldn't load activity. ${read.error?.message || ""}</p>`
        : !activity
          ? html`<p class="text-xs text-fg-muted">Loading activity…</p>`
          : activity.totalTurns === 0
            ? html`<p class="text-sm text-fg-muted">No turns in the last 7 days.</p>`
            : html`
                <div class="agents-activity-chart" aria-hidden="true">
                  ${activity.days.map(
                    (day) => html`
                      <div key=${day.date} class="agents-activity-day" title=${day.label + ": " + day.turns + " turns, " + formatUsd(day.cost)}>
                        <span class="agents-activity-turns">${day.turns}</span>
                        <span class="agents-activity-track">
                          <span
                            class="agents-activity-bar"
                            style=${"height:" + (activity.maxTurns > 0 ? Math.round((day.turns / activity.maxTurns) * 100) : 0) + "%"}
                          ></span>
                        </span>
                        <span class="agents-activity-date">${day.label}</span>
                        <span class="agents-activity-cost">${formatUsd(day.cost)}</span>
                      </div>
                    `,
                  )}
                </div>
                <table class="sr-only">
                  <caption>Turns and cost per day for ${name}</caption>
                  <thead><tr><th scope="col">Day</th><th scope="col">Turns</th><th scope="col">Cost</th></tr></thead>
                  <tbody>
                    ${activity.days.map(
                      (day) => html`<tr key=${day.date}><th scope="row">${day.date}</th><td>${day.turns}</td><td>${formatUsd(day.cost)}</td></tr>`,
                    )}
                  </tbody>
                </table>
              `}
    </section>
  `;
};

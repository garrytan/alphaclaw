import { h } from "preact";
import htm from "htm";
import { formatInteger, formatUsd } from "../../lib/format.js";
import { AsyncSection } from "../async-section.js";
import { SegmentedControl } from "../segmented-control.js";
import {
  kRangeOptions,
  kUsageBreakdownOptions,
  kUsageSourceOrder,
} from "./constants.js";
import { renderSourceLabel } from "./formatters.js";
import { hasUsage } from "./strip-model.js";

const html = htm.bind(h);

const sourceRowOf = (agentRow, sourceName) => {
  const breakdown = agentRow?.sourceBreakdown;
  const row = Array.isArray(breakdown)
    ? breakdown.find((entry) => String(entry?.source || "") === sourceName)
    : breakdown?.[sourceName];
  return row || { totalCost: 0, totalTokens: 0, turnCount: 0 };
};

// Spend by agent (the table rule: a real table, sentence-case headers, the
// source split as columns), plus the models with no pricing.
export const AgentCostTable = ({ summary }) => {
  const agents = Array.isArray(summary?.costByAgent?.agents)
    ? summary.costByAgent.agents
    : [];
  const missingPricingModels = Array.from(
    new Set(
      (summary?.daily || [])
        .flatMap((dayRow) => dayRow?.models || [])
        .filter(
          (modelRow) =>
            !modelRow?.pricingFound && Number(modelRow?.totalTokens || 0) > 0,
        )
        .map(
          (modelRow) =>
            String(modelRow?.model || "unknown").trim() || "unknown",
        ),
    ),
  ).sort((leftValue, rightValue) => leftValue.localeCompare(rightValue));
  const missingPricingLabel =
    missingPricingModels.length > 3
      ? `${missingPricingModels.slice(0, 3).join(", ")}, +${missingPricingModels.length - 3} more`
      : missingPricingModels.join(", ");

  return html`
    <section class="usage-card" aria-labelledby="usage-agents-title">
      <div class="usage-card-head">
        <h2 class="usage-card-title" id="usage-agents-title">Estimated spend by agent</h2>
      </div>
      ${agents.length === 0
        ? html`<p class="text-sm text-fg-muted">No agent usage recorded for this range.</p>`
        : html`
            <table class="ac-table">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col" class="ac-table-num">Spend</th>
                  <th scope="col" class="ac-table-num">Tokens</th>
                  <th scope="col" class="ac-table-num">Turns</th>
                  ${kUsageSourceOrder.map(
                    (sourceName) => html`<th scope="col" class="ac-table-num">${renderSourceLabel(sourceName)}</th>`,
                  )}
                </tr>
              </thead>
              <tbody>
                ${agents.map(
                  (agentRow) => html`
                    <tr key=${String(agentRow.agent || "")}>
                      <td data-label="Agent" class="ac-table-name">${String(agentRow.agent || "unknown")}</td>
                      <td data-label="Spend" class="ac-table-num">${formatUsd(agentRow.totalCost)}</td>
                      <td data-label="Tokens" class="ac-table-num">${formatInteger(agentRow.totalTokens)}</td>
                      <td data-label="Turns" class="ac-table-num">${formatInteger(agentRow.turnCount)}</td>
                      ${kUsageSourceOrder.map((sourceName) => {
                        const sourceRow = sourceRowOf(agentRow, sourceName);
                        return html`<td
                          data-label=${renderSourceLabel(sourceName)}
                          class="ac-table-num"
                          title=${`${formatInteger(sourceRow.totalTokens)} tokens · ${formatInteger(sourceRow.turnCount)} turns`}
                        >
                          ${formatUsd(sourceRow.totalCost)}
                        </td>`;
                      })}
                    </tr>
                  `,
                )}
              </tbody>
            </table>
          `}
      ${missingPricingModels.length
        ? html`<p class="text-xs text-fg-muted mt-3">
            Missing model pricing for ${missingPricingModels.length}
            ${missingPricingModels.length === 1 ? "model" : "models"}: ${missingPricingLabel}.
          </p>`
        : null}
    </section>
  `;
};

export const OverviewSection = ({
  summary = null,
  summaryLoading = false,
  summaryError = null,
  onRetry = () => {},
  metric = "tokens",
  breakdown = "model",
  days = 30,
  overviewCanvasRef,
  onDaysChange = () => {},
  onMetricChange = () => {},
  onBreakdownChange = () => {},
}) => {
  // The controls stay interactive from the first frame; the chart area alone
  // shows loading, a failed read (never the previous range's bars) or the
  // empty state.
  const chartState = summaryError
    ? "error"
    : !summary
      ? summaryLoading ? "loading" : "empty"
      : hasUsage(summary) ? "chart" : "empty";

  return html`
    <div class="usage-sections">
      <section class="usage-card" aria-labelledby="usage-chart-title">
        <div class="usage-card-head">
          <h2 class="usage-card-title" id="usage-chart-title">By day</h2>
          <div class="usage-card-actions">
            <select
              class="bg-field border rounded-lg text-xs px-2.5 py-1.5 text-body focus:border-fg-muted"
              value=${breakdown}
              onChange=${(event) =>
                onBreakdownChange(String(event.currentTarget?.value || "model"))}
              aria-label="Usage chart breakdown"
            >
              ${kUsageBreakdownOptions.map(
                (option) => html`<option value=${option.value}>${option.label}</option>`,
              )}
            </select>
            <${SegmentedControl}
              options=${kRangeOptions.map((option) => ({
                label: option.label,
                value: option.value,
              }))}
              value=${days}
              onChange=${onDaysChange}
            />
            <${SegmentedControl}
              options=${[
                { label: "tokens", value: "tokens" },
                { label: "cost", value: "cost" },
              ]}
              value=${metric}
              onChange=${onMetricChange}
            />
          </div>
        </div>
        ${chartState === "chart"
          ? html`<div class="relative" style=${{ height: "280px" }}><canvas ref=${overviewCanvasRef}></canvas></div>`
          : html`<${AsyncSection}
              loading=${chartState === "loading"}
              loadingLabel="Loading…"
              error=${summaryError}
              errorHeadline="Couldn't load usage."
              onRetry=${onRetry}
              empty=${chartState === "empty"}
              emptyTitle="No usage yet"
              emptyBody="Spend appears here after your agents' first turns."
            />`}
      </section>
      ${chartState === "chart" ? html`<${AgentCostTable} summary=${summary} />` : null}
    </div>
  `;
};

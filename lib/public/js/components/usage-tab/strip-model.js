import { formatCompactNumber, formatInteger, formatUsd, toLocalDayKey } from "../../lib/format.js";

// Pure view-models for the Usage page (ALPH-69 PR 3b), from the one summary
// read the page already makes.

// The first local day key of a window of `days` calendar days ending today
// (DST-safe: steps the calendar, never subtracts milliseconds).
export const windowStartDayKey = (days, nowMs = Date.now()) => {
  const start = new Date(nowMs);
  start.setDate(start.getDate() - (Math.max(1, days) - 1));
  return toLocalDayKey(start);
};

// Spend and tokens for today, the last 7 and the last 30 calendar days.
export const buildPeriodSummary = (daily = [], nowMs = Date.now()) => {
  const today = toLocalDayKey(new Date(nowMs));
  const weekStart = windowStartDayKey(7, nowMs);
  const monthStart = windowStartDayKey(30, nowMs);
  const totals = { today: { tokens: 0, cost: 0 }, week: { tokens: 0, cost: 0 }, month: { tokens: 0, cost: 0 } };
  for (const row of Array.isArray(daily) ? daily : []) {
    const date = String(row?.date || "");
    const tokens = Number(row?.totalTokens || 0);
    const cost = Number(row?.totalCost || 0);
    for (const [key, since] of [["today", today], ["week", weekStart], ["month", monthStart]]) {
      if (key === "today" ? date === today : date >= since) {
        totals[key].tokens += tokens;
        totals[key].cost += cost;
      }
    }
  }
  return totals;
};

// The model with the most tokens across the range, and its share.
export const findMostUsedModel = (daily = []) => {
  const byModel = new Map();
  let total = 0;
  for (const row of Array.isArray(daily) ? daily : []) {
    for (const modelRow of Array.isArray(row?.models) ? row.models : []) {
      const tokens = Number(modelRow?.totalTokens || 0);
      if (tokens <= 0) continue;
      const model = String(modelRow?.model || "unknown").trim() || "unknown";
      byModel.set(model, (byModel.get(model) || 0) + tokens);
      total += tokens;
    }
  }
  let best = null;
  for (const [model, tokens] of byModel) {
    if (!best || tokens > best.tokens || (tokens === best.tokens && model < best.model)) best = { model, tokens };
  }
  return best ? { ...best, share: total > 0 ? best.tokens / total : 0 } : null;
};

export const hasUsage = (summary = null) => {
  const totals = summary?.totals || {};
  return Number(totals.turnCount || 0) > 0 || Number(totals.totalTokens || 0) > 0 || Number(totals.totalCost || 0) > 0;
};

const kLoading = { value: "—", detail: "", loading: true };

// Spend, Turns, Tokens and Most used model. A failed summary read shows "—"
// in every cell with the cause, never the previous range's numbers.
export const buildUsageStripCells = ({ summary = null, loading = false, error = null, days = 30, nowMs = Date.now() } = {}) => {
  const labels = [
    ["spend", "Spend " + days + "d"],
    ["turns", "Turns"],
    ["tokens", "Tokens"],
    ["model", "Most used model"],
  ];
  if (error) {
    const cause = String(error?.message || error || "Could not load usage");
    return labels.map(([key, label]) => ({ key, label, value: "—", detail: cause, error: true }));
  }
  if (!summary) return labels.map(([key, label]) => ({ key, label, ...(loading ? kLoading : { value: "—", detail: "" }) }));
  const totals = summary.totals || {};
  const turns = Number(totals.turnCount || 0);
  const tokens = Number(totals.totalTokens || 0);
  const cost = Number(totals.totalCost || 0);
  const cacheRead = Number(totals.cacheReadTokens || 0);
  const prompt = Number(totals.inputTokens || 0) + cacheRead + Number(totals.cacheWriteTokens || 0);
  const period = buildPeriodSummary(summary.daily, nowMs);
  const top = findMostUsedModel(summary.daily);
  return [
    {
      key: "spend",
      label: labels[0][1],
      value: formatUsd(cost),
      detail: formatUsd(period.today.cost) + " today · " + formatUsd(period.week.cost) + " last 7 days",
    },
    {
      key: "turns",
      label: "Turns",
      value: formatInteger(turns),
      detail: turns > 0 ? formatUsd(cost / turns) + " per turn" : "No turns yet",
    },
    {
      key: "tokens",
      label: "Tokens",
      value: formatCompactNumber(tokens),
      detail:
        (prompt > 0 ? ((cacheRead / prompt) * 100).toFixed(1) + "% cache hits" : "0.0% cache hits") +
        (turns > 0 ? " · " + formatCompactNumber(tokens / turns) + " per turn" : ""),
    },
    top
      ? { key: "model", label: "Most used model", value: top.model, title: top.model, mono: true, detail: Math.round(top.share * 100) + "% of tokens" }
      : { key: "model", label: "Most used model", value: "—", detail: "No turns yet" },
  ];
};

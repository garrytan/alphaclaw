const { deriveCostBreakdown } = require("../../cost-utils");
// Time-zone helpers live in utils/time-zone.js (shared with cron trends);
// re-exported below under their original names for back-compat.
const {
  kUtcTimeZone,
  normalizeTimeZone,
  toTimeZoneDayKey,
} = require("../../utils/time-zone");

const kDefaultSessionLimit = 50;
const kMaxSessionLimit = 200;
const kDefaultDays = 30;
const kDefaultMaxPoints = 100;
const kMaxMaxPoints = 1000;
const kDayMs = 24 * 60 * 60 * 1000;

const coerceInt = (value, fallbackValue = 0) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallbackValue;
};

const clampInt = (value, minValue, maxValue, fallbackValue) =>
  Math.min(maxValue, Math.max(minValue, coerceInt(value, fallbackValue)));

const toDayKey = (timestampMs) => new Date(timestampMs).toISOString().slice(0, 10);

const getPeriodRange = (days, timeZone = kUtcTimeZone) => {
  const now = Date.now();
  const safeDays = clampInt(days, 1, 3650, kDefaultDays);
  const startMs = now - safeDays * kDayMs;
  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const startDay = normalizedTimeZone === kUtcTimeZone
    ? toDayKey(startMs)
    : toTimeZoneDayKey(startMs, normalizedTimeZone);
  return { now, safeDays, startDay, timeZone: normalizedTimeZone };
};

const getUsageMetricsFromEventRow = (row) => {
  const inputTokens = coerceInt(row.input_tokens);
  const outputTokens = coerceInt(row.output_tokens);
  const cacheReadTokens = coerceInt(row.cache_read_tokens);
  const cacheWriteTokens = coerceInt(row.cache_write_tokens);
  const totalTokens =
    coerceInt(row.total_tokens) ||
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const cost = deriveCostBreakdown({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    provider: row.provider,
    model: row.model,
  });
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    ...cost,
  };
};

const parseAgentAndSourceFromSessionRef = (sessionRef) => {
  const raw = String(sessionRef || "").trim();
  if (!raw) {
    return { agent: "unknown", source: "chat" };
  }
  const parts = raw.split(":");
  const agent =
    parts[0] === "agent" && String(parts[1] || "").trim()
      ? String(parts[1] || "").trim()
      : "unknown";
  const source = parts.includes("hook")
    ? "hooks"
    : parts.includes("cron")
      ? "cron"
      : "chat";
  return { agent, source };
};

const downsamplePoints = (points, maxPoints) => {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const sampled = [];
  for (let index = 0; index < points.length; index += stride) {
    sampled.push(points[index]);
  }
  const lastPoint = points[points.length - 1];
  if (sampled[sampled.length - 1]?.timestamp !== lastPoint.timestamp) {
    sampled.push(lastPoint);
  }
  return sampled;
};

module.exports = {
  kDefaultSessionLimit,
  kMaxSessionLimit,
  kDefaultDays,
  kDefaultMaxPoints,
  kMaxMaxPoints,
  kDayMs,
  kUtcTimeZone,
  coerceInt,
  clampInt,
  normalizeTimeZone,
  toTimeZoneDayKey,
  toDayKey,
  getPeriodRange,
  getUsageMetricsFromEventRow,
  parseAgentAndSourceFromSessionRef,
  downsamplePoints,
};

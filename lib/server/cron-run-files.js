const path = require("path");
const { tailLines } = require("./utils/tail-bytes");
const { CronHistoryUnavailableError } = require("./cron-run-errors");
const kRunLogTailBytes = 256 * 1024;
const kMaxRunsLimit = 200;
const kDefaultRunsLimit = 20;

const readRunLines = (runLogPath) => {
  try {
    return tailLines(runLogPath, kRunLogTailBytes, { throwOnError: true });
  } catch (error) {
    throw new CronHistoryUnavailableError(error);
  }
};

const toFiniteNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const sanitizeCronJobId = (jobId = "") => {
  const trimmed = String(jobId || "").trim();
  if (!trimmed) throw new Error("Job id is required");
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) {
    throw new Error("Invalid job id");
  }
  return trimmed;
};

const normalizeRunStatus = (value = "all") => {
  const normalized = String(value || "all").trim().toLowerCase();
  if (["ok", "error", "skipped", "all"].includes(normalized)) return normalized;
  return "all";
};

const normalizeDeliveryStatus = (value = "all") => {
  const normalized = String(value || "all").trim().toLowerCase();
  if (
    ["delivered", "not-delivered", "unknown", "not-requested", "all"].includes(
      normalized,
    )
  ) {
    return normalized;
  }
  return "all";
};


const paginate = (items = [], { limit = 200, offset = 0 } = {}) => {
  const safeLimit = Math.max(1, Math.min(200, Number.parseInt(String(limit), 10) || 200));
  const safeOffset = Math.max(0, Number.parseInt(String(offset), 10) || 0);
  const total = items.length;
  const entries = items.slice(safeOffset, safeOffset + safeLimit);
  const nextOffset = safeOffset + entries.length;
  return {
    entries,
    total,
    offset: safeOffset,
    limit: safeLimit,
    hasMore: nextOffset < total,
    nextOffset: nextOffset < total ? nextOffset : null,
  };
};

const parseRunLogLine = (line, jobId) => {
  if (!line) return null;
  try {
    const value = JSON.parse(line);
    if (!value || typeof value !== "object") return null;
    if (String(value.action || "") !== "finished") return null;
    if (String(value.jobId || "") !== jobId) return null;
    const ts = toFiniteNumber(value.ts, 0);
    if (!ts) return null;
    return {
      ts,
      jobId,
      action: "finished",
      status: value.status,
      error: value.error,
      summary: value.summary,
      delivered:
        typeof value.delivered === "boolean" ? value.delivered : undefined,
      deliveryStatus: value.deliveryStatus,
      deliveryError: value.deliveryError,
      sessionId: value.sessionId,
      sessionKey: value.sessionKey,
      runAtMs: value.runAtMs,
      durationMs: value.durationMs,
      nextRunAtMs: value.nextRunAtMs,
      model: value.model,
      provider: value.provider,
      usage:
        value.usage && typeof value.usage === "object" ? value.usage : undefined,
    };
  } catch {
    return null;
  }
};


const readJobRuns = ({
  runsDir,
  jobId,
  limit = kDefaultRunsLimit,
  offset = 0,
  status = "all",
  deliveryStatus = "all",
  sortDir = "desc",
  query = "",
}) => {
  const safeJobId = sanitizeCronJobId(jobId);
  const runLogPath = path.join(runsDir, `${safeJobId}.jsonl`);
  // Bounded tail read (run logs are append-only and unbounded): reads at most
  // kRunLogTailBytes from the END of the file — never the whole file.
  const lines = readRunLines(runLogPath).map((line) => line.trim()).filter(Boolean);
  const entries = lines
    .map((line) => parseRunLogLine(line, safeJobId))
    .filter(Boolean);

  const normalizedStatus = normalizeRunStatus(status);
  const normalizedDeliveryStatus = normalizeDeliveryStatus(deliveryStatus);
  const queryText = String(query || "").trim().toLowerCase();

  const filtered = entries.filter((entry) => {
    if (normalizedStatus !== "all" && String(entry.status || "") !== normalizedStatus) {
      return false;
    }
    const entryDelivery = String(entry.deliveryStatus || "not-requested");
    if (
      normalizedDeliveryStatus !== "all" &&
      entryDelivery !== normalizedDeliveryStatus
    ) {
      return false;
    }
    if (!queryText) return true;
    const searchable = [
      String(entry.summary || ""),
      String(entry.error || ""),
      String(entry.model || ""),
      String(entry.provider || ""),
    ]
      .join(" ")
      .toLowerCase();
    return searchable.includes(queryText);
  });

  filtered.sort((a, b) => {
    if (sortDir === "asc") return a.ts - b.ts;
    return b.ts - a.ts;
  });

  const page = paginate(filtered, {
    limit: Math.max(1, Math.min(kMaxRunsLimit, Number.parseInt(String(limit), 10) || kDefaultRunsLimit)),
    offset,
  });
  return {
    runLogPath,
    entries: page.entries,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    hasMore: page.hasMore,
    nextOffset: page.nextOffset,
  };
};

const readJobDurationStats = ({ runsDir, jobId, sinceMs = 0 }) => {
  const safeJobId = sanitizeCronJobId(jobId);
  const runLogPath = path.join(runsDir, `${safeJobId}.jsonl`);
  // Bounded tail read (run logs are append-only and unbounded): reads at most
  // kRunLogTailBytes from the END of the file — never the whole file.
  const lines = readRunLines(runLogPath).map((line) => line.trim()).filter(Boolean);
  const safeSinceMs = toFiniteNumber(sinceMs, 0);
  let totalDurationMs = 0;
  let sampleCount = 0;
  for (const line of lines) {
    const entry = parseRunLogLine(line, safeJobId);
    if (!entry) continue;
    if (safeSinceMs > 0 && toFiniteNumber(entry.ts, 0) < safeSinceMs) continue;
    const durationMs = toFiniteNumber(entry.durationMs, -1);
    if (!Number.isFinite(durationMs) || durationMs < 0) continue;
    totalDurationMs += durationMs;
    sampleCount += 1;
  }
  return {
    totalDurationMs,
    sampleCount,
    avgDurationMs: sampleCount > 0 ? Math.round(totalDurationMs / sampleCount) : 0,
  };
};

module.exports = { toFiniteNumber, sanitizeCronJobId, normalizeRunStatus, normalizeDeliveryStatus, parseRunLogLine, readJobRuns, readJobDurationStats, readRunLines };

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

module.exports = { toFiniteNumber, sanitizeCronJobId, normalizeRunStatus, normalizeDeliveryStatus, parseRunLogLine };

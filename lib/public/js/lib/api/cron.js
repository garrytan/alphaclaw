import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export async function fetchCronJobs({ sortBy = "nextRunAtMs", sortDir = "asc" } = {}) {
  const params = new URLSearchParams();
  if (sortBy) params.set("sortBy", String(sortBy));
  if (sortDir) params.set("sortDir", String(sortDir));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await authFetch(`/api/cron/jobs${suffix}`);
  return parseJsonOrThrow(res, "Could not load cron jobs");
}

export async function fetchCronStatus() {
  const res = await authFetch("/api/cron/status");
  return parseJsonOrThrow(res, "Could not load cron status");
}

export async function fetchCronJobRuns(
  id,
  {
    limit = 20,
    offset = 0,
    status = "all",
    deliveryStatus = "all",
    sortDir = "desc",
    query = "",
  } = {},
) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    status: String(status || "all"),
    deliveryStatus: String(deliveryStatus || "all"),
    sortDir: String(sortDir || "desc"),
  });
  if (String(query || "").trim()) params.set("query", String(query).trim());
  const safeId = encodeURIComponent(String(id || ""));
  const res = await authFetch(`/api/cron/jobs/${safeId}/runs?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load cron run history");
}

export async function fetchCronJobUsage(id, { days = 30 } = {}) {
  const params = new URLSearchParams({ days: String(days) });
  const safeId = encodeURIComponent(String(id || ""));
  const res = await authFetch(`/api/cron/jobs/${safeId}/usage?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load cron job usage");
}

export async function fetchCronJobTrends(id, { range = "7d" } = {}) {
  const params = new URLSearchParams({ range: String(range || "7d") });
  const safeId = encodeURIComponent(String(id || ""));
  const res = await authFetch(`/api/cron/jobs/${safeId}/trends?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load cron job trends");
}

export async function fetchCronBulkUsage({ days = 30 } = {}) {
  const params = new URLSearchParams({ days: String(days) });
  const res = await authFetch(`/api/cron/usage/bulk?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load cron usage overview");
}

export async function fetchCronBulkRuns({
  sinceMs = 0,
  limitPerJob = 20,
  status = "all",
  deliveryStatus = "all",
  sortDir = "desc",
} = {}) {
  const params = new URLSearchParams({
    sinceMs: String(sinceMs || 0),
    limitPerJob: String(limitPerJob || 20),
    status: String(status || "all"),
    deliveryStatus: String(deliveryStatus || "all"),
    sortDir: String(sortDir || "desc"),
  });
  const res = await authFetch(`/api/cron/runs/bulk?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load cron run outcomes");
}

export async function triggerCronJobRun(id) {
  const safeId = encodeURIComponent(String(id || ""));
  const res = await authFetch(`/api/cron/jobs/${safeId}/run`, { method: "POST" });
  return parseJsonOrThrow(res, "Could not trigger cron job run");
}

export async function setCronJobEnabled(id, enabled) {
  const safeId = encodeURIComponent(String(id || ""));
  const action = enabled ? "enable" : "disable";
  const res = await authFetch(`/api/cron/jobs/${safeId}/${action}`, {
    method: "POST",
  });
  return parseJsonOrThrow(res, "Could not update cron job state");
}

export async function updateCronJobPrompt(id, message) {
  const safeId = encodeURIComponent(String(id || ""));
  const res = await authFetch(`/api/cron/jobs/${safeId}/prompt`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: String(message || "") }),
  });
  return parseJsonOrThrow(res, "Could not update cron prompt");
}

export async function updateCronJobRouting(
  id,
  {
    sessionTarget = "",
    wakeMode = "",
    deliveryMode = "",
    deliveryChannel = "",
    deliveryTo = "",
  } = {},
) {
  const safeId = encodeURIComponent(String(id || ""));
  const res = await authFetch(`/api/cron/jobs/${safeId}/routing`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionTarget: String(sessionTarget || ""),
      wakeMode: String(wakeMode || ""),
      deliveryMode: String(deliveryMode || ""),
      deliveryChannel: String(deliveryChannel || ""),
      deliveryTo: String(deliveryTo || ""),
    }),
  });
  return parseJsonOrThrow(res, "Could not update cron routing");
}

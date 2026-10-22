import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export async function fetchUsageSummary(days = 30) {
  const params = new URLSearchParams({ days: String(days) });
  const res = await authFetch(`/api/usage/summary?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load usage summary");
}

export async function fetchUsageSessions(limit = 50) {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await authFetch(`/api/usage/sessions?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load usage sessions");
}

export async function fetchUsageSessionDetail(sessionId) {
  const res = await authFetch(
    `/api/usage/sessions/${encodeURIComponent(String(sessionId || ""))}`,
  );
  return parseJsonOrThrow(res, "Could not load usage session detail");
}

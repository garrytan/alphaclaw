import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export async function fetchRelayStatus() {
  const res = await authFetch("/api/relay/status");
  return parseJsonOrThrow(res, "Could not load the relay status");
}

export async function fetchRelayRuns({ limit = 50 } = {}) {
  const res = await authFetch("/api/relay/runs?limit=" + encodeURIComponent(String(limit)));
  return parseJsonOrThrow(res, "Could not load bridged relay messages");
}

export async function fetchRelayMessages({ limit = 50, before = null } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set("before", String(before));
  const res = await authFetch("/api/relay/messages?" + params.toString());
  return parseJsonOrThrow(res, "Could not load the relay log");
}

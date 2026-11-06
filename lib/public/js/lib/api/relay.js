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

export async function fetchRelayRemote() {
  const res = await authFetch("/api/relay/remote");
  return parseJsonOrThrow(res, "Could not load relay connections");
}

export async function revokeRelayClient(clientId) {
  const res = await authFetch("/api/relay/remote/clients/" + encodeURIComponent(String(clientId)) + "/revoke", { method: "POST" });
  return parseJsonOrThrow(res, "Could not revoke the connection");
}

export async function removeRelayBinding(agent) {
  const res = await authFetch("/api/relay/remote/bindings/" + encodeURIComponent(String(agent)), { method: "DELETE" });
  return parseJsonOrThrow(res, "Could not remove the binding");
}

export async function fetchRelayMessages({ limit = 50, before = null } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set("before", String(before));
  const res = await authFetch("/api/relay/messages?" + params.toString());
  return parseJsonOrThrow(res, "Could not load the relay log");
}

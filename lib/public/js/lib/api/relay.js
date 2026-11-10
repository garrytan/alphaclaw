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

export async function openRelayConsentWindow() {
  const res = await authFetch("/api/relay/remote/consent-window", { method: "POST" });
  return parseJsonOrThrow(res, "Could not allow a new connection");
}

export async function revokeRelayClient(clientId) {
  const res = await authFetch("/api/relay/remote/clients/" + encodeURIComponent(String(clientId)) + "/revoke", { method: "POST" });
  return parseJsonOrThrow(res, "Could not revoke the connection");
}

export async function removeRelayBinding(agent) {
  const res = await authFetch("/api/relay/remote/bindings/" + encodeURIComponent(String(agent)), { method: "DELETE" });
  return parseJsonOrThrow(res, "Could not remove the binding");
}

export async function grantRelayDelegate(agent) {
  const res = await authFetch("/api/relay/remote/grants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agent: String(agent), tier: "delegate" }),
  });
  return parseJsonOrThrow(res, "Could not add the grant");
}

// A Capy grant: threads of this Capy project and owner whose machines attest
// with their Capy token act as you (relay trust v2 PR3).
export async function grantRelayCapyProject({ project, user }) {
  const res = await authFetch("/api/relay/remote/grants", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: "capy", project: String(project), user: String(user), tier: "delegate" }),
  });
  return parseJsonOrThrow(res, "Could not add the Capy project");
}

export async function revokeRelayGrant(id) {
  const res = await authFetch("/api/relay/remote/grants/" + encodeURIComponent(String(id)) + "/revoke", { method: "POST" });
  return parseJsonOrThrow(res, "Could not revoke the grant");
}

export async function retryRelayArchive() {
  const res = await authFetch("/api/relay/archive/retry", { method: "POST" });
  return parseJsonOrThrow(res, "Could not retry the brain archive");
}

export async function fetchRelayMessages({ limit = 50, before = null } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before) params.set("before", String(before));
  const res = await authFetch("/api/relay/messages?" + params.toString());
  return parseJsonOrThrow(res, "Could not load the relay log");
}

export async function fetchRelayConversations({ q = "", agent = "", from = "", to = "", before = null, limit = 50 } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  for (const [key, value] of Object.entries({ q, agent, from, to })) if (value) params.set(key, String(value));
  if (before) params.set("before", String(before));
  const res = await authFetch("/api/relay/conversations?" + params.toString());
  return parseJsonOrThrow(res, "Could not load relay conversations");
}

export async function fetchRelayConversation(id, { before = null } = {}) {
  const params = new URLSearchParams();
  if (before) params.set("before", String(before));
  const query = params.toString();
  const res = await authFetch("/api/relay/conversations/" + encodeURIComponent(String(id)) + (query ? "?" + query : ""));
  return parseJsonOrThrow(res, "Could not load the relay conversation");
}

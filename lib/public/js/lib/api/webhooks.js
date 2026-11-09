import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export async function fetchWebhooks() {
  const res = await authFetch("/api/webhooks");
  return parseJsonOrThrow(res, "Could not load webhooks");
}

export async function fetchWebhookDetail(name) {
  const res = await authFetch(`/api/webhooks/${encodeURIComponent(name)}`);
  return parseJsonOrThrow(res, "Could not load webhook detail");
}

export async function createWebhook(
  name,
  { destination = null, oauthCallback = false } = {},
) {
  const res = await authFetch("/api/webhooks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      ...(destination ? { destination } : {}),
      oauthCallback: !!oauthCallback,
    }),
  });
  return parseJsonOrThrow(res, "Could not create webhook");
}

export async function deleteWebhook(name, { deleteTransformDir = false } = {}) {
  const res = await authFetch(`/api/webhooks/${encodeURIComponent(name)}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ deleteTransformDir: !!deleteTransformDir }),
  });
  return parseJsonOrThrow(res, "Could not delete webhook");
}

export async function updateWebhookDestination(name, { destination = null } = {}) {
  const res = await authFetch(
    `/api/webhooks/${encodeURIComponent(name)}/destination`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        destination,
      }),
    },
  );
  return parseJsonOrThrow(res, "Could not update webhook destination");
}

export async function rotateWebhookOauthCallback(name) {
  const res = await authFetch(
    `/api/webhooks/${encodeURIComponent(name)}/oauth-callback/rotate`,
    {
      method: "POST",
    },
  );
  return parseJsonOrThrow(res, "Could not rotate OAuth callback");
}

export async function fetchWebhookRequests(
  name,
  { limit = 50, offset = 0, status = "all" } = {},
) {
  const params = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    status: String(status || "all"),
  });
  const res = await authFetch(
    `/api/webhooks/${encodeURIComponent(name)}/requests?${params.toString()}`,
  );
  return parseJsonOrThrow(res, "Could not load webhook requests");
}

export async function fetchWebhookRequest(name, id) {
  const res = await authFetch(
    `/api/webhooks/${encodeURIComponent(name)}/requests/${encodeURIComponent(String(id))}`,
  );
  return parseJsonOrThrow(res, "Could not load webhook request");
}

// Sends a request to a hook's public ingress (or OAuth callback) URL the way an
// outside sender would: plain fetch, never authFetch, so the hook's own 401 is
// reported as the hook's answer instead of signing the Setup UI out. Resolves
// to the hook's rejection message, or "" when the hook accepted the request.
export async function sendWebhookRequest(url, options = {}) {
  const response = await fetch(url, options);
  const bodyText = await response.text();
  let body = null;
  try {
    body = bodyText ? JSON.parse(bodyText) : null;
  } catch {
    body = null;
  }
  if (body?.ok === false) return body?.error || "Webhook rejected";
  if (!response.ok) return body?.error || bodyText || `HTTP ${response.status}`;
  return "";
}

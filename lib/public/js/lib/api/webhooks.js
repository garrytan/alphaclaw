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

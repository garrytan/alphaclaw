import { fetchReadResponse } from "../api-read-request.js";
import { authFetch } from "./http.js";
import { parseJsonOrThrow, parseEnvelopeOrThrow } from "./parse.js";

export async function fetchAlphaclawVersion(refresh = false) {
  const query = refresh ? "?refresh=1" : "";
  const res = await authFetch(`/api/alphaclaw/version${query}`);
  return parseJsonOrThrow(res, "Could not load data");
}

export async function fetchAlphaclawReleaseNotes(tag = "") {
  const normalizedTag = String(tag || "").trim();
  const query = normalizedTag
    ? `?${new URLSearchParams({ tag: normalizedTag }).toString()}`
    : "";
  try {
    const res = await authFetch(`/api/alphaclaw/release-notes${query}`);
    return await parseJsonOrThrow(res, "Could not load release notes");
  } catch {
    const endpoint = normalizedTag
      ? `https://api.github.com/repos/chrysb/alphaclaw/releases/tags/${encodeURIComponent(normalizedTag)}`
      : "https://api.github.com/repos/chrysb/alphaclaw/releases/latest";
    const res = await fetchReadResponse(endpoint, {
      headers: { Accept: "application/vnd.github+json" },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(text || "Could not load release notes");
    }
    if (!res.ok) {
      throw new Error(data?.message || text || "Could not load release notes");
    }
    return {
      ok: true,
      tag: String(data?.tag_name || normalizedTag || ""),
      name: String(data?.name || ""),
      body: String(data?.body || ""),
      htmlUrl: String(data?.html_url || ""),
      publishedAt: String(data?.published_at || ""),
    };
  }
}

export async function updateAlphaclaw() {
  const res = await authFetch("/api/alphaclaw/update", { method: "POST" });
  return parseEnvelopeOrThrow(res, "Could not update AlphaClaw");
}

export async function resolveManagedUpdateAttempt(attemptId, outcome) {
  const res = await authFetch(`/api/alphaclaw/update/${encodeURIComponent(String(attemptId || ""))}/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmProviderChecked: true, outcome }),
  });
  return parseEnvelopeOrThrow(res, "Could not resolve the deployment status");
}

export async function updateSyncCron(payload) {
  const res = await authFetch("/api/sync-cron", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || "Could not parse sync cron response");
  }
  if (!res.ok) {
    throw new Error(data.error || text || `HTTP ${res.status}`);
  }
  return data;
}

export async function updateOpenAiCompatApiFeature(enabled) {
  const res = await authFetch("/api/alphaclaw/config/features/openai-compat-api", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || "Could not parse AlphaClaw config response");
  }
  if (!res.ok) {
    throw new Error(data.error || text || `HTTP ${res.status}`);
  }
  return data;
}

export async function updateAgentAdminFeature(enabled) {
  const res = await authFetch("/api/alphaclaw/config/features/agent-admin", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  return parseJsonOrThrow(res, "Could not update Agent Administration setting");
}

export async function rotateAgentAdminToken() {
  const res = await authFetch("/api/admin/token/rotate", { method: "POST" });
  return parseJsonOrThrow(res, "Could not rotate the agent-admin token");
}

export async function fetchAgentAdminConfirms() {
  const res = await authFetch("/api/admin/confirms");
  return parseJsonOrThrow(res, "Could not load pending confirmations");
}

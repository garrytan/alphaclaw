import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export const fetchDoctorStatus = async () => {
  const res = await authFetch("/api/doctor/status");
  return parseJsonOrThrow(res, "Could not load Doctor status");
};

export const startDoctorRun = async () => {
  const res = await authFetch("/api/doctor/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  // The run endpoint can answer 503 {ok:false, gatewayUnavailable, reason};
  // keep those fields on the thrown error so the UI can explain the refusal.
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || "Could not start Doctor run");
  }
  if (!res.ok || data?.ok === false) {
    const error = new Error(data?.error || text || `HTTP ${res.status}`);
    if (data?.gatewayUnavailable) error.gatewayUnavailable = true;
    if (data?.reason) error.reason = String(data.reason);
    throw error;
  }
  return data;
};

export const fetchDoctorSettings = async () => {
  const res = await authFetch("/api/doctor/settings");
  return parseJsonOrThrow(res, "Could not load Doctor settings");
};

// Partial-body PUT: send only the fields the caller changed (a stale local
// copy of a sibling field must never be written back).
export const updateDoctorSettings = async ({
  autoRunEnabled = undefined,
  scan = undefined,
} = {}) => {
  const body = {};
  if (autoRunEnabled !== undefined) body.autoRunEnabled = Boolean(autoRunEnabled);
  if (scan !== undefined) body.scan = scan;
  const res = await authFetch("/api/doctor/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return parseJsonOrThrow(res, "Could not save Doctor settings");
};

export const fetchDoctorRuns = async (limit = 10) => {
  const params = new URLSearchParams({ limit: String(limit) });
  const res = await authFetch(`/api/doctor/runs?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load Doctor runs");
};

export const fetchDoctorCards = async ({ runId = "all" } = {}) => {
  const params = new URLSearchParams();
  if (String(runId || "").trim()) params.set("runId", String(runId || ""));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await authFetch(`/api/doctor/cards${suffix}`);
  return parseJsonOrThrow(res, "Could not load Doctor findings");
};

export const updateDoctorCardStatus = async ({ cardId, status }) => {
  const res = await authFetch(
    `/api/doctor/cards/${encodeURIComponent(String(cardId || ""))}/status`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: String(status || "") }),
    },
  );
  return parseJsonOrThrow(res, "Could not update Doctor card status");
};

export const sendDoctorCardFix = async ({
  cardId,
  sessionKey = "",
  replyChannel = "",
  replyTo = "",
  prompt = "",
} = {}) => {
  const res = await authFetch(
    `/api/doctor/findings/${encodeURIComponent(String(cardId || ""))}/fix`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionKey: String(sessionKey || ""),
        replyChannel: String(replyChannel || ""),
        replyTo: String(replyTo || ""),
        prompt: String(prompt || ""),
      }),
    },
  );
  return parseJsonOrThrow(res, "Could not send Doctor fix request");
};

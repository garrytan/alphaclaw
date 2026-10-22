import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

export async function fetchWatchdogStatus() {
  const res = await authFetch("/api/watchdog/status");
  return parseJsonOrThrow(res, "Could not load watchdog status");
}

export async function fetchWatchdogIncidents({ limit = 10, before = null } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (before != null) params.set("before", String(before));
  const res = await authFetch(`/api/watchdog/incidents?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load watchdog incidents");
}

export async function fetchWatchdogIncidentDetail(incidentId) {
  const res = await authFetch(
    `/api/watchdog/incidents/${encodeURIComponent(String(incidentId))}`,
  );
  return parseJsonOrThrow(res, "Could not load incident detail");
}

export async function fetchWatchdogOverseer() {
  const res = await authFetch("/api/watchdog/overseer");
  return parseJsonOrThrow(res, "Could not load watchdog overseer settings");
}

export async function updateWatchdogOverseer(enabled) {
  const res = await authFetch("/api/watchdog/overseer", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: enabled === true }),
  });
  return parseJsonOrThrow(res, "Could not save watchdog overseer settings");
}

export async function requestWatchdogOverseerReview({ incidentId = null } = {}) {
  const res = await authFetch("/api/watchdog/overseer/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(incidentId != null ? { incidentId } : {}),
  });
  return parseJsonOrThrow(res, "Could not start an overseer review");
}

// Dedicated 15s-poll read of the persisted situation report — polling the
// settings endpoint instead would respawn `claude --version` per tab.
export async function fetchWatchdogOverseerSituation() {
  const res = await authFetch("/api/watchdog/overseer/situation");
  return parseJsonOrThrow(res, "Could not load the overseer situation report");
}

// Body-preserving parse (WI-3.5): a 502 {ok:false, error, result} carries the
// per-channel failures (result.failures[] channel/target/reason/errorCode) —
// attach `result` to the rejection so the settings card can list them instead
// of a bare toast. 200 {ok:true, result} resolves unchanged.
export async function triggerWatchdogTestNotification() {
  const res = await authFetch("/api/watchdog/test-notification", {
    method: "POST",
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok || data?.ok === false) {
    const error = new Error(
      data?.error || data?.message || "Could not send test notification",
    );
    if (data?.result && typeof data.result === "object") error.result = data.result;
    error.status = res.status;
    throw error;
  }
  return data || {};
}

export async function fetchWatchdogEvents(limit = 20, { includeRoutine = false } = {}) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (includeRoutine) params.set("includeRoutine", "1");
  const res = await authFetch(`/api/watchdog/events?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load watchdog events");
}

export async function fetchWatchdogLogs(tail = 65536) {
  const res = await authFetch(
    `/api/watchdog/logs?tail=${encodeURIComponent(String(tail))}`,
  );
  if (!res.ok) throw new Error("Could not load watchdog logs");
  return res.text();
}

// Delta poll for the watchdog logs pane: `since=<gen>:<offset>` returns only
// the bytes appended past that cursor as {ok, gen, offset, data, reset}.
// Rotation bumps `gen`; an invalid/stale cursor yields reset:true plus a
// fresh tail. Calling without a cursor sends an intentionally invalid one so
// the server bootstraps the client (reset:true + the current cursor).
export async function fetchWatchdogLogsDelta({ gen = null, offset = null } = {}) {
  const toCursorPart = (value) => {
    const parsed = Number(value);
    return value != null && Number.isFinite(parsed) ? parsed : -1;
  };
  const since = `${toCursorPart(gen)}:${toCursorPart(offset)}`;
  const res = await authFetch(
    `/api/watchdog/logs?since=${encodeURIComponent(since)}`,
  );
  return parseJsonOrThrow(res, "Could not load watchdog log updates");
}

export async function closeWatchdogTerminalSession(sessionId) {
  const res = await authFetch("/api/watchdog/terminal/close", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: String(sessionId || ""),
    }),
  });
  return parseJsonOrThrow(res, "Could not close watchdog terminal");
}

export async function triggerWatchdogRepair({ force = false } = {}) {
  const res = await authFetch("/api/watchdog/repair", {
    method: "POST",
    ...(force ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ force: true }) } : {}),
  });
  const body = await res.json();
  if (!res.ok || body?.ok === false || body?.skipped) {
    throw Object.assign(new Error(body?.message || body?.error || body?.reason || "Repair did not complete"), {
      status: res.status, code: body?.code, recovery: body?.recovery, hint: body?.hint,
      notStarted: body?.notStarted === true, responseReceived: true,
    });
  }
  return body;
}

export async function resumeWatchdogChannels() {
  const res = await authFetch("/api/watchdog/resume-channels", {
    method: "POST",
  });
  return parseJsonOrThrow(res, "Could not resume channels");
}

export async function fetchWatchdogResources() {
  const res = await authFetch("/api/watchdog/resources");
  return parseJsonOrThrow(res, "Could not load system resources");
}

export async function fetchWatchdogSettings() {
  const res = await authFetch("/api/watchdog/settings");
  return parseJsonOrThrow(res, "Could not load watchdog settings");
}

export async function updateWatchdogSettings(settings) {
  const res = await authFetch("/api/watchdog/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings || {}),
  });
  return parseJsonOrThrow(res, "Could not update watchdog settings");
}

export async function fetchWatchdogMemorySettings() {
  const res = await authFetch("/api/watchdog/memory");
  return parseJsonOrThrow(res, "Could not load memory monitor settings");
}

export async function updateWatchdogMemorySettings(patch) {
  const res = await authFetch("/api/watchdog/memory", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch || {}),
  });
  return parseJsonOrThrow(res, "Could not update memory monitor settings");
}

export async function fetchAutotune() {
  const res = await authFetch("/api/autotune");
  return parseJsonOrThrow(res, "Could not load autotune status");
}

export async function updateAutotuneSettings(body) {
  const res = await authFetch("/api/autotune/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  return parseJsonOrThrow(res, "Could not save autotune settings");
}

export async function reapplyAutotune() {
  const res = await authFetch("/api/autotune/reapply", { method: "POST" });
  return parseJsonOrThrow(res, "Could not recalculate autotune settings");
}

export async function acknowledgeAutotuneResize() {
  const res = await authFetch("/api/autotune/resize-ack", { method: "PUT" });
  return parseJsonOrThrow(res, "Could not dismiss the resize notice");
}

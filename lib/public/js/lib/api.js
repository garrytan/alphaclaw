import { subscribeToSse } from "./sse.js";
// Memoized in format.js at module load, so the header zone always matches the
// zone the display formatters render in (never diverges mid-session).
import { getBrowserTimeZone } from "./format.js";
import {
  kChatSendOutboxStorageKey,
  kChatSessionDraftsStorageKey,
} from "./storage-keys.js";

const kClientTimeZoneHeader = "x-client-timezone";

export const authFetch = async (url, opts = {}) => {
  const nextOptions = { ...opts };
  const headers = new Headers(opts?.headers || {});
  if (!headers.has(kClientTimeZoneHeader)) {
    const browserTimeZone = getBrowserTimeZone();
    if (browserTimeZone) {
      headers.set(kClientTimeZoneHeader, browserTimeZone);
    }
  }
  nextOptions.headers = headers;
  const res = await fetch(url, nextOptions);
  if (res.status === 401) {
    try {
      window.localStorage?.clear?.();
    } catch {}
    window.location.href = "/setup";
    throw new Error("Unauthorized");
  }
  return res;
};

export const subscribeStatusEvents = ({
  onMessage = () => {},
  onOpen = () => {},
  onError = () => {},
} = {}) => {
  if (typeof window?.EventSource !== "function") {
    throw new Error("Server events are not supported in this browser");
  }
  const source = new window.EventSource("/api/events/status", {
    withCredentials: true,
  });
  const handleStatus = (event) => {
    let payload = {};
    try {
      payload = event?.data ? JSON.parse(event.data) : {};
    } catch {}
    onMessage(payload || {});
  };
  source.addEventListener("status", handleStatus);
  source.onopen = () => onOpen();
  source.onerror = (event) => onError(event);
  return () => {
    source.removeEventListener("status", handleStatus);
    source.onopen = null;
    source.onerror = null;
    source.close();
  };
};

export async function fetchStatus() {
  const res = await authFetch("/api/status");
  // A non-OK response (the route's 500 {error} envelope) is a FAILED poll,
  // never a status frame — consuming it as data kept connectivity "online"
  // and rendered the version-skew legacy card against a broken server.
  return parseJsonOrThrow(res, "Could not load status");
}

export async function fetchPairings() {
  const res = await authFetch("/api/pairings");
  return res.json();
}

export async function approvePairing(id, channel, accountId = "") {
  const res = await authFetch(`/api/pairings/${id}/approve`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, accountId }),
  });
  return res.json();
}

export async function rejectPairing(id, channel, accountId = "") {
  const res = await authFetch(`/api/pairings/${id}/reject`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ channel, accountId }),
  });
  return parseJsonOrThrow(res, "Could not reject pairing");
}

export async function fetchGoogleAccounts() {
  const res = await authFetch("/api/google/accounts");
  return res.json();
}

export async function fetchGoogleStatus(accountId = "") {
  const params = new URLSearchParams();
  if (accountId) params.set("accountId", String(accountId));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await authFetch(`/api/google/status${suffix}`);
  return res.json();
}

export async function fetchGoogleCredentials({
  accountId = "",
  client = "",
} = {}) {
  const params = new URLSearchParams();
  if (accountId) params.set("accountId", String(accountId));
  if (client) params.set("client", String(client));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await authFetch(`/api/google/credentials${suffix}`);
  return res.json();
}

export async function checkGoogleApis(accountId = "") {
  const params = new URLSearchParams();
  if (accountId) params.set("accountId", String(accountId));
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const res = await authFetch(`/api/google/check${suffix}`);
  return res.json();
}

export async function saveGoogleCredentials({
  clientId,
  clientSecret,
  email,
  services = [],
  client = "default",
  personal = false,
  accountId = "",
}) {
  const res = await authFetch("/api/google/credentials", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientId,
      clientSecret,
      email,
      services,
      client,
      personal,
      accountId,
    }),
  });
  return res.json();
}

export async function saveGoogleAccount({
  email,
  services = [],
  client = "default",
  personal = false,
  accountId = "",
}) {
  const res = await authFetch("/api/google/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, services, client, personal, accountId }),
  });
  return res.json();
}

export async function disconnectGoogle(accountId = "") {
  const res = await authFetch("/api/google/disconnect", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId }),
  });
  return res.json();
}

export const fetchGmailConfig = async () => {
  const res = await authFetch("/api/gmail/config");
  return parseJsonOrThrow(res, "Could not load Gmail watch config");
};

export const saveGmailConfig = async ({
  client = "default",
  topicPath = "",
  projectId = "",
  regeneratePushToken = false,
} = {}) => {
  const res = await authFetch("/api/gmail/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client,
      topicPath,
      projectId,
      regeneratePushToken,
    }),
  });
  return parseJsonOrThrow(res, "Could not save Gmail watch config");
};

export const startGmailWatch = async (accountId, { destination = null } = {}) => {
  const res = await authFetch("/api/gmail/watch/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: String(accountId || ""),
      ...(destination ? { destination } : {}),
    }),
  });
  return parseJsonOrThrow(res, "Could not start Gmail watch");
};

export const stopGmailWatch = async (accountId) => {
  const res = await authFetch("/api/gmail/watch/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountId: String(accountId || "") }),
  });
  return parseJsonOrThrow(res, "Could not stop Gmail watch");
};

export const renewGmailWatch = async ({
  accountId = "",
  force = true,
} = {}) => {
  const res = await authFetch("/api/gmail/watch/renew", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accountId: String(accountId || ""),
      force: Boolean(force),
    }),
  });
  return parseJsonOrThrow(res, "Could not renew Gmail watch");
};

export const fetchAgentSessions = async () => {
  const res = await authFetch("/api/agent/sessions");
  return parseJsonOrThrow(res, "Could not load agent sessions");
};

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

export const fetchDoctorRun = async (runId) => {
  const res = await authFetch(
    `/api/doctor/runs/${encodeURIComponent(String(runId || ""))}`,
  );
  return parseJsonOrThrow(res, "Could not load Doctor run");
};

export const fetchDoctorRunCards = async (runId) => {
  const res = await authFetch(
    `/api/doctor/runs/${encodeURIComponent(String(runId || ""))}/cards`,
  );
  return parseJsonOrThrow(res, "Could not load Doctor cards");
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

export const sendAgentMessage = async ({
  message = "",
  sessionKey = "",
} = {}) => {
  const res = await authFetch("/api/agent/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: String(message || ""),
      sessionKey: String(sessionKey || ""),
    }),
  });
  return parseJsonOrThrow(res, "Could not send message to agent");
};


// Async restart: 202 { ok, operationId, attached? } with progress streamed
// over /api/operations/:id/events. A 409 (apply in progress) surfaces its
// `code` so callers can render the conflict instead of a generic failure.
export async function restartGatewayAsync() {
  const res = await authFetch("/api/gateway/restart?async=1", {
    method: "POST",
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok || body?.ok === false) {
    const error = new Error(
      body?.error || "Could not restart gateway",
    );
    if (body?.code) error.code = body.code;
    error.status = res.status;
    throw error;
  }
  return body || {};
}

export async function fetchRestartStatus() {
  const res = await authFetch("/api/restart-status");
  return parseJsonOrThrow(res, "Could not load restart status");
}

export async function dismissRestartStatus() {
  const res = await authFetch("/api/restart-status/dismiss", {
    method: "POST",
  });
  return parseJsonOrThrow(res, "Could not dismiss restart status");
}

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

export async function triggerWatchdogTestNotification() {
  const res = await authFetch("/api/watchdog/test-notification", {
    method: "POST",
  });
  return parseJsonOrThrow(res, "Could not send test notification");
}

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

export async function fetchUsageSessionTimeSeries(sessionId, maxPoints = 100) {
  const params = new URLSearchParams({ maxPoints: String(maxPoints) });
  const safeSessionId = encodeURIComponent(String(sessionId || ""));
  const res = await authFetch(
    `/api/usage/sessions/${safeSessionId}/timeseries?${params.toString()}`,
  );
  return parseJsonOrThrow(res, "Could not load usage time series");
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

export async function createWatchdogTerminalSession() {
  const res = await authFetch("/api/watchdog/terminal/session", {
    method: "POST",
  });
  return parseJsonOrThrow(res, "Could not start watchdog terminal");
}

export async function fetchWatchdogTerminalOutput(sessionId, cursor = 0) {
  const params = new URLSearchParams({
    sessionId: String(sessionId || ""),
    cursor: String(cursor || 0),
  });
  const res = await authFetch(`/api/watchdog/terminal/output?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not read watchdog terminal output");
}

export async function sendWatchdogTerminalInput(sessionId, input = "") {
  const res = await authFetch("/api/watchdog/terminal/input", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: String(sessionId || ""),
      input: String(input || ""),
    }),
  });
  return parseJsonOrThrow(res, "Could not send watchdog terminal input");
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

export async function triggerWatchdogRepair() {
  const res = await authFetch("/api/watchdog/repair", { method: "POST" });
  return parseJsonOrThrow(res, "Could not trigger watchdog repair");
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

export async function fetchDashboardUrl() {
  const res = await authFetch("/api/gateway/dashboard");
  return parseJsonOrThrow(res, "Could not load dashboard URL");
}

export async function fetchClaudeCodeStatus() {
  const res = await authFetch("/api/claude-code/status");
  return parseJsonOrThrow(res, "Could not load Claude Code launcher status");
}

// Claude Code envelope (routine session + every local rescue endpoint): the
// launcher hook and the rescue card branch on the machine code
// (confirm_required shows the one-time modal, not_configured is the silent
// fallback, needs_login routes to setup) — keep it on the thrown error like
// parseEnvelopeOrThrow does. Middleware-level refusals put prose in `error`
// and the machine code in `code`, so a dedicated code field wins when
// present.
const parseClaudeCodeEnvelopeOrThrow = async (res, fallbackError) => {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || fallbackError);
  }
  if (!res.ok || data?.ok === false) {
    const error = new Error(
      data?.message || data?.error || `HTTP ${res.status}`,
    );
    const code = data?.code || data?.error;
    if (code) error.code = code;
    // A confirm_required (409) from the local-session POST carries the
    // server's AUTHORITATIVE live config (permissionMode + cwd) so the confirm
    // modal names the mode the server is actually set to — never a possibly
    // stale cached status snapshot. Thread them onto the error so the hook can
    // read them; older servers omit them and the hook falls back to the cache.
    if (data?.permissionMode != null) error.permissionMode = data.permissionMode;
    if (data?.cwd != null) error.cwd = data.cwd;
    throw error;
  }
  return data;
};

export async function createClaudeCodeSession({ confirmed = false } = {}) {
  const res = await authFetch("/api/claude-code/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed }),
  });
  return parseClaudeCodeEnvelopeOrThrow(
    res,
    "Could not start a Claude Code session",
  );
}

// Direct status fetch for the local-session pollers (launcher 202 poll, the
// Watchdog rescue card, the setup modal). Same fetch as fetchClaudeCodeStatus
// (aliased) but consumed OUTSIDE useCachedFetch on purpose: a poller reading
// through the shared cache would see up-to-60s-stale local state
// mid-transition. Mutating callers still invalidate
// kClaudeCodeStatusCacheKey so cached consumers refresh too.
export const fetchClaudeCodeStatusDirect = fetchClaudeCodeStatus;

export async function createClaudeCodeLocalSession({
  confirmed = false,
  permissionMode = null,
} = {}) {
  const res = await authFetch("/api/claude-code/local/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // permissionMode is the mode the consent UI displayed (TOCTOU guard):
    // the server refuses with confirm_required when a provided mode
    // mismatches its configured one, so a stale snapshot can never assert
    // consent to a mode the operator never saw. null means no assertion.
    body: JSON.stringify({
      confirmed,
      permissionMode: permissionMode == null ? null : String(permissionMode),
    }),
  });
  return parseClaudeCodeEnvelopeOrThrow(
    res,
    "Could not start the rescue Claude Code session",
  );
}

export async function stopClaudeCodeLocalSession() {
  const res = await authFetch("/api/claude-code/local/session/stop", {
    method: "POST",
  });
  return parseClaudeCodeEnvelopeOrThrow(
    res,
    "Could not stop the rescue Claude Code session",
  );
}

export async function startClaudeCodeLocalLogin() {
  const res = await authFetch("/api/claude-code/local/login", {
    method: "POST",
  });
  return parseClaudeCodeEnvelopeOrThrow(res, "Could not start the Claude login");
}

export async function submitClaudeCodeLocalLoginCode({ code = "" } = {}) {
  const res = await authFetch("/api/claude-code/local/login/code", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  return parseClaudeCodeEnvelopeOrThrow(res, "Could not submit the login code");
}

export async function cancelClaudeCodeLocalLogin() {
  const res = await authFetch("/api/claude-code/local/login/cancel", {
    method: "POST",
  });
  return parseClaudeCodeEnvelopeOrThrow(res, "Could not cancel the Claude login");
}

export async function logoutClaudeCodeLocal() {
  const res = await authFetch("/api/claude-code/local/logout", {
    method: "POST",
  });
  return parseClaudeCodeEnvelopeOrThrow(res, "Could not log out of Claude");
}

export async function fetchClaudeCodeLocalTail({ source = "session" } = {}) {
  const query = new URLSearchParams({ source: String(source || "session") });
  const res = await authFetch(`/api/claude-code/local/tail?${query.toString()}`);
  return parseClaudeCodeEnvelopeOrThrow(res, "Could not load the rescue CLI output");
}

export async function fetchAlphaclawVersion(refresh = false) {
  const query = refresh ? "?refresh=1" : "";
  const res = await authFetch(`/api/alphaclaw/version${query}`);
  return res.json();
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
    const res = await fetch(endpoint, {
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
  return res.json();
}

export async function fetchSyncCron() {
  const res = await authFetch("/api/sync-cron");
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

export async function fetchDevicePairings() {
  const res = await authFetch("/api/devices");
  return res.json();
}

export async function approveDevice(id) {
  const safeId = encodeURIComponent(String(id || ""));
  const res = await authFetch(`/api/devices/${safeId}/approve`, { method: "POST" });
  return parseJsonOrThrow(res, "Could not approve device");
}

export async function rejectDevice(id) {
  const safeId = encodeURIComponent(String(id || ""));
  const res = await authFetch(`/api/devices/${safeId}/reject`, { method: "POST" });
  return parseJsonOrThrow(res, "Could not reject device");
}

export const fetchNodesStatus = async () => {
  const res = await authFetch("/api/nodes");
  return parseJsonOrThrow(res, "Could not load nodes");
};

export const approveNode = async (nodeId) => {
  const safeNodeId = encodeURIComponent(String(nodeId || ""));
  const res = await authFetch(`/api/nodes/${safeNodeId}/approve`, {
    method: "POST",
  });
  return parseJsonOrThrow(res, "Could not approve node");
};

export const removeNode = async (nodeId) => {
  const safeNodeId = encodeURIComponent(String(nodeId || ""));
  const res = await authFetch(`/api/nodes/${safeNodeId}`, {
    method: "DELETE",
  });
  return parseJsonOrThrow(res, "Could not remove node");
};

export const routeExecToNode = async (nodeId) => {
  const safeNodeId = encodeURIComponent(String(nodeId || ""));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await authFetch(`/api/nodes/${safeNodeId}/route`, {
      method: "POST",
      signal: controller.signal,
    });
    return parseJsonOrThrow(res, "Could not route execution to node");
  } catch (error) {
    if (String(error?.name || "") === "AbortError") {
      throw new Error("Routing timed out. Gateway may be restarting or unavailable.");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
};

export const fetchNodeConnectInfo = async () => {
  const res = await authFetch("/api/nodes/connect-info");
  return parseJsonOrThrow(res, "Could not load connect info");
};

export const fetchNodeBrowserStatusForNode = async (nodeId, profile = "user") => {
  const safeNodeId = encodeURIComponent(String(nodeId || ""));
  const params = new URLSearchParams({ profile: String(profile || "user") });
  const res = await authFetch(
    `/api/nodes/${safeNodeId}/browser-status?${params.toString()}`,
  );
  return parseJsonOrThrow(res, "Could not load node browser status");
};

export const fetchNodeExecConfig = async () => {
  const res = await authFetch("/api/nodes/exec-config");
  return parseJsonOrThrow(res, "Could not load node exec config");
};

export const saveNodeExecConfig = async (payload) => {
  const res = await authFetch("/api/nodes/exec-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not save node exec config");
};

export const fetchNodeExecApprovals = async () => {
  const res = await authFetch("/api/nodes/exec-approvals");
  return parseJsonOrThrow(res, "Could not load node exec approvals");
};

export const addNodeExecAllowlistPattern = async (pattern) => {
  const res = await authFetch("/api/nodes/exec-approvals/allowlist", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pattern: String(pattern || "") }),
  });
  return parseJsonOrThrow(res, "Could not add allowlist pattern");
};

export const removeNodeExecAllowlistPattern = async (entryId) => {
  const safeEntryId = encodeURIComponent(String(entryId || ""));
  const res = await authFetch(`/api/nodes/exec-approvals/allowlist/${safeEntryId}`, {
    method: "DELETE",
  });
  return parseJsonOrThrow(res, "Could not remove allowlist pattern");
};

export const fetchAuthStatus = async () => {
  const res = await authFetch("/api/auth/status");
  return res.json();
};

export const fetchAuthIdentity = async () => {
  const res = await authFetch("/api/auth/identity");
  return parseEnvelopeOrThrow(res, "Could not load identity");
};

export const logout = async () => {
  // Chat drafts and queued outbox content are member data — they must not
  // survive an identity change on a shared origin. Cleared before the POST so
  // even a failed logout request never leaves them behind on a shared device.
  try {
    localStorage.removeItem(kChatSendOutboxStorageKey);
    localStorage.removeItem(kChatSessionDraftsStorageKey);
  } catch {}
  const res = await authFetch("/api/auth/logout", { method: "POST" });
  return res.json();
};

export async function fetchOnboardStatus() {
  const res = await authFetch("/api/onboard/status");
  return res.json();
}

export async function fetchOnboardProgress() {
  const res = await authFetch("/api/onboard/progress");
  return res.json();
}

export async function runOnboard(vars, modelKey, { importMode = false } = {}) {
  const res = await authFetch("/api/onboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vars, modelKey, importMode }),
  });
  return res.json();
}

export async function verifyGithubOnboardingRepo(repo, token, mode = "new") {
  const res = await authFetch("/api/onboard/github/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repo, token, mode }),
  });
  return res.json();
}

export async function scanImportRepo(tempDir) {
  const res = await authFetch("/api/onboard/import/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tempDir }),
  });
  return res.json();
}

export async function applyImport({
  tempDir,
  approvedSecrets = [],
  skipSecretExtraction = false,
  githubRepo = "",
  githubToken = "",
}) {
  const res = await authFetch("/api/onboard/import/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tempDir,
      approvedSecrets,
      skipSecretExtraction,
      githubRepo,
      githubToken,
    }),
  });
  return res.json();
}

export const fetchModels = async () => {
  const res = await authFetch("/api/models");
  return res.json();
};

export const fetchModelStatus = async () => {
  const res = await authFetch("/api/models/status");
  return res.json();
};

export const fetchThinkingOptions = async (modelKey) => {
  const normalized = String(modelKey || "").trim();
  const qs = new URLSearchParams({ modelKey: normalized });
  const res = await authFetch(`/api/models/thinking-options?${qs.toString()}`);
  return res.json();
};

export const setPrimaryModel = async (modelKey) => {
  const res = await authFetch("/api/models/set", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelKey }),
  });
  return res.json();
};

export const fetchModelsConfig = async ({ agentId } = {}) => {
  const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
  const res = await authFetch(`/api/models/config${qs}`);
  return res.json();
};

export const saveModelsConfig = async ({
  primary,
  configuredModels,
  profiles,
  authOrder,
  agentId,
} = {}) => {
  const qs = agentId ? `?agentId=${encodeURIComponent(agentId)}` : "";
  const res = await authFetch(`/api/models/config${qs}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ primary, configuredModels, profiles, authOrder }),
  });
  return res.json();
};

export const fetchAuthProfiles = async () => {
  const res = await authFetch("/api/models/auth");
  return res.json();
};

export const upsertAuthProfile = async (profileId, credential) => {
  const res = await authFetch(
    `/api/models/auth/${encodeURIComponent(profileId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(credential),
    },
  );
  return res.json();
};

export const deleteAuthProfile = async (profileId) => {
  const res = await authFetch(
    `/api/models/auth/${encodeURIComponent(profileId)}`,
    {
      method: "DELETE",
    },
  );
  return res.json();
};

// Telegram topic registry (returns raw payloads so callers can inspect
// degraded-state codes like TOPIC_REGISTRY_UNREADABLE on ok:false responses).
export async function getTelegramTopics() {
  const res = await authFetch("/api/telegram/topics");
  return res.json();
}

export async function restoreTelegramTopic(groupId, topicId) {
  const safeGroupId = encodeURIComponent(String(groupId || ""));
  const safeTopicId = encodeURIComponent(String(topicId || ""));
  const res = await authFetch(
    `/api/telegram/groups/${safeGroupId}/topics/${safeTopicId}/restore`,
    { method: "POST" },
  );
  return res.json();
}

export async function verifyTelegramTopic(groupId, topicId) {
  const safeGroupId = encodeURIComponent(String(groupId || ""));
  const safeTopicId = encodeURIComponent(String(topicId || ""));
  const res = await authFetch(
    `/api/telegram/groups/${safeGroupId}/topics/${safeTopicId}/verify`,
    { method: "POST" },
  );
  return res.json();
}

export async function sweepTopicDiscovery() {
  const res = await authFetch("/api/telegram/discovery/sweep", {
    method: "POST",
  });
  return res.json();
}

export async function getTopicDiscoveryStatus() {
  const res = await authFetch("/api/telegram/discovery/status");
  return res.json();
}

export const fetchAgents = async () => {
  const res = await authFetch("/api/agents");
  return parseJsonOrThrow(res, "Could not load agents");
};

export const fetchChannelAccounts = async () => {
  const res = await authFetch("/api/channels/accounts");
  return parseJsonOrThrow(res, "Could not load channel accounts");
};

export const fetchChannelAccountToken = async ({
  provider = "",
  accountId = "default",
} = {}) => {
  const params = new URLSearchParams({
    provider: String(provider || ""),
    accountId: String(accountId || "default"),
  });
  const res = await authFetch(`/api/channels/accounts/token?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load channel token");
};

export const createChannelAccount = async (payload) => {
  const res = await authFetch("/api/channels/accounts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not create channel account");
};

export const createChannelAccountJob = async (payload) => {
  const res = await authFetch("/api/channels/accounts/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not start channel account operation");
};

export const subscribeOperationEvents = ({
  operationId = "",
  onMessage = () => {},
  onError = () => {},
}) =>
  subscribeToSse({
    url: `/api/operations/${encodeURIComponent(String(operationId || ""))}/events`,
    onMessage,
    onError,
  });

export const updateChannelAccount = async (payload) => {
  const res = await authFetch("/api/channels/accounts", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not update channel account");
};

export const deleteChannelAccount = async (payload) => {
  const res = await authFetch("/api/channels/accounts", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not delete channel account");
};

export const runChannelAccountLogin = async (payload) => {
  const res = await authFetch("/api/channels/accounts/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not run channel login");
};

export const fetchChannelAccountLoginStatus = async ({
  provider = "",
  accountId = "default",
} = {}) => {
  const params = new URLSearchParams({
    provider: String(provider || ""),
    accountId: String(accountId || "default"),
  });
  const res = await authFetch(
    `/api/channels/accounts/login-status?${params.toString()}`,
  );
  return parseJsonOrThrow(res, "Could not load channel login status");
};

export const fetchAgent = async (agentId) => {
  const res = await authFetch(`/api/agents/${encodeURIComponent(String(agentId || ""))}`);
  return parseJsonOrThrow(res, "Could not load agent");
};

export const fetchAgentWorkspaceSize = async (agentId) => {
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/workspace-size`,
  );
  return parseJsonOrThrow(res, "Could not load workspace size");
};

export const fetchAgentBindings = async (agentId) => {
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/bindings`,
  );
  return parseJsonOrThrow(res, "Could not load agent bindings");
};

export const createAgent = async (payload) => {
  const res = await authFetch("/api/agents", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not create agent");
};

export const updateAgent = async (agentId, payload) => {
  const res = await authFetch(`/api/agents/${encodeURIComponent(String(agentId || ""))}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseJsonOrThrow(res, "Could not update agent");
};

export const addAgentBinding = async (agentId, payload) => {
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/bindings`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    },
  );
  return parseJsonOrThrow(res, "Could not add agent binding");
};

export const removeAgentBinding = async (agentId, payload) => {
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/bindings`,
    {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    },
  );
  return parseJsonOrThrow(res, "Could not remove agent binding");
};

export const deleteAgent = async (agentId, { keepWorkspace = true } = {}) => {
  const query = new URLSearchParams({
    keepWorkspace: keepWorkspace ? "true" : "false",
  });
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}?${query.toString()}`,
    { method: "DELETE" },
  );
  return parseJsonOrThrow(res, "Could not delete agent");
};

export const setDefaultAgent = async (agentId) => {
  const res = await authFetch(
    `/api/agents/${encodeURIComponent(String(agentId || ""))}/default`,
    { method: "POST" },
  );
  return parseJsonOrThrow(res, "Could not set default agent");
};

export const fetchCodexStatus = async () => {
  const res = await authFetch("/api/codex/status");
  return res.json();
};

export const disconnectCodex = async () => {
  const res = await authFetch("/api/codex/disconnect", { method: "POST" });
  return res.json();
};

export const exchangeCodexOAuth = async (input) => {
  const res = await authFetch("/api/codex/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input }),
  });
  return res.json();
};

export async function fetchEnvVars() {
  const res = await authFetch("/api/env");
  return res.json();
}

export async function saveEnvVars(vars) {
  const res = await authFetch("/api/env", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ vars }),
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || "Could not parse env save response");
  }
  if (!res.ok) {
    throw new Error(data.error || text || `HTTP ${res.status}`);
  }
  return data;
}

const parseJsonOrThrow = async (res, fallbackError) => {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || fallbackError);
  }
  if (!res.ok || data?.ok === false) {
    // Prefer the human-readable message when the server sends one alongside
    // the machine code — operators should never be toasted "not_steady_state".
    throw new Error(data.message || data.error || text || `HTTP ${res.status}`);
  }
  return data;
};

// The OpenClaw channel endpoints use a structured error envelope
// ({ok, code, message, hint, docsUrl}); keep those fields on the thrown
// error so the UI can render `message` with `hint` underneath verbatim.
const parseEnvelopeOrThrow = async (res, fallbackError) => {
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(text || fallbackError);
  }
  if (!res.ok || data?.ok === false) {
    const error = new Error(
      data?.message || data?.error || text || `HTTP ${res.status}`,
    );
    if (data?.code) error.code = data.code;
    if (data?.hint) error.hint = data.hint;
    if (data?.docsUrl) error.docsUrl = data.docsUrl;
    // Diagnostic command output some failure envelopes ship (backup-sqlite);
    // without this the server's deliberately-included tail is unreachable.
    if (data?.tail) error.tail = String(data.tail);
    throw error;
  }
  return data;
};

export async function fetchOpenclawChannel() {
  const res = await authFetch("/api/openclaw/channel");
  return parseEnvelopeOrThrow(res, "Could not load OpenClaw channel state");
}

export async function fetchOpenclawCapabilities() {
  const res = await authFetch("/api/openclaw/capabilities");
  return parseEnvelopeOrThrow(res, "Could not probe OpenClaw capabilities");
}

export async function fetchOpenclawCatalog({ refresh = false } = {}) {
  const query = refresh ? "?refresh=1" : "";
  const res = await authFetch(`/api/openclaw/catalog${query}`);
  return parseEnvelopeOrThrow(res, "Could not load the OpenClaw version catalog");
}

export async function updateOpenclawReleaseChannel(releaseChannel) {
  const res = await authFetch(
    "/api/alphaclaw/config/updates/openclaw-release-channel",
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ releaseChannel }),
    },
  );
  return parseEnvelopeOrThrow(res, "Could not update the release channel");
}

export async function applyOpenclawVersion(payload) {
  const res = await authFetch("/api/openclaw/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseEnvelopeOrThrow(res, "Could not start the OpenClaw update");
}

// Operator recovery for a reconciler gateway hold: re-run the settings
// migration, optionally consenting to strip the exact keys the validator
// blamed. Custom parse (restartGatewayAsync precedent): the 409 "still held"
// envelope carries no message but a fresh `outcome` — attach it so the
// Upgrade page can name the new hold reason instead of a generic failure.
export async function retryOpenclawReconcile({ stripBlamedKeys = false } = {}) {
  const res = await authFetch("/api/openclaw/reconcile/retry", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(stripBlamedKeys ? { stripBlamedKeys: true } : {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok || data?.ok === false) {
    const error = new Error(
      data?.message || data?.error || "Could not retry the settings migration",
    );
    if (data?.code) error.code = data.code;
    if (data?.hint) error.hint = data.hint;
    if (data?.outcome) error.outcome = data.outcome;
    error.status = res.status;
    throw error;
  }
  return data || {};
}

export async function fetchBuzzSetup() {
  const res = await authFetch("/api/channels/buzz/setup");
  return parseEnvelopeOrThrow(res, "Could not load Buzz setup state");
}

export async function runBuzzSetupAction(action, payload = {}) {
  const res = await authFetch(
    `/api/channels/buzz/setup/${encodeURIComponent(action)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    },
  );
  return parseEnvelopeOrThrow(res, "Buzz setup step failed");
}

export async function fetchTeam() {
  const res = await authFetch("/api/team");
  return parseEnvelopeOrThrow(res, "Could not load team status");
}

export async function fetchTeamPresence() {
  const res = await authFetch("/api/team/presence");
  return parseEnvelopeOrThrow(res, "Could not load presence");
}

export async function enableTeam(payload) {
  const res = await authFetch("/api/team/enable", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseEnvelopeOrThrow(res, "Could not enable team access");
}

export async function disableTeam() {
  const res = await authFetch("/api/team/disable", { method: "POST" });
  return parseEnvelopeOrThrow(res, "Could not disable team access");
}

export async function createTeamInvite(payload) {
  const res = await authFetch("/api/team/invites", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
  return parseEnvelopeOrThrow(res, "Could not create the invite");
}

export async function revokeTeamInvite(inviteId) {
  const res = await authFetch(
    `/api/team/invites/${encodeURIComponent(inviteId)}`,
    { method: "DELETE" },
  );
  return parseEnvelopeOrThrow(res, "Could not revoke the invite");
}

export async function updateTeamMember(memberId, payload) {
  const res = await authFetch(
    `/api/team/members/${encodeURIComponent(memberId)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload || {}),
    },
  );
  return parseEnvelopeOrThrow(res, "Could not update the member");
}

export async function removeTeamMember(memberId) {
  const res = await authFetch(
    `/api/team/members/${encodeURIComponent(memberId)}`,
    { method: "DELETE" },
  );
  return parseEnvelopeOrThrow(res, "Could not remove the member");
}

export async function runOpenclawRepair() {
  const res = await authFetch("/api/openclaw/repair", { method: "POST" });
  return parseEnvelopeOrThrow(res, "Could not start the repair");
}

// Rollback fencing (issue #20): when the update migrated the state DBs the
// server answers 409 rollback_requires_confirmation instead of rolling back.
// Custom parse (retryOpenclawReconcile precedent): attach code/hint plus the
// verified pre-update backup file so the UI can raise the second-stage
// data-risk confirm that names it; `confirmDataRisk` resends with consent.
export async function rollbackOpenclaw({ confirmDataRisk = false } = {}) {
  const res = await authFetch("/api/openclaw/rollback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(confirmDataRisk ? { confirmDataRisk: true } : {}),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok || data?.ok === false) {
    const error = new Error(
      data?.message || data?.error || "Could not roll back OpenClaw",
    );
    if (data?.code) error.code = data.code;
    if (data?.hint) error.hint = data.hint;
    if (data?.backupFile) error.backupFile = data.backupFile;
    error.status = res.status;
    throw error;
  }
  return data || {};
}

export async function markOpenclawGood() {
  const res = await authFetch("/api/openclaw/mark-good", { method: "POST" });
  return parseEnvelopeOrThrow(res, "Could not mark this version as good");
}

export async function fetchOpenclawOverseer() {
  const res = await authFetch("/api/openclaw/overseer");
  return parseEnvelopeOrThrow(res, "Could not load overseer settings");
}

export async function updateOpenclawOverseer(enabled) {
  const res = await authFetch("/api/openclaw/overseer", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: enabled === true }),
  });
  return parseEnvelopeOrThrow(res, "Could not save overseer settings");
}

export async function fetchOpenclawMedic() {
  const res = await authFetch("/api/openclaw/medic");
  return parseEnvelopeOrThrow(res, "Could not load medic settings");
}

export async function updateOpenclawMedic(enabled) {
  const res = await authFetch("/api/openclaw/medic", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled: enabled === true }),
  });
  return parseEnvelopeOrThrow(res, "Could not save medic settings");
}

export async function createOpenclawSqliteBackup() {
  const res = await authFetch("/api/openclaw/backup-sqlite", { method: "POST" });
  return parseEnvelopeOrThrow(res, "Could not create the SQLite backup");
}

export async function clearOpenclawBlocklist(id = null) {
  const res = await authFetch("/api/openclaw/blocklist/clear", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(id ? { id } : {}),
  });
  return parseEnvelopeOrThrow(res, "Could not clear the blocklist");
}

export async function fetchOpenclawRuns() {
  const res = await authFetch("/api/openclaw/runs");
  return parseEnvelopeOrThrow(res, "Could not load the update history");
}

export async function fetchOpenclawRun(operationId) {
  const res = await authFetch(
    `/api/openclaw/runs/${encodeURIComponent(String(operationId || ""))}`,
  );
  return parseEnvelopeOrThrow(res, "Could not load the update run");
}

// Success body is text/plain (the durable run log); error bodies are the
// usual JSON envelope, so only the failure path goes through the parser.
// Defaults to the last 256KB: a dev-build log can be 10MB, and rendering that
// into one <pre> freezes the tab (worst on phones). Pass tailBytes: null for
// the full file (download flows).
export async function fetchOpenclawRunLogText(
  operationId,
  { tailBytes = 256 * 1024 } = {},
) {
  const suffix =
    Number.isFinite(tailBytes) && tailBytes > 0 ? `?tail=${tailBytes}` : "";
  const res = await authFetch(
    `/api/openclaw/runs/${encodeURIComponent(String(operationId || ""))}/log${suffix}`,
  );
  if (!res.ok) {
    await parseEnvelopeOrThrow(res, "Could not load the update log");
  }
  const text = await res.text();
  return res.headers?.get?.("x-log-truncated-head") === "1"
    ? `[…log truncated — showing the last ${Math.round(tailBytes / 1024)}KB of ${res.headers.get("x-log-total-bytes")} bytes]\n${text}`
    : text;
}

export async function fetchOpenclawFeatures() {
  const res = await authFetch("/api/openclaw/features");
  return parseEnvelopeOrThrow(res, "Could not load OpenClaw feature support");
}

export async function fetchOpenclawNotifications() {
  const res = await authFetch("/api/openclaw/notifications");
  return parseEnvelopeOrThrow(res, "Could not load notification settings");
}

export async function updateOpenclawNotifications({
  preferredChannel = null,
  adminTargets = [],
} = {}) {
  const res = await authFetch("/api/openclaw/notifications", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ preferredChannel, adminTargets }),
  });
  return parseEnvelopeOrThrow(res, "Could not save notification settings");
}

// Apply operations stream `step`/`output`/`done`/`error` SSE events. A plain
// connection drop also surfaces as an "error"-typed event with no data — that
// must go to onError (likely the post-apply restart), not onMessage.
export const subscribeOpenclawApplyEvents = ({
  operationId = "",
  onMessage = () => {},
  onError = () => {},
} = {}) => {
  if (typeof window?.EventSource !== "function") {
    throw new Error("Server events are not supported in this browser");
  }
  const source = new window.EventSource(
    `/api/operations/${encodeURIComponent(String(operationId || ""))}/events`,
    { withCredentials: true },
  );
  const parsePayload = (event) => {
    try {
      return event?.data ? JSON.parse(event.data) : {};
    } catch {
      return {};
    }
  };
  const makeHandler = (name) => (event) => {
    if (name === "error" && (typeof event?.data !== "string" || !event.data)) {
      onError(event);
      return;
    }
    onMessage({ event: name, data: parsePayload(event) });
  };
  const handlers = ["step", "output", "done", "error"].map((name) => [
    name,
    makeHandler(name),
  ]);
  for (const [name, handler] of handlers) {
    source.addEventListener(name, handler);
  }
  return () => {
    for (const [name, handler] of handlers) {
      source.removeEventListener(name, handler);
    }
    source.close();
  };
};

// Gateway restarts stream over the same generic operation-events channel
// (`step`/`done`/`error`, with replay on reconnect).
export const subscribeGatewayRestartEvents = (options = {}) =>
  subscribeOpenclawApplyEvents(options);

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

export async function createWebhookOauthCallback(name) {
  const res = await authFetch(
    `/api/webhooks/${encodeURIComponent(name)}/oauth-callback`,
    {
      method: "POST",
    },
  );
  return parseJsonOrThrow(res, "Could not enable OAuth callback");
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

export async function deleteWebhookOauthCallback(name) {
  const res = await authFetch(
    `/api/webhooks/${encodeURIComponent(name)}/oauth-callback`,
    {
      method: "DELETE",
    },
  );
  return parseJsonOrThrow(res, "Could not delete OAuth callback");
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

export const fetchBrowseTree = async (options = {}) => {
  const { depth = 3, path = "" } =
    typeof options === "number" ? { depth: options, path: "" } : options;
  const params = new URLSearchParams({ depth: String(depth) });
  if (path) params.set("path", String(path));
  const res = await authFetch(`/api/browse/tree?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load file tree");
};

export const fetchFileContent = async (filePath) => {
  const params = new URLSearchParams({ path: String(filePath || "") });
  const res = await authFetch(`/api/browse/read?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load file content");
};

export const saveFileContent = async (filePath, content) => {
  const normalizedPath = String(filePath || "");
  const normalizedContent = typeof content === "string" ? content : String(content ?? "");
  const res = await authFetch("/api/browse/write", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: normalizedPath, content: normalizedContent }),
  });
  return parseJsonOrThrow(res, "Could not save file");
};

export const createBrowseFile = async (filePath) => {
  const res = await authFetch("/api/browse/create-file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: String(filePath || "") }),
  });
  return parseJsonOrThrow(res, "Could not create file");
};

export const createBrowseFolder = async (folderPath) => {
  const res = await authFetch("/api/browse/create-folder", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: String(folderPath || "") }),
  });
  return parseJsonOrThrow(res, "Could not create folder");
};

export const moveBrowsePath = async (from, to) => {
  const res = await authFetch("/api/browse/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from: String(from || ""), to: String(to || "") }),
  });
  return parseJsonOrThrow(res, "Could not move path");
};

export const deleteBrowseFile = async (filePath) => {
  const res = await authFetch("/api/browse/delete", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: String(filePath || "") }),
  });
  return parseJsonOrThrow(res, "Could not delete file");
};

export const downloadBrowseFile = async (filePath) => {
  const params = new URLSearchParams({ path: String(filePath || "") });
  const res = await authFetch(`/api/browse/download?${params.toString()}`);
  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(errorText || "Could not download file");
  }
  const fileBlob = await res.blob();
  const urlApi = window?.URL || URL;
  if (!urlApi?.createObjectURL || !urlApi?.revokeObjectURL) {
    throw new Error("Download is not supported in this browser");
  }
  const downloadUrl = urlApi.createObjectURL(fileBlob);
  const fileName =
    String(filePath || "")
      .split("/")
      .filter(Boolean)
      .pop() || "download";
  try {
    const downloadLink = document.createElement("a");
    downloadLink.href = downloadUrl;
    downloadLink.download = fileName;
    document.body?.appendChild(downloadLink);
    downloadLink.click();
    downloadLink.remove();
  } finally {
    urlApi.revokeObjectURL(downloadUrl);
  }
  return { ok: true };
};

export const restoreBrowseFile = async (filePath) => {
  const res = await authFetch("/api/browse/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: String(filePath || "") }),
  });
  return parseJsonOrThrow(res, "Could not restore file");
};

export const fetchBrowseGitSummary = async () => {
  const res = await authFetch("/api/browse/git-summary");
  return parseJsonOrThrow(res, "Could not load git summary");
};

export const fetchBrowseFileDiff = async (filePath) => {
  const params = new URLSearchParams({ path: String(filePath || "") });
  const res = await authFetch(`/api/browse/git-diff?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load file diff");
};

export const fetchBrowseSqliteTable = async ({
  filePath,
  table,
  limit = 50,
  offset = 0,
}) => {
  const params = new URLSearchParams({
    path: String(filePath || ""),
    table: String(table || ""),
    limit: String(limit),
    offset: String(offset),
  });
  const res = await authFetch(`/api/browse/sqlite-table?${params.toString()}`);
  return parseJsonOrThrow(res, "Could not load sqlite table data");
};

export const syncBrowseChanges = async (message = "") => {
  const res = await authFetch("/api/browse/git-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: String(message || "") }),
  });
  return parseJsonOrThrow(res, "Could not sync changes");
};

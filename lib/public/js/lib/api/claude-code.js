import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

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
    throw Object.assign(new Error(text || fallbackError), { status: res.status });
  }
  if (!res.ok || data?.ok === false) {
    const error = new Error(
      data?.message || data?.error || `HTTP ${res.status}`,
    );
    error.status = res.status;
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

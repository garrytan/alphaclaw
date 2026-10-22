import { authFetch } from "./http.js";
import { parseJsonOrThrow } from "./parse.js";

// Async restart: 202 { ok, operationId, attached? } with progress streamed
// over /api/operations/:id/events. A 409 (apply in progress) surfaces its
// `code` so callers can render the conflict instead of a generic failure.
export async function restartGatewayAsync(options = {}) {
  const res = await authFetch("/api/gateway/restart?async=1", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {}
  if (!res.ok || body?.ok === false || body?.skipped) {
    const error = new Error(
      body?.error || "Could not restart gateway",
    );
    if (body?.code) error.code = body.code;
    error.status = res.status;
    error.recovery = body?.recovery || null;
    error.hint = body?.hint || null;
    error.notStarted = res.status < 500;
    throw error;
  }
  if (!body || body.ok !== true) throw new Error("Restart result unknown: AlphaClaw returned no usable admission result");
  return body || {};
}

export async function fetchRestartStatus() {
  const res = await authFetch("/api/restart-status");
  return parseJsonOrThrow(res, "Could not load restart status");
}

// "Restart now": cut the running restart's drain short. A 409 means that
// restart already moved past the ask (or finished).
export async function expediteGatewayRestart(operationId) {
  const res = await authFetch("/api/gateway/restart/expedite", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ operationId }),
  });
  return parseJsonOrThrow(res, "Could not stop OpenClaw now");
}

export async function dismissRestartStatus() {
  const res = await authFetch("/api/restart-status/dismiss", {
    method: "POST",
  });
  return parseJsonOrThrow(res, "Could not dismiss restart status");
}

// Gateway restarts stream `step`/`output`/`done`/`error` SSE events over the
// generic operation-events channel (with replay on reconnect). A plain
// connection drop also surfaces as an "error"-typed event with no data — that
// must go to onError, not onMessage.
export const subscribeGatewayRestartEvents = ({
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

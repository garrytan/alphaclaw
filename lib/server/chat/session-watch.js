// Session watching (ALPH-68, d4): live rows for conversations this browser
// did not start (Telegram, relay, cron, another tab).
//
// The bridge holds ONE sessions.subscribe on its shared gateway socket. The
// gateway then sends session.message for every transcript append and
// sessions.changed for list changes. Each browser socket watches the keys it
// shows (watch/unwatch frames); a row for a key nobody watches is dropped
// before any work, and bodies are never retained or logged.
//
// Foreign events never attach to a browser-started run (H16). While a session
// has a browser run in flight, its rows and foreign events are not forwarded:
// the run's own stream and the history refetch at its done cover it.
const { buildHistoryMessages } = require("./history");
const { kMaxWatchedSessionsPerSocket } = require("./protocol");

const kSessionsChangedDebounceMs = 1500;
const kSubscribeRetryMs = 5000;

const readSessionKey = (payload = {}) =>
  String(
    payload?.sessionKey ||
      payload?.session?.key ||
      payload?.data?.sessionKey ||
      payload?.meta?.sessionKey ||
      "",
  ).trim();

const readRunId = (payload = {}) =>
  String(payload?.runId || payload?.run?.id || payload?.data?.runId || payload?.meta?.runId || "").trim();

const createSessionWatch = ({
  requestGateway,
  deliver,
  broadcast,
  // (sessionKey) → the sockets attached to this browser's in-flight run for
  // the session, or null. Those tabs get the run's own stream; every other
  // watcher of the session still gets its rows.
  browserRunSockets = () => null,
  maxPerSocket = kMaxWatchedSessionsPerSocket,
  sessionsChangedDebounceMs = kSessionsChangedDebounceMs,
  subscribeRetryMs = kSubscribeRetryMs,
  onSessionsChanged = () => {},
}) => {
  const watchers = new Map();
  const keysBySocket = new Map();
  let subscribed = false;
  let subscribing = null;
  let sessionsChangedTimer = null;
  let subscribeRetryTimer = null;
  let subscribeFailed = false;
  const stats = {
    forwardedRows: 0,
    droppedRows: 0,
    suppressedRows: 0,
    forwardedEvents: 0,
    droppedEvents: 0,
    subscribeFailures: 0,
  };

  const desyncWatchers = () => {
    for (const [sessionKey, set] of watchers) {
      const serialized = JSON.stringify({ type: "desync", sessionKey });
      for (const ws of set) deliver(ws, sessionKey, serialized);
    }
  };

  // A failed subscribe is retried while anyone watches; once it lands,
  // watchers refetch the rows they missed in between.
  const ensureSubscribed = () => {
    if (subscribed || subscribing) return subscribing;
    subscribing = requestGateway("sessions.subscribe", {})
      .then(() => {
        subscribed = true;
        if (subscribeFailed) desyncWatchers();
        subscribeFailed = false;
      })
      .catch(() => {
        stats.subscribeFailures += 1;
        subscribeFailed = true;
        if (subscribeRetryTimer || watchers.size === 0) return;
        subscribeRetryTimer = setTimeout(() => {
          subscribeRetryTimer = null;
          if (watchers.size > 0) ensureSubscribed();
        }, subscribeRetryMs);
        if (typeof subscribeRetryTimer?.unref === "function") subscribeRetryTimer.unref();
      })
      .finally(() => {
        subscribing = null;
      });
    return subscribing;
  };

  const watch = (ws, sessionKey) => {
    const key = String(sessionKey || "").trim();
    if (!key) return { ok: false, code: "protocol_invalid" };
    let keys = keysBySocket.get(ws);
    if (!keys) {
      keys = new Set();
      keysBySocket.set(ws, keys);
    }
    if (!keys.has(key) && keys.size >= maxPerSocket) {
      return { ok: false, code: "watch_limit" };
    }
    keys.add(key);
    let set = watchers.get(key);
    if (!set) {
      set = new Set();
      watchers.set(key, set);
    }
    set.add(ws);
    ensureSubscribed();
    return { ok: true };
  };

  const unwatch = (ws, sessionKey) => {
    const key = String(sessionKey || "").trim();
    keysBySocket.get(ws)?.delete(key);
    const set = watchers.get(key);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) watchers.delete(key);
  };

  const detach = (ws) => {
    for (const key of keysBySocket.get(ws) || []) {
      const set = watchers.get(key);
      if (!set) continue;
      set.delete(ws);
      if (set.size === 0) watchers.delete(key);
    }
    keysBySocket.delete(ws);
  };

  const sendToWatchers = (sessionKey, frame, except = null) => {
    const set = watchers.get(sessionKey);
    if (!set || set.size === 0) return false;
    const serialized = JSON.stringify(frame);
    for (const ws of set) {
      if (!except?.has(ws)) deliver(ws, sessionKey, serialized);
    }
    return true;
  };

  const scheduleSessionsChanged = () => {
    if (sessionsChangedTimer) return;
    sessionsChangedTimer = setTimeout(() => {
      sessionsChangedTimer = null;
      onSessionsChanged();
      broadcast({ type: "sessions" });
    }, sessionsChangedDebounceMs);
    if (typeof sessionsChangedTimer?.unref === "function") sessionsChangedTimer.unref();
  };

  const forwardSessionMessage = (payload = {}) => {
    const sessionKey = readSessionKey(payload);
    if (!sessionKey || !watchers.has(sessionKey)) {
      stats.droppedRows += 1;
      return;
    }
    const runSockets = browserRunSockets(sessionKey);
    if (runSockets && [...watchers.get(sessionKey)].every((ws) => runSockets.has(ws))) {
      stats.suppressedRows += 1;
      return;
    }
    const message = payload?.message;
    if (!message || typeof message !== "object") return;
    const role = String(message?.role || "").toLowerCase();
    const runId = readRunId(payload);
    if (role === "toolresult") {
      const toolCallId = String(message?.toolCallId || "");
      if (!toolCallId) return;
      stats.forwardedRows += 1;
      sendToWatchers(sessionKey, {
        type: "session-event",
        kind: "tool-result",
        sessionKey,
        ...(runId ? { runId } : {}),
        toolCallId,
        toolResult: message,
      }, runSockets);
      return;
    }
    const { messages } = buildHistoryMessages({ history: { messages: [message] }, sessionKey });
    if (messages.length === 0) return;
    stats.forwardedRows += 1;
    sendToWatchers(sessionKey, {
      type: "session-event",
      kind: "row",
      sessionKey,
      ...(runId ? { runId } : {}),
      messages,
    }, runSockets);
  };

  // Gateway events no browser run claimed. Returns nothing: callers keep
  // their own buffering (H13) untouched.
  const handleUnroutedEvent = (eventPayload = {}) => {
    const eventName = String(eventPayload?.event || "");
    const payload = eventPayload?.payload || {};
    const sessionKey = readSessionKey(payload);
    if (!sessionKey || !watchers.has(sessionKey) || browserRunSockets(sessionKey)) {
      stats.droppedEvents += 1;
      return;
    }
    const runId = readRunId(payload);
    const base = { type: "session-event", sessionKey, ...(runId ? { runId } : {}) };
    if (eventName === "chat") {
      if (String(payload?.state || "") !== "error") return;
      stats.forwardedEvents += 1;
      sendToWatchers(sessionKey, { ...base, kind: "run", phase: "error" });
      return;
    }
    if (eventName !== "agent") return;
    const stream = String(payload?.stream || "");
    const data = payload?.data || {};
    if (stream === "assistant") {
      const delta = String((data?.delta == null || data?.delta === "" ? data?.text : data?.delta) || "");
      if (!delta) return;
      stats.forwardedEvents += 1;
      sendToWatchers(sessionKey, { ...base, kind: "chunk", content: delta });
      return;
    }
    const phase = String(data?.phase || "");
    if (stream === "lifecycle" && (phase === "start" || phase === "end" || phase === "error")) {
      stats.forwardedEvents += 1;
      sendToWatchers(sessionKey, { ...base, kind: "run", phase });
      return;
    }
    if (stream === "run_status" && phase === "retrying") {
      stats.forwardedEvents += 1;
      sendToWatchers(sessionKey, {
        ...base,
        kind: "run",
        phase: "retrying",
        message: String(data?.message || ""),
      });
    }
  };

  // Returns true when the event belongs to session watching.
  const handleGatewayEvent = (eventPayload = {}) => {
    const eventName = String(eventPayload?.event || "");
    if (eventName === "session.message") {
      forwardSessionMessage(eventPayload.payload || {});
      return true;
    }
    if (eventName === "sessions.changed") {
      scheduleSessionsChanged();
      return true;
    }
    return false;
  };

  // A fresh gateway socket has no subscription, and rows written while it
  // was down never arrive: watchers refetch history through a desync.
  let connectedBefore = false;
  const onGatewayConnected = () => {
    subscribed = false;
    const reconnect = connectedBefore;
    connectedBefore = true;
    if (watchers.size === 0) return;
    ensureSubscribed();
    if (!reconnect) return;
    desyncWatchers();
    scheduleSessionsChanged();
  };

  const onGatewayDisconnect = () => {
    subscribed = false;
  };

  const close = () => {
    if (sessionsChangedTimer) clearTimeout(sessionsChangedTimer);
    sessionsChangedTimer = null;
    if (subscribeRetryTimer) clearTimeout(subscribeRetryTimer);
    subscribeRetryTimer = null;
  };

  return {
    watch,
    unwatch,
    detach,
    ensureSubscribed,
    handleGatewayEvent,
    handleUnroutedEvent,
    onGatewayConnected,
    onGatewayDisconnect,
    close,
    stats: () => ({ ...stats, watchedSessions: watchers.size, subscribed }),
  };
};

module.exports = { createSessionWatch };

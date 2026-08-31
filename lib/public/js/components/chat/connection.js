// Reconnect/staleness state for the chat socket — modeled on
// createConnectivityMonitor in hooks/use-app-shell-controller.js (pure,
// injectable clock/random, node-env testable). The hook owns the WebSocket;
// this module owns the POLICY:
//   - UNLIMITED retries, 1s → 15s capped backoff with ±30% full jitter — the
//     old 8-attempts-then-silently-dead behavior is gone.
//   - After the outage budget (60s) the mode escalates reconnecting → offline
//     (a visible "Retry now" affordance); retries continue regardless.
//   - hello-timeout → LEGACY mode (D6): the server predates protocol v2, so
//     sends are single-shot and never auto-retried (an old server has no
//     dedupe — retries would duplicate turns).
//   - httpFallback replaces the old realtimeDisabledRef latch (MW5): entered
//     ONLY by the hook when the upgrade endpoint is genuinely unavailable and
//     never while a socket is CONNECTING/OPEN; any successful open clears it.
//   - Staleness: no frame (incl. pong) for kStaleAfterMs → treat the socket
//     as dead and reconnect.

export const kBackoffBaseMs = 1000;
export const kBackoffMaxMs = 15_000;
export const kOfflineBudgetMs = 60_000;
export const kHelloTimeoutMs = 3_000;
export const kClientPingIntervalMs = 25_000;
export const kStaleAfterMs = 45_000;

export const createConnectionMonitor = ({
  now = () => Date.now(),
  random = () => Math.random(),
} = {}) => {
  let mode = "connecting"; // connecting|online|reconnecting|offline|httpFallback|legacy
  let attempts = 0;
  let outageStartedAt = null;
  let lastFrameAt = 0;
  let openedAt = 0;
  let helloSeen = false;

  const failureMode = () => {
    if (outageStartedAt == null) outageStartedAt = now();
    return now() - outageStartedAt >= kOfflineBudgetMs ? "offline" : "reconnecting";
  };

  return {
    getMode: () => mode,
    getAttempts: () => attempts,
    isLegacy: () => mode === "legacy",
    nextDelayMs: () => {
      const base = Math.min(kBackoffBaseMs * 2 ** attempts, kBackoffMaxMs);
      return Math.round(base * (0.7 + 0.6 * random()));
    },
    recordConnecting: () => {
      if (mode === "httpFallback") return;
      if (mode !== "reconnecting" && mode !== "offline") mode = "connecting";
    },
    recordOpen: () => {
      openedAt = now();
      lastFrameAt = openedAt;
      helloSeen = false;
      // Optimistically online; hello (or its absence) refines to legacy.
      mode = "online";
      attempts = 0;
      outageStartedAt = null;
    },
    recordHello: () => {
      helloSeen = true;
      if (mode === "legacy") mode = "online";
    },
    // Called on a timer after open: no hello within the window ⇒ the server
    // is an older build — degrade honestly instead of retry-duplicating.
    checkHelloTimeout: () => {
      if (helloSeen || !openedAt) return false;
      if (now() - openedAt < kHelloTimeoutMs) return false;
      mode = "legacy";
      return true;
    },
    recordFrame: () => {
      lastFrameAt = now();
    },
    isStale: () => lastFrameAt > 0 && now() - lastFrameAt >= kStaleAfterMs,
    recordClose: () => {
      attempts += 1;
      openedAt = 0;
      helloSeen = false;
      if (mode !== "httpFallback") mode = failureMode();
    },
    retryNow: () => {
      outageStartedAt = now();
      attempts = 0;
      if (mode !== "httpFallback") mode = "reconnecting";
    },
    enterHttpFallback: () => {
      mode = "httpFallback";
    },
    leaveHttpFallback: () => {
      if (mode === "httpFallback") mode = "reconnecting";
    },
  };
};

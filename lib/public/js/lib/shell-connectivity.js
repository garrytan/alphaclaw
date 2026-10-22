import { fetchOnboardStatus } from "./api.js";

// ---------------------------------------------------------------------------
// M3.4 helpers (exported for tests)
// ---------------------------------------------------------------------------

// A failed /api/onboarded fetch means AlphaClaw is unreachable or still
// booting — NOT that the user is un-onboarded. Retry with backoff instead of
// dropping an onboarded user into the setup wizard.
export const kOnboardRetryDelaysMs = [1000, 2000, 4000, 8000, 10000];

export const startOnboardStatusLoad = ({
  fetchOnboardStatusFn = fetchOnboardStatus,
  onResolved = () => {},
  delaysMs = kOnboardRetryDelaysMs,
} = {}) => {
  let disposed = false;
  let timerId = null;
  let attempt = 0;
  const load = () => {
    fetchOnboardStatusFn()
      .then((data) => {
        if (!disposed) onResolved(!!data?.onboarded);
      })
      .catch(() => {
        if (disposed) return;
        const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
        attempt += 1;
        timerId = setTimeout(load, delay);
      });
  };
  load();
  return () => {
    disposed = true;
    if (timerId) clearTimeout(timerId);
  };
};

// Outage state machine for the status feed: frames flip it online, repeated
// failures walk reconnecting → unreachable once the budget is spent.
// "unreachable" is sticky until a frame arrives or the user retries.
export const kReconnectBudgetMs = 120000;

export const createConnectivityMonitor = ({
  budgetMs = kReconnectBudgetMs,
  onChange = () => {},
  now = () => Date.now(),
} = {}) => {
  let mode = "online";
  let outageStartedAt = null;
  const setMode = (next) => {
    if (mode === next) return;
    mode = next;
    onChange(mode);
  };
  return {
    getMode: () => mode,
    recordFrame: () => {
      outageStartedAt = null;
      setMode("online");
    },
    recordFailure: () => {
      if (outageStartedAt == null) outageStartedAt = now();
      if (mode === "unreachable") return;
      setMode(
        now() - outageStartedAt >= budgetMs ? "unreachable" : "reconnecting",
      );
    },
    retry: () => {
      outageStartedAt = now();
      setMode("reconnecting");
    },
  };
};

// Post-self-restart reachability poller (AlphaClaw self-update reconnect
// pattern): poll /api/status every `intervalMs` for up to `maxAttempts`;
// reload only once a poll succeeds — never a blind timed reload.
export const kReachabilityPollIntervalMs = 3000;
export const kReachabilityPollMaxAttempts = 40; // ~2 minutes at 3s cadence

export const createReachabilityPoller = ({
  poll,
  intervalMs = kReachabilityPollIntervalMs,
  graceMs = 0,
  maxAttempts = kReachabilityPollMaxAttempts,
  isReady = null,
  onSuccess = () => {},
  onExhausted = () => {},
  // Honest boot status: while AlphaClaw provably keeps booting (the
  // placeholder answers without a stuck verdict, or the same boot keeps
  // advancing), the attempt budget renews instead of declaring it
  // unreachable — a pending self-update install alone can outlast it.
  keepWaiting = null,
} = {}) => {
  let cancelled = false;
  let timerId = null;
  let attempts = 0;
  const attempt = async () => {
    if (cancelled) return;
    attempts += 1;
    try {
      const payload = await poll();
      // Reachable is not always ready: a managed deploy keeps the OLD
      // process serving until the platform swaps it, so callers can gate
      // success on the polled payload (e.g. a changed version). A not-ready
      // poll counts as an attempt and keeps polling.
      if (typeof isReady !== "function" || isReady(payload)) {
        if (!cancelled) onSuccess();
        return;
      }
    } catch {
      // Still restarting.
    }
    if (cancelled) return;
    if (attempts >= maxAttempts) {
      if (typeof keepWaiting === "function" && keepWaiting()) {
        attempts = 0;
      } else {
        onExhausted();
        return;
      }
    }
    timerId = setTimeout(attempt, intervalMs);
  };
  timerId = setTimeout(attempt, graceMs > 0 ? graceMs : intervalMs);
  return () => {
    cancelled = true;
    if (timerId) clearTimeout(timerId);
  };
};

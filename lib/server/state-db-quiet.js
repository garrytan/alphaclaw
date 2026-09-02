// State-DB quiet period — an awaited barrier that tells every in-process
// toucher of OpenClaw's SQLite state (status readers, cron store, pairing
// writers, auth-store writers, the notification flusher) to stand down while
// the quiesced pre-update backup snapshots the state dir (issue #54: the
// upstream `backup create` lost its state lease to our own traffic).
//
// Leaf module — zero requires — so bin/, the backup driver, and the readers
// can all load it without cycles.
//
//   idle ──beginStateDbQuiet({owner,maxMs})──▶ beginning
//            flag set FIRST (readers fall back immediately)
//            await every listener.begin()   (≤ kListenerBeginBudgetMs total;
//                                            slow/throwing → event, not a block)
//            await open handles → 0          (≤ kHandleDrainBudgetMs; still
//                                            open → event, proceed)
//            owner's AbortSignal fires (or any other failure) → end() the
//            listeners that began, clear the flag, rethrow
//          ──▶ quiet(token)
//                ├─ releaseStateDbQuiet(token) / token.release()
//                │     matching token only · idempotent · clears the timer ·
//                │     listeners end() in reverse order ──▶ idle
//                └─ expiry at maxMs (unref'd timer)
//                      expired=true · isStateDbQuiet() → false · event
//                      "expired" · listeners end() ──▶ idle(expired)
//                      (the owner checks isStateDbQuiet() and aborts —
//                      the barrier never silently reopens under a live copy)
//   invalid: a second begin while beginning/quiet → StateDbQuietError
//            ("already quiet"); a foreign token's release is ignored.
//
// Kill switch: OPENCLAW_STATE_DB_QUIET=off (deployment-only env) makes begin
// resolve a no-op token — the flag is never set and an event says so.
const kStateDbQuietEventKind = "state_db_quiet";
const kStateDbQuietEnvKey = "OPENCLAW_STATE_DB_QUIET";
const kStateDbQuietOff = "off";
const kListenerBeginBudgetMs = 5000;
const kHandleDrainBudgetMs = 2000;
const kHandleDrainPollMs = 20;
const kBackupInProgressCode = "backup_in_progress";
const kBackupInProgressMessage = "A backup is in progress; retry in about two minutes.";
const kStateDbQuietRetryAfterSec = 120;

class StateDbQuietError extends Error {
  constructor(message = kBackupInProgressMessage, { code = kBackupInProgressCode } = {}) {
    super(message);
    this.name = "StateDbQuietError";
    this.code = code;
  }
}

const createIdleState = () => ({
  quiet: false,
  beginning: false,
  owner: null,
  since: 0,
  expired: false,
  token: null,
  expiryTimer: null,
  onEvent: null,
});

const listeners = new Set();
let state = createIdleState();
let openHandles = 0;
let tokenSequence = 0;

const emit = (onEvent, status, fields = {}) => {
  if (typeof onEvent !== "function") return;
  try {
    onEvent({ kind: kStateDbQuietEventKind, status, owner: state.owner, ...fields });
  } catch {}
};

const isStateDbQuietDisabled = () =>
  String(process.env[kStateDbQuietEnvKey] || "").trim().toLowerCase() === kStateDbQuietOff;

const onStateDbQuiet = (listener) => {
  if (!listener || typeof listener !== "object") {
    throw new TypeError("onStateDbQuiet: listener must be an object");
  }
  const name = String(listener.name || "").trim();
  if (!name) throw new TypeError("onStateDbQuiet: listener.name is required");
  if (listener.begin != null && typeof listener.begin !== "function") {
    throw new TypeError(`onStateDbQuiet(${name}): begin must be a function`);
  }
  if (listener.end != null && typeof listener.end !== "function") {
    throw new TypeError(`onStateDbQuiet(${name}): end must be a function`);
  }
  const entry = { name, begin: listener.begin || null, end: listener.end || null };
  listeners.add(entry);
  return () => {
    listeners.delete(entry);
  };
};

const isStateDbQuiet = () => state.quiet;

const getStateDbQuietState = () => ({
  quiet: state.quiet,
  owner: state.owner,
  since: state.since,
  expired: state.expired,
  openHandles,
});

const enterStateDbHandle = () => {
  openHandles += 1;
  return openHandles;
};

const exitStateDbHandle = () => {
  openHandles = Math.max(0, openHandles - 1);
  return openHandles;
};

const withStateDbHandle = (fn) => {
  enterStateDbHandle();
  try {
    return fn();
  } finally {
    exitStateDbHandle();
  }
};

const getStateDbHandleCount = () => openHandles;

const sleep = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

// Runs end() on the given listeners in reverse registration order; a
// throwing end() is reported and never blocks the others.
const endListeners = (begun, onEvent) => {
  for (const entry of [...begun].reverse()) {
    if (!entry.end) continue;
    try {
      entry.end();
    } catch (error) {
      emit(onEvent, "listener_error", {
        listener: entry.name,
        phase: "end",
        error: error?.message || String(error),
      });
    }
  }
};

// Starts every listener's begin() and waits for all of them, bounded by ONE
// shared budget. Every listener whose begin() was invoked is recorded in
// `begun` (even if it is still pending when the budget runs out) so a later
// rollback/release can end() it.
const beginListeners = async (begun, onEvent) => {
  const pending = [];
  for (const entry of listeners) {
    begun.push(entry);
    if (!entry.begin) continue;
    let settled = false;
    const run = (async () => {
      try {
        await entry.begin();
      } catch (error) {
        emit(onEvent, "listener_error", {
          listener: entry.name,
          phase: "begin",
          error: error?.message || String(error),
        });
      } finally {
        settled = true;
      }
    })();
    pending.push({ entry, run, isSettled: () => settled });
  }
  if (pending.length === 0) return;
  let budgetTimer = null;
  const budget = new Promise((resolve) => {
    budgetTimer = setTimeout(() => resolve("timeout"), kListenerBeginBudgetMs);
    budgetTimer.unref?.();
  });
  const outcome = await Promise.race([
    Promise.all(pending.map((item) => item.run)).then(() => "done"),
    budget,
  ]);
  if (budgetTimer) clearTimeout(budgetTimer);
  if (outcome === "timeout") {
    emit(onEvent, "listener_timeout", {
      budgetMs: kListenerBeginBudgetMs,
      listeners: pending.filter((item) => !item.isSettled()).map((item) => item.entry.name),
    });
  }
};

const drainHandles = async (onEvent) => {
  const deadline = Date.now() + kHandleDrainBudgetMs;
  while (openHandles > 0 && Date.now() < deadline) {
    await sleep(kHandleDrainPollMs);
  }
  if (openHandles > 0) {
    emit(onEvent, "handles_open", { openHandles, budgetMs: kHandleDrainBudgetMs });
  }
};

const clearExpiryTimer = () => {
  if (state.expiryTimer) clearTimeout(state.expiryTimer);
  state.expiryTimer = null;
};

const finishQuiet = ({ status, token, begun }) => {
  const onEvent = state.onEvent;
  const heldMs = Math.max(0, Date.now() - state.since);
  clearExpiryTimer();
  const owner = state.owner;
  const since = state.since;
  state = {
    ...createIdleState(),
    owner,
    since,
    expired: status === "expired",
  };
  emit(onEvent, status, { heldMs, token: token.id });
  endListeners(begun, onEvent);
};

// Optional AbortSignal support for begin: the owner (the backup driver) can
// abort a begin that is still awaiting listeners/handles when its own
// deadline passes. Rejects with signal.reason (or a plain Error).
const abortError = (signal) =>
  signal.reason instanceof Error ? signal.reason : new Error("beginStateDbQuiet aborted");

const createAbortRace = (signal) => {
  if (!signal) return { race: (promise) => promise, cleanup: () => {} };
  let onAbort = null;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => {});
  return {
    race: (promise) => Promise.race([promise, aborted]),
    cleanup: () => {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    },
  };
};

const beginStateDbQuiet = async ({ owner, maxMs, onEvent = null, signal = null } = {}) => {
  const ownerName = String(owner || "").trim();
  if (!ownerName) throw new TypeError("beginStateDbQuiet: owner is required");
  if (!Number.isFinite(maxMs) || maxMs <= 0) {
    throw new TypeError("beginStateDbQuiet: maxMs must be a positive number");
  }
  if (signal?.aborted) throw abortError(signal);
  if (isStateDbQuietDisabled()) {
    const disabledToken = {
      id: `disabled-${++tokenSequence}`,
      owner: ownerName,
      disabled: true,
      release: () => {},
    };
    try {
      onEvent?.({
        kind: kStateDbQuietEventKind,
        status: "disabled",
        owner: ownerName,
        envKey: kStateDbQuietEnvKey,
      });
    } catch {}
    return { token: disabledToken, release: disabledToken.release };
  }
  if (state.quiet || state.beginning) {
    throw new StateDbQuietError(
      `already quiet (held by ${state.owner || "unknown"} since ${new Date(state.since).toISOString()})`,
    );
  }

  const token = { id: `quiet-${++tokenSequence}`, owner: ownerName, disabled: false };
  const begun = [];
  state = {
    ...createIdleState(),
    quiet: true,
    beginning: true,
    owner: ownerName,
    since: Date.now(),
    token,
    onEvent,
  };
  emit(onEvent, "begin", { maxMs, listeners: listeners.size, openHandles });
  const { race, cleanup } = createAbortRace(signal);
  try {
    const listenerStartedAt = Date.now();
    await race(beginListeners(begun, onEvent));
    const listenerMs = Date.now() - listenerStartedAt;
    const drainStartedAt = Date.now();
    await race(drainHandles(onEvent));
    const drainMs = Date.now() - drainStartedAt;
    state.beginning = false;
    token.begun = begun;
    state.expiryTimer = setTimeout(() => {
      if (state.token !== token) return;
      finishQuiet({ status: "expired", token, begun });
    }, maxMs);
    state.expiryTimer.unref?.();
    emit(onEvent, "quiet", { listenerMs, drainMs, openHandles, maxMs });
  } catch (error) {
    const owner = state.owner;
    const since = state.since;
    clearExpiryTimer();
    state = { ...createIdleState(), owner, since };
    emit(onEvent, "begin_failed", { error: error?.message || String(error) });
    endListeners(begun, onEvent);
    throw error;
  } finally {
    cleanup();
  }
  token.release = () => releaseStateDbQuiet(token);
  return { token, release: token.release };
};

const releaseStateDbQuiet = (token) => {
  if (!token || token !== state.token || !state.quiet || state.beginning) return false;
  finishQuiet({ status: "released", token, begun: token.begun || [] });
  return true;
};

const resetStateDbQuietForTests = ({ listeners: clearListeners = false } = {}) => {
  clearExpiryTimer();
  state = createIdleState();
  openHandles = 0;
  if (clearListeners) listeners.clear();
};

module.exports = {
  kStateDbQuietEventKind,
  kStateDbQuietEnvKey,
  kListenerBeginBudgetMs,
  kHandleDrainBudgetMs,
  kBackupInProgressCode,
  kBackupInProgressMessage,
  kStateDbQuietRetryAfterSec,
  StateDbQuietError,
  onStateDbQuiet,
  beginStateDbQuiet,
  releaseStateDbQuiet,
  isStateDbQuiet,
  getStateDbQuietState,
  enterStateDbHandle,
  exitStateDbHandle,
  withStateDbHandle,
  getStateDbHandleCount,
  resetStateDbQuietForTests,
};

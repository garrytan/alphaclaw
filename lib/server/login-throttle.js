const {
  kLoginWindowMs,
  kLoginMaxAttempts,
  kLoginBaseLockMs,
  kLoginMaxLockMs,
  kLoginGlobalWindowMs,
  kLoginGlobalMaxAttempts,
  kLoginGlobalBaseLockMs,
  kLoginGlobalMaxLockMs,
  kLoginStateTtlMs,
} = require("./constants");

const kGlobalStateKey = "global:login";
const kLoginThrottleScope = "login";

const createLoginAttemptState = (now) => ({
  attempts: 0,
  windowStart: now,
  lockUntil: 0,
  failStreak: 0,
  lastSeenAt: now,
});

const normalizeState = (state, now) => ({
  attempts: Number.parseInt(String(state?.attempts ?? 0), 10) || 0,
  windowStart: Number.parseInt(String(state?.windowStart ?? now), 10) || now,
  lockUntil: Number.parseInt(String(state?.lockUntil ?? 0), 10) || 0,
  failStreak: Number.parseInt(String(state?.failStreak ?? 0), 10) || 0,
  lastSeenAt: Number.parseInt(String(state?.lastSeenAt ?? now), 10) || now,
});

const createMemoryLoginThrottleStore = () => {
  const states = new Map();

  return {
    get: (stateKey) => states.get(stateKey) || null,
    set: (stateKey, state) => {
      states.set(stateKey, { ...state });
    },
    delete: (stateKey) => {
      states.delete(stateKey);
    },
    entries: () =>
      Array.from(states.entries()).map(([stateKey, state]) => [
        stateKey,
        { ...state },
      ]),
    runExclusive: (callback) => callback(),
  };
};

const getClientStateKey = (clientKey, scope = kLoginThrottleScope) => {
  const normalizedClientKey = String(clientKey || "unknown");
  return scope === kLoginThrottleScope
    ? `client:${normalizedClientKey}`
    : `client:${scope}:${normalizedClientKey}`;
};

const getGlobalStateKey = (scope = kLoginThrottleScope) =>
  scope === kLoginThrottleScope ? kGlobalStateKey : `global:${scope}`;

const getLaneStateKey = (laneKey, scope = kLoginThrottleScope) =>
  `lane:${scope}:${String(laneKey || "unknown")}`;

const getOrCreateState = (store, stateKey, now) => {
  const existing = store.get(stateKey);
  if (existing) {
    const state = normalizeState(existing, now);
    state.lastSeenAt = now;
    store.set(stateKey, state);
    return state;
  }
  const next = createLoginAttemptState(now);
  store.set(stateKey, next);
  return next;
};

const evaluateState = ({ store, stateKey, now, windowMs }) => {
  const state = getOrCreateState(store, stateKey, now);
  if (state.lockUntil > now) {
    return {
      state,
      blocked: true,
      retryAfterSec: Math.max(1, Math.ceil((state.lockUntil - now) / 1000)),
    };
  }
  if (now - state.windowStart >= windowMs) {
    state.attempts = 0;
    state.windowStart = now;
    store.set(stateKey, state);
  }
  return { state, blocked: false, retryAfterSec: 0 };
};

const recordStateFailure = ({
  store,
  stateKey,
  now,
  windowMs,
  maxAttempts,
  baseLockMs,
  maxLockMs,
}) => {
  const state = getOrCreateState(store, stateKey, now);
  if (state.lockUntil > now) {
    return {
      state,
      lockMs: state.lockUntil - now,
      locked: true,
      retryAfterSec: Math.max(1, Math.ceil((state.lockUntil - now) / 1000)),
    };
  }
  if (now - state.windowStart >= windowMs) {
    state.attempts = 0;
    state.windowStart = now;
  }
  state.attempts += 1;
  state.lastSeenAt = now;
  if (state.attempts < maxAttempts) {
    store.set(stateKey, state);
    return { state, lockMs: 0, locked: false, retryAfterSec: 0 };
  }
  state.failStreak += 1;
  state.attempts = 0;
  state.windowStart = now;
  const lockMultiplier = Math.max(1, 2 ** (state.failStreak - 1));
  const lockMs = Math.min(baseLockMs * lockMultiplier, maxLockMs);
  state.lockUntil = now + lockMs;
  store.set(stateKey, state);
  return {
    state,
    lockMs,
    locked: true,
    retryAfterSec: Math.max(1, Math.ceil(lockMs / 1000)),
  };
};

const chooseThrottleResult = (...results) => {
  const blockedResults = results.filter((result) => result.blocked);
  if (blockedResults.length === 0) {
    return { blocked: false, retryAfterSec: 0 };
  }
  return {
    blocked: true,
    retryAfterSec: Math.max(
      ...blockedResults.map((result) => result.retryAfterSec || 0),
    ),
  };
};

const chooseFailureResult = (...results) => {
  const lockedResults = results.filter((result) => result.locked);
  if (lockedResults.length === 0) {
    return { lockMs: 0, locked: false, retryAfterSec: 0 };
  }
  return {
    lockMs: Math.max(...lockedResults.map((result) => result.lockMs || 0)),
    locked: true,
    retryAfterSec: Math.max(
      ...lockedResults.map((result) => result.retryAfterSec || 0),
    ),
  };
};

const createLoginThrottle = ({
  store = createMemoryLoginThrottleStore(),
  scope = kLoginThrottleScope,
  windowMs = kLoginWindowMs,
  maxAttempts = kLoginMaxAttempts,
  baseLockMs = kLoginBaseLockMs,
  maxLockMs = kLoginMaxLockMs,
  globalWindowMs = kLoginGlobalWindowMs,
  globalMaxAttempts = kLoginGlobalMaxAttempts,
  globalBaseLockMs = kLoginGlobalBaseLockMs,
  globalMaxLockMs = kLoginGlobalMaxLockMs,
  stateTtlMs = kLoginStateTtlMs,
} = {}) => {
  const runExclusive =
    typeof store.runExclusive === "function"
      ? (callback) => store.runExclusive(callback)
      : (callback) => callback();

  const getOrCreateLoginAttemptState = (clientKey, now) =>
    runExclusive(() => {
      const clientStateKey = getClientStateKey(clientKey, scope);
      const globalStateKey = getGlobalStateKey(scope);
      return {
        clientKey,
        clientStateKey,
        globalStateKey,
        client: getOrCreateState(store, clientStateKey, now),
        global: getOrCreateState(store, globalStateKey, now),
      };
    });

  // Allocation-free global pre-check: callers gating high-cardinality
  // untrusted keys (e.g. spoofable client IPs on an unauthenticated route)
  // consult the ONE global bucket first, so a flood that has already
  // exhausted the global window never creates per-client entries at all —
  // peak store cardinality stays ~globalMaxAttempts per window instead of
  // one entry per forged key.
  const evaluateGlobalThrottle = (now) =>
    runExclusive(() => {
      const result = evaluateState({
        store,
        stateKey: getGlobalStateKey(scope),
        now,
        windowMs: globalWindowMs,
      });
      return { blocked: result.blocked, retryAfterSec: result.retryAfterSec };
    });

  const recordGlobalFailure = (now) =>
    runExclusive(() => {
      const result = recordStateFailure({
        store,
        stateKey: getGlobalStateKey(scope),
        now,
        windowMs: globalWindowMs,
        maxAttempts: globalMaxAttempts,
        baseLockMs: globalBaseLockMs,
        maxLockMs: globalMaxLockMs,
      });
      return { lockMs: result.lockMs, locked: result.locked, retryAfterSec: result.retryAfterSec };
    });

  const evaluateLoginThrottle = (stateBundle, now) =>
    runExclusive(() => {
      const clientStateKey =
        stateBundle?.clientStateKey ||
        getClientStateKey(stateBundle?.clientKey, scope);
      const globalStateKey = stateBundle?.globalStateKey || getGlobalStateKey(scope);
      const clientResult = evaluateState({
        store,
        stateKey: clientStateKey,
        now,
        windowMs,
      });
      const globalResult = evaluateState({
        store,
        stateKey: globalStateKey,
        now,
        windowMs: globalWindowMs,
      });
      if (stateBundle) {
        stateBundle.client = clientResult.state;
        stateBundle.global = globalResult.state;
      }
      return chooseThrottleResult(clientResult, globalResult);
    });

  const recordLoginFailure = (stateBundle, now) =>
    runExclusive(() => {
      const clientStateKey =
        stateBundle?.clientStateKey ||
        getClientStateKey(stateBundle?.clientKey, scope);
      const globalStateKey = stateBundle?.globalStateKey || getGlobalStateKey(scope);
      const clientResult = recordStateFailure({
        store,
        stateKey: clientStateKey,
        now,
        windowMs,
        maxAttempts,
        baseLockMs,
        maxLockMs,
      });
      const globalResult = recordStateFailure({
        store,
        stateKey: globalStateKey,
        now,
        windowMs: globalWindowMs,
        maxAttempts: globalMaxAttempts,
        baseLockMs: globalBaseLockMs,
        maxLockMs: globalMaxLockMs,
      });
      if (stateBundle) {
        stateBundle.client = clientResult.state;
        stateBundle.global = globalResult.state;
      }
      return chooseFailureResult(clientResult, globalResult);
    });

  // A success that was counted before its check ran (routes/auth.js) clears
  // only what its own count did. lockUntil is the bucket's lock right after
  // that count: a later lock is other attempts' failures and stays. A bucket
  // the caller resets is deleted unless such a lock is on it.
  const lockedByOthers = (state, lockUntil, now) => state.lockUntil > now && state.lockUntil !== lockUntil;
  const resetBucket = (stateKey, lockUntil, now) => {
    if (lockUntil !== undefined && lockedByOthers(normalizeState(store.get(stateKey), now), lockUntil, now)) return;
    store.delete(stateKey);
  };

  // Takes back one count: lifts the bucket's lock if that count set it (the
  // other attempts in its window stay counted), else removes one attempt from
  // the window it was counted in. counted: the bucket right after that count.
  const refundCount = (stateKey, counted, limit, now) => {
    if (!counted) return;
    const state = normalizeState(store.get(stateKey), now);
    if (state.lockUntil > now && state.lockUntil === counted.lockUntil) {
      store.set(stateKey, { ...state, lockUntil: 0, failStreak: Math.max(0, state.failStreak - 1), attempts: limit - 1 });
    } else if (state.lockUntil <= now && state.windowStart === counted.windowStart && state.attempts > 0) {
      store.set(stateKey, { ...state, attempts: state.attempts - 1 });
    }
  };

  // countedIn: the bundle a sign-in was counted with. Its success takes back
  // its box-wide count, and lifts the box-wide lock if that count set it.
  const recordLoginSuccess = (clientKey, countedIn = null) => {
    if (!clientKey) return;
    runExclusive(() => {
      const now = Date.now();
      // Clear only this client's bucket. Deleting the GLOBAL bucket on any
      // single success let a distributed brute force reset the cross-client
      // lockout by interleaving one valid login, defeating it entirely (MW3).
      resetBucket(getClientStateKey(clientKey, scope), countedIn?.client?.lockUntil, now);
      refundCount(getGlobalStateKey(scope), countedIn?.global, globalMaxAttempts, now);
    });
  };

  // Owner lanes (a verified known-browser pass, the recovery code): a bucket
  // of their own with the per-client numbers that never reads or writes the
  // per-client or box-wide bucket. Callers open a lane only after verifying
  // its credential, so a forged one never creates a row.
  const evaluateLaneThrottle = (laneKey, now) =>
    runExclusive(() => {
      const result = evaluateState({
        store,
        stateKey: getLaneStateKey(laneKey, scope),
        now,
        windowMs,
      });
      return { blocked: result.blocked, retryAfterSec: result.retryAfterSec };
    });

  const recordLaneFailure = (laneKey, now) =>
    runExclusive(() => {
      const result = recordStateFailure({
        store,
        stateKey: getLaneStateKey(laneKey, scope),
        now,
        windowMs,
        maxAttempts,
        baseLockMs,
        maxLockMs,
      });
      return {
        lockMs: result.lockMs,
        locked: result.locked,
        retryAfterSec: result.retryAfterSec,
        lockUntil: result.state.lockUntil,
        windowStart: result.state.windowStart,
      };
    });

  // The per-client (per-address) bucket alone, for a recovery-code attempt:
  // a blocked address is refused before the code is compared, and a wrong
  // code counts against its address (and, when it buys a decoy hash, against
  // the box-wide bucket through recordGlobalFailure).
  const evaluateClientThrottle = (clientKey, now) =>
    runExclusive(() => {
      const result = evaluateState({
        store,
        stateKey: getClientStateKey(clientKey, scope),
        now,
        windowMs,
      });
      return { blocked: result.blocked, retryAfterSec: result.retryAfterSec };
    });

  const recordClientFailure = (clientKey, now) =>
    runExclusive(() => {
      const result = recordStateFailure({
        store,
        stateKey: getClientStateKey(clientKey, scope),
        now,
        windowMs,
        maxAttempts,
        baseLockMs,
        maxLockMs,
      });
      return {
        lockMs: result.lockMs,
        locked: result.locked,
        retryAfterSec: result.retryAfterSec,
      };
    });

  // counted: what recordLaneFailure returned for this attempt.
  const recordLaneSuccess = (laneKey, counted = null) => {
    runExclusive(() => {
      resetBucket(getLaneStateKey(laneKey, scope), counted?.lockUntil, Date.now());
    });
  };

  // A lane one bucket serves for many accounts (the recovery code): a success
  // or an attempt that never ran takes back only its own count, so it cannot
  // wipe out wrong passwords other attempts sent through that lane.
  const refundLaneCount = (laneKey, counted) => {
    runExclusive(() => {
      refundCount(getLaneStateKey(laneKey, scope), counted, maxAttempts, Date.now());
    });
  };

  const cleanupLoginAttemptStates = () => {
    const now = Date.now();
    runExclusive(() => {
      for (const [stateKey, rawState] of store.entries()) {
        if (!rawState) {
          store.delete(stateKey);
          continue;
        }
        const state = normalizeState(rawState, now);
        if (state.lockUntil > now) continue;
        if (now - state.lastSeenAt > stateTtlMs) {
          store.delete(stateKey);
        }
      }
    });
  };

  return {
    getOrCreateLoginAttemptState,
    evaluateGlobalThrottle,
    recordGlobalFailure,
    evaluateLoginThrottle,
    recordLoginFailure,
    recordLoginSuccess,
    evaluateLaneThrottle,
    recordLaneFailure,
    evaluateClientThrottle,
    recordClientFailure,
    recordLaneSuccess,
    refundLaneCount,
    cleanupLoginAttemptStates,
  };
};

module.exports = {
  createLoginThrottle,
  createMemoryLoginThrottleStore,
  kGlobalStateKey,
};

const {
  createLoginThrottle,
  createMemoryLoginThrottleStore,
} = require("../../lib/server/login-throttle");
const {
  kLoginWindowMs,
  kLoginMaxAttempts,
  kLoginBaseLockMs,
  kLoginMaxLockMs,
  kLoginGlobalMaxAttempts,
  kLoginStateTtlMs,
} = require("../../lib/server/constants");

describe("server/login-throttle", () => {
  it("locks after max failures and reports retry-after while blocked", () => {
    const throttle = createLoginThrottle();
    const now = 1_000;
    const state = throttle.getOrCreateLoginAttemptState("client-1", now);

    for (let i = 0; i < kLoginMaxAttempts - 1; i += 1) {
      expect(throttle.recordLoginFailure(state, now + i)).toEqual(
        expect.objectContaining({
          lockMs: 0,
          locked: false,
        }),
      );
    }

    const lockResult = throttle.recordLoginFailure(state, now + 100);
    expect(lockResult.locked).toBe(true);
    expect(lockResult.lockMs).toBeGreaterThanOrEqual(kLoginBaseLockMs);

    const blocked = throttle.evaluateLoginThrottle(state, now + 101);
    expect(blocked.blocked).toBe(true);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("applies exponential backoff and caps lock at max lock", () => {
    const throttle = createLoginThrottle();
    const state = throttle.getOrCreateLoginAttemptState("client-2", 5_000);
    let now = 5_000;

    const getLockMsForStreak = () => {
      for (let i = 0; i < kLoginMaxAttempts; i += 1) {
        const result = throttle.recordLoginFailure(state, now + i);
        if (result.locked) return result.lockMs;
      }
      return 0;
    };

    const firstLockMs = getLockMsForStreak();
    now += kLoginWindowMs + firstLockMs + 1;
    const secondLockMs = getLockMsForStreak();

    expect(secondLockMs).toBeGreaterThanOrEqual(firstLockMs);
    expect(secondLockMs).toBeLessThanOrEqual(kLoginMaxLockMs);
  });

  it("removes the client bucket on login success", () => {
    const throttle = createLoginThrottle();
    const now = 10_000;
    const state = throttle.getOrCreateLoginAttemptState("client-3", now);
    throttle.recordLoginFailure(state, now);
    throttle.recordLoginSuccess("client-3");

    const next = throttle.getOrCreateLoginAttemptState("client-3", now + 1);
    expect(next.client.attempts).toBe(0);
    expect(next.client.failStreak).toBe(0);
  });

  // MW3: a single client's success must NOT zero the GLOBAL bucket, or a
  // distributed brute force could reset the cross-client lockout by
  // interleaving one valid login.
  it("does not reset the global bucket on a single client's success (MW3)", () => {
    const throttle = createLoginThrottle();
    const now = 20_000;

    // Accumulate global failures across several distinct clients.
    for (let i = 0; i < 3; i += 1) {
      const state = throttle.getOrCreateLoginAttemptState(`bad-${i}`, now + i);
      throttle.recordLoginFailure(state, now + i);
    }
    const beforeSuccess = throttle.getOrCreateLoginAttemptState(
      "observer",
      now + 10,
    );
    expect(beforeSuccess.global.attempts).toBeGreaterThanOrEqual(3);

    // A legitimate success by one client clears only that client.
    throttle.recordLoginSuccess("good-client");

    const afterSuccess = throttle.getOrCreateLoginAttemptState(
      "observer-2",
      now + 11,
    );
    expect(afterSuccess.global.attempts).toBeGreaterThanOrEqual(3);
  });

  it("isolates scoped throttle state in the same store", () => {
    const store = createMemoryLoginThrottleStore();
    const loginThrottle = createLoginThrottle({
      store,
      maxAttempts: 2,
      globalMaxAttempts: 100,
    });
    const apiThrottle = createLoginThrottle({
      store,
      scope: "openai-compat-api",
      maxAttempts: 2,
      globalMaxAttempts: 100,
    });
    const now = 12_000;
    const apiState = apiThrottle.getOrCreateLoginAttemptState("client-1", now);

    apiThrottle.recordLoginFailure(apiState, now);

    const loginState = loginThrottle.getOrCreateLoginAttemptState(
      "client-1",
      now + 1,
    );
    expect(loginState.client.attempts).toBe(0);
    expect(loginState.global.attempts).toBe(0);
    expect(store.entries().map(([key]) => key)).toEqual(
      expect.arrayContaining([
        "client:openai-compat-api:client-1",
        "global:openai-compat-api",
        "client:client-1",
        "global:login",
      ]),
    );
  });

  it("locks globally even when failures rotate across client keys", () => {
    const throttle = createLoginThrottle();
    const now = 15_000;

    for (let i = 0; i < kLoginGlobalMaxAttempts - 1; i += 1) {
      const state = throttle.getOrCreateLoginAttemptState(
        `client-${i}`,
        now + i,
      );
      const result = throttle.recordLoginFailure(state, now + i);
      expect(result.locked).toBe(false);
    }

    const finalState = throttle.getOrCreateLoginAttemptState(
      "fresh-client",
      now + kLoginGlobalMaxAttempts,
    );
    const lockResult = throttle.recordLoginFailure(
      finalState,
      now + kLoginGlobalMaxAttempts,
    );
    expect(lockResult.locked).toBe(true);

    const blockedState = throttle.getOrCreateLoginAttemptState(
      "another-fresh-client",
      now + kLoginGlobalMaxAttempts + 1,
    );
    const blocked = throttle.evaluateLoginThrottle(
      blockedState,
      now + kLoginGlobalMaxAttempts + 1,
    );
    expect(blocked.blocked).toBe(true);
  });

  it("resets the attempt window when evaluating after the window elapses", () => {
    const throttle = createLoginThrottle();
    const now = 30_000;
    const state = throttle.getOrCreateLoginAttemptState("client-window", now);

    throttle.recordLoginFailure(state, now);
    expect(state.client.attempts).toBe(1);

    const result = throttle.evaluateLoginThrottle(state, now + kLoginWindowMs + 1);

    expect(result.blocked).toBe(false);
    expect(state.client.attempts).toBe(0);
    expect(state.client.windowStart).toBe(now + kLoginWindowMs + 1);
  });

  it("reports remaining lock time when failures continue during a lock", () => {
    const throttle = createLoginThrottle();
    const now = 40_000;
    const state = throttle.getOrCreateLoginAttemptState("client-locked", now);

    let lockResult = null;
    for (let i = 0; i < kLoginMaxAttempts; i += 1) {
      lockResult = throttle.recordLoginFailure(state, now + i);
    }
    expect(lockResult.locked).toBe(true);

    const repeatResult = throttle.recordLoginFailure(state, now + kLoginMaxAttempts);

    expect(repeatResult.locked).toBe(true);
    expect(repeatResult.lockMs).toBeGreaterThan(0);
    expect(repeatResult.lockMs).toBeLessThanOrEqual(lockResult.lockMs);
    expect(repeatResult.retryAfterSec).toBeGreaterThan(0);
  });

  it("works with stores that do not implement runExclusive", () => {
    const states = new Map();
    const store = {
      get: (stateKey) => states.get(stateKey) || null,
      set: (stateKey, state) => {
        states.set(stateKey, { ...state });
      },
      delete: (stateKey) => {
        states.delete(stateKey);
      },
      entries: () => Array.from(states.entries()),
    };
    const throttle = createLoginThrottle({ store });
    const now = 50_000;

    const state = throttle.getOrCreateLoginAttemptState("client-basic", now);
    const failure = throttle.recordLoginFailure(state, now);
    const evaluation = throttle.evaluateLoginThrottle(state, now + 1);

    expect(failure.locked).toBe(false);
    expect(evaluation.blocked).toBe(false);
    expect(states.get("client:client-basic").attempts).toBe(1);
  });

  it("deletes malformed entries during cleanup", () => {
    const states = new Map([["client:broken", null]]);
    const store = {
      get: (stateKey) => states.get(stateKey) || null,
      set: (stateKey, state) => {
        states.set(stateKey, { ...state });
      },
      delete: vi.fn((stateKey) => {
        states.delete(stateKey);
      }),
      entries: () => Array.from(states.entries()),
      runExclusive: (callback) => callback(),
    };
    const throttle = createLoginThrottle({ store });

    throttle.cleanupLoginAttemptStates();

    expect(store.delete).toHaveBeenCalledWith("client:broken");
    expect(states.size).toBe(0);
  });

  it("cleans up stale states past TTL", () => {
    const throttle = createLoginThrottle();
    const oldNow = 20_000;
    throttle.getOrCreateLoginAttemptState("client-4", oldNow);

    vi.spyOn(Date, "now").mockReturnValue(oldNow + kLoginStateTtlMs + 1);
    throttle.cleanupLoginAttemptStates();

    const fresh = throttle.getOrCreateLoginAttemptState(
      "client-4",
      oldNow + kLoginStateTtlMs + 2,
    );
    expect(fresh.client.windowStart).toBe(oldNow + kLoginStateTtlMs + 2);
  });
});

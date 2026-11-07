const express = require("express");
const request = require("supertest");
const { createLoginThrottle } = require("../../lib/server/login-throttle");
const {
  kLoginGlobalMaxAttempts,
  kLoginGlobalSoftDelayMs,
  kLoginMaxAttempts,
} = require("../../lib/server/constants");
const { getClientKey } = require("../../lib/server/helpers");

// ALPH-71 L-3: the human login throttle's global bucket slows sign-in instead
// of closing it, so 25 bad guesses from strangers cannot lock the owner out.

const fillGlobalBucket = (throttle, now) => {
  for (let i = 0; i < kLoginGlobalMaxAttempts; i += 1) {
    const state = throttle.getOrCreateLoginAttemptState(`stranger-${i}`, now + i);
    throttle.recordLoginFailure(state, now + i);
  }
  return now + kLoginGlobalMaxAttempts;
};

describe("login throttle globalMode delay", () => {
  it("never blocks a fresh client on a full global bucket; it reports the soft delay instead", () => {
    const throttle = createLoginThrottle({ globalMode: "delay" });
    const now = fillGlobalBucket(throttle, 30_000);
    const owner = throttle.getOrCreateLoginAttemptState("owner", now + 1);
    const verdict = throttle.evaluateLoginThrottle(owner, now + 1);
    expect(verdict.blocked).toBe(false);
    expect(verdict.delayMs).toBe(kLoginGlobalSoftDelayMs);
    const failure = throttle.recordLoginFailure(owner, now + 2);
    expect(failure.locked).toBe(false);
  });

  it("reports no delay while the global bucket has room", () => {
    const throttle = createLoginThrottle({ globalMode: "delay" });
    const state = throttle.getOrCreateLoginAttemptState("owner", 1_000);
    expect(throttle.evaluateLoginThrottle(state, 1_000)).toEqual({
      blocked: false,
      retryAfterSec: 0,
      delayMs: 0,
    });
  });

  it("still locks one client that keeps guessing", () => {
    const throttle = createLoginThrottle({ globalMode: "delay" });
    const now = 50_000;
    const state = throttle.getOrCreateLoginAttemptState("guesser", now);
    let last = null;
    for (let i = 0; i < kLoginMaxAttempts; i += 1) {
      last = throttle.recordLoginFailure(state, now + i);
    }
    expect(last.locked).toBe(true);
    expect(throttle.evaluateLoginThrottle(state, now + 10).blocked).toBe(true);
  });

  it("keeps the lockout for every other throttle (the default mode)", () => {
    const throttle = createLoginThrottle({ scope: "agent-admin" });
    const now = fillGlobalBucket(throttle, 70_000);
    const fresh = throttle.getOrCreateLoginAttemptState("fresh", now + 1);
    const verdict = throttle.evaluateLoginThrottle(fresh, now + 1);
    expect(verdict.blocked).toBe(true);
    expect(verdict.delayMs).toBeUndefined();
  });
});

describe("POST /api/auth/login with a full global bucket", () => {
  const loadAuthRoutes = () => {
    vi.resetModules();
    const modulePath = require.resolve("../../lib/server/routes/auth");
    delete require.cache[modulePath];
    return require(modulePath);
  };

  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
  });

  it("waits the soft delay, then checks the password: the owner still signs in", async () => {
    process.env.SETUP_PASSWORD = "owner-pass";
    const { registerAuthRoutes } = loadAuthRoutes();
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    registerAuthRoutes({
      app,
      loginThrottle: {
        ...createLoginThrottle({ globalMode: "delay", globalSoftDelayMs: 300 }),
        getClientKey,
      },
    });
    for (let i = 0; i < kLoginGlobalMaxAttempts; i += 1) {
      const res = await request(app)
        .post("/api/auth/login")
        .set("X-Forwarded-For", `203.0.113.${i + 1}`)
        .send({ password: "wrong" });
      expect(res.status).toBe(401);
    }
    const startedAt = Date.now();
    const wrong = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "198.51.100.7")
      .send({ password: "wrong" });
    expect(wrong.status).toBe(401);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(280);
    const owner = await request(app)
      .post("/api/auth/login")
      .set("X-Forwarded-For", "198.51.100.8")
      .send({ password: "owner-pass" });
    expect(owner.status).toBe(200);
    expect(owner.body).toEqual({ ok: true });
  });

  it("lets one client's parallel attempts during the soft delay check no more passwords than its own limit", async () => {
    process.env.SETUP_PASSWORD = "owner-pass";
    const { registerAuthRoutes } = loadAuthRoutes();
    const app = express();
    app.set("trust proxy", 1);
    app.use(express.json());
    const throttle = createLoginThrottle({ globalMode: "delay", globalSoftDelayMs: 200 });
    fillGlobalBucket(throttle, Date.now());
    const recordLoginFailure = vi.fn(throttle.recordLoginFailure);
    registerAuthRoutes({
      app,
      loginThrottle: { ...throttle, recordLoginFailure, getClientKey },
    });
    const burst = kLoginMaxAttempts + 4;
    const results = await Promise.all(
      Array.from({ length: burst }, () =>
        request(app)
          .post("/api/auth/login")
          .set("X-Forwarded-For", "198.51.100.42")
          .send({ password: "wrong" }),
      ),
    );
    expect(recordLoginFailure.mock.calls.length).toBeLessThanOrEqual(kLoginMaxAttempts);
    expect(results.filter((res) => res.status === 401).length).toBeLessThan(kLoginMaxAttempts);
    expect(results.filter((res) => res.status === 429).length).toBeGreaterThanOrEqual(burst - kLoginMaxAttempts);
  });
});

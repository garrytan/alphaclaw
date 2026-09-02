const express = require("express");
const request = require("supertest");
const { registerCodexRoutes } = require("../../lib/server/routes/codex");

const createApp = ({ changed = true } = {}) => {
  const app = express();
  app.use(express.json());
  const onAuthChanged = vi.fn();
  registerCodexRoutes({
    app,
    createPkcePair: () => ({ verifier: "verifier", challenge: "challenge" }),
    parseCodexAuthorizationInput: () => ({}),
    getCodexAccountId: () => null,
    authProfiles: {
      getCodexProfile: () => null,
      removeCodexProfiles: () => changed,
    },
    onAuthChanged,
  });
  return { app, onAuthChanged };
};

describe("server/routes/codex", () => {
  it("invalidates model discovery when Codex auth is disconnected", async () => {
    const { app, onAuthChanged } = createApp();

    await request(app).post("/api/codex/disconnect").expect(200, {
      ok: true,
      changed: true,
    });

    expect(onAuthChanged).toHaveBeenCalledOnce();
  });

  it("does not invalidate model discovery when disconnect changes nothing", async () => {
    const { app, onAuthChanged } = createApp({ changed: false });

    await request(app).post("/api/codex/disconnect").expect(200, {
      ok: true,
      changed: false,
    });

    expect(onAuthChanged).not.toHaveBeenCalled();
  });

  it("maps a state-DB quiet-period disconnect to 409 backup_in_progress with Retry-After", async () => {
    const { StateDbQuietError } = require("../../lib/server/state-db-quiet");
    const app = express();
    app.use(express.json());
    const onAuthChanged = vi.fn();
    registerCodexRoutes({
      app,
      createPkcePair: () => ({ verifier: "verifier", challenge: "challenge" }),
      parseCodexAuthorizationInput: () => ({}),
      getCodexAccountId: () => null,
      authProfiles: {
        getCodexProfile: () => null,
        removeCodexProfiles: () => {
          throw new StateDbQuietError();
        },
      },
      onAuthChanged,
    });

    const res = await request(app).post("/api/codex/disconnect");

    expect(res.status).toBe(409);
    expect(res.headers["retry-after"]).toBe("120");
    expect(res.body).toEqual({
      ok: false,
      code: "backup_in_progress",
      error: "A backup is in progress; retry in about two minutes.",
    });
    expect(onAuthChanged).not.toHaveBeenCalled();
  });

  it("keeps the 503 retry mapping for other fail-closed auth-store errors", async () => {
    const app = express();
    app.use(express.json());
    registerCodexRoutes({
      app,
      createPkcePair: () => ({ verifier: "verifier", challenge: "challenge" }),
      parseCodexAuthorizationInput: () => ({}),
      getCodexAccountId: () => null,
      authProfiles: {
        getCodexProfile: () => null,
        removeCodexProfiles: () => {
          throw new Error("state/openclaw.sqlite is busy");
        },
      },
      onAuthChanged: vi.fn(),
    });

    const res = await request(app).post("/api/codex/disconnect");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ ok: false, error: "state/openclaw.sqlite is busy" });
  });

  // R8: during a backup the store is UNAVAILABLE, not empty — the status
  // route says so additively (`connected` keeps its shape).
  it("GET /api/codex/status reports unavailable:true + reason while the store is unavailable, and the normal shape otherwise", async () => {
    let availability = { unavailable: true, reason: "backup_in_progress" };
    const app = express();
    registerCodexRoutes({
      app,
      createPkcePair: () => ({ verifier: "verifier", challenge: "challenge" }),
      parseCodexAuthorizationInput: () => ({}),
      getCodexAccountId: () => null,
      authProfiles: {
        getCodexProfile: () => ({ profileId: "openai-codex", accountId: "acct-1", expires: 42 }),
        getAuthStoreAvailability: () => availability,
        removeCodexProfiles: () => false,
      },
      onAuthChanged: vi.fn(),
    });

    const during = await request(app).get("/api/codex/status");
    expect(during.status).toBe(200);
    expect(during.body).toEqual({
      connected: false,
      unavailable: true,
      reason: "backup_in_progress",
    });

    availability = { unavailable: false, reason: null };
    const after = await request(app).get("/api/codex/status");
    expect(after.body).toEqual({
      connected: true,
      profileId: "openai-codex",
      accountId: "acct-1",
      expires: 42,
    });
  });
});

// R6: the OAuth code/state are one-use. A StateDbQuietError AFTER the token
// exchange used to answer 409 and discard tokens the retry could never
// re-obtain; a barrier already held used to consume the state before refusing.
describe("server/routes/codex OAuth exchange vs the state-DB quiet period", () => {
  const {
    beginStateDbQuiet,
    resetStateDbQuietForTests,
    isStateDbQuiet,
    StateDbQuietError,
  } = require("../../lib/server/state-db-quiet");
  const kOriginalFetch = global.fetch;
  const flushMacrotask = () => new Promise((resolve) => setImmediate(resolve));
  const tokenResponse = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
    }),
  });
  let token = null;

  const createOauthApp = () => {
    const app = express();
    app.use(express.json());
    const onAuthChanged = vi.fn();
    const stored = [];
    // Mirrors the real store: the write fails closed while the barrier holds.
    const upsertCodexProfile = vi.fn((credential) => {
      if (isStateDbQuiet()) throw new StateDbQuietError();
      stored.push(credential);
    });
    registerCodexRoutes({
      app,
      createPkcePair: () => ({ verifier: "verifier", challenge: "challenge" }),
      parseCodexAuthorizationInput: (input) => {
        const url = new URL(String(input));
        return { code: url.searchParams.get("code"), state: url.searchParams.get("state") };
      },
      getCodexAccountId: () => "acct-1",
      authProfiles: {
        getCodexProfile: () => null,
        upsertCodexProfile,
        removeCodexProfiles: () => false,
      },
      onAuthChanged,
    });
    return { app, onAuthChanged, upsertCodexProfile, stored };
  };

  const startAndGetState = async (app) => {
    const res = await request(app).get("/auth/codex/start");
    expect(res.status).toBe(302);
    return new URL(res.headers.location).searchParams.get("state");
  };

  beforeEach(() => {
    resetStateDbQuietForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    token?.release();
    token = null;
    resetStateDbQuietForTests();
    global.fetch = kOriginalFetch;
    vi.restoreAllMocks();
  });

  it("callback: a held barrier is answered BEFORE the one-use state is consumed — no exchange, and the same URL succeeds after the backup", async () => {
    const { app, upsertCodexProfile, onAuthChanged } = createOauthApp();
    const state = await startAndGetState(app);
    global.fetch = vi.fn(async () => tokenResponse());
    ({ token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 }));

    const refused = await request(app).get(`/auth/codex/callback?code=c1&state=${state}`);
    expect(refused.status).toBe(200);
    expect(refused.text).toContain("codex: 'error'");
    expect(refused.text).toContain("A backup is in progress");
    expect(global.fetch).not.toHaveBeenCalled();
    expect(upsertCodexProfile).not.toHaveBeenCalled();

    token.release();
    token = null;
    const retried = await request(app).get(`/auth/codex/callback?code=c1&state=${state}`);
    expect(retried.text).toContain("codex: 'success'");
    expect(retried.text).not.toContain("deferred");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(upsertCodexProfile).toHaveBeenCalledTimes(1);
    expect(onAuthChanged).toHaveBeenCalledTimes(1);
  });

  it("exchange: a held barrier is a 409 backup_in_progress BEFORE the state is consumed, and the same paste succeeds after", async () => {
    const { app, upsertCodexProfile, onAuthChanged } = createOauthApp();
    const state = await startAndGetState(app);
    global.fetch = vi.fn(async () => tokenResponse());
    ({ token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 }));
    const input = `http://localhost:1455/auth/callback?code=c1&state=${state}`;

    const refused = await request(app).post("/api/codex/exchange").send({ input });
    expect(refused.status).toBe(409);
    expect(refused.headers["retry-after"]).toBe("120");
    expect(refused.body).toEqual({
      ok: false,
      code: "backup_in_progress",
      error: "A backup is in progress; retry in about two minutes.",
    });
    expect(global.fetch).not.toHaveBeenCalled();

    token.release();
    token = null;
    const retried = await request(app).post("/api/codex/exchange").send({ input });
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual({ ok: true });
    expect(upsertCodexProfile).toHaveBeenCalledTimes(1);
    expect(onAuthChanged).toHaveBeenCalledTimes(1);
  });

  it("callback: a barrier that begins mid-exchange never discards the redeemed tokens — the page says deferred and the write lands when the barrier lifts", async () => {
    const { app, upsertCodexProfile, onAuthChanged, stored } = createOauthApp();
    const state = await startAndGetState(app);
    global.fetch = vi.fn(async () => {
      ({ token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 }));
      return tokenResponse();
    });

    const res = await request(app).get(`/auth/codex/callback?code=c1&state=${state}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("codex: 'success', deferred: true");
    expect(res.text).toContain("saved as soon as the running backup finishes");
    // Refused once by the barrier, retained, not yet announced.
    expect(upsertCodexProfile).toHaveBeenCalledTimes(1);
    expect(stored).toEqual([]);
    expect(onAuthChanged).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("deferred until the barrier lifts"),
    );

    token.release();
    token = null;
    await flushMacrotask();
    expect(stored).toEqual([
      expect.objectContaining({
        access: "access-token",
        refresh: "refresh-token",
        accountId: "acct-1",
      }),
    ]);
    expect(onAuthChanged).toHaveBeenCalledTimes(1);
  });

  it("exchange: a barrier that begins mid-exchange answers 202 { ok, deferred, reason } and the write lands when the barrier lifts", async () => {
    const { app, onAuthChanged, stored } = createOauthApp();
    const state = await startAndGetState(app);
    global.fetch = vi.fn(async () => {
      ({ token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 }));
      return tokenResponse();
    });

    const res = await request(app)
      .post("/api/codex/exchange")
      .send({ input: `http://localhost:1455/auth/callback?code=c1&state=${state}` });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, deferred: true, reason: "backup_in_progress" });
    expect(stored).toEqual([]);
    expect(onAuthChanged).not.toHaveBeenCalled();

    token.release();
    token = null;
    await flushMacrotask();
    expect(stored).toHaveLength(1);
    expect(onAuthChanged).toHaveBeenCalledTimes(1);
  });

  it("a deferred write is dropped loudly, never written, when its retry fails for a non-barrier reason", async () => {
    const { app, upsertCodexProfile, onAuthChanged, stored } = createOauthApp();
    const state = await startAndGetState(app);
    global.fetch = vi.fn(async () => {
      ({ token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 }));
      return tokenResponse();
    });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await request(app).get(`/auth/codex/callback?code=c1&state=${state}`);
    expect(res.text).toContain("deferred: true");
    upsertCodexProfile.mockImplementation(() => {
      throw new Error("schema drift");
    });

    token.release();
    token = null;
    await flushMacrotask();
    expect(stored).toEqual([]);
    expect(onAuthChanged).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining("deferred Codex profile write FAILED (schema drift)"),
    );
  });

  // The DIRECT write's non-barrier failures kept their pre-deferral contract
  // across the rewrite (persistCodexProfileOrDefer re-throws anything that is
  // not a StateDbQuietError): a store error is still an ERROR to the client —
  // callback → error page carrying the message, exchange → 500 with no
  // Retry-After — never a "deferred" success, and no pending slot is armed
  // that a later barrier release could replay.
  it("a non-barrier store failure on the direct write is still an error (callback page / exchange 500) — never deferred, nothing armed for a later release", async () => {
    const { app, upsertCodexProfile, onAuthChanged, stored } = createOauthApp();
    vi.spyOn(console, "error").mockImplementation(() => {});
    global.fetch = vi.fn(async () => tokenResponse());
    upsertCodexProfile.mockImplementation(() => {
      throw new Error("state/openclaw.sqlite is busy");
    });

    const callbackState = await startAndGetState(app);
    const callback = await request(app).get(
      `/auth/codex/callback?code=c1&state=${callbackState}`,
    );
    expect(callback.status).toBe(200);
    expect(callback.text).toContain("codex: 'error'");
    expect(callback.text).toContain("state/openclaw.sqlite is busy");
    expect(callback.text).not.toContain("deferred");

    const exchangeState = await startAndGetState(app);
    const exchange = await request(app)
      .post("/api/codex/exchange")
      .send({ input: `http://localhost:1455/auth/callback?code=c2&state=${exchangeState}` });
    expect(exchange.status).toBe(500);
    expect(exchange.headers["retry-after"]).toBeUndefined();
    expect(exchange.body).toEqual({ ok: false, error: "state/openclaw.sqlite is busy" });

    expect(upsertCodexProfile).toHaveBeenCalledTimes(2);
    expect(onAuthChanged).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("deferred until the barrier lifts"),
    );

    // No phantom slot: a later barrier cycle replays nothing.
    upsertCodexProfile.mockImplementation((credential) => stored.push(credential));
    ({ token } = await beginStateDbQuiet({ owner: "backup", maxMs: 60_000 }));
    token.release();
    token = null;
    await flushMacrotask();
    expect(upsertCodexProfile).toHaveBeenCalledTimes(2);
    expect(stored).toEqual([]);
    expect(onAuthChanged).not.toHaveBeenCalled();
  });
});

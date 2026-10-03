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
  it("waits for disconnect activation and reports a saved-but-restart-required result", async () => {
    const app = express();
    let finish;
    const refreshGatewayAuth = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const restartRequiredState = { markRequired: vi.fn() };
    registerCodexRoutes({ app, authProfiles: { removeCodexProfiles: () => true, refreshGatewayAuth }, restartRequiredState });
    let settled = false;
    const pending = request(app).post("/api/codex/disconnect").then((res) => { settled = true; return res; });
    await vi.waitFor(() => expect(refreshGatewayAuth).toHaveBeenCalledWith(undefined, restartRequiredState));
    expect(settled).toBe(false);
    finish({ authRuntimeRefreshed: false, restartRequired: true });
    const res = await pending;
    expect(res.body).toMatchObject({ ok: true, changed: true, authRuntimeRefreshed: false, restartRequired: true });
  });

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

  // R8: an unreadable store is UNAVAILABLE, not empty — the status route says
  // so additively (`connected` keeps its shape).
  it("GET /api/codex/status reports unavailable:true + reason while the store is unavailable, and the normal shape otherwise", async () => {
    let availability = { unavailable: true, reason: "AUTH_STORE_UNREADABLE" };
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
      reason: "AUTH_STORE_UNREADABLE",
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

describe("server/routes/codex OAuth exchange", () => {
  const kOriginalFetch = global.fetch;
  const tokenResponse = () => ({
    ok: true,
    status: 200,
    json: async () => ({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
    }),
  });

  const createOauthApp = () => {
    const app = express();
    app.use(express.json());
    const onAuthChanged = vi.fn();
    const upsertCodexProfile = vi.fn();
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
    return { app, onAuthChanged, upsertCodexProfile };
  };

  const startAndGetState = async (app) => {
    const res = await request(app).get("/auth/codex/start");
    expect(res.status).toBe(302);
    return new URL(res.headers.location).searchParams.get("state");
  };

  afterEach(() => {
    global.fetch = kOriginalFetch;
    vi.restoreAllMocks();
  });

  it("callback: redeems the one-use state, writes the profile and reports success", async () => {
    const { app, upsertCodexProfile, onAuthChanged } = createOauthApp();
    const state = await startAndGetState(app);
    global.fetch = vi.fn(async () => tokenResponse());

    const res = await request(app).get(`/auth/codex/callback?code=c1&state=${state}`);
    expect(res.text).toContain("codex: 'success'");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(upsertCodexProfile).toHaveBeenCalledWith(
      expect.objectContaining({ access: "access-token", refresh: "refresh-token", accountId: "acct-1" }),
    );
    expect(onAuthChanged).toHaveBeenCalledTimes(1);

    const replay = await request(app).get(`/auth/codex/callback?code=c1&state=${state}`);
    expect(replay.text).toContain("State mismatch");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("exchange: a pasted redirect URL writes the profile and answers ok", async () => {
    const { app, upsertCodexProfile, onAuthChanged } = createOauthApp();
    const state = await startAndGetState(app);
    global.fetch = vi.fn(async () => tokenResponse());

    const res = await request(app)
      .post("/api/codex/exchange")
      .send({ input: `http://localhost:1455/auth/callback?code=c1&state=${state}` });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
    expect(upsertCodexProfile).toHaveBeenCalledTimes(1);
    expect(onAuthChanged).toHaveBeenCalledTimes(1);
  });

  it("a store failure on the profile write is an error (callback page / exchange 500)", async () => {
    const { app, upsertCodexProfile, onAuthChanged } = createOauthApp();
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

    const exchangeState = await startAndGetState(app);
    const exchange = await request(app)
      .post("/api/codex/exchange")
      .send({ input: `http://localhost:1455/auth/callback?code=c2&state=${exchangeState}` });
    expect(exchange.status).toBe(500);
    expect(exchange.body).toEqual({ ok: false, error: "state/openclaw.sqlite is busy" });

    expect(upsertCodexProfile).toHaveBeenCalledTimes(2);
    expect(onAuthChanged).not.toHaveBeenCalled();
  });
});

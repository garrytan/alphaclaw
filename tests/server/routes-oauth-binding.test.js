const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { EventEmitter } = require("events");

const { registerGoogleRoutes } = require("../../lib/server/routes/google");

// E-C11 coverage the plan requires: OAuth callback completion and WS upgrade
// paths, not just JSON routes.

const buildGoogleApp = ({
  identityRole = "admin",
  getBaseUrl = () => "http://127.0.0.1:3000",
} = {}) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-oauth-"));
  const app = express();
  app.use(express.json());
  // Simulate requireAuth having resolved an identity (the real mount runs
  // before these routes).
  app.use((req, res, next) => {
    if (identityRole) req.alphaclawIdentity = { kind: "member", role: identityRole };
    next();
  });
  registerGoogleRoutes({
    app,
    fs,
    isGatewayRunning: async () => false,
    gogCmd: async () => ({ ok: true, stdout: "", stderr: "" }),
    getBaseUrl,
    readGoogleCredentials: () => ({ clientId: "cid", clientSecret: "sec" }),
    getApiEnableUrl: () => "",
    constants: {
      GOG_CONFIG_DIR: tmpDir,
      GOG_STATE_PATH: path.join(tmpDir, "google-state.json"),
      API_TEST_COMMANDS: {},
      BASE_SCOPES: ["openid"],
      SCOPE_MAP: { gmail: "gmail-scope" },
      REVERSE_SCOPE_MAP: { "gmail-scope": "gmail" },
      kMaxGoogleAccounts: 5,
      gogClientCredentialsPath: () => path.join(tmpDir, "creds.json"),
    },
  });
  return { app, tmpDir };
};

const startFlow = async (app, { query = "", cookie = "", headers = {} } = {}) => {
  let req = request(app).get(`/auth/google/start${query}`);
  if (cookie) req = req.set("Cookie", cookie);
  for (const [name, value] of Object.entries(headers)) {
    req = req.set(name, value);
  }
  const start = await req;
  expect(start.status).toBe(302);
  return new URL(start.headers.location).searchParams.get("state");
};

describe("server/routes OAuth callback binding (E-C11 / PR #114 pattern)", () => {
  afterEach(() => {
    delete global.fetch;
    vi.restoreAllMocks();
  });

  it("rejects a Google callback whose state this server never issued", async () => {
    const { app, tmpDir } = buildGoogleApp();
    // A forged state an attacker could mint freely before the flow map existed.
    const forgedState = Buffer.from(
      JSON.stringify({ client: "default", email: "x@y.z", services: ["gmail"] }),
    ).toString("base64url");
    const res = await request(app).get(
      `/auth/google/callback?code=stolen-code&state=${forgedState}`,
    );
    // The callback answers a popup: errors render an HTML page that
    // postMessages the failure — never a completed sign-in.
    expect(res.status).toBe(200);
    // The message's apostrophe is backslash-escaped inside the page's inline
    // script, so match around it.
    expect(res.text).toContain("started from this dashboard");
    expect(res.text).toContain("google: 'error'");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("issues opaque single-use states from an ADMIN-gated start; members get 403", async () => {
    const admin = buildGoogleApp({ identityRole: "admin" });
    const state = await startFlow(admin.app);
    // Opaque 16-byte hex token; the linking payload lives server-side only —
    // there is nothing in the state to decode, edit, or re-encode.
    expect(state).toMatch(/^[0-9a-f]{32}$/);
    expect(() =>
      JSON.parse(Buffer.from(state, "base64url").toString()),
    ).toThrow();

    // Same app instance: the state is consumable exactly once. The first
    // callback consumes it (then fails later on the token exchange — which
    // must NOT happen before the flow check, so stub fetch to prove order).
    const fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(String(url));
      return { ok: false, json: async () => ({ error: "stub" }) };
    };
    await request(admin.app).get(
      `/auth/google/callback?code=c1&state=${state}`,
    );
    expect(fetchCalls.length).toBe(1); // state accepted → reached exchange
    const replay = await request(admin.app).get(
      `/auth/google/callback?code=c2&state=${state}`,
    );
    expect(replay.text).toContain("started from this dashboard");
    expect(fetchCalls.length).toBe(1); // replayed state never reaches exchange

    const member = buildGoogleApp({ identityRole: "member" });
    const memberStart = await request(member.app).get("/auth/google/start");
    expect(memberStart.status).toBe(403);
    fs.rmSync(admin.tmpDir, { recursive: true, force: true });
    fs.rmSync(member.tmpDir, { recursive: true, force: true });
  });

  it("callback query params cannot alter the server-held flow payload (tamper)", async () => {
    const { app, tmpDir } = buildGoogleApp();
    const state = await startFlow(app, { query: "?services=gmail" });

    global.fetch = async (url) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "at",
            refresh_token: "rt",
            scope: "gmail-scope",
          }),
        };
      }
      return { ok: true, json: async () => ({ email: "linked@example.com" }) };
    };
    const res = await request(app).get(
      `/auth/google/callback?code=c&state=${state}&accountId=victim&email=evil%40x.y&services=all`,
    );
    expect(res.text).toContain("google: 'success'");

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "google-state.json"), "utf8"),
    );
    const accounts = Array.isArray(saved.accounts) ? saved.accounts : [];
    expect(accounts.length).toBe(1);
    // Everything the attacker appended to the callback URL is ignored: the
    // linked identity and services come from the server-held flow + Google.
    expect(accounts[0].email).toBe("linked@example.com");
    expect(accounts[0].services).toEqual(["gmail"]);
    expect(accounts[0].id).not.toBe("victim");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("expires a pending flow after its TTL (zero exchanges)", async () => {
    const { kGoogleOauthStateTtlMs } = require("../../lib/server/constants");
    const { app, tmpDir } = buildGoogleApp();
    const state = await startFlow(app);

    const fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(String(url));
      return { ok: false, json: async () => ({ error: "stub" }) };
    };
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(
      realNow + kGoogleOauthStateTtlMs + 1000,
    );
    const res = await request(app).get(
      `/auth/google/callback?code=c&state=${state}`,
    );
    expect(res.text).toContain("started from this dashboard");
    expect(fetchCalls.length).toBe(0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a denied consent consumes the flow — the state cannot be replayed with a code", async () => {
    const { app, tmpDir } = buildGoogleApp();
    const state = await startFlow(app);

    const denied = await request(app).get(
      `/auth/google/callback?error=access_denied&state=${state}`,
    );
    expect(denied.status).toBe(302); // legacy redirect for consent errors

    const fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(String(url));
      return { ok: false, json: async () => ({ error: "stub" }) };
    };
    const replay = await request(app).get(
      `/auth/google/callback?code=c&state=${state}`,
    );
    expect(replay.text).toContain("started from this dashboard");
    expect(fetchCalls.length).toBe(0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("pins the token exchange to the start-time redirect_uri (proxy drift)", async () => {
    const { app, tmpDir } = buildGoogleApp({
      getBaseUrl: (req) =>
        `http://${req?.headers?.["x-forwarded-host"] || "127.0.0.1:3000"}`,
    });
    const state = await startFlow(app, {
      headers: { "X-Forwarded-Host": "a.example" },
    });

    let exchangeBody = null;
    global.fetch = async (url, options) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        exchangeBody = options?.body;
        return { ok: false, json: async () => ({ error: "stub" }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    await request(app)
      .get(`/auth/google/callback?code=c&state=${state}`)
      .set("X-Forwarded-Host", "b.example");
    expect(String(exchangeBody)).toContain(
      encodeURIComponent("http://a.example/auth/google/callback"),
    );
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("caps pending flows: the oldest state is evicted past the bound", async () => {
    const { kGoogleOauthMaxPendingFlows } = require("../../lib/server/constants");
    const { app, tmpDir } = buildGoogleApp();
    const firstState = await startFlow(app);
    for (let i = 0; i < kGoogleOauthMaxPendingFlows; i += 1) {
      await startFlow(app);
    }

    const fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(String(url));
      return { ok: false, json: async () => ({ error: "stub" }) };
    };
    const res = await request(app).get(
      `/auth/google/callback?code=c&state=${firstState}`,
    );
    expect(res.text).toContain("started from this dashboard");
    expect(fetchCalls.length).toBe(0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("soft session binding: a different session cannot complete the flow; absent sessions still can", async () => {
    const { app, tmpDir } = buildGoogleApp();
    const fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(String(url));
      return { ok: false, json: async () => ({ error: "stub" }) };
    };

    // Mismatched session: rejected before any exchange.
    const mismatchState = await startFlow(app, { cookie: "setup_token=alpha" });
    const mismatch = await request(app)
      .get(`/auth/google/callback?code=c&state=${mismatchState}`)
      .set("Cookie", "setup_token=beta");
    expect(mismatch.text).toContain("started from this dashboard");
    expect(fetchCalls.length).toBe(0);

    // Same session: passes the binding, reaches the exchange.
    const sameState = await startFlow(app, { cookie: "setup_token=alpha" });
    await request(app)
      .get(`/auth/google/callback?code=c&state=${sameState}`)
      .set("Cookie", "setup_token=alpha");
    expect(fetchCalls.length).toBe(1);

    // Cookie-less callback: the no-session exemption is preserved.
    const bareState = await startFlow(app, { cookie: "setup_token=alpha" });
    await request(app).get(`/auth/google/callback?code=c&state=${bareState}`);
    expect(fetchCalls.length).toBe(2);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("stages the refresh token in a private mkdtemp file, never a predictable /tmp path (H14)", async () => {
    const { app, tmpDir } = buildGoogleApp();
    const state = await startFlow(app);

    const writes = [];
    const realWriteFileSync = fs.writeFileSync;
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, data, opts) => {
      writes.push({ target: String(target), opts });
      return realWriteFileSync(target, data, opts);
    });
    global.fetch = async (url) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "at",
            refresh_token: "rt",
            scope: "gmail-scope",
          }),
        };
      }
      return { ok: true, json: async () => ({ email: "linked@example.com" }) };
    };

    const res = await request(app).get(
      `/auth/google/callback?code=c&state=${state}`,
    );
    expect(res.text).toContain("google: 'success'");

    const tokenWrite = writes.find((w) =>
      w.target.endsWith("token.json"),
    );
    expect(tokenWrite).toBeTruthy();
    // Not the old predictable, world-readable shared-tmp path.
    expect(tokenWrite.target).not.toMatch(/\/gog-token-\d+\.json$/);
    expect(tokenWrite.target).toContain("alphaclaw-gog-");
    expect(tokenWrite.opts).toMatchObject({ mode: 0o600 });
    // The private dir is cleaned up (no residual token file on disk).
    expect(fs.existsSync(tokenWrite.target)).toBe(false);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("a start with an unknown accountId cannot plant it — the callback creates a fresh account (regression)", async () => {
    const { app, tmpDir } = buildGoogleApp();
    const state = await startFlow(app, {
      query: "?accountId=planted-target&services=gmail",
    });

    global.fetch = async (url) => {
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return {
          ok: true,
          json: async () => ({
            access_token: "at",
            refresh_token: "rt",
            scope: "gmail-scope",
          }),
        };
      }
      return { ok: true, json: async () => ({ email: "fresh@example.com" }) };
    };
    const res = await request(app).get(
      `/auth/google/callback?code=c&state=${state}`,
    );
    expect(res.text).toContain("google: 'success'");

    const saved = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "google-state.json"), "utf8"),
    );
    const accounts = Array.isArray(saved.accounts) ? saved.accounts : [];
    expect(accounts.length).toBe(1);
    expect(accounts[0].id).not.toBe("planted-target");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("rejects a consenting Google identity that differs from the flow's email — nothing saved (F095)", async () => {
    const { app, tmpDir } = buildGoogleApp();
    const state = await startFlow(app, { query: "?email=expected%40example.com&services=gmail" });

    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return { ok: true, json: async () => ({ access_token: "at-1", refresh_token: "rt-1" }) };
      }
      if (String(url).includes("userinfo")) {
        return { ok: true, json: async () => ({ email: "someone.else@example.com" }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    const res = await request(app).get(`/auth/google/callback?code=c&state=${state}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("google: 'error'");
    expect(res.text).toContain("account_mismatch");
    expect(res.text).toContain("someone.else@example.com");
    expect(calls.some((url) => url.includes("userinfo"))).toBe(true);
    // No account was persisted for either identity.
    const statePath = path.join(tmpDir, "google-state.json");
    if (fs.existsSync(statePath)) {
      const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect((saved.accounts || []).filter((a) => a.authenticated)).toEqual([]);
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("verifies identity on every exchange (userinfo is fetched even when the flow carries an email)", async () => {
    const { app, tmpDir } = buildGoogleApp();
    const state = await startFlow(app, { query: "?email=expected%40example.com&services=gmail" });
    const calls = [];
    global.fetch = async (url) => {
      calls.push(String(url));
      if (String(url).includes("oauth2.googleapis.com/token")) {
        return { ok: true, json: async () => ({ access_token: "at-1", refresh_token: "rt-1" }) };
      }
      if (String(url).includes("userinfo")) {
        return { ok: true, json: async () => ({ email: "Expected@Example.com" }) };
      }
      return { ok: true, json: async () => ({}) };
    };
    const res = await request(app).get(`/auth/google/callback?code=c&state=${state}`);
    // Case-insensitive match passes the identity gate (the rest of the import
    // runs against the stub gog and may still fail later, but never as a mismatch).
    expect(res.text).not.toContain("account_mismatch");
    expect(calls.some((url) => url.includes("userinfo"))).toBe(true);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("server/watchdog-terminal-ws admin gate (4.6)", () => {
  const buildBridge = ({ isAdmin }) => {
    const server = new EventEmitter();
    const {
      createWatchdogTerminalWsBridge,
    } = require("../../lib/server/watchdog-terminal-ws");
    createWatchdogTerminalWsBridge({
      server,
      proxy: { ws: vi.fn() },
      getGatewayUrl: () => "http://127.0.0.1:1",
      isAuthorizedRequest: () => true,
      isAdminRequest: () => isAdmin,
      watchdogTerminal: { createOrReuseSession: () => ({ id: "s1" }) },
      chatWsService: null,
    });
    return server;
  };

  const makeSocket = () => {
    const writes = [];
    return {
      writes,
      write: (chunk) => writes.push(String(chunk)),
      destroy: vi.fn(),
    };
  };

  it("refuses the terminal WS upgrade for authenticated non-admins", () => {
    const server = buildBridge({ isAdmin: false });
    const socket = makeSocket();
    server.emit(
      "upgrade",
      {
        url: "/api/watchdog/terminal/ws",
        headers: { host: "localhost", cookie: "setup_token=member" },
      },
      socket,
      Buffer.alloc(0),
    );
    expect(socket.writes.join("")).toContain("403 Forbidden");
    expect(socket.writes.join("")).toContain("Admin access required");
    expect(socket.destroy).toHaveBeenCalled();
  });

  it("admits admins past the terminal gate (upgrade proceeds)", () => {
    const server = buildBridge({ isAdmin: true });
    const socket = makeSocket();
    // A real WebSocketServer.handleUpgrade aborts on a fake socket — what
    // matters here is that the gate did NOT write the 403 refusal.
    try {
      server.emit(
        "upgrade",
        {
          url: "/api/watchdog/terminal/ws",
          headers: { host: "localhost", cookie: "setup_token=admin" },
        },
        socket,
        Buffer.alloc(0),
      );
    } catch {}
    expect(socket.writes.join("")).not.toContain("403 Forbidden");
  });
});

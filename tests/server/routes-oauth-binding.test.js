const fs = require("fs");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { EventEmitter } = require("events");

const { registerGoogleRoutes } = require("../../lib/server/routes/google");

// E-C11 coverage the plan requires: OAuth callback completion and WS upgrade
// paths, not just JSON routes.

const buildGoogleApp = ({ identityRole = "admin" } = {}) => {
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
    getBaseUrl: () => "http://127.0.0.1:3000",
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

describe("server/routes OAuth callback binding (E-C11)", () => {
  it("rejects a Google callback whose state carries no server-issued nonce", async () => {
    const { app, tmpDir } = buildGoogleApp();
    // A forged state an attacker could mint freely before the nonce existed.
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

  it("issues single-use nonces from an ADMIN-gated start; members get 403", async () => {
    const admin = buildGoogleApp({ identityRole: "admin" });
    const start = await request(admin.app).get("/auth/google/start");
    expect(start.status).toBe(302);
    const authUrl = new URL(start.headers.location);
    const state = authUrl.searchParams.get("state");
    const decoded = JSON.parse(Buffer.from(state, "base64url").toString());
    expect(typeof decoded.nonce).toBe("string");
    expect(decoded.nonce.length).toBeGreaterThanOrEqual(16);

    // Same app instance: the nonce is consumable exactly once. The first
    // callback consumes it (then fails later on the token exchange — which
    // must NOT happen before the nonce check, so stub fetch to prove order).
    const fetchCalls = [];
    global.fetch = async (url) => {
      fetchCalls.push(String(url));
      return { ok: false, json: async () => ({ error: "stub" }) };
    };
    await request(admin.app).get(
      `/auth/google/callback?code=c1&state=${state}`,
    );
    expect(fetchCalls.length).toBe(1); // nonce accepted → reached exchange
    const replay = await request(admin.app).get(
      `/auth/google/callback?code=c2&state=${state}`,
    );
    expect(replay.text).toContain("started from this dashboard");
    expect(fetchCalls.length).toBe(1); // replayed nonce never reaches exchange
    delete global.fetch;

    const member = buildGoogleApp({ identityRole: "member" });
    const memberStart = await request(member.app).get("/auth/google/start");
    expect(memberStart.status).toBe(403);
    fs.rmSync(admin.tmpDir, { recursive: true, force: true });
    fs.rmSync(member.tmpDir, { recursive: true, force: true });
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

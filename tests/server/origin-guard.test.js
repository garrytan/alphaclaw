const express = require("express");
const request = require("supertest");
const { EventEmitter } = require("events");

const { classifyBrowserOrigin } = require("../../lib/server/control-ui-mount");
const { createWatchdogTerminalWsBridge } = require("../../lib/server/watchdog-terminal-ws");

const kCanonical = "https://claw.example.com";

const loadAuthRoutes = () => {
  vi.resetModules();
  const modulePath = require.resolve("../../lib/server/routes/auth");
  delete require.cache[modulePath];
  return require(modulePath);
};

const createThrottleMock = () => ({
  getClientKey: vi.fn(() => "client-key"),
  getOrCreateLoginAttemptState: vi.fn(() => ({ attempts: 0 })),
  evaluateLoginThrottle: vi.fn(() => ({ blocked: false, retryAfterSec: 0 })),
  recordLoginFailure: vi.fn(() => ({ lockMs: 0, locked: false })),
  recordLoginSuccess: vi.fn(),
  cleanupLoginAttemptStates: vi.fn(),
});

const kAgentToken = "d".repeat(64);

const createAuthApp = ({ trustedOrigin = kCanonical } = {}) => {
  process.env.SETUP_PASSWORD = "origin-secret";
  const { registerAuthRoutes } = loadAuthRoutes();
  const app = express();
  app.use(express.json());
  const throttle = createThrottleMock();
  registerAuthRoutes({
    app,
    loginThrottle: throttle,
    agentAdmin: {
      isEnabled: () => true,
      readToken: () => kAgentToken,
      throttle,
      onAuthEvent: vi.fn(),
    },
    getTrustedBrowserOrigin: () => trustedOrigin,
  });
  app.post("/api/thing", (req, res) => res.json({ ok: true }));
  app.get("/api/thing", (req, res) => res.json({ ok: true }));
  return app;
};

const loginCookie = async (app) => {
  const login = await request(app)
    .post("/api/auth/login")
    .send({ password: "origin-secret" });
  expect(login.status).toBe(200);
  return String(login.headers["set-cookie"]?.[0] || "").split(";")[0];
};

describe("classifyBrowserOrigin (control-ui-mount.js)", () => {
  const classify = (headers, trustedOrigin = kCanonical) =>
    classifyBrowserOrigin({ headers, trustedOrigin });

  it("is same when the Origin host is the requested host, X-Forwarded-Host or the canonical origin", () => {
    expect(classify({ host: "box.lan:3000", origin: "http://box.lan:3000" })).toBe("same");
    expect(classify({ host: "box.lan", origin: "https://box.lan:443" })).toBe("same");
    expect(
      classify({ host: "127.0.0.1:3000", "x-forwarded-host": "claw.custom.dev", origin: "https://claw.custom.dev" }),
    ).toBe("same");
    expect(classify({ host: "10.0.0.5:3000", origin: kCanonical })).toBe("same");
    expect(classify({ host: "box.lan:3000", origin: "http://box.lan:3000" }, "")).toBe("same");
  });

  it("is cross for another site, a look-alike host, Origin: null and a malformed Origin", () => {
    expect(classify({ host: "box.lan:3000", origin: "https://evil.example" })).toBe("cross");
    expect(classify({ host: "box.lan:3000", origin: "http://box.lan.evil.example:3000" })).toBe("cross");
    expect(classify({ host: "box.lan:3000", origin: "null" })).toBe("cross");
    expect(classify({ host: "box.lan:3000", origin: "http://box.lan:3000/path" })).toBe("cross");
    expect(classify({ host: "box.lan:3000", origin: "https://claw.example.com.evil.dev" })).toBe("cross");
  });

  it("is cross when the Origin's port is the other scheme's default (http on 443, https on 80)", () => {
    expect(classify({ host: "box.example", origin: "http://box.example:443" }, "")).toBe("cross");
    expect(classify({ host: "box.example", origin: "https://box.example:80" }, "")).toBe("cross");
    expect(classify({ host: "box.example:443", origin: "http://box.example:443" }, "")).toBe("cross");
    expect(classify({ host: "box.example:443", origin: "https://box.example" }, "")).toBe("same");
    expect(classify({ host: "box.example:80", origin: "http://box.example" }, "")).toBe("same");
    expect(classify({ host: "box.example:80", origin: "https://box.example" }, "")).toBe("cross");
    expect(classify({ host: "box.example", origin: "https://box.example" }, "")).toBe("same");
    expect(classify({ host: "box.example", origin: "http://box.example" }, "")).toBe("same");
  });

  it("is cross for an http Origin when a proxy says the request came over https", () => {
    const cloudflare = { host: "box.example", "x-forwarded-proto": "https", "cf-visitor": '{"scheme":"https"}' };
    expect(classify({ ...cloudflare, origin: "https://box.example" }, "")).toBe("same");
    expect(classify({ ...cloudflare, origin: "http://box.example" }, "")).toBe("cross");
    const innerProxySaysHttp = { host: "box.example", "x-forwarded-proto": "http", "cf-visitor": '{"scheme":"https"}' };
    expect(classify({ ...innerProxySaysHttp, origin: "https://box.example" }, "")).toBe("same");
    expect(classify({ ...innerProxySaysHttp, origin: "http://box.example" }, "")).toBe("cross");
    const chain = { host: "box.example", "x-forwarded-proto": "https, http" };
    expect(classify({ ...chain, origin: "http://box.example" }, "")).toBe("cross");
  });

  it("lets the Origin's own scheme stand when no proxy says https", () => {
    expect(classify({ host: "box.example", "x-forwarded-proto": "http", origin: "https://box.example" }, "")).toBe("same");
    expect(classify({ host: "box.example", "x-forwarded-proto": "http", origin: "http://box.example" }, "")).toBe("same");
    expect(classify({ host: "box.example:3000", origin: "http://box.example:3000" }, "")).toBe("same");
    expect(classify({ host: "box.example:8443", origin: "https://box.example:8443" }, "")).toBe("same");
    expect(classify({ host: "box.example", "cf-visitor": "not json", origin: "http://box.example" }, "")).toBe("same");
  });

  it("is cross for an Origin that is not http or https", () => {
    expect(classify({ host: "box.example", origin: "ftp://box.example" }, "")).toBe("cross");
    expect(classify({ host: "abcdef", origin: "chrome-extension://abcdef" }, "")).toBe("cross");
  });

  it("is absent with no Origin, unless fetch metadata says the request came from another site", () => {
    expect(classify({ host: "box.lan" })).toBe("absent");
    expect(classify({ host: "box.lan", "sec-fetch-site": "same-origin" })).toBe("absent");
    expect(classify({ host: "box.lan", "sec-fetch-site": "none" })).toBe("absent");
    expect(classify({ host: "box.lan", "sec-fetch-site": "cross-site" })).toBe("cross");
    expect(classify({ host: "box.lan", "sec-fetch-site": "same-site" })).toBe("cross");
  });
});

describe("cookie-authenticated /api writes must come from the box's origin (L-4)", () => {
  afterEach(() => {
    delete process.env.SETUP_PASSWORD;
    vi.restoreAllMocks();
  });

  it("refuses a cross-origin cookie POST with 403 origin_mismatch and logs the actor", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = createAuthApp();
    const cookie = await loginCookie(app);
    const res = await request(app)
      .post("/api/thing")
      .set("Cookie", cookie)
      .set("Host", "box.lan:3000")
      .set("Origin", "https://evil.example")
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Cross-origin request refused", code: "origin_mismatch" });
    const line = warn.mock.calls.map((args) => String(args[0])).find((text) => text.startsWith("[origin] refused"));
    expect(line).toContain("http POST /api/thing");
    expect(line).toContain("code=origin_mismatch");
    expect(line).toContain("actor=human");
    expect(line).toContain('origin="https://evil.example"');
  });

  it("refuses a cookie POST without Origin whose fetch metadata says cross-site", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = createAuthApp();
    const cookie = await loginCookie(app);
    const res = await request(app)
      .post("/api/thing")
      .set("Cookie", cookie)
      .set("Sec-Fetch-Site", "cross-site")
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("origin_mismatch");
  });

  it("accepts a same-origin, canonical-origin or Origin-less cookie POST and every cookie GET", async () => {
    const app = createAuthApp();
    const cookie = await loginCookie(app);
    const sameHost = await request(app)
      .post("/api/thing")
      .set("Cookie", cookie)
      .set("Host", "box.lan:3000")
      .set("Origin", "http://box.lan:3000")
      .send({});
    expect(sameHost.status).toBe(200);
    const canonical = await request(app)
      .post("/api/thing")
      .set("Cookie", cookie)
      .set("Origin", kCanonical)
      .send({});
    expect(canonical.status).toBe(200);
    const noOrigin = await request(app).post("/api/thing").set("Cookie", cookie).send({});
    expect(noOrigin.status).toBe(200);
    const crossGet = await request(app)
      .get("/api/thing")
      .set("Cookie", cookie)
      .set("Origin", "https://evil.example");
    expect(crossGet.status).toBe(200);
  });

  it("refuses a cross-origin cookie POST on a case-variant /API path (Express routes ignore case)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = createAuthApp();
    const cookie = await loginCookie(app);
    for (const path of ["/API/thing", "/Api/thing"]) {
      const res = await request(app)
        .post(path)
        .set("Cookie", cookie)
        .set("Host", "box.lan:3000")
        .set("Origin", "https://evil.example")
        .send({});
      expect(res.status, path).toBe(403);
      expect(res.body.code, path).toBe("origin_mismatch");
    }
  });

  it("refuses a cross-origin cookie logout with 403 origin_mismatch and leaves the session working", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const app = createAuthApp({ trustedOrigin: "https://box.example.com" });
    const cookie = await loginCookie(app);
    const res = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .set("Host", "box.example.com")
      .set("Origin", "https://evil.example.com")
      .send({});
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: "Cross-origin request refused", code: "origin_mismatch" });
    expect(res.headers["set-cookie"]).toBeUndefined();
    const line = warn.mock.calls.map((args) => String(args[0])).find((text) => text.startsWith("[origin] refused"));
    expect(line).toContain("http POST /api/auth/logout");
    expect(line).toContain("code=origin_mismatch");
    const after = await request(app).get("/api/thing").set("Cookie", cookie);
    expect(after.status).toBe(200);

    const sameOrigin = await request(app)
      .post("/api/auth/logout")
      .set("Cookie", cookie)
      .set("Host", "box.example.com")
      .set("Origin", "https://box.example.com")
      .send({});
    expect(sameOrigin.status).toBe(200);
    expect(sameOrigin.body).toEqual({ ok: true });
    const ended = await request(app).get("/api/thing").set("Cookie", cookie);
    expect(ended.status).toBe(401);
  });

  it("exempts bearer requests: the agent token never rides the browser's ambient credential", async () => {
    const app = createAuthApp();
    const res = await request(app)
      .post("/api/thing")
      .set("Authorization", `Bearer ${kAgentToken}`)
      .set("Origin", "https://evil.example")
      .send({});
    expect(res.status).toBe(200);
  });
});

describe("WebSocket upgrades (L-4 origin, L-1 catch-all allowlist)", () => {
  const createBridge = ({ authorized = true } = {}) => {
    const server = new EventEmitter();
    const proxied = [];
    const chatUpgrades = [];
    const terminalUpgrades = [];
    createWatchdogTerminalWsBridge({
      server,
      proxy: { ws: vi.fn((req) => proxied.push(req.url)) },
      getGatewayUrl: () => "http://127.0.0.1:18789",
      isAuthorizedRequest: () => authorized,
      isAdminRequest: () => authorized,
      watchdogTerminal: { createOrReuseSession: () => null, subscribe: () => ({}) },
      chatWsService: { handleUpgrade: vi.fn((req) => chatUpgrades.push(req.url)) },
      resolveProxyIdentity: () => null,
      getTrustedBrowserOrigin: () => kCanonical,
    });
    return { server, proxied, chatUpgrades, terminalUpgrades };
  };
  const createSocket = () => ({ write: vi.fn(), destroy: vi.fn(), on: vi.fn() });
  const upgrade = (bridge, url, headers = {}) => {
    const socket = createSocket();
    bridge.server.emit("upgrade", { url, headers: { host: "box.lan:3000", ...headers }, socket: {} }, socket, Buffer.alloc(0));
    return socket;
  };

  afterEach(() => vi.restoreAllMocks());

  for (const path of ["/api/ws/chat", "/api/watchdog/terminal/ws"]) {
    it(`refuses a cross-origin ${path} upgrade with 403 origin_mismatch`, () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const bridge = createBridge();
      const socket = upgrade(bridge, path, { origin: "https://evil.example" });
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("403 Forbidden"));
      expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('"code":"origin_mismatch"'));
      expect(socket.destroy).toHaveBeenCalled();
      expect(bridge.chatUpgrades).toHaveLength(0);
      expect(bridge.proxied).toHaveLength(0);
      expect(String(warn.mock.calls[0]?.[0])).toContain(`[origin] refused ws GET ${path}`);
    });
  }

  it("accepts a same-origin or Origin-less chat upgrade", () => {
    const bridge = createBridge();
    const same = upgrade(bridge, "/api/ws/chat", { origin: "http://box.lan:3000" });
    const none = upgrade(bridge, "/api/ws/chat");
    const canonical = upgrade(bridge, "/api/ws/chat", { origin: kCanonical });
    for (const socket of [same, none, canonical]) expect(socket.write).not.toHaveBeenCalled();
    expect(bridge.chatUpgrades).toEqual(["/api/ws/chat", "/api/ws/chat", "/api/ws/chat"]);
  });

  it("still answers an unauthenticated cross-origin chat upgrade 401 (auth first)", () => {
    const bridge = createBridge({ authorized: false });
    const socket = upgrade(bridge, "/api/ws/chat", { origin: "https://evil.example" });
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining("401 Unauthorized"));
  });

  it("forwards only the gateway's own WebSocket paths through the catch-all", () => {
    const bridge = createBridge();
    const forwarded = [
      "/",
      "/?token=x",
      "/openclaw",
      "/openclaw/chat",
      "/__openclaw__/worker",
      "/__openclaw__/cap/canvas/ws",
      "/node-desktop/attach?ticket=t",
      "/node-portal/attach?ticket=t",
      "/desktop/observe?token=t",
      "/desktop/audio?token=t",
      "/browser/screencast?token=t",
    ];
    for (const url of forwarded) {
      const socket = upgrade(bridge, url);
      expect(socket.write, url).not.toHaveBeenCalled();
    }
    expect(bridge.proxied).toEqual(forwarded);
    for (const url of ["/random", "/api/ws/other", "/v1/responses", "/hooks/x", "/openclawx", "/__openclaw", "/desktop/observe/extra"]) {
      const socket = upgrade(bridge, url);
      expect(socket.write, url).toHaveBeenCalledWith(expect.stringContaining("404 Not Found"));
      expect(socket.destroy).toHaveBeenCalled();
    }
    expect(bridge.proxied).toEqual(forwarded);
  });

  it("forwards the Chrome extension relay path /browser/extension (OpenClaw 2026.10.9 registers it beside /browser/screencast)", () => {
    const bridge = createBridge();
    const socket = upgrade(bridge, "/browser/extension");
    expect(socket.write).not.toHaveBeenCalled();
    expect(bridge.proxied).toEqual(["/browser/extension"]);
  });
});

// Logout closes the terminal and chat WebSockets of the sessions it ended
// (ALPH-73 round 5). Both are authorized only at upgrade, so before this an
// open socket kept working after logout: the terminal kept forwarding input
// to the shell. This suite wires the real auth routes, the real upgrade
// bridge and the real chat service the way lib/server.js does (one emitter,
// logout emits on it), against real sockets on a real HTTP server.
const { EventEmitter } = require("events");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const express = require("express");
const request = require("supertest");
const { WebSocket } = require("ws");

const { initAuthDb, closeAuthDb, getAuthDb } = require("../../lib/server/db/auth");
const { createMembersStore } = require("../../lib/server/db/auth/members");
const { registerAuthRoutes } = require("../../lib/server/routes/auth");
const { createWatchdogTerminalWsBridge } = require("../../lib/server/watchdog-terminal-ws");
const { createChatBridgeTestKit } = require("./helpers/chat-gateway-harness");

const kOwnerPassword = "owner-secret";
const kLoggedOut = { code: 1000, reason: "Logged out" };

const createLoginThrottleMock = () => ({
  getClientKey: vi.fn(() => "client-key"),
  getOrCreateLoginAttemptState: vi.fn(() => ({ attempts: 0 })),
  evaluateLoginThrottle: vi.fn(() => ({ blocked: false, retryAfterSec: 0 })),
  recordLoginFailure: vi.fn(() => ({ lockMs: 0, locked: false })),
  recordLoginSuccess: vi.fn(),
  cleanupLoginAttemptStates: vi.fn(),
});

const cookieOf = (res) => (res.headers["set-cookie"]?.[0] || "").split(";")[0];

describe("logout closes open terminal and chat sockets", () => {
  let rootDir;
  let cleanups;
  let app;
  let port;
  let membersStore;
  let writeInput;

  beforeEach(async () => {
    vi.stubEnv("SETUP_PASSWORD", kOwnerPassword);
    vi.stubEnv("ALPHACLAW_ALLOW_LEGACY_LOGIN", undefined);
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-logout-sockets-"));
    initAuthDb({ rootDir });
    membersStore = createMembersStore({ getDb: getAuthDb });
    cleanups = [];

    const authSessionEvents = new EventEmitter();
    app = express();
    app.use(express.json());
    const auth = registerAuthRoutes({
      app,
      loginThrottle: createLoginThrottleMock(),
      membersStore,
      readTeamSettings: () => ({ enabled: true, disableLegacyLogin: false }),
      onLogout: (event) => authSessionEvents.emit("logout", event),
    });

    const kit = createChatBridgeTestKit({ cleanups });
    const gateway = await kit.startGatewayHarness();
    const chatWsService = kit.createService(gateway, { authSessionEvents });

    writeInput = vi.fn();
    const server = http.createServer(app);
    createWatchdogTerminalWsBridge({
      server,
      proxy: { ws: vi.fn() },
      getGatewayUrl: () => `http://127.0.0.1:${gateway.port}`,
      isAuthorizedRequest: auth.isAuthorizedRequest,
      isAdminRequest: auth.isAdminRequest,
      watchdogTerminal: {
        createOrReuseSession: () => ({ id: "terminal-1" }),
        subscribe: () => ({ ok: true, unsubscribe: () => {} }),
        writeInput,
      },
      chatWsService,
      resolveRequestIdentity: auth.resolveRequestIdentity,
      authSessionEvents,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
    cleanups.push(() => {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    });
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) {
      await cleanup();
    }
    vi.unstubAllEnvs();
    closeAuthDb();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const loginOwner = async () =>
    cookieOf(await request(app).post("/api/auth/login").send({ password: kOwnerPassword }));

  const loginMember = async (email) => {
    membersStore.createMember({ email, displayName: email, role: "admin", password: "member password" });
    return cookieOf(await request(app).post("/api/auth/login").send({ email, password: "member password" }));
  };

  // Resolves once the socket's first message of firstType arrives.
  const openSocket = (pathname, cookie, firstType) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers: { cookie } });
      const socket = { ws, messages: [], closed: null };
      socket.closedPromise = new Promise((resolveClose) => {
        ws.on("close", (code, reason) => {
          socket.closed = { code, reason: String(reason) };
          resolveClose(socket.closed);
        });
      });
      cleanups.push(() => ws.terminate());
      ws.on("message", (raw) => {
        const message = JSON.parse(String(raw));
        socket.messages.push(message);
        if (message.type === firstType) resolve(socket);
      });
      ws.on("error", reject);
      ws.on("unexpected-response", (req, res) => reject(new Error(`upgrade answered ${res.statusCode}`)));
    });

  const openTerminal = (cookie) => openSocket("/api/watchdog/terminal/ws", cookie, "session");
  const openChat = (cookie) => openSocket("/api/ws/chat", cookie, "hello");

  const closedWithin = (socket, ms = 3000) =>
    Promise.race([
      socket.closedPromise,
      new Promise((resolve) => setTimeout(() => resolve("still open"), ms)),
    ]);

  const answersPing = async (socket) => {
    const ts = Date.now();
    socket.ws.send(JSON.stringify({ type: "ping", ts }));
    for (let i = 0; i < 100; i += 1) {
      if (socket.messages.some((m) => m.type === "pong" && m.ts === ts)) return true;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return false;
  };

  it("closes the owner's terminal and chat sockets and every member's on a legacy logout, and drops terminal input sent after it", async () => {
    const ownerCookie = await loginOwner();
    const memberCookie = await loginMember("member@example.com");
    const terminal = await openTerminal(ownerCookie);
    const chat = await openChat(ownerCookie);
    const memberChat = await openChat(memberCookie);

    terminal.ws.send(JSON.stringify({ type: "input", data: "before-logout" }));
    await vi.waitFor(() => expect(writeInput).toHaveBeenCalledWith({ sessionId: "terminal-1", input: "before-logout" }));

    // Paused, the client does not read the server's close frame, so it still
    // sends: the input reaches a socket the server is already closing.
    terminal.ws.pause();
    const logout = await request(app).post("/api/auth/logout").set("Cookie", ownerCookie).send({});
    expect(logout.status).toBe(200);
    terminal.ws.send(JSON.stringify({ type: "input", data: "after-logout" }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    terminal.ws.resume();

    expect(await closedWithin(terminal)).toEqual(kLoggedOut);
    expect(await closedWithin(chat)).toEqual(kLoggedOut);
    expect(await closedWithin(memberChat)).toEqual(kLoggedOut);
    expect(writeInput).not.toHaveBeenCalledWith({ sessionId: "terminal-1", input: "after-logout" });
    expect(writeInput).toHaveBeenCalledTimes(1);
  });

  it("closes only the logged-out member's sockets on a member logout", async () => {
    const ownerCookie = await loginOwner();
    const aliceCookie = await loginMember("alice@example.com");
    const bobCookie = await loginMember("bob@example.com");
    const aliceTerminal = await openTerminal(aliceCookie);
    const aliceChat = await openChat(aliceCookie);
    const bobChat = await openChat(bobCookie);
    const ownerChat = await openChat(ownerCookie);

    const logout = await request(app).post("/api/auth/logout").set("Cookie", aliceCookie).send({});
    expect(logout.status).toBe(200);

    expect(await closedWithin(aliceTerminal)).toEqual(kLoggedOut);
    expect(await closedWithin(aliceChat)).toEqual(kLoggedOut);
    expect(await answersPing(bobChat)).toBe(true);
    expect(await answersPing(ownerChat)).toBe(true);
    expect(bobChat.closed).toBeNull();
    expect(ownerChat.closed).toBeNull();
  });
});

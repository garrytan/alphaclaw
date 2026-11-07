// Team admin changes close the sockets of the sessions they end (GST-1800).
// A role change, disable or removal rotates the member's token secret, and
// team-off rotates every member's, so the member's cookie stops working; the
// terminal and chat sockets that cookie opened are authorized only at upgrade
// and kept working. The legacy-login lockdown refuses every existing owner
// shared-password session the same way. This suite wires the real auth and
// team routes, the real upgrade bridge and the real chat service the way
// lib/server.js does (one emitter, both routes emit on it), against real
// sockets. Only the team transition service is a stub: it flips the flag
// (routes-team covers the real transition).
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
const { registerTeamRoutes } = require("../../lib/server/routes/team");
const { createTeamPresence } = require("../../lib/server/team/presence");
const { createWatchdogTerminalWsBridge } = require("../../lib/server/watchdog-terminal-ws");
const { createChatBridgeTestKit } = require("./helpers/chat-gateway-harness");

const kOwnerPassword = "owner-secret";
const kEnded = { code: 1000, reason: "Logged out" };

const createLoginThrottleMock = () => ({
  getClientKey: vi.fn(() => "client-key"),
  getOrCreateLoginAttemptState: vi.fn(() => ({ attempts: 0 })),
  evaluateLoginThrottle: vi.fn(() => ({ blocked: false, retryAfterSec: 0 })),
  recordLoginFailure: vi.fn(() => ({ lockMs: 0, locked: false })),
  recordLoginSuccess: vi.fn(),
  cleanupLoginAttemptStates: vi.fn(),
});

const cookieOf = (res) => (res.headers["set-cookie"]?.[0] || "").split(";")[0];

describe("team admin changes close the ended sessions' sockets", () => {
  let rootDir;
  let cleanups;
  let app;
  let port;
  let membersStore;
  let settings;
  let sessionsEndedThrows;

  beforeEach(async () => {
    vi.stubEnv("SETUP_PASSWORD", kOwnerPassword);
    vi.stubEnv("ALPHACLAW_ALLOW_LEGACY_LOGIN", undefined);
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "alphaclaw-team-sockets-"));
    initAuthDb({ rootDir });
    membersStore = createMembersStore({ getDb: getAuthDb });
    cleanups = [];
    settings = { enabled: true, disableLegacyLogin: false };
    sessionsEndedThrows = false;

    const authSessionEvents = new EventEmitter();
    const emitEnded = (event) => authSessionEvents.emit("logout", event);
    app = express();
    app.use(express.json());
    const auth = registerAuthRoutes({
      app,
      loginThrottle: createLoginThrottleMock(),
      membersStore,
      readTeamSettings: () => ({ ...settings }),
      onLogout: emitEnded,
    });
    registerTeamRoutes({
      app,
      requireAdmin: auth.requireAdmin,
      membersStore,
      teamStateStore: { read: () => ({}) },
      teamService: {
        isTransitionInFlight: () => false,
        reconcileRoster: async () => false,
        setEnabled: async (enabled, { prepareEnable } = {}) => {
          if (enabled) {
            const prepared = prepareEnable();
            if (!prepared.ok) return prepared;
          }
          settings.enabled = enabled;
          return { ok: true, enabled };
        },
      },
      presence: createTeamPresence(),
      readTeamSettings: () => ({ ...settings }),
      updateTeamSettings: (patch) => {
        for (const [key, value] of Object.entries(patch)) {
          if (value !== undefined) settings[key] = value;
        }
      },
      onSessionsEnded: (event) => {
        if (sessionsEndedThrows) throw new Error("emitter broke");
        emitEnded(event);
      },
    });

    const kit = createChatBridgeTestKit({ cleanups });
    const gateway = await kit.startGatewayHarness();
    const chatWsService = kit.createService(gateway, { authSessionEvents });

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
        writeInput: () => {},
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
    const member = membersStore.createMember({ email, displayName: email, role: "admin", password: "member password" });
    const cookie = cookieOf(await request(app).post("/api/auth/login").send({ email, password: "member password" }));
    return { id: member.id, cookie };
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

  const openBoth = async (cookie) => ({
    terminal: await openSocket("/api/watchdog/terminal/ws", cookie, "session"),
    chat: await openSocket("/api/ws/chat", cookie, "hello"),
  });

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

  const expectClosed = async ({ terminal, chat }) => {
    expect(await closedWithin(terminal)).toEqual(kEnded);
    expect(await closedWithin(chat)).toEqual(kEnded);
  };

  const expectOpen = async ({ terminal, chat }) => {
    expect(await answersPing(chat)).toBe(true);
    expect(terminal.closed).toBeNull();
    expect(chat.closed).toBeNull();
  };

  const setUp = async () => {
    const ownerCookie = await loginOwner();
    const alice = await loginMember("alice@example.com");
    const bob = await loginMember("bob@example.com");
    return {
      ownerCookie,
      alice: { ...alice, sockets: await openBoth(alice.cookie) },
      bob: { ...bob, sockets: await openBoth(bob.cookie) },
      owner: await openBoth(ownerCookie),
    };
  };

  it.each([
    ["demoted", (id, cookie) => request(app).patch(`/api/team/members/${id}`).set("Cookie", cookie).send({ role: "member" })],
    ["disabled", (id, cookie) => request(app).patch(`/api/team/members/${id}`).set("Cookie", cookie).send({ disabled: true })],
    ["removed", (id, cookie) => request(app).delete(`/api/team/members/${id}`).set("Cookie", cookie)],
  ])("closes a member's terminal and chat sockets when an admin has them %s, and no one else's", async (label, act) => {
    const { ownerCookie, alice, bob, owner } = await setUp();

    const res = await act(alice.id, ownerCookie);
    expect(res.status).toBe(200);

    await expectClosed(alice.sockets);
    await expectOpen(bob.sockets);
    await expectOpen(owner);
  });

  it("closes every member's sockets on team-off and leaves the owner's shared-password sockets open", async () => {
    const { ownerCookie, alice, bob, owner } = await setUp();

    const res = await request(app).post("/api/team/disable").set("Cookie", ownerCookie).send({});
    expect(res.status).toBe(200);

    await expectClosed(alice.sockets);
    await expectClosed(bob.sockets);
    await expectOpen(owner);
  });

  it("closes the owner's shared-password sockets when enabling team arms the legacy-login lockdown", async () => {
    settings.enabled = false;
    const ownerCookie = await loginOwner();
    const owner = await openBoth(ownerCookie);

    const res = await request(app).post("/api/team/enable").set("Cookie", ownerCookie).send({
      ownerEmail: "owner@example.com",
      ownerPassword: "owner member pw",
      confirmHostIsolation: true,
      disableLegacyLogin: true,
    });
    expect(res.status).toBe(200);

    await expectClosed(owner);
  });

  it("keeps the owner's sockets open when the lockdown is armed while the emergency hatch is open", async () => {
    settings.enabled = false;
    vi.stubEnv("ALPHACLAW_ALLOW_LEGACY_LOGIN", "1");
    const ownerCookie = await loginOwner();
    const owner = await openBoth(ownerCookie);

    const res = await request(app).post("/api/team/enable").set("Cookie", ownerCookie).send({
      ownerEmail: "owner@example.com",
      ownerPassword: "owner member pw",
      confirmHostIsolation: true,
      disableLegacyLogin: true,
    });
    expect(res.status).toBe(200);

    await expectOpen(owner);
  });

  it("keeps the owner's sockets open when team is enabled without the lockdown", async () => {
    settings.enabled = false;
    const ownerCookie = await loginOwner();
    const owner = await openBoth(ownerCookie);

    const res = await request(app).post("/api/team/enable").set("Cookie", ownerCookie).send({
      ownerEmail: "owner@example.com",
      ownerPassword: "owner member pw",
      confirmHostIsolation: true,
    });
    expect(res.status).toBe(200);

    await expectOpen(owner);
  });

  it("still applies the admin change when closing the sockets fails", async () => {
    const ownerCookie = await loginOwner();
    const alice = await loginMember("alice@example.com");
    await loginMember("bob@example.com");
    sessionsEndedThrows = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await request(app).patch(`/api/team/members/${alice.id}`).set("Cookie", ownerCookie).send({ disabled: true });

    expect(res.status).toBe(200);
    expect(membersStore.getMember(alice.id).disabled).toBe(true);
    expect(warn).toHaveBeenCalledWith("[alphaclaw] Team change could not close open sockets: emitter broke");
    warn.mockRestore();
  });
});

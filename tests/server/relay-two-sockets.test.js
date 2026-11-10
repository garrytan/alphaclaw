const fs = require("fs");
const os = require("os");
const path = require("path");
const { WebSocketServer, WebSocket } = require("ws");

const { createRelayBridge, kRelaySessionPrefix, kLaneSessionInfix } = require("../../lib/server/relay/bridge");
const { openBridgeStore } = require("../../lib/server/relay/bridge-store");
const { createRelayService } = require("../../lib/server/relay");
const { kRelayGuardPluginId } = require("../../lib/server/relay/guard-entry");
const { createGatewayClient, kGatewayChatBridgeScopes, kGatewayPeerScopes } = require("../../lib/server/chat/gateway-client");

// GST-2090: the relay bridge has two gateway sockets. OpenClaw runs a
// chat.send as the owner (senderIsOwner) when the sending client holds
// operator.admin, so a delegate's turn goes over the admin socket and every
// other turn over the peer socket, which has read and write only.
const kAgent = "capy-25cf4e98b5b6";
const kGrant = "rg_0123456789abcdef";
const kHour = 60 * 60 * 1000;
const quiet = { log: () => {}, warn: () => {} };

const flush = async (times = 20) => {
  for (let index = 0; index < times; index += 1) await new Promise((resolve) => setImmediate(resolve));
};

const createFakeEngine = () => {
  let seq = 0;
  let id = 500;
  const events = [];
  const messages = new Map();
  const replies = [];
  return {
    replies,
    dm(from, text, metadata = {}) {
      const message = { id: String(++id), agent_name: from, text, metadata };
      messages.set(message.id, message);
      events.push({ seq: ++seq, type: "dm.received", payload: { conversation_id: "dm_" + from, message: { id: message.id, agent_name: from, text } } });
      return message.id;
    },
    events: async (key, since, limit) => {
      const page = events.filter((event) => event.seq > since).slice(0, limit);
      return { events: page, latest_seq: seq, next_since: page.length ? page[page.length - 1].seq : since };
    },
    conversations: async () => [...new Set(events.map((event) => event.payload.message.agent_name))].map((name) => ({ id: "dm_" + name, type: "1:1", participants: [name, "wintermute"] })),
    getMessage: async (token, messageId) => messages.get(String(messageId)),
    reply: async (token, parentId, text, data) => {
      replies.push({ parentId, text, data });
      return { id: String(++id) };
    },
    thread: async () => ({ replies: [] }),
  };
};

// One fake gateway socket. Its chat.send records the turn; "down" makes it
// fail the way a socket that cannot connect does (before the frame is
// written, no gateway answer).
const createFakeSocket = () => {
  const socket = {
    sends: [],
    calls: [],
    down: false,
    requestGateway: async (method, params, timeoutMs, { onFrameWritten } = {}) => {
      socket.calls.push(method);
      if (socket.down) throw new Error("OpenClaw gateway connect backing off after 3 failure(s)");
      if (method === "chat.send") {
        onFrameWritten?.();
        socket.sends.push(params);
        return { runId: params.idempotencyKey };
      }
      if (method === "chat.history") return { messages: [] };
      if (method === "sessions.list") return { sessions: [] };
      if (method === "chat.abort") return { ok: true };
      if (method === "plugins.list") return { plugins: [{ id: kRelayGuardPluginId, runtime: { state: "active" } }] };
      throw new Error("unexpected " + method);
    },
  };
  return socket;
};

const delegateVerdict = (extra = {}) => ({ trust: "delegate", reason: "grant", grantId: kGrant, lanesMax: 3, generation: 1, ...extra });
const peerVerdict = () => ({ trust: "peer", reason: "no_grant", lanesMax: 1 });

const setupBridge = ({ verdict = peerVerdict, withPeer = true } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relay-two-sockets-"));
  const nowRef = { value: Date.parse("2026-11-09T10:00:00Z") };
  const store = openBridgeStore({ dbPath: path.join(dir, "bridge.db"), now: () => nowRef.value });
  const engine = createFakeEngine();
  const admin = createFakeSocket();
  const peer = createFakeSocket();
  const guard = { active: true };
  const trust = { verdict };
  const bridge = createRelayBridge({
    engine,
    getAuth: () => ({ workspaceKey: "rk", agentToken: "at", agentName: "wintermute" }),
    store,
    requestGateway: (...args) => admin.requestGateway(...args),
    ...(withPeer ? { requestPeerGateway: (...args) => peer.requestGateway(...args) } : {}),
    checkGuard: async () => guard.active,
    resolveAgentId: () => "main",
    config: { maxConcurrent: 6, hourlyCap: 100 },
    resolveSenderTrust: (sender) => trust.verdict(sender),
    now: () => nowRef.value,
    setTimer: () => null,
    clearTimer: () => {},
    logger: quiet,
  });
  bridge.start();
  const tick = async () => {
    await bridge._internal.pollOnce();
    await bridge._internal.pump();
    await flush();
  };
  return {
    store,
    engine,
    admin,
    peer,
    guard,
    trust,
    nowRef,
    bridge,
    tick,
    cleanup: () => {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
};

describe("relay bridge: two gateway sockets (GST-2090)", () => {
  let ctx;
  afterEach(() => ctx?.cleanup());

  it("sends a peer's turn on the peer socket and a delegate's turn on the admin socket", async () => {
    ctx = setupBridge({ verdict: (sender) => (sender === kAgent ? delegateVerdict() : peerVerdict()) });
    await ctx.tick();
    const peerMessage = ctx.engine.dm("capy-peer", "hello from a peer");
    const delegateMessage = ctx.engine.dm(kAgent, "hello from the owner's thread");
    await ctx.tick();
    expect(ctx.peer.sends.map((send) => send.idempotencyKey)).toEqual(["relay-" + peerMessage]);
    expect(ctx.admin.sends.map((send) => send.idempotencyKey)).toEqual(["relay-" + delegateMessage]);
    expect(ctx.store.get(peerMessage).trust).toBe("peer");
    expect(ctx.store.get(delegateMessage).trust).toBe("delegate");
    // Nothing but a peer's chat.send rides the peer socket.
    expect(ctx.peer.calls).toEqual(["chat.send"]);
  });

  // The one job of this test: fail if a peer turn ever rides the admin
  // socket, whatever made it a peer. Each message is queued while its sender
  // still looks like a delegate (the guard holds it), then dispatched after
  // the reason applies.
  it.each([
    ["no grant", peerVerdict, {}],
    ["generation_stale", () => delegateVerdict({ generation: 2 }), { relay_generation: 1 }],
    ["attestation_stale", () => delegateVerdict({ attestationRequired: true, attestedUntil: Date.parse("2026-11-09T10:30:00Z") }), {}],
    ["check_failed", () => { throw new Error("remote.db is locked"); }, {}],
  ])("a peer turn (%s) never rides the admin socket", async (_reason, atDispatch, metadata) => {
    ctx = setupBridge({ verdict: () => delegateVerdict() });
    await ctx.tick();
    ctx.guard.active = false;
    const messageId = ctx.engine.dm(kAgent, "queued as a delegate", metadata);
    await ctx.tick();
    expect(ctx.store.get(messageId).state).toBe("queued");
    ctx.trust.verdict = atDispatch;
    ctx.guard.active = true;
    ctx.nowRef.value += 3 * kHour;
    await ctx.tick();
    expect(ctx.store.get(messageId)).toMatchObject({ state: "dispatched", trust: "peer" });
    expect(ctx.admin.calls).not.toContain("chat.send");
    expect(ctx.peer.sends.map((send) => send.idempotencyKey)).toEqual(["relay-" + messageId]);
  });

  it("with the peer socket down a peer turn waits, then fails as a dispatch failure, and is never sent on the admin socket", async () => {
    ctx = setupBridge();
    ctx.peer.down = true;
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-peer", "are you there?");
    await ctx.tick();
    expect(ctx.store.get(messageId)).toMatchObject({ state: "queued", trust: "peer" });
    for (let minute = 0; minute < 35; minute += 1) {
      ctx.nowRef.value += 60 * 1000;
      await ctx.tick();
    }
    expect(ctx.store.get(messageId)).toMatchObject({ state: "failed", code: "run_failed" });
    expect(ctx.engine.replies).toEqual([expect.objectContaining({ parentId: messageId, data: expect.objectContaining({ relay_code: "run_failed" }) })]);
    expect(ctx.admin.calls).not.toContain("chat.send");
    expect(ctx.peer.calls.filter((method) => method === "chat.send").length).toBeGreaterThan(1);
  });

  it("with no peer socket configured a peer turn is never sent", async () => {
    ctx = setupBridge({ withPeer: false });
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-peer", "hello");
    await ctx.tick();
    expect(ctx.store.get(messageId).state).toBe("queued");
    expect(ctx.admin.calls).not.toContain("chat.send");
  });

  // The admin socket is the only one whose run events reach the bridge. If it
  // drops during a pump, after the guard check, a turn sent on the peer
  // socket would run with no socket to hear its end (the reply then waits for
  // the 30-minute stall reconcile). It waits for the next pump's guard check,
  // which reconnects the admin socket, instead.
  it("after the admin socket drops mid-pump a peer turn waits for the next guard check", async () => {
    ctx = setupBridge();
    await ctx.tick();
    const messageId = ctx.engine.dm("capy-peer", "sent while the admin socket drops");
    await ctx.bridge._internal.pollOnce();
    expect(ctx.store.get(messageId).state).toBe("queued");
    const getMessage = ctx.engine.getMessage;
    ctx.engine.getMessage = async (...args) => {
      ctx.engine.getMessage = getMessage;
      ctx.bridge.onGatewayDisconnect();
      return getMessage(...args);
    };
    await ctx.bridge._internal.pump();
    await flush();
    expect(ctx.store.get(messageId).state).toBe("queued");
    expect(ctx.peer.sends).toEqual([]);
    await ctx.tick();
    expect(ctx.store.get(messageId)).toMatchObject({ state: "dispatched", trust: "peer" });
    expect(ctx.peer.sends.map((send) => send.idempotencyKey)).toEqual(["relay-" + messageId]);
    expect(ctx.admin.calls).not.toContain("chat.send");
  });

  // Wintermute's ask: every turn the bridge sends goes into a relay session,
  // agent:<id>:relay-<sender> or agent:<id>:relay-<sender>:lane-<name>, and
  // never into the owner's main session.
  it("every chat.send carries a relay session key built from the bridge's own prefix and lane infix, never :main", async () => {
    expect(kRelaySessionPrefix).toMatch(/^relay-/);
    expect(":" + kRelaySessionPrefix).toContain(":relay-");
    expect(kLaneSessionInfix).toBe(":lane-");
    const escape = (text) => text.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
    const shape = new RegExp("^agent:main:" + escape(kRelaySessionPrefix) + "[a-z0-9][a-z0-9_.-]*(?:" + escape(kLaneSessionInfix) + "[a-z0-9][a-z0-9_-]*)?$");
    ctx = setupBridge({ verdict: (sender) => (sender === kAgent ? delegateVerdict() : peerVerdict()) });
    await ctx.tick();
    ctx.engine.dm("Capy-Peer", "no lane");
    ctx.engine.dm("other.peer", "one lane", { relay_lane: "evals" });
    ctx.engine.dm(kAgent, "default lane");
    ctx.engine.dm(kAgent, "gbrain lane", { relay_lane: "gbrain" });
    ctx.engine.dm("main", "a sender named main");
    await ctx.tick();
    const keys = [...ctx.peer.sends, ...ctx.admin.sends].map((send) => send.sessionKey);
    expect(keys).toHaveLength(5);
    for (const key of keys) {
      expect(key).toMatch(shape);
      expect(key).toContain(":" + kRelaySessionPrefix);
      expect(key).not.toMatch(/:main$/);
    }
    expect(keys).toEqual(expect.arrayContaining(["agent:main:relay-capy-peer", "agent:main:relay-other.peer:lane-evals", "agent:main:relay-" + kAgent, "agent:main:relay-" + kAgent + ":lane-gbrain", "agent:main:relay-main"]));
  });
});

// The relay service wires both sockets: only the admin socket's events and
// disconnects reach the bridge, and both close on stop.
describe("relay service: two gateway sockets (GST-2090)", () => {
  const json = (status, data) => new Response(JSON.stringify({ ok: status < 300, data }), { status, headers: { "content-type": "application/json" } });
  let root;
  let service;
  afterEach(() => {
    service?.stop();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    service = null;
    root = null;
  });

  const boot = async ({ dropScopes = false } = {}) => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-two-sockets-svc-"));
    let seq = 0;
    const events = [];
    const messages = new Map();
    const replies = [];
    const fetchImpl = async (url, options = {}) => {
      const { pathname, searchParams } = new URL(url);
      if (pathname === "/health") return json(200, { ok: true });
      if (pathname === "/internal/workspaces") return json(201, { workspace_id: "ws1", api_key: "rk_live_test" });
      if (pathname === "/v1/agents" && options.method === "POST") return json(201, { name: JSON.parse(options.body).name, token: "at_live_1" });
      if (pathname === "/v1/inbox") return json(200, { unread_dms: [] });
      if (pathname === "/v1/workspace/events") {
        const since = Number(searchParams.get("since")) || 0;
        const page = events.filter((event) => event.seq > since);
        return json(200, { events: page, latest_seq: seq, next_since: page.length ? page[page.length - 1].seq : since });
      }
      if (pathname === "/v1/dm/conversations/all") return json(200, [...new Set(events.map((event) => event.payload.message.agent_name))].map((name) => ({ id: "dm_" + name, type: "1:1", participants: [name, "wintermute"] })));
      const replyMatch = pathname.match(/^\/v1\/messages\/([^/]+)\/replies$/);
      if (replyMatch && options.method === "POST") {
        replies.push({ parentId: replyMatch[1], ...JSON.parse(options.body) });
        return json(201, { id: "r" + replies.length });
      }
      if (replyMatch) return json(200, { replies: [] });
      const messageMatch = pathname.match(/^\/v1\/messages\/([^/]+)$/);
      if (messageMatch) return messages.has(messageMatch[1]) ? json(200, messages.get(messageMatch[1])) : json(404, null);
      return json(404, null);
    };
    const dm = (from, text) => {
      const id = String(700 + seq);
      messages.set(id, { id, agent_name: from, text, metadata: {} });
      events.push({ seq: ++seq, type: "dm.received", payload: { conversation_id: "dm_" + from, message: { id, agent_name: from, text } } });
      return id;
    };
    const clients = [];
    service = createRelayService({
      env: {},
      rootDir: root,
      getSupervisor: () => ({ start: () => {}, getStatus: () => ({ status: "running" }) }),
      readDefaultAgentLabel: () => "Wintermute",
      fetchImpl,
      ensureBinary: async () => ({ downloaded: false }),
      listAddresses: () => [],
      setTimer: () => ({ unref() {} }),
      clearTimer: () => {},
      logger: quiet,
      resolveSenderTrust: (sender) => (sender === kAgent ? delegateVerdict() : peerVerdict()),
      createGatewayClient: (options) => {
        const client = {
          ...createFakeSocket(),
          options,
          scopes: [...(dropScopes || !options.scopes ? kGatewayChatBridgeScopes : options.scopes)],
          closed: false,
        };
        client.close = () => {
          client.closed = true;
        };
        clients.push(client);
        return client;
      },
    });
    await service._internal.run();
    const bridge = service._internal.state.bridge;
    const tick = async () => {
      await bridge._internal.pollOnce();
      await bridge._internal.pump();
      await flush(40);
    };
    await tick();
    return { clients, dm, replies, tick };
  };

  // OpenClaw broadcasts a run's events to every operator client that may see
  // the session, so both sockets get each frame.
  const broadcast = (clients, send) => {
    const runId = send.idempotencyKey;
    const sessionKey = send.sessionKey;
    const frames = [
      { type: "event", event: "agent", payload: { runId, sessionKey, stream: "assistant", data: { delta: "hello " } } },
      { type: "event", event: "agent", payload: { runId, sessionKey, stream: "assistant", data: { delta: "world" } } },
      { type: "event", event: "agent", payload: { runId, sessionKey, stream: "lifecycle", data: { phase: "end" } } },
    ];
    for (const frame of frames) for (const client of clients) client.options.onEvent(frame);
  };

  it("creates the admin socket with the chat scopes and the peer socket with read and write only", async () => {
    const { clients } = await boot();
    expect(clients).toHaveLength(2);
    const [admin, peer] = clients;
    expect(admin.options.scopes).toBeUndefined();
    expect(peer.options.scopes).toEqual(["operator.read", "operator.write"]);
    expect(kGatewayPeerScopes).not.toContain("operator.admin");
    expect(kGatewayChatBridgeScopes).toContain("operator.admin");
  });

  it("handles each run event once although both sockets receive it: one reply, deltas not doubled", async () => {
    const { clients, dm, replies, tick } = await boot();
    const [admin, peer] = clients;
    const messageId = dm("capy-peer", "say hello");
    await tick();
    expect(peer.sends).toHaveLength(1);
    expect(admin.sends).toEqual([]);
    broadcast(clients, peer.sends[0]);
    await flush(80);
    // chat.history has no answer here, so the reply is the streamed text.
    expect(replies).toEqual([expect.objectContaining({ parentId: messageId, text: "hello world" })]);
    expect(service.getStore().get(messageId).state).toBe("answered");
  });

  it("a delegate's turn rides the admin socket and its events are handled once too", async () => {
    const { clients, dm, replies, tick } = await boot();
    const [admin, peer] = clients;
    const messageId = dm(kAgent, "save it");
    await tick();
    expect(admin.sends).toHaveLength(1);
    expect(peer.sends).toEqual([]);
    broadcast(clients, admin.sends[0]);
    await flush(80);
    expect(replies).toEqual([expect.objectContaining({ parentId: messageId, text: "hello world" })]);
  });

  it("only the admin socket's disconnect moves running turns to reconciling; a peer socket drop loses no events", async () => {
    const { clients, dm, tick } = await boot();
    const [admin, peer] = clients;
    const messageId = dm("capy-peer", "long job");
    await tick();
    peer.options.onDisconnect("Gateway disconnected (code 1006)");
    expect(service.getStore().get(messageId).state).toBe("dispatched");
    admin.options.onDisconnect("Gateway disconnected (code 1006)");
    expect(service.getStore().get(messageId).state).toBe("reconciling");
  });

  it("closes both sockets on stop", async () => {
    const { clients } = await boot();
    service.stop();
    expect(clients.map((client) => client.closed)).toEqual([true, true]);
  });

  it("a factory that drops the peer scopes leaves peer turns unsent instead of sending them as the owner", async () => {
    const { clients, dm, tick } = await boot({ dropScopes: true });
    const messageId = dm("capy-peer", "hello");
    await tick();
    expect(clients.flatMap((client) => client.sends)).toEqual([]);
    expect(service.getStore().get(messageId).state).toBe("queued");
  });
});

// The gateway client itself: the scopes it connects with, and two clients
// that each keep their own connection and backoff.
describe("gateway client scopes (GST-2090)", () => {
  let wss;
  let openclawDir;
  const connects = [];
  let refuseScopes = null;
  beforeEach(async () => {
    connects.length = 0;
    refuseScopes = null;
    openclawDir = fs.mkdtempSync(path.join(os.tmpdir(), "gw-client-"));
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((resolve) => wss.once("listening", resolve));
    wss.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const frame = JSON.parse(String(raw));
        if (frame.method === "connect") {
          connects.push(frame.params.scopes);
          const refused = refuseScopes && JSON.stringify(frame.params.scopes) === JSON.stringify(refuseScopes);
          socket.send(JSON.stringify(refused ? { type: "res", id: frame.id, ok: false, error: { code: "UNAUTHORIZED", message: "scopes refused" } } : { type: "res", id: frame.id, ok: true, payload: { type: "hello-ok" } }));
          return;
        }
        socket.send(JSON.stringify({ type: "res", id: frame.id, ok: true, payload: { method: frame.method } }));
      });
      socket.send(JSON.stringify({ type: "event", event: "connect.challenge" }));
    });
  });
  afterEach(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => wss.close(resolve));
    fs.rmSync(openclawDir, { recursive: true, force: true });
  });

  const makeClient = (options = {}) =>
    createGatewayClient({ fs, openclawDir, getGatewayPort: () => wss.address().port, WebSocketImpl: WebSocket, ...options });

  it("connects with the chat bridge scopes by default and with exactly the scopes it is given", async () => {
    const admin = makeClient();
    const peer = makeClient({ scopes: kGatewayPeerScopes });
    try {
      await admin.requestGateway("sessions.list", {});
      await peer.requestGateway("chat.send", {});
      expect(connects).toEqual([kGatewayChatBridgeScopes, ["operator.read", "operator.write"]]);
      expect(admin.scopes).toEqual(kGatewayChatBridgeScopes);
      expect(peer.scopes).toEqual(["operator.read", "operator.write"]);
    } finally {
      admin.close();
      peer.close();
    }
  });

  it("a peer socket that cannot connect backs off on its own and leaves the admin socket working; each closes on its own", async () => {
    refuseScopes = [...kGatewayPeerScopes];
    const admin = makeClient();
    const peer = makeClient({ scopes: kGatewayPeerScopes });
    try {
      await expect(peer.requestGateway("chat.send", {})).rejects.toThrow("scopes refused");
      await expect(peer.requestGateway("chat.send", {})).rejects.toThrow(/backing off after 1 failure/);
      await expect(admin.requestGateway("sessions.list", {})).resolves.toEqual({ method: "sessions.list" });
      peer.close();
      await expect(admin.requestGateway("chat.history", {})).resolves.toEqual({ method: "chat.history" });
      admin.close();
      await expect(admin.requestGateway("chat.history", {})).rejects.toThrow("Chat bridge closed");
    } finally {
      admin.close();
      peer.close();
    }
  });
});
